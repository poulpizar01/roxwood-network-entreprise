import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Client } from "discord.js";
import { addAttachments, getApplication, getApplicationSummary, saveLogMessageRef, setAttachmentDiscordUrls } from "./recruitmentService.js";
import { getTicketById } from "./ticketService.js";
import { getGuildConfig, setRecruitmentStatusMessageId } from "./guildConfigService.js";
import { prisma } from "../db/prisma.js";
import { resolveImageDisplay } from "../utils/imageAttachment.js";
import { isCdnEnabled } from "../utils/cdnStorage.js";
import { logger } from "../utils/logger.js";

/**
 * Construction et mise a jour du message de suivi d'une candidature (recap + boutons
 * Statut/S'assigner). Regroupe ici plutot que dans `interactionCreate.ts` car ce message
 * doit pouvoir etre rafraichi depuis deux endroits distincts : un clic sur bouton/menu
 * (`ButtonInteraction`/`StringSelectMenuInteraction`) et l'auto-acceptation par le monitoring
 * RECRUITMENT (`Client` seul, pas d'interaction).
 *
 * Les pieces jointes du candidat ne sont chargees et affichees qu'une seule fois, au moment ou
 * il clique "J'ai terminé d'envoyer mes fichiers" (voir `finalizeRecruitmentAttachments`) —
 * jamais de facon incrementale a chaque fichier recu. En mode CDN (production, `CDN_TOKEN`
 * configure), chaque image a deja une URL stable et externe (`imageUrl`) des sa reception :
 * une simple edition du message suffit alors, sans jamais toucher aux pieces jointes Discord.
 * En mode base (dev local, pas de CDN), ce n'est pas qu'une question d'efficacite : verifie en
 * conditions reelles, Discord ne persiste pas de facon fiable l'image d'un embed nouvellement
 * ajoute a un message existant via `PATCH` (meme quand la reponse de l'appel l'affichait
 * correctement juste apres l'edition, une relecture immediate du message ne la montrait plus).
 * Une image ajoutee en une seule fois via `POST` (nouveau message) fonctionne de facon fiable —
 * d'ou, dans ce mode, le choix de supprimer puis reposter le message plutot que de l'editer.
 * Une fois les URLs Discord capturees (voir `RecruitmentAttachment.discordUrl`), les
 * rafraichissements suivants (changement de statut, assignation) restent de simples editions
 * de texte qui reutilisent ces URLs deja resolues, sans plus jamais toucher aux pieces jointes
 * du message.
 */

/** Etapes du pipeline de recrutement proposees dans le menu deroulant "Statut". */
export const RECRUITMENT_STATUS_CHOICES = [
  { name: "En attente", value: "PENDING" },
  { name: "Entretien", value: "INTERVIEW" },
  { name: "Accepté", value: "ACCEPTED" },
  { name: "Refusé", value: "REJECTED" },
] as const;

/** Libelle affichable d'un statut de candidature (fallback sur la valeur brute si inconnue). */
export function recruitmentStatusLabel(status: string): string {
  return RECRUITMENT_STATUS_CHOICES.find((c) => c.value === status)?.name ?? status;
}

/**
 * Construit l'embed principal de suivi d'une candidature (candidat, salon, statut, recruteur,
 * reponses au formulaire, liste des pieces jointes) ainsi qu'un embed image supplementaire par
 * piece jointe image deja resolue — `imageUrl` (CDN, production) si present, sinon `discordUrl`
 * (dev/base, voir `finalizeRecruitmentAttachments`). Ne touche jamais aux octets ni aux pieces
 * jointes du message : uniquement du texte et des URLs deja connues, donc toujours sur d'etre
 * applique par une simple edition. Reutilise a la fois pour le premier envoi (texte seul,
 * aucune piece jointe encore), la finalisation en mode CDN, et la mise a jour du message apres
 * un changement de statut/assignation.
 */
