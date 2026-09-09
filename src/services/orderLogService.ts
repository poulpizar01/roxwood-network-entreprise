import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type AttachmentBuilder, type Client } from "discord.js";
import {
  computeDiscountAmount,
  computeGrandTotal,
  computeTotal,
  computeTotalWeightGrams,
  getOrderByTicket,
  saveConfirmationMessageId,
  setInvoiceNumber,
} from "./orderService.js";
import { getTicketById } from "./ticketService.js";
import { getGuildConfig, getShopBanner } from "./guildConfigService.js";
import { dispatchWebhook } from "./webhookDispatcher.js";
import { logger } from "../utils/logger.js";
import { resolveImageDisplay } from "../utils/imageAttachment.js";

/**
 * Construction et mise a jour de l'unique message de commande dans le salon du ticket :
 * un embed "en cours" pendant que le client compose sa commande, puis un embed "suivi"
 * (recap + boutons Statut/Marquer payee/Facture/Ajouter/Retirer) une fois validee. Le
 * meme message est edite en place tout du long (voir `upsertOrderMessage`) plutot que
 * reposte a chaque article ajoute. Regroupe ici pour etre reutilisable a la fois par les
 * boutons (`interactionCreate.ts`) sans dependre d'un type d'interaction precis (juste un `Client`).
 */

/** Statuts logistiques disponibles pour une commande (independants du statut de paiement). */
export const ORDER_STATUS_CHOICES = [
  { name: "En attente", value: "PENDING" },
  { name: "En préparation", value: "PREPARING" },
  { name: "Livrée", value: "DELIVERED" },
  { name: "Annulée", value: "CANCELLED" },
] as const;

/** Libelle affichable d'un statut de commande (fallback sur la valeur brute si inconnue). */
export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_CHOICES.find((c) => c.value === status)?.name ?? status;
}

type OrderWithItems = NonNullable<Awaited<ReturnType<typeof getOrderByTicket>>>;

/** Embed affiche pendant que le client compose sa commande (avant "Valider la commande"). */
function buildOrderInProgressEmbed(order: OrderWithItems): EmbedBuilder {
  const total = computeTotal(order);
  return new EmbedBuilder()
    .setTitle("Commande en cours")
    .setColor(0x5865f2)
    .setDescription(
      order.items.map((i) => `**${i.name}** x${i.quantity} — ${(i.unitPrice * i.quantity).toLocaleString("fr-FR")} $`).join("\n") ||
        "Aucun article"
    )
    .addFields({ name: "Total", value: `${total.toLocaleString("fr-FR")} $` });
}

/** Boutons affiches pendant la composition : continuer d'ajouter, ou valider. */
function buildOrderInProgressRow(): ActionRowBuilder<ButtonBuilder> {
  const addMore = new ButtonBuilder().setCustomId("order:add-more").setLabel("Ajouter un article").setStyle(ButtonStyle.Secondary);
  const confirm = new ButtonBuilder().setCustomId("order:confirm").setLabel("Valider la commande").setStyle(ButtonStyle.Success);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(addMore, confirm);
}

/**
 * Construit l'embed recapitulatif d'une commande validee (articles, statut, paiement, total).
 * "Total" reflete deja livraison/reduction si l'un des deux est defini (voir `computeGrandTotal`) ;
 * le detail (sous-total, livraison, reduction) n'est affiche que si au moins un des deux est
 * non nul, pour ne pas alourdir l'embed dans le cas courant ou aucun des deux n'est utilise.
 */
function buildOrderEmbed(order: OrderWithItems): EmbedBuilder {
  const grandTotal = computeGrandTotal(order);

  const embed = new EmbedBuilder()
    .setTitle("Commande")
    .setColor(order.paymentStatus === "PAID" ? 0x57f287 : 0x5865f2)
    .setDescription(
      order.items.map((i) => `**${i.name}** x${i.quantity} — ${(i.unitPrice * i.quantity).toLocaleString("fr-FR")} $`).join("\n") ||
        "Aucun article"
    )
    .addFields(
      { name: "Statut", value: `**${orderStatusLabel(order.status)}**`, inline: true },
      { name: "Paiement", value: order.paymentStatus === "PAID" ? "**Payée** ✅" : "**Non payée**", inline: true },
      { name: "Total", value: `${grandTotal.toLocaleString("fr-FR")} $`, inline: true }
    );

  if (order.deliveryFee !== 0 || order.discountPercent !== 0) {
    embed.addFields(
      { name: "Sous-total articles", value: `${computeTotal(order).toLocaleString("fr-FR")} $`, inline: true },
      { name: "Livraison", value: `${order.deliveryFee.toLocaleString("fr-FR")} $`, inline: true },
      {
        name: "Réduction",
        value: `${order.discountPercent}% (-${computeDiscountAmount(order).toLocaleString("fr-FR")} $)`,
        inline: true,
      }
    );
  }

  return embed;
}