export function buildRecruitmentEmbed(
  ticket: { channelId: string; openerId: string | null },
  application: {
    status: string;
    recruiterId: string | null;
    answers: { question: string; answer: string }[];
    attachments: { filename: string; imageUrl?: string | null; discordUrl: string | null }[];
  }
): EmbedBuilder[] {
  const embed = new EmbedBuilder()
    .setTitle("Candidature")
    .setColor(0x5865f2)
    .addFields(
      { name: "Candidat", value: ticket.openerId ? `<@${ticket.openerId}>` : "inconnu", inline: true },
      { name: "Ticket", value: `<#${ticket.channelId}>`, inline: true },
      { name: "Statut", value: `**${recruitmentStatusLabel(application.status)}**`, inline: true },
      { name: "Recruteur", value: application.recruiterId ? `<@${application.recruiterId}>` : "non assigné", inline: true },
      ...application.answers.map((a) => ({ name: a.question, value: a.answer || "-" }))
    );

  const imageEmbeds: EmbedBuilder[] = [];
  if (application.attachments.length > 0) {
    embed.addFields({
      name: "Pièces jointes",
      value: application.attachments.map((a, i) => a.filename || `Fichier ${i + 1}`).join("\n"),
    });

    for (const a of application.attachments) {
      const url = a.imageUrl ?? a.discordUrl;
      if (url) imageEmbeds.push(new EmbedBuilder().setTitle(a.filename).setColor(0x5865f2).setImage(url));
    }
  }

  return [embed, ...imageEmbeds];
}

/** Boutons "Statut" et "S'assigner" affiches sous le message de suivi d'une candidature. */
export function buildRecruitmentActionRow(ticketId: string): ActionRowBuilder<ButtonBuilder> {
  const statusButton = new ButtonBuilder()
    .setCustomId(`recruitment:status:${ticketId}`)
    .setLabel("Statut")
    .setStyle(ButtonStyle.Secondary);
  const assignButton = new ButtonBuilder()
    .setCustomId(`recruitment:assign:${ticketId}`)
    .setLabel("S'assigner")
    .setStyle(ButtonStyle.Primary);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(statusButton, assignButton);
}

/**
 * Determine ou poster le message de suivi d'une candidature : le salon dedie configure
 * par la guilde (`recruitmentLogChannelId`) si present et accessible, sinon le salon du
 * ticket lui-meme. Le repli est silencieux (juste logge) pour ne jamais bloquer l'envoi
 * du recap a cause d'une mauvaise configuration (salon supprime, permissions manquantes...).
 */
export async function resolveRecruitmentLogChannel(client: Client, guildId: string | null, ticketChannelId: string) {
  const config = guildId ? await getGuildConfig(guildId) : null;
  const configuredChannelId = config?.recruitmentLogChannelId;

  if (configuredChannelId) {
    try {
      const channel = await client.channels.fetch(configuredChannelId);
      if (channel?.isTextBased() && !channel.isDMBased()) return channel;
    } catch (error) {
      logger.warn(`Salon de suivi recrutement ${configuredChannelId} inaccessible, repli sur le salon du ticket`, error);
    }
  }

  const fallback = await client.channels.fetch(ticketChannelId);
  return fallback?.isTextBased() && !fallback.isDMBased() ? fallback : null;
}

/**
 * Recharge le ticket/la candidature depuis la base et met a jour en place le message de
 * suivi (embed + boutons), apres un changement de statut ou d'assignation — jamais pour une
 * piece jointe, voir `finalizeRecruitmentAttachments` pour ce cas. No-op silencieux si le
 * message de suivi n'a jamais ete envoye (candidature pas encore soumise) ou n'est plus
 * accessible (salon/message supprime) — journalise mais ne fait pas echouer l'action qui a
 * declenche la mise a jour.
 */
export async function refreshRecruitmentLogMessage(client: Client, ticketId: string): Promise<void> {
  const ticket = await getTicketById(ticketId);
  const application = await getApplicationSummary(ticketId);
  if (!ticket || !application || !application.logChannelId || !application.logMessageId) return;

  try {
    const channel = await client.channels.fetch(application.logChannelId);
    if (!channel?.isTextBased() || channel.isDMBased()) return;
    const message = await channel.messages.fetch(application.logMessageId);
    const embeds = buildRecruitmentEmbed(ticket, application);
    await message.edit({ embeds, components: [buildRecruitmentActionRow(ticketId)] });
  } catch (error) {
    logger.error(`Echec de mise a jour du message de suivi pour le ticket ${ticketId}`, error);
  }
}

/**
 * Charge et affiche, en une seule fois, les pieces jointes (images) que le candidat a envoyees
 * dans le salon du ticket — declenchee par le bouton "J'ai terminé d'envoyer mes fichiers" (voir
 * `handleRecruitmentFinishAttachments` dans `interactionCreate.ts`). `files` : octets deja
 * telecharges et verifies comme images par l'appelant, depuis les URL CDN Discord des messages
 * du candidat. Le stockage effectif (CDN ou base) est decide par `addAttachments`.
 *
 * En mode CDN (voir `isCdnEnabled`), chaque image a deja une URL stable et externe : une simple
 * edition du message existant suffit (ou un premier envoi s'il n'existait pas encore). En mode
 * base/dev, une image ne peut pas etre ajoutee de facon fiable a un message existant par edition
 * (voir le commentaire en tete de fichier) : le message de suivi existant est donc supprime puis
 * reposte integralement avec les images cette fois — en un seul `POST`, la seule methode fiable
 * constatee — et les URLs Discord finales de chaque image sont ensuite capturees et stockees,
 * pour que tous les rafraichissements ulterieurs (`refreshRecruitmentLogMessage`) restent de
 * simples editions de texte.
 */
export async function finalizeRecruitmentAttachments(
  client: Client,
  ticketId: string,
  files: { data: Buffer; filename: string; contentType?: string | null }[]
): Promise<void> {
  await addAttachments(ticketId, files);

  const ticket = await getTicketById(ticketId);
  const application = await getApplication(ticketId);
  if (!ticket || !application) return;

  const channel = application.logChannelId
    ? await client.channels.fetch(application.logChannelId).catch(() => null)
    : await resolveRecruitmentLogChannel(client, ticket.guildId, ticket.channelId).catch(() => null);
  if (!channel?.isTextBased() || channel.isDMBased()) return;

  if (isCdnEnabled()) {
    const embeds = buildRecruitmentEmbed(ticket, application);
    const components = [buildRecruitmentActionRow(ticketId)];
    const oldMessage = application.logMessageId ? await channel.messages.fetch(application.logMessageId).catch(() => null) : null;
    if (oldMessage) {
      await oldMessage.edit({ embeds, components });
      return;
    }
    const newMessage = await channel.send({ embeds, components });
    await saveLogMessageRef(ticketId, channel.id, newMessage.id);
    return;
  }

  // Le texte est identique a `buildRecruitmentEmbed`, mais ici les images sont fraichement
  // uploadees (`attachment://`) puisque c'est le tout premier — et unique — envoi qui les
  // introduit, plutot que reutilisees via une URL deja connue (il n'y en a pas encore).
  const [infoEmbed] = buildRecruitmentEmbed(ticket, application);

  const uploadFiles: AttachmentBuilder[] = [];
  const imageEmbeds: EmbedBuilder[] = [];
  // On associe chaque piece jointe a son embed dans le meme ordre, pour retrouver apres coup
  // quelle URL Discord finale correspond a quelle ligne `RecruitmentAttachment`.
  const imageAttachmentIds: string[] = [];

  for (const [i, a] of application.attachments.entries()) {
    // `uniqueName` (plutot que `a.filename` tel quel) : plusieurs fichiers du candidat peuvent
    // partager le meme nom, ce qui rendrait ambigue la reference `attachment://` de chacun dans
    // le meme message.
    const uniqueName = `${i}-${a.filename || "fichier"}`;
    const image = await resolveImageDisplay({ url: a.imageUrl, filename: a.filename }, `recruitment-attachments/${a.id}`, uniqueName);
    if (!image?.attachment) continue;
    uploadFiles.push(image.attachment);
    imageEmbeds.push(new EmbedBuilder().setTitle(a.filename).setColor(0x5865f2).setImage(image.url));
    imageAttachmentIds.push(a.id);
  }

  if (application.logMessageId) {
    const oldMessage = await channel.messages.fetch(application.logMessageId).catch(() => null);
    if (oldMessage) await oldMessage.delete().catch((error) => logger.warn(`Echec suppression de l'ancien message de suivi pour le ticket ${ticketId}`, error));
  }

  const newMessage = await channel.send({
    embeds: [infoEmbed, ...imageEmbeds],
    files: uploadFiles,
    components: [buildRecruitmentActionRow(ticketId)],
  });
  await saveLogMessageRef(ticketId, channel.id, newMessage.id);

  if (imageAttachmentIds.length > 0) {
    const resolvedImageEmbeds = newMessage.embeds.filter((e) => e.image);
    const urls = imageAttachmentIds
      .map((attachmentId, i) => {
        const url = resolvedImageEmbeds[i]?.image?.url;
        return url ? { attachmentId, discordUrl: url } : null;
      })
      .filter((u): u is { attachmentId: string; discordUrl: string } => u !== null);
    await setAttachmentDiscordUrls(urls);
  }
}