/**
 * Boutons du message de commande validee. Ligne 1 : suivi (statut, paiement, facture).
 * Ligne 2 : corrections manuelles exceptionnelles ("Ajouter un article" reutilise le
 * meme bouton/flux que le client, "Retirer un article" ouvre un menu des lignes existantes).
 */
function buildOrderActionRows(ticketId: string): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`order:status:${ticketId}`).setLabel("Statut").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`order:mark-paid:${ticketId}`).setLabel("Marquer payée").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`order:invoice:${ticketId}`).setLabel("Facture").setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("order:add-more").setLabel("Ajouter un article").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`order:remove-item:${ticketId}`).setLabel("Retirer un article").setStyle(ButtonStyle.Danger)
  );
  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`order:set-delivery:${ticketId}`).setLabel("Livraison").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`order:set-discount:${ticketId}`).setLabel("Réduction").setStyle(ButtonStyle.Secondary)
  );
  return [row1, row2, row3];
}

/**
 * Cree l'unique message de commande d'un ticket s'il n'existe pas encore, ou l'edite en
 * place sinon — evite de reposter un nouveau message a chaque article ajoute. Choisit
 * automatiquement le style "en cours" ou "valide" selon `order.confirmed`. Si le message
 * memorise n'est plus accessible (supprime manuellement), en reposte un nouveau et met a
 * jour la reference.
 */
export async function upsertOrderMessage(client: Client, ticketId: string): Promise<void> {
  const ticket = await getTicketById(ticketId);
  const order = await getOrderByTicket(ticketId);
  if (!ticket || !order) return;

  const payload = order.confirmed
    ? { embeds: [buildOrderEmbed(order)], components: buildOrderActionRows(ticketId) }
    : { embeds: [buildOrderInProgressEmbed(order)], components: [buildOrderInProgressRow()] };

  const channel = await client.channels.fetch(ticket.channelId);
  if (!channel?.isTextBased() || channel.isDMBased()) return;

  if (order.confirmationMessageId) {
    try {
      const message = await channel.messages.fetch(order.confirmationMessageId);
      await message.edit(payload);
      return;
    } catch (error) {
      logger.warn(`Message de commande ${order.confirmationMessageId} introuvable, nouveau message poste`, error);
    }
  }

  const message = await channel.send(payload);
  await saveConfirmationMessageId(order.id, message.id);
}

/**
 * Envoie l'etat complet et courant d'une commande sur l'unique evenement `order.updated` —
 * meme raisonnement que `absenceService.dispatchAbsenceUpdated` : un recepteur qui veut
 * generer sa propre facture n'a qu'un type d'evenement a ecouter pour toujours avoir la
 * derniere version (articles, montants, statut de paiement), plutot que de recomposer l'etat
 * a partir de plusieurs evenements. Appelee a la validation de la commande par le client et a
 * chaque (re)generation de facture (voir `sendInvoiceForOrder`).
 */
export async function dispatchOrderUpdated(
  guildId: string,
  ticket: { id: string; channelId: string; openerId: string | null },
  order: OrderWithItems
): Promise<void> {
  await dispatchWebhook(guildId, "order.updated", {
    orderId: order.id,
    ticketId: ticket.id,
    channelId: ticket.channelId,
    customerId: ticket.openerId,
    confirmed: order.confirmed,
    status: order.status,
    paymentStatus: order.paymentStatus,
    invoiceNumber: order.invoiceNumber,
    items: order.items.map((i) => ({
      name: i.name,
      unitPrice: i.unitPrice,
      quantity: i.quantity,
      weightGrams: i.weightGrams,
      answers: i.answers.map((a) => ({ question: a.question, answer: a.answer })),
    })),
    subtotal: computeTotal(order),
    deliveryFee: order.deliveryFee,
    discountPercent: order.discountPercent,
    discountAmount: computeDiscountAmount(order),
    total: computeGrandTotal(order),
  });
}

/** Formate un poids en grammes pour affichage (ex: `120.0kg`), meme convention decimale que la reference fournie par l'utilisateur. */
function formatWeight(grams: number): string {
  return `${(grams / 1000).toFixed(1)}kg`;
}

/**
 * Construit l'embed de facture : articles, sous-total/livraison/reduction/total, et le
 * "profil boutique" configure par la guilde (RIB, telephone, message de remerciement,
 * banniere — voir `panel:service:set-shop-profile`). Poids total/camions requis ne sont
 * affiches que si au moins un article de la commande a un poids configure (voir
 * `computeTotalWeightGrams`) — sinon ces deux champs sont omis plutot que d'afficher "0kg".
 */