/**
 * Applique les effets de bord declenches quand une candidature passe a ACCEPTED (voir
 * `panel:recruitment:set-accepted-category`/`-role`) : deplace le salon du ticket vers la
 * categorie configuree et/ou ajoute le role configure au candidat. Chaque effet est
 * independant et optionnel (`null` = desactive) ; un echec sur l'un (permissions, hierarchie
 * de roles, salon/membre introuvable) est journalise sans bloquer l'autre. Appelee a la fois
 * depuis le changement de statut manuel (bouton "Statut") et l'auto-acceptation par le
 * monitoring RECRUITMENT ("embauche"), pour ne jamais dupliquer cette logique.
 */
export async function applyRecruitmentAcceptance(client: Client, ticketId: string): Promise<void> {
  const ticket = await getTicketById(ticketId);
  if (!ticket) return;

  const config = await getGuildConfig(ticket.guildId);
  if (!config) return;

  if (config.recruitmentAcceptedCategoryId) {
    try {
      const channel = await client.channels.fetch(ticket.channelId);
      if (channel && "setParent" in channel) {
        await channel.setParent(config.recruitmentAcceptedCategoryId, { lockPermissions: false });
      }
    } catch (error) {
      logger.warn(`Echec du deplacement du salon ${ticket.channelId} vers la categorie d'acceptation`, error);
    }
  }

  if (config.recruitmentAcceptedRoleId && ticket.openerId) {
    try {
      const guild = await client.guilds.fetch(ticket.guildId);
      const member = await guild.members.fetch(ticket.openerId);
      await member.roles.add(config.recruitmentAcceptedRoleId);
    } catch (error) {
      logger.warn(`Echec de l'ajout du role d'acceptation a ${ticket.openerId}`, error);
    }
  }
}

/**
 * Construit/met a jour en place le message permanent affichant l'etat ouvert/ferme des
 * recrutements dans le salon configure (`recruitmentStatusChannelId`) — distinct du panneau
 * d'administration, potentiellement visible par tout le monde (ex: annonce publique "on
 * recrute"). No-op si aucun salon n'est configure. Si le message precedent n'est plus
 * accessible (supprime manuellement), en reposte un nouveau plutot que d'echouer.
 */
export async function refreshRecruitmentStatusMessage(client: Client, guildId: string): Promise<void> {
  const config = await getGuildConfig(guildId);
  if (!config?.recruitmentStatusChannelId) return;

  const embed = new EmbedBuilder()
    .setTitle("Recrutement")
    .setColor(config.recruitmentOpen ? 0x57f287 : 0xed4245)
    .setDescription(config.recruitmentOpen ? "**Les recrutements sont ouverts.**" : "**Les recrutements sont actuellement fermés.**");

  try {
    const channel = await client.channels.fetch(config.recruitmentStatusChannelId);
    if (!channel?.isTextBased() || channel.isDMBased()) return;

    if (config.recruitmentStatusMessageId) {
      try {
        const message = await channel.messages.fetch(config.recruitmentStatusMessageId);
        await message.edit({ embeds: [embed] });
        return;
      } catch {
        // Message supprime ou inaccessible : on retombe sur le repost ci-dessous.
      }
    }

    const message = await channel.send({ embeds: [embed] });
    await setRecruitmentStatusMessageId(guildId, message.id);
  } catch (error) {
    logger.error(`Echec de mise a jour du message de statut recrutement pour la guilde ${guildId}`, error);
  }
}

/**
 * Rafraichit le message de statut recrutement de toutes les guildes qui en ont configure un —
 * appelee au demarrage du bot (voir `ready.ts`), meme raisonnement que
 * `refreshAllPanelsAcrossGuilds` : une mise a jour du bot (libelle, couleur...) se propage
 * ainsi automatiquement sans reconfiguration manuelle.
 */
export async function refreshAllRecruitmentStatusMessages(client: Client): Promise<void> {
  const configs = await prisma.guildConfig.findMany({ where: { recruitmentStatusChannelId: { not: null } }, select: { guildId: true } });
  for (const config of configs) {
    await refreshRecruitmentStatusMessage(client, config.guildId);
  }
}