async function buildInvoiceEmbed(
  guildId: string,
  guildName: string,
  customerLabel: string,
  order: OrderWithItems,
  invoiceNumber: string
): Promise<{ embed: EmbedBuilder; files: AttachmentBuilder[] }> {
  const config = await getGuildConfig(guildId);
  const subtotal = computeTotal(order);
  const grandTotal = computeGrandTotal(order);
  const discountAmount = computeDiscountAmount(order);
  const totalWeightGrams = computeTotalWeightGrams(order);

  const embed = new EmbedBuilder()
    .setTitle(guildName)
    .setColor(order.paymentStatus === "PAID" ? 0x57f287 : 0x5865f2)
    .setDescription(`**Facture n° ${invoiceNumber}**`)
    .addFields(
      { name: "Entreprise", value: guildName, inline: true },
      { name: "Commande passée par", value: customerLabel, inline: true },
      { name: "Date", value: order.createdAt.toLocaleDateString("fr-FR"), inline: true },
      {
        name: "Articles de la commande",
        value:
          order.items.map((i) => `- ${i.quantity}x ${i.name} — ${(i.unitPrice * i.quantity).toLocaleString("fr-FR")}$`).join("\n") ||
          "Aucun article",
      },
      { name: "Sous-total", value: `${subtotal.toLocaleString("fr-FR")}$`, inline: true },
      { name: "Livraison facturée", value: `${order.deliveryFee.toLocaleString("fr-FR")}$`, inline: true },
      { name: "Réduction appliquée", value: `${order.discountPercent}% (-${discountAmount.toLocaleString("fr-FR")}$)`, inline: true },
      { name: "TOTAL À PAYER", value: `**${grandTotal.toLocaleString("fr-FR")}$**` }
    );

  if (totalWeightGrams !== null) {
    embed.addFields({ name: "Poids total", value: formatWeight(totalWeightGrams), inline: true });
    if (config?.truckCapacityGrams) {
      embed.addFields({ name: "Camions requis", value: String(Math.ceil(totalWeightGrams / config.truckCapacityGrams)), inline: true });
    }
  }

  if (config?.shopRib) embed.addFields({ name: "RIB pour le règlement", value: config.shopRib });

  const footerLines = [config?.shopThankYouMessage, config?.shopPhone ? `Téléphone : ${config.shopPhone}` : null].filter(
    (line): line is string => Boolean(line)
  );
  if (footerLines.length > 0) embed.setFooter({ text: footerLines.join("\n") });

  const files: AttachmentBuilder[] = [];
  const banner = await getShopBanner(guildId);
  const image = banner ? await resolveImageDisplay(banner, `shop-banners/${guildId}`) : null;
  if (image) {
    embed.setImage(image.url);
    if (image.attachment) files.push(image.attachment);
  }

  return { embed, files };
}

/**
 * Construit et poste l'embed de facture dans le salon du ticket. Reutilise le numero de
 * facture existant s'il y en a deja un, pour eviter que renvoyer la facture n'en change
 * le numero. Resout le pseudo affiche du client (fallback "Client" si le membre a quitte
 * le serveur ou si l'opener n'a pas pu etre determine a l'ouverture du ticket).
 */
export async function sendInvoiceForOrder(
  client: Client,
  guildId: string,
  ticket: { id: string; channelId: string; openerId: string | null },
  order: OrderWithItems
): Promise<void> {
  const invoiceNumber = order.invoiceNumber ?? (await setInvoiceNumber(guildId, order.id));

  let guildName = "Roxwood Network";
  let customerLabel = "Client";
  try {
    const guild = await client.guilds.fetch(guildId);
    guildName = guild.name;
    if (ticket.openerId) {
      try {
        const member = await guild.members.fetch(ticket.openerId);
        customerLabel = member.displayName;
      } catch {
        // membre introuvable (parti du serveur) : on garde le libelle par defaut
      }
    }
  } catch (error) {
    logger.warn(`Impossible de recuperer la guilde ${guildId} pour la facture`, error);
  }

  const { embed, files } = await buildInvoiceEmbed(guildId, guildName, customerLabel, order, invoiceNumber);

  const channel = await client.channels.fetch(ticket.channelId);
  if (channel?.isTextBased() && !channel.isDMBased()) {
    await channel.send({ embeds: [embed], files });
  }

  // `order.invoiceNumber` peut encore etre `null` en memoire si c'est cet appel qui vient de
  // le generer (setInvoiceNumber ecrit en base mais ne mute pas l'objet local) : on passe le
  // numero resolu explicitement plutot que de relire un champ potentiellement perime.
  await dispatchOrderUpdated(guildId, ticket, { ...order, invoiceNumber });
}
