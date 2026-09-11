import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Interaction,
  type Message,
  type StringSelectMenuInteraction,
  type TextBasedChannel,
} from "discord.js";
import { commandsByName } from "../commands/index.js";
import { getTicketByChannel, getTicketById, markTicketClosed } from "../services/ticketService.js";
import {
  MAX_RECRUITMENT_ATTACHMENTS,
  assignRecruiter,
  getApplicationSummary,
  saveAnswers,
  saveLogMessageRef,
  setStatus as setApplicationStatus,
} from "../services/recruitmentService.js";
import {
  RECRUITMENT_STATUS_CHOICES,
  applyRecruitmentAcceptance,
  buildRecruitmentActionRow,
  buildRecruitmentEmbed,
  finalizeRecruitmentAttachments,
  recruitmentStatusLabel,
  refreshRecruitmentLogMessage,
  refreshRecruitmentStatusMessage,
  resolveRecruitmentLogChannel,
} from "../services/recruitmentLogService.js";
import {
  addField,
  addItem,
  buildCatalogSelectOptions,
  getItem,
  listActive,
  listActiveWithFields,
  removeField,
  removeItem as removeCatalogItem,
  setItemImage,
  setItemWeight,
} from "../services/catalogService.js";
import {
  addItemFromAnswers,
  getOrCreateOrder,
  getOrderByTicket,
  markConfirmed,
  removeItem as removeOrderItem,
  setDeliveryFee,
  setDiscountPercent,
  setPaymentStatus,
  setStatus as setOrderStatus,
} from "../services/orderService.js";
import {
  ORDER_STATUS_CHOICES,
  dispatchOrderUpdated,
  orderStatusLabel,
  sendInvoiceForOrder,
  upsertOrderMessage,
} from "../services/orderLogService.js";
import {
  clearAbsenceReviewChannel,
  clearCategoryForType,
  clearMonitoringChannel,
  clearRecruitmentAcceptedCategory,
  clearRecruitmentAcceptedRole,
  clearRecruitmentStatusChannel,
  clearShopBanner,
  getGuildConfig,
  isAbsenceApprover,
  isTicketManager,
  setAbsenceApproverRoles,
  setAbsenceReviewChannel,
  setCategoryForType,
  setCategoryManagerRoles,
  setMonitoringChannel,
  setMonitoringJobId,
  setOnDutyRole,
  setRecruitmentAcceptedCategory,
  setRecruitmentAcceptedRole,
  setRecruitmentLogChannel,
  setRecruitmentOpen,
  setRecruitmentStatusChannel,
  setShopBanner,
  setShopProfile,
} from "../services/guildConfigService.js";
import {
  addQuestion as addRecruitmentQuestion,
  getEffectiveQuestions,
  listQuestions as listRecruitmentQuestions,
  removeQuestion as removeRecruitmentQuestion,
} from "../services/recruitmentQuestionService.js";
import {
  MONITORING_TYPE_LABELS,
  TICKET_TYPE_LABELS,
  refreshAbsencesPanelMessage,
  refreshMonitoringPanelMessage,
  refreshRecruitmentPanelMessage,
  refreshServicePanelMessage,
  refreshTicketsPanelMessage,
  setPanelEnabled,
} from "../services/panelService.js";
import { createAbsenceRequest, formatFrenchDate, getAbsenceRequest, parseFrenchDate, resolveAbsenceRequest } from "../services/absenceService.js";
import { postAbsenceRequest, refreshAbsenceMessage } from "../services/absenceLogService.js";
import { WEBHOOK_EVENT_LABELS, describeSubscription, type WebhookEventType } from "../services/webhookDispatcher.js";
import { createSubscription, listCustomSubscriptions, listSubscriptions, removeSubscription } from "../services/webhookSubscriptionService.js";
import { createSheetSync, listSheetSyncs, removeSheetSync } from "../services/sheetSyncService.js";
import type { MonitoringLogType } from "@prisma/client";
import { logger } from "../utils/logger.js";
import {
  downloadImageBytes,
  IMAGE_TOO_LARGE_MESSAGE,
  IMAGE_TOO_LARGE_SHORT,
  ImageTooLargeError,
  isImageAttachment,
  MAX_UPLOAD_SIZE_BYTES,
  resolveImageDisplay,
} from "../utils/imageAttachment.js";

/**
 * Point d'entree unique pour toutes les interactions Discord (commandes slash, boutons,
 * menus deroulants, soumissions de modal). Route chaque interaction vers son handler dedie
 * en fonction de son type et de son `customId`. C'est ici que vivent les trois flux
 * conversationnels a plusieurs etapes du bot :
 * - Recrutement : bouton "recruitment:start-form" -> modal -> "recruitment:submit-form"
 *   -> bouton candidat "recruitment:finish-attachments:<ticketId>" (charge les pieces jointes
 *   envoyees entre-temps, une seule fois), puis pilotage staff par boutons
 *   "recruitment:assign:<ticketId>" / "recruitment:status:<ticketId>" -> menu
 *   "recruitment:set-status:<ticketId>"
 * - Commande self-service : select "order:select-item" -> modal dynamique ->
 *   "order:submit-item:<catalogItemId>" -> boutons "order:add-more" / "order:confirm", puis
 *   pilotage staff par boutons "order:status:<ticketId>" / "order:mark-paid:<ticketId>" /
 *   "order:invoice:<ticketId>" / "order:remove-item:<ticketId>"
 * - Panneau d'administration (prefixe "panel:") : boutons du message racine ->
 *   "panel:root:tickets"/"absences"/"monitoring", puis pour Tickets une serie de mini-flux
 *   select-puis-select (categorie/role) decrits pres de chaque handler `handlePanelTickets*`.
 */

/**
 * Verifie que l'utilisateur a l'origine d'une interaction sur un composant (bouton, menu)
 * fait partie des roles de gestion de la categorie de ticket donnee. `interaction.member`
 * est soit un `GuildMember` complet (roles exposes via un `RoleManager.cache`), soit un
 * objet API brut non-cache (roles directement en `string[]`) — les deux formes sont geres
 * ici pour eviter un appel reseau supplementaire (`guild.members.fetch`) a chaque clic.
 */
async function isStaffInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  categoryId: string
): Promise<boolean> {
  if (!interaction.guildId || !interaction.member) return false;
  const config = await getGuildConfig(interaction.guildId);
  const roles = interaction.member.roles;
  const roleIds = Array.isArray(roles) ? roles : [...roles.cache.keys()];
  return isTicketManager(config, categoryId, roleIds);
}

/**
 * Message affiche quand `isStaffInteraction` refuse un clic. Explicite la cause (droits
 * insuffisants, pas juste "ca ne marche pas") et l'action corrective, pour ne pas laisser
 * un admin de test se demander pourquoi ses propres boutons ne repondent pas.
 */
const NOT_STAFF_MESSAGE =
  "Tu n'as pas les droits suffisants pour cette action : elle est réservée aux gestionnaires de cette catégorie. " +
  "Demande à un administrateur de t'ajouter via le panneau (bouton Tickets → Ajouter un rôle de gestion).";

/**
 * Verifie la permission Discord native "Gerer le serveur" (ManageGuild), comme le fait deja
 * `/config`. Contrairement aux autres boutons du panneau (qui ne s'appuient que sur la
 * visibilite du salon panneau cote permissions Discord), les actions les plus sensibles du
 * panneau "Monitoring" (jobId, role "en service", salons surveilles, webhooks sortants —
 * ces derniers determinent qui reçoit en direct les donnees de l'entreprise) ont ce filet de
 * securite supplementaire : une mauvaise configuration des permissions du salon panneau ne
 * suffit alors plus a elle seule a exposer ces reglages a n'importe qui.
 */
function isGuildManager(interaction: ButtonInteraction): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

const NOT_GUILD_MANAGER_MESSAGE = "Tu n'as pas les droits suffisants pour cette action : elle est réservée aux membres avec la permission \"Gérer le serveur\".";

/** Route une commande slash vers son `Command.execute`, avec gestion d'erreur generique commune a toutes les commandes. */
async function handleChatInputCommand(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  const command = commandsByName.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    logger.error(`Erreur lors de l'execution de /${interaction.commandName}`, error);
    const payload = { content: "Une erreur est survenue lors de l'exécution de la commande.", ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  }
}

/**
 * Clic sur le bouton "Remplir le formulaire" d'un ticket de recrutement : ouvre un modal
 * avec les questions configurees par le staff (panneau "Recrutement"), ou les 5 questions
 * par defaut si aucune n'est configuree — voir `getEffectiveQuestions`.
 */
async function handleRecruitmentStartForm(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId || !interaction.channelId) return;

  const ticket = await getTicketByChannel(interaction.channelId);
  if (ticket) {
    const application = await getApplicationSummary(ticket.id);
    if (application?.submittedAt) {
      await interaction.reply({ content: "Vous avez déjà soumis votre candidature.", ephemeral: true });
      return;
    }
  }

  const questions = await getEffectiveQuestions(interaction.guildId);
  const modal = new ModalBuilder().setCustomId("recruitment:submit-form").setTitle("Formulaire de candidature");
  const rows = questions.map((question, index) => {
    const input = new TextInputBuilder()
      .setCustomId(`q${index}`)
      .setLabel(question.label)
      .setStyle(question.style === "PARAGRAPH" ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(true);
    return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
  });
  modal.addComponents(...rows);

  await interaction.showModal(modal);
}

/**
 * Soumission du formulaire de candidature : enregistre les reponses, puis poste le recap
 * (texte seul, sans piece jointe pour l'instant) avec les boutons "Statut"/"S'assigner" dans
 * le salon de suivi dedie a la guilde si configure, sinon dans le salon du ticket lui-meme. Le
 * candidat recoit une confirmation avec un bouton "J'ai terminé d'envoyer mes fichiers" : les
 * modals Discord ne supportant pas l'upload de fichier, il peut envoyer d'eventuelles pieces
 * jointes directement en message dans le salon puis cliquer ce bouton une fois termine (voir
 * `handleRecruitmentFinishAttachments`) — c'est ce clic, et lui seul, qui charge les fichiers
 * sur la candidature, en une seule fois.
 *
 * Relit les questions "effectives" au moment de la soumission (pas de correlation stockee
 * avec celles affichees a l'ouverture du modal) : dans le cas rare ou le staff modifie le
 * formulaire pendant qu'un candidat le remplit, les libelles enregistres peuvent differer de
 * ceux vus par le candidat — compromis accepte, coherent avec le reste du code (pas d'etat de
 * session par interaction).
 *
 * Rejette toute resoumission (`submittedAt` deja renseigne) : sans ce garde-fou, un double-clic
 * sur "Remplir le formulaire" (jamais desactive apres usage) dupliquerait les reponses dans le
 * recap et ecraserait `logChannelId`/`logMessageId` avec un nouveau message, laissant l'ancien
 * orphelin (plus jamais mis a jour par les changements de statut/assignation suivants).
 */
async function handleRecruitmentSubmitForm(interaction: Interaction): Promise<void> {
  if (!interaction.isModalSubmit() || !interaction.channelId || !interaction.guildId) return;

  const ticket = await getTicketByChannel(interaction.channelId);
  if (!ticket || ticket.type !== "RECRUITMENT") {
    await interaction.reply({ content: "Ce salon n'est pas rattaché à une candidature.", ephemeral: true });
    return;
  }

  const existing = await getApplicationSummary(ticket.id);
  if (existing?.submittedAt) {
    await interaction.reply({ content: "Vous avez déjà soumis votre candidature.", ephemeral: true });
    return;
  }

  const questions = await getEffectiveQuestions(interaction.guildId);
  const answers = questions.map((question, index) => ({
    question: question.label,
    answer: interaction.fields.getTextInputValue(`q${index}`),
  }));

  const application = await saveAnswers(ticket.id, answers);

  const logChannel = await resolveRecruitmentLogChannel(interaction.client, interaction.guildId, ticket.channelId);
  if (logChannel) {
    const embeds = buildRecruitmentEmbed(ticket, application);
    const message = await logChannel.send({
      embeds,
      components: [buildRecruitmentActionRow(ticket.id)],
    });
    await saveLogMessageRef(ticket.id, logChannel.id, message.id);
  }

  const finishButton = new ButtonBuilder()
    .setCustomId(`recruitment:finish-attachments:${ticket.id}`)
    .setLabel("J'ai terminé d'envoyer mes fichiers")
    .setStyle(ButtonStyle.Primary);
  await interaction.reply({
    content:
      "Formulaire envoyé, merci ! Notre équipe va examiner votre candidature. " +
      "Vous pouvez envoyer des photos directement dans ce salon si besoin, puis cliquer sur le bouton ci-dessous une fois terminé.",
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(finishButton)],
  });
}

/** Nombre max de messages parcourus par `fetchMessagesSince` — garde-fou, aucun ticket normal n'en approche. */
const MAX_HISTORY_SCAN_MESSAGES = 500;

/**
 * Recupere tous les messages d'un salon poste apres `sinceTimestamp` (epoch ms), en paginant
 * en arriere par lots de 100 plutot qu'une seule page limitee — voir `handleRecruitmentFinishAttachments`,
 * ou une limite fixe de 50 pouvait faire disparaitre silencieusement des pieces jointes du
 * candidat si le salon avait ete actif entre-temps (staff, autres bots...).
 */
async function fetchMessagesSince(channel: TextBasedChannel, sinceTimestamp: number): Promise<Message[]> {
  const collected: Message[] = [];
  let before: string | undefined;

  while (collected.length < MAX_HISTORY_SCAN_MESSAGES) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;

    const batchMessages = [...batch.values()];
    collected.push(...batchMessages);

    const oldest = batchMessages[batchMessages.length - 1];
    if (oldest.createdTimestamp <= sinceTimestamp) break;
    before = oldest.id;
  }

  return collected.filter((m) => m.createdTimestamp >= sinceTimestamp);
}

/**
 * Clic sur "J'ai terminé d'envoyer mes fichiers" : recupere tous les fichiers envoyes par le
 * candidat dans le salon depuis la soumission du formulaire, les telecharge/stocke en une
 * seule fois (voir `finalizeRecruitmentAttachments`), et affiche le resultat au candidat.
 * Reserve au candidat lui-meme (`ticket.openerId`) — un clic par quelqu'un d'autre est ignore
 * silencieusement plutot que de traiter les fichiers d'une autre personne.
 *
 * `deferReply` : parcourir l'historique du salon + telecharger plusieurs fichiers peut
 * facilement depasser le delai de 3s avant lequel Discord attend une premiere reponse.
 */
async function handleRecruitmentFinishAttachments(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isButton() || !interaction.channelId) return;

  const ticket = await getTicketById(ticketId);
  if (!ticket || ticket.type !== "RECRUITMENT") return;
  if (ticket.openerId && interaction.user.id !== ticket.openerId) {
    await interaction.reply({ content: "Seul le candidat peut valider ses propres fichiers.", ephemeral: true });
    return;
  }

  const application = await getApplicationSummary(ticketId);
  if (application && application.attachments.length > 0) {
    await interaction.reply({ content: "Vos fichiers ont déjà été enregistrés.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const channel = await interaction.client.channels.fetch(interaction.channelId);
  if (!channel?.isTextBased() || channel.isDMBased()) {
    await interaction.editReply({ content: "Salon introuvable, réessaie plus tard." });
    return;
  }

  // Pagine en arriere jusqu'a la soumission du formulaire plutot qu'une simple limite de 50
  // messages : un salon avec beaucoup d'echanges (staff, autres bots...) entre la soumission
  // et le clic sur ce bouton pouvait faire sortir les pieces jointes du candidat de la fenetre,
  // les faisant disparaitre silencieusement. `maxMessages` reste un garde-fou raisonnable
  // (aucun ticket normal n'a besoin de plus).
  const sinceTimestamp = application?.submittedAt?.getTime() ?? 0;
  const candidateMessages = (await fetchMessagesSince(channel, sinceTimestamp)).filter(
    (m) => m.author.id === interaction.user.id && m.attachments.size > 0
  );

  const allAttachments = candidateMessages.flatMap((m) => [...m.attachments.values()]);

  const accepted: { data: Buffer; filename: string; contentType?: string | null }[] = [];
  const rejected: string[] = [];
  for (const attachment of allAttachments) {
    const name = attachment.name ?? "fichier";
    if (accepted.length >= MAX_RECRUITMENT_ATTACHMENTS) {
      rejected.push(`${name} (limite de ${MAX_RECRUITMENT_ATTACHMENTS} fichiers par candidature atteinte)`);
      continue;
    }
    if (!isImageAttachment(attachment)) {
      rejected.push(`${name} (seules les images sont acceptées : png, jpg, webp — pas de gif)`);
      continue;
    }
    if (attachment.size > MAX_UPLOAD_SIZE_BYTES) {
      rejected.push(`${name} (${IMAGE_TOO_LARGE_SHORT})`);
      continue;
    }
    try {
      const data = await downloadImageBytes(attachment.url);
      accepted.push({ data, filename: name, contentType: attachment.contentType });
    } catch (error) {
      if (error instanceof ImageTooLargeError) {
        rejected.push(`${name} (${IMAGE_TOO_LARGE_SHORT})`);
        continue;
      }
      logger.warn(`Echec de telechargement de la piece jointe ${name} pour le ticket ${ticketId}`, error);
      rejected.push(`${name} (échec du téléchargement, réessaie)`);
    }
  }

  if (accepted.length > 0) await finalizeRecruitmentAttachments(interaction.client, ticketId, accepted);

  const parts: string[] = [];
  parts.push(accepted.length > 0 ? `${accepted.length} fichier(s) enregistré(s).` : "Aucun fichier trouvé dans ce salon.");
  if (rejected.length > 0) parts.push(`Non retenu(s) : ${rejected.join(", ")}.`);
  await interaction.editReply({ content: parts.join(" ") });
}

/**
 * Clic sur "S'assigner" (message de suivi d'une candidature) : assigne l'utilisateur ayant
 * clique comme recruteur (reassignation possible si quelqu'un d'autre etait deja assigne),
 * puis met a jour le message de suivi. Reserve aux gestionnaires de la categorie du ticket.
 */
async function handleRecruitmentAssign(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isButton()) return;

  const ticket = await getTicketById(ticketId);
  if (!ticket) {
    await interaction.reply({ content: "Candidature introuvable.", ephemeral: true });
    return;
  }
  if (!(await isStaffInteraction(interaction, ticket.categoryId))) {
    await interaction.reply({ content: NOT_STAFF_MESSAGE, ephemeral: true });
    return;
  }

  await assignRecruiter(ticketId, interaction.user.id);
  await refreshRecruitmentLogMessage(interaction.client, ticketId);
  await interaction.reply({ content: "Vous êtes assigné à cette candidature.", ephemeral: true });
}

/**
 * Clic sur "Statut" (message de suivi d'une candidature) : affiche, en ephemere (visible
 * seulement par le staff qui a clique), un menu deroulant des 4 etapes du pipeline. Reserve
 * aux gestionnaires de la categorie du ticket.
 */
async function handleRecruitmentStatusButton(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isButton()) return;

  const ticket = await getTicketById(ticketId);
  if (!ticket) {
    await interaction.reply({ content: "Candidature introuvable.", ephemeral: true });
    return;
  }
  if (!(await isStaffInteraction(interaction, ticket.categoryId))) {
    await interaction.reply({ content: NOT_STAFF_MESSAGE, ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`recruitment:set-status:${ticketId}`)
    .setPlaceholder("Choisir une étape")
    .addOptions(RECRUITMENT_STATUS_CHOICES.map((c) => ({ label: c.name, value: c.value })));

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

/**
 * Selection d'une etape dans le menu deroulant "Statut" : met a jour la candidature et le
 * message de suivi, puis remplace le menu ephemere par une confirmation textuelle (`update`
 * plutot que `reply`, pour editer ce meme message ephemere au lieu d'en empiler un nouveau).
 * Un passage a REFUSÉ clôture aussi le ticket (voir `closeTicketIfRejected`).
 */
async function handleRecruitmentSetStatus(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isStringSelectMenu()) return;

  const ticket = await getTicketById(ticketId);
  if (!ticket) {
    await interaction.reply({ content: "Candidature introuvable.", ephemeral: true });
    return;
  }
  if (!(await isStaffInteraction(interaction, ticket.categoryId))) {
    await interaction.reply({ content: NOT_STAFF_MESSAGE, ephemeral: true });
    return;
  }

  const status = interaction.values[0] as (typeof RECRUITMENT_STATUS_CHOICES)[number]["value"];
  await setApplicationStatus(ticketId, status);
  await refreshRecruitmentLogMessage(interaction.client, ticketId);

  if (status === "ACCEPTED") {
    await applyRecruitmentAcceptance(interaction.client, ticketId);
  }

  if (status === "REJECTED") {
    await closeTicketIfRejected(interaction, ticketId);
  }

  await interaction.update({ content: `Statut mis à jour : **${recruitmentStatusLabel(status)}**`, components: [] });
}

/**
 * Marque le ticket comme clôturé côté suivi (statut CLOSED, arrête l'escalade et les stats
 * "ouverts") quand une candidature passe à REFUSÉ, et invite le staff à fermer le salon
 * cote Ticket Tool. Fermeture reellement automatisee testee et abandonnee : ni `channel.send`
 * (le bot) ni un message via webhook de salon ne declenchent le `$close` de Ticket Tool —
 * confirme empiriquement que Ticket Tool ignore tout message qui n'est pas poste par un vrai
 * utilisateur humain (bot ou webhook, meme resultat). Cliquer le bouton "Close" de Ticket
 * Tool a la place d'un humain n'est de toute facon pas possible (Discord ne permet pas a un
 * bot de simuler l'interaction d'un autre bot) — donc pas d'alternative automatisee restante,
 * et le bouton natif de Ticket Tool doit rester intact (voir le filtre sur les messages a
 * composants dans `messageCreate.ts`, pour ne pas le supprimer par erreur). No-op si le
 * ticket est deja ferme (evite un message en double si le statut est change plusieurs fois).
 */
async function closeTicketIfRejected(interaction: ButtonInteraction | StringSelectMenuInteraction, ticketId: string): Promise<void> {
  const ticket = await getTicketById(ticketId);
  if (!ticket || ticket.status !== "OPEN") return;

  await markTicketClosed(ticket.channelId, ticket.guildId);

  try {
    const channel = await interaction.client.channels.fetch(ticket.channelId);
    if (channel?.isTextBased() && !channel.isDMBased()) {
      await channel.send(
        "Cette candidature a été refusée : le ticket est marqué comme clôturé côté suivi. " +
          "Le staff peut maintenant fermer ce salon via le bouton \"Close\" de Ticket Tool."
      );
    }
  } catch (error) {
    logger.error(`Echec notification de cloture pour le ticket ${ticketId}`, error);
  }
}

/**
 * Selection d'un article dans le menu deroulant du catalogue : affiche un embed de
 * confirmation (nom, description complete, prix, photo) avant d'ouvrir le formulaire —
 * Discord n'autorise qu'une seule reponse par interaction (soit un modal, soit un
 * message/embed, jamais les deux), c'est donc la seule facon de montrer la photo de l'article
 * avant que le client ne s'engage, le modal lui-meme ne pouvant afficher aucun contenu riche.
 */
async function handleOrderSelectItem(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu()) return;

  const catalogItemId = interaction.values[0];
  const item = await getItem(interaction.guildId!, catalogItemId);
  if (!item) {
    await interaction.reply({ content: "Cet article n'existe plus.", ephemeral: true });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(item.name)
    .setColor(0x5865f2)
    .addFields({ name: "Prix", value: `${item.price.toLocaleString("fr-FR")} $`, inline: true });
  if (item.description) embed.setDescription(item.description);

  const files = [];
  const image = await resolveImageDisplay({ url: item.imageUrl, filename: item.imageFilename }, `catalog-items/${item.id}`);
  if (image) {
    embed.setImage(image.url);
    if (image.attachment) files.push(image.attachment);
  }

  const confirmButton = new ButtonBuilder().setCustomId(`order:confirm-item:${item.id}`).setLabel("Continuer").setStyle(ButtonStyle.Success);
  await interaction.reply({
    embeds: [embed],
    files,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton)],
    ephemeral: true,
  });
}

/**
 * Clic sur "Continuer" (embed de confirmation) : construit et affiche le modal dynamique a
 * partir des champs personnalises configures pour cet article par le staff
 * (`CatalogItemField`). Si l'article n'a aucun champ personnalise, affiche un unique champ de
 * confirmation optionnel plutot qu'un modal vide (Discord exige au moins un composant).
 */
async function handleOrderConfirmItem(interaction: Interaction, catalogItemId: string): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId) return;

  const item = await getItem(interaction.guildId, catalogItemId);
  if (!item) {
    await interaction.reply({ content: "Cet article n'existe plus.", ephemeral: true });
    return;
  }

  const modal = new ModalBuilder().setCustomId(`order:submit-item:${item.id}`).setTitle(item.name.slice(0, 45));

  if (item.fields.length === 0) {
    const input = new TextInputBuilder()
      .setCustomId("confirm")
      .setLabel("Confirmer la commande de cet article")
      .setStyle(TextInputStyle.Short)
      .setValue("oui")
      .setRequired(false);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  } else {
    for (const field of item.fields) {
      const input = new TextInputBuilder()
        .setCustomId(field.id)
        .setLabel(field.label.slice(0, 45))
        .setStyle(field.style === "PARAGRAPH" ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(field.required);
      // Pas de type de champ "nombre" natif dans les modals Discord : on guide via placeholder,
      // la valeur est parsee et validee cote serveur (voir orderService.addItemFromAnswers).
      if (field.style === "QUANTITY") input.setPlaceholder("Nombre (ex: 1)");
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    }
  }

  await interaction.showModal(modal);
}

/**
 * Soumission du modal d'un article : ajoute la ligne a la commande en cours (creee si besoin),
 * puis cree ou edite en place l'unique message de commande du ticket (voir
 * `orderLogService.upsertOrderMessage`) — plus de spam d'un nouveau message a chaque article.
 *
 * @param catalogItemId - extrait du customId du modal par l'appelant (`onInteractionCreate`)
 */
async function handleOrderSubmitItem(interaction: Interaction, catalogItemId: string): Promise<void> {
  if (!interaction.isModalSubmit() || !interaction.channelId) return;

  const ticket = await getTicketByChannel(interaction.channelId);
  if (!ticket || ticket.type !== "SERVICE") {
    await interaction.reply({ content: "Ce salon n'est pas rattaché à une commande.", ephemeral: true });
    return;
  }

  const item = await getItem(interaction.guildId!, catalogItemId);
  if (!item) {
    await interaction.reply({ content: "Cet article n'existe plus.", ephemeral: true });
    return;
  }

  const order = await getOrCreateOrder(ticket.id);
  const answers = item.fields.map((field) => ({
    field,
    value: interaction.fields.getTextInputValue(field.id),
  }));
  await addItemFromAnswers(order.id, item, answers);
  await upsertOrderMessage(interaction.client, ticket.id);

  await interaction.reply({ content: "Article ajouté à la commande.", ephemeral: true });
}

/**
 * Clic sur "Ajouter un article" : re-affiche le menu deroulant du catalogue, en reponse
 * ephemere (visible seulement par celui qui clique) pour ne pas encombrer le salon d'un
 * nouveau menu a chaque fois. Utilise a la fois par le client (avant validation) et par le
 * staff (correction apres validation, meme bouton reutilise sur le message de suivi).
 */
async function handleOrderAddMore(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const items = await listActive(interaction.guildId!);
  if (items.length === 0) {
    await interaction.reply({ content: "Le catalogue est vide.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("order:select-item")
    .setPlaceholder("Choisir un article")
    .addOptions(buildCatalogSelectOptions(items));

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

/**
 * Clic sur "Valider la commande" : etape finale du flux self-service cote client. Bascule
 * le message de commande vers son style "suivi" (boutons staff) et ping les roles de gestion
 * de la categorie du ticket separement (un `content` modifie par edition ne notifie personne
 * sur Discord, contrairement a un nouveau message). Refuse si la commande est vide.
 */
async function handleOrderConfirm(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const ticket = await getTicketByChannel(interaction.channelId);
  if (!ticket || ticket.type !== "SERVICE") {
    await interaction.reply({ content: "Ce salon n'est pas rattaché à une commande.", ephemeral: true });
    return;
  }

  const order = await getOrderByTicket(ticket.id);
  if (!order || order.items.length === 0) {
    await interaction.reply({ content: "La commande est vide, ajoutez au moins un article.", ephemeral: true });
    return;
  }

  await markConfirmed(order.id);
  await upsertOrderMessage(interaction.client, ticket.id);
  await dispatchOrderUpdated(ticket.guildId, ticket, { ...order, confirmed: true });

  const config = await getGuildConfig(ticket.guildId);
  const category = config?.ticketCategories.find((c) => c.categoryId === ticket.categoryId);
  const mentions = (category?.managerRoleIds ?? []).map((roleId) => `<@&${roleId}>`).join(" ");
  if (interaction.channel?.isTextBased() && !interaction.channel.isDMBased()) {
    await interaction.channel.send(mentions ? `${mentions} Nouvelle commande à traiter.` : "Nouvelle commande à traiter.");
  }
  await interaction.reply({ content: "Commande validée, le staff a été notifié.", ephemeral: true });
}

/**
 * Clic sur "Statut" (message de suivi d'une commande) : affiche, en ephemere, un menu
 * deroulant des 4 statuts logistiques. Reserve aux gestionnaires de la categorie du ticket.
 */
async function handleOrderStatusButton(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isButton()) return;

  const ticket = await getTicketById(ticketId);
  if (!ticket) {
    await interaction.reply({ content: "Commande introuvable.", ephemeral: true });
    return;
  }
  if (!(await isStaffInteraction(interaction, ticket.categoryId))) {
    await interaction.reply({ content: NOT_STAFF_MESSAGE, ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`order:set-status:${ticketId}`)
    .setPlaceholder("Choisir un statut")
    .addOptions(ORDER_STATUS_CHOICES.map((c) => ({ label: c.name, value: c.value })));

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

/** Selection d'un statut dans le menu deroulant "Statut" d'une commande. Reserve aux gestionnaires de la categorie du ticket. */
async function handleOrderSetStatus(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isStringSelectMenu()) return;

  const ticket = await getTicketById(ticketId);
  if (!ticket) {
    await interaction.reply({ content: "Commande introuvable.", ephemeral: true });
    return;
  }
  if (!(await isStaffInteraction(interaction, ticket.categoryId))) {
    await interaction.reply({ content: NOT_STAFF_MESSAGE, ephemeral: true });
    return;
  }

  const order = await getOrderByTicket(ticketId);
  if (!order) {
    await interaction.reply({ content: "Commande introuvable.", ephemeral: true });
    return;
  }

  const status = interaction.values[0] as (typeof ORDER_STATUS_CHOICES)[number]["value"];
  await setOrderStatus(order.id, status);
  await upsertOrderMessage(interaction.client, ticketId);

  await interaction.update({ content: `Statut mis à jour : **${orderStatusLabel(status)}**`, components: [] });
}

/**
 * Clic sur "Marquer payée" (message de suivi d'une commande) : bascule le paiement a PAID
 * et genere/poste automatiquement la facture. Reserve aux gestionnaires de la categorie du
 * ticket. `deferReply` : le rendu de l'image (canvas) + son upload peuvent depasser le delai
 * de 3s avant lequel Discord attend une premiere reponse a l'interaction.
 */
async function handleOrderMarkPaid(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isButton()) return;

  const ticket = await getTicketById(ticketId);
  if (!ticket) {
    await interaction.reply({ content: "Commande introuvable.", ephemeral: true });
    return;
  }
  if (!(await isStaffInteraction(interaction, ticket.categoryId))) {
    await interaction.reply({ content: NOT_STAFF_MESSAGE, ephemeral: true });
    return;
  }

  const order = await getOrderByTicket(ticketId);
  if (!order || order.items.length === 0) {
    await interaction.reply({ content: "Commande introuvable ou vide.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  await setPaymentStatus(order.id, "PAID");
  await upsertOrderMessage(interaction.client, ticketId);

  const updated = await getOrderByTicket(ticketId);
  if (updated) await sendInvoiceForOrder(interaction.client, ticket.guildId, ticket, updated);

  await interaction.editReply("Commande marquée payée, facture générée.");
}

/**
 * Clic sur "Facture" (message de suivi d'une commande) : regenere/renvoie l'image de
 * facture sans changer le statut de paiement. Reserve aux gestionnaires de la categorie du ticket.
 */
async function handleOrderInvoiceButton(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isButton()) return;

  const ticket = await getTicketById(ticketId);
  if (!ticket) {
    await interaction.reply({ content: "Commande introuvable.", ephemeral: true });
    return;
  }
  if (!(await isStaffInteraction(interaction, ticket.categoryId))) {
    await interaction.reply({ content: NOT_STAFF_MESSAGE, ephemeral: true });
    return;
  }

  const order = await getOrderByTicket(ticketId);
  if (!order || order.items.length === 0) {
    await interaction.reply({ content: "Commande introuvable ou vide.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  await sendInvoiceForOrder(interaction.client, ticket.guildId, ticket, order);
  await interaction.editReply("Facture renvoyée.");
}

/** Clic sur "Livraison" : modal avec le montant courant pre-rempli. Reserve aux gestionnaires de la categorie du ticket. */
async function handleOrderSetDeliveryButton(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isButton()) return;

  const ticket = await getTicketById(ticketId);
  if (!ticket) {
    await interaction.reply({ content: "Commande introuvable.", ephemeral: true });
    return;
  }
  if (!(await isStaffInteraction(interaction, ticket.categoryId))) {
    await interaction.reply({ content: NOT_STAFF_MESSAGE, ephemeral: true });
    return;
  }

  const order = await getOrderByTicket(ticketId);
  const modal = new ModalBuilder().setCustomId(`order:set-delivery-modal:${ticketId}`).setTitle("Frais de livraison");
  const amountInput = new TextInputBuilder().setCustomId("amount").setLabel("Montant").setStyle(TextInputStyle.Short).setRequired(true);
  amountInput.setValue(String(order?.deliveryFee ?? 0));
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput));
  await interaction.showModal(modal);
}

async function handleOrderSetDeliveryModal(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isModalSubmit()) return;

  const amount = Number(interaction.fields.getTextInputValue("amount"));
  if (!Number.isInteger(amount) || amount < 0) {
    await interaction.reply({ content: "Montant invalide : entre un nombre entier positif.", ephemeral: true });
    return;
  }

  const order = await getOrderByTicket(ticketId);
  if (!order) {
    await interaction.reply({ content: "Commande introuvable.", ephemeral: true });
    return;
  }

  await setDeliveryFee(order.id, amount);
  await upsertOrderMessage(interaction.client, ticketId);
  await interaction.reply({ content: `Livraison définie sur ${amount.toLocaleString("fr-FR")} $.`, ephemeral: true });
}

/** Clic sur "Réduction" : modal avec le montant courant pre-rempli. Reserve aux gestionnaires de la categorie du ticket. */
async function handleOrderSetDiscountButton(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isButton()) return;

  const ticket = await getTicketById(ticketId);
  if (!ticket) {
    await interaction.reply({ content: "Commande introuvable.", ephemeral: true });
    return;
  }
  if (!(await isStaffInteraction(interaction, ticket.categoryId))) {
    await interaction.reply({ content: NOT_STAFF_MESSAGE, ephemeral: true });
    return;
  }

  const order = await getOrderByTicket(ticketId);
  const modal = new ModalBuilder().setCustomId(`order:set-discount-modal:${ticketId}`).setTitle("Réduction");
  const percentInput = new TextInputBuilder().setCustomId("percent").setLabel("Pourcentage (0-100)").setStyle(TextInputStyle.Short).setRequired(true);
  percentInput.setValue(String(order?.discountPercent ?? 0));
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(percentInput));
  await interaction.showModal(modal);
}

async function handleOrderSetDiscountModal(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isModalSubmit()) return;

  const percent = Number(interaction.fields.getTextInputValue("percent"));
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    await interaction.reply({ content: "Pourcentage invalide : entre un nombre entier entre 0 et 100.", ephemeral: true });
    return;
  }

  const order = await getOrderByTicket(ticketId);
  if (!order) {
    await interaction.reply({ content: "Commande introuvable.", ephemeral: true });
    return;
  }

  await setDiscountPercent(order.id, percent);
  await upsertOrderMessage(interaction.client, ticketId);
  await interaction.reply({ content: `Réduction définie sur ${percent}%.`, ephemeral: true });
}

/**
 * Clic sur "Retirer un article" (message de suivi d'une commande) : affiche, en ephemere,
 * un menu deroulant des lignes actuelles de la commande. Reserve aux gestionnaires de la categorie du ticket.
 */
async function handleOrderRemoveItemButton(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isButton()) return;

  const ticket = await getTicketById(ticketId);
  if (!ticket) {
    await interaction.reply({ content: "Commande introuvable.", ephemeral: true });
    return;
  }
  if (!(await isStaffInteraction(interaction, ticket.categoryId))) {
    await interaction.reply({ content: NOT_STAFF_MESSAGE, ephemeral: true });
    return;
  }

  const order = await getOrderByTicket(ticketId);
  if (!order || order.items.length === 0) {
    await interaction.reply({ content: "Aucun article dans cette commande.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`order:remove-item-select:${ticketId}`)
    .setPlaceholder("Choisir l'article a retirer")
    .addOptions(
      order.items.slice(0, 25).map((item) => ({
        label: `${item.name} x${item.quantity}`.slice(0, 100),
        description: `${(item.unitPrice * item.quantity).toLocaleString("fr-FR")} $`,
        value: item.id,
      }))
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

/** Selection d'un article a retirer dans le menu deroulant "Retirer un article". Reserve aux gestionnaires de la categorie du ticket. */
async function handleOrderRemoveItemSelect(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isStringSelectMenu()) return;

  const ticket = await getTicketById(ticketId);
  if (!ticket) {
    await interaction.reply({ content: "Commande introuvable.", ephemeral: true });
    return;
  }
  if (!(await isStaffInteraction(interaction, ticket.categoryId))) {
    await interaction.reply({ content: NOT_STAFF_MESSAGE, ephemeral: true });
    return;
  }

  await removeOrderItem(interaction.values[0]);
  await upsertOrderMessage(interaction.client, ticketId);

  await interaction.update({ content: "Article retiré de la commande.", components: [] });
}

/**
 * Clic sur un bouton du message racine du panneau ("Tickets"/"Absences"/"Monitoring") : active
 * la fonctionnalite et cree/rafraichit son message dedie dans le meme salon.
 */
async function handlePanelRootButton(interaction: Interaction, key: "TICKETS" | "ABSENCES" | "MONITORING"): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId || !interaction.channelId) return;

  await setPanelEnabled(interaction.guildId, key, true);

  if (key === "TICKETS") {
    await refreshTicketsPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  } else if (key === "ABSENCES") {
    await refreshAbsencesPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  } else {
    await refreshMonitoringPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  }

  await interaction.reply({ content: "Fonctionnalité activée, voir le message ci-dessus.", ephemeral: true });
}

/**
 * Clic sur "Service client"/"Recrutement" dans le message dedie "Tickets" : ouvre le message
 * dedie imbrique correspondant.
 */
async function handlePanelTicketsNested(interaction: Interaction, key: "SERVICE" | "RECRUITMENT"): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId || !interaction.channelId) return;

  await setPanelEnabled(interaction.guildId, key, true);

  if (key === "SERVICE") {
    await refreshServicePanelMessage(interaction.client, interaction.guildId, interaction.channelId);
    await interaction.reply({ content: "Service client activé, voir le message ci-dessus.", ephemeral: true });
    return;
  }

  await refreshRecruitmentPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.reply({ content: "Recrutement activé, voir le message ci-dessus.", ephemeral: true });
}

/**
 * Clic sur "Définir les rôles de gestion" : d'abord choisir le type concerne (au plus 2 —
 * Recrutement/Service — puisqu'un seul mapping existe par type). La valeur transmise reste
 * la `categoryId` (cle technique du `TicketCategoryConfig`), seul le libelle affiche change.
 */
async function handlePanelTicketsSetRoles(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId) return;

  const config = await getGuildConfig(interaction.guildId);
  const categories = config?.ticketCategories ?? [];
  if (categories.length === 0) {
    await interaction.reply({ content: "Aucune catégorie configurée, configurez Recrutement ou Service client d'abord.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("panel:tickets:set-roles-category")
    .setPlaceholder("Choisir un type")
    .addOptions(
      categories.map((c) => ({
        label: TICKET_TYPE_LABELS[c.type],
        value: c.categoryId,
      }))
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

/**
 * Categorie choisie : menu natif Discord (RoleSelectMenu) en selection multiple, pre-rempli
 * avec les roles deja assignes (`setDefaultRoles`) — valider remplace l'ensemble complet des
 * roles de gestion de cette categorie (0 role = tout retirer en un seul geste).
 */
async function handlePanelTicketsSetRolesCategory(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu() || !interaction.guildId) return;

  const categoryId = interaction.values[0];
  const config = await getGuildConfig(interaction.guildId);
  const currentRoleIds = config?.ticketCategories.find((c) => c.categoryId === categoryId)?.managerRoleIds ?? [];

  const select = new RoleSelectMenuBuilder()
    .setCustomId(`panel:tickets:set-roles-select:${categoryId}`)
    .setPlaceholder("Choisir un ou plusieurs rôles")
    .setMinValues(0)
    .setMaxValues(25);
  if (currentRoleIds.length > 0) select.setDefaultRoles(currentRoleIds);

  const row = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select);
  await interaction.update({ content: "Quels rôles doivent gérer cette catégorie ?", components: [row] });
}

async function handlePanelTicketsSetRolesSelect(interaction: Interaction, categoryId: string): Promise<void> {
  if (!interaction.isRoleSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  const roleIds = interaction.values;
  await setCategoryManagerRoles(interaction.guildId, categoryId, roleIds);
  await refreshTicketsPanelMessage(interaction.client, interaction.guildId, interaction.channelId);

  await interaction.update({
    content: roleIds.length ? `Rôles de gestion définis : ${roleIds.map((r) => `<@&${r}>`).join(" ")}` : "Rôles de gestion retirés.",
    components: [],
  });
}

/**
 * Soumission du formulaire de declaration : valide les dates (format + coherence), cree la
 * demande, la poste dans le salon de suivi (ping du role approbateur) et confirme au demandeur.
 */
async function handleAbsenceSubmitForm(interaction: Interaction): Promise<void> {
  if (!interaction.isModalSubmit() || !interaction.guildId) return;

  const startRaw = interaction.fields.getTextInputValue("startDate");
  const endRaw = interaction.fields.getTextInputValue("endDate");
  const reason = interaction.fields.getTextInputValue("reason");

  const startDate = parseFrenchDate(startRaw);
  const endDate = parseFrenchDate(endRaw);
  if (!startDate || !endDate) {
    await interaction.reply({ content: "Format de date invalide, attendu JJ/MM/AAAA.", ephemeral: true });
    return;
  }
  if (endDate < startDate) {
    await interaction.reply({ content: "La date de fin ne peut pas être avant la date de début.", ephemeral: true });
    return;
  }

  const request = await createAbsenceRequest(interaction.guildId, interaction.user.id, startDate, endDate, reason);
  const posted = await postAbsenceRequest(interaction.client, interaction.guildId, request);

  await interaction.reply({
    content: posted
      ? `Demande d'absence envoyée (${formatFrenchDate(startDate)} → ${formatFrenchDate(endDate)}), en attente de validation.`
      : "Demande enregistrée, mais le salon de suivi n'est pas configuré ou plus accessible — préviens un administrateur.",
    ephemeral: true,
  });
}

/**
 * Clic sur "Définir les rôles approbateurs" : menu natif Discord (RoleSelectMenu) en
 * selection multiple, pre-rempli avec les roles deja configures — valider remplace
 * l'ensemble complet (0 role = tout retirer en un seul geste).
 */
async function handlePanelAbsencesSetApproverRoles(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId) return;

  const config = await getGuildConfig(interaction.guildId);
  const currentRoleIds = config?.absenceApproverRoleIds ?? [];

  const select = new RoleSelectMenuBuilder()
    .setCustomId("panel:absences:set-approver-roles-select")
    .setPlaceholder("Choisir un ou plusieurs rôles")
    .setMinValues(0)
    .setMaxValues(25);
  if (currentRoleIds.length > 0) select.setDefaultRoles(currentRoleIds);

  const row = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handlePanelAbsencesSetApproverRolesSelect(interaction: Interaction): Promise<void> {
  if (!interaction.isRoleSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  const roleIds = interaction.values;
  await setAbsenceApproverRoles(interaction.guildId, roleIds);
  await refreshAbsencesPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({
    content: roleIds.length ? `Rôles approbateurs définis : ${roleIds.map((r) => `<@&${r}>`).join(" ")}` : "Rôles approbateurs retirés.",
    components: [],
  });
}

/** Clic sur "Définir le salon de suivi" : menu natif Discord filtre aux salons textuels. */
async function handlePanelAbsencesSetReviewChannel(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const select = new ChannelSelectMenuBuilder()
    .setCustomId("panel:absences:set-review-channel-select")
    .setPlaceholder("Choisir un salon")
    .addChannelTypes(ChannelType.GuildText);
  const row = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handlePanelAbsencesSetReviewChannelSelect(interaction: Interaction): Promise<void> {
  if (!interaction.isChannelSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  const channelId = interaction.values[0];
  await setAbsenceReviewChannel(interaction.guildId, channelId);
  await refreshAbsencesPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({ content: `Salon de suivi défini sur <#${channelId}>.`, components: [] });
}

/** Clic sur "Retirer le salon de suivi" : retire directement, un seul salon possible. */
async function handlePanelAbsencesClearReviewChannel(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId || !interaction.channelId) return;

  await clearAbsenceReviewChannel(interaction.guildId);
  await refreshAbsencesPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.reply({ content: "Salon de suivi retiré.", ephemeral: true });
}


/**
 * Clic sur "Accepter"/"Refuser" du message de suivi d'une demande d'absence : reserve au
 * role approbateur configure (verification directe, pas via `isStaffInteraction` qui est
 * scopee par categorie de ticket — les absences ne sont pas liees a un ticket).
 */
async function handleAbsenceResolve(interaction: Interaction, requestId: string, status: "ACCEPTED" | "REFUSED"): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId || !interaction.member) return;

  const config = await getGuildConfig(interaction.guildId);
  const roles = interaction.member.roles;
  const roleIds = Array.isArray(roles) ? roles : [...roles.cache.keys()];
  if (!isAbsenceApprover(config, roleIds)) {
    await interaction.reply({
      content: "Tu n'as pas les droits suffisants : seul le rôle approbateur configuré peut traiter les demandes d'absence.",
      ephemeral: true,
    });
    return;
  }

  // Pre-verification rapide pour le cas courant (evite un aller-retour d'ecriture inutile) —
  // la vraie garantie contre un double traitement simultane vient de la mise a jour
  // conditionnelle dans `resolveAbsenceRequest` elle-meme (`updateMany` atomique).
  const request = await getAbsenceRequest(requestId);
  if (!request || request.status !== "PENDING") {
    await interaction.reply({ content: "Cette demande a déjà été traitée.", ephemeral: true });
    return;
  }

  const resolved = await resolveAbsenceRequest(requestId, interaction.user.id, status);
  if (!resolved) {
    await interaction.reply({ content: "Cette demande a déjà été traitée.", ephemeral: true });
    return;
  }
  await refreshAbsenceMessage(interaction.client, requestId);
  await interaction.reply({ content: status === "ACCEPTED" ? "Demande acceptée." : "Demande refusée.", ephemeral: true });
}

/** Clic sur "Définir la catégorie" (Service client) : menu natif Discord pour choisir la catégorie. */
async function handlePanelServiceSetCategory(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const select = new ChannelSelectMenuBuilder()
    .setCustomId("panel:service:set-category-select")
    .setPlaceholder("Choisir une catégorie")
    .addChannelTypes(ChannelType.GuildCategory);
  const row = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handleServiceSetCategorySelect(interaction: Interaction): Promise<void> {
  if (!interaction.isChannelSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  const categoryId = interaction.values[0];
  await setCategoryForType(interaction.guildId, "SERVICE", categoryId);
  await refreshServicePanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({ content: `Catégorie définie sur <#${categoryId}>.`, components: [] });
}

/** Clic sur "Retirer la catégorie" (Service client) : retire directement, un seul mapping possible par type. */
async function handlePanelServiceClearCategory(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId || !interaction.channelId) return;

  await clearCategoryForType(interaction.guildId, "SERVICE");
  await refreshServicePanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.reply({ content: "Catégorie retirée.", ephemeral: true });
}

/** Options d'un `StringSelectMenu` listant les articles actifs (tronque a 25 — limite Discord). */
async function buildItemOptions(guildId: string) {
  const items = await listActive(guildId);
  return items.slice(0, 25).map((item) => ({
    label: item.name.slice(0, 100),
    description: `${item.price.toLocaleString("fr-FR")} $`,
    value: item.id,
  }));
}

/** Clic sur "Ajouter un article" : modal (nom, prix, description). La photo se fait ensuite via "Changer la photo". */
async function handlePanelServiceAddItem(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const modal = new ModalBuilder().setCustomId("panel:service:add-item-modal").setTitle("Ajouter un article");
  const nameInput = new TextInputBuilder().setCustomId("name").setLabel("Nom").setStyle(TextInputStyle.Short).setRequired(true);
  const priceInput = new TextInputBuilder().setCustomId("price").setLabel("Prix").setStyle(TextInputStyle.Short).setRequired(true);
  const descriptionInput = new TextInputBuilder()
    .setCustomId("description")
    .setLabel("Description")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(priceInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(descriptionInput)
  );
  await interaction.showModal(modal);
}

async function handleServiceAddItemModal(interaction: Interaction): Promise<void> {
  if (!interaction.isModalSubmit() || !interaction.guildId || !interaction.channelId) return;

  const name = interaction.fields.getTextInputValue("name");
  const priceRaw = interaction.fields.getTextInputValue("price");
  const description = interaction.fields.getTextInputValue("description") || undefined;

  const price = Number(priceRaw);
  if (!Number.isInteger(price) || price < 0) {
    await interaction.reply({ content: "Prix invalide : entre un nombre entier positif.", ephemeral: true });
    return;
  }

  await addItem(interaction.guildId, { name, price, description });
  await refreshServicePanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.reply({
    content: `Article **${name}** créé. Utilise "Changer la photo d'un article" pour lui ajouter une image.`,
    ephemeral: true,
  });
}

/** Clic sur "Retirer un article" : menu natif des articles actifs. */
async function handlePanelServiceRemoveItem(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId) return;

  const options = await buildItemOptions(interaction.guildId);
  if (options.length === 0) {
    await interaction.reply({ content: "Aucun article configuré.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder().setCustomId("panel:service:remove-item-select").setPlaceholder("Choisir un article").addOptions(options);
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handleServiceRemoveItemSelect(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  await removeCatalogItem(interaction.guildId, interaction.values[0]);
  await refreshServicePanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({ content: "Article retiré.", components: [] });
}

/** Clic sur "Changer la photo d'un article" : menu natif des articles actifs. */
async function handlePanelServiceSetImage(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId) return;

  const options = await buildItemOptions(interaction.guildId);
  if (options.length === 0) {
    await interaction.reply({ content: "Aucun article configuré.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder().setCustomId("panel:service:set-image-select").setPlaceholder("Choisir un article").addOptions(options);
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

/**
 * Article choisi : attend un message avec piece jointe dans ce salon (60s) — les modals
 * Discord ne supportent pas l'upload de fichier, c'est donc le seul moyen technique de
 * recuperer une image (meme contournement que les pieces jointes de candidature).
 */
async function handleServiceSetImageSelect(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  const channel = await interaction.client.channels.fetch(interaction.channelId);
  if (!channel?.isTextBased() || channel.isDMBased()) return;

  const itemId = interaction.values[0];
  await interaction.update({ content: "Envoie la photo de l'article en message dans ce salon (60 secondes)...", components: [] });

  const collected = await channel
    .awaitMessages({
      filter: (m) => m.author.id === interaction.user.id && m.attachments.size > 0,
      max: 1,
      time: 60_000,
    })
    .catch(() => null);

  const photoMessage = collected?.first();
  const attachment = photoMessage?.attachments.first();
  if (!photoMessage || !attachment) {
    await interaction.editReply({ content: "Aucune image reçue à temps, réessaie avec le bouton." });
    return;
  }
  if (attachment.size > MAX_UPLOAD_SIZE_BYTES) {
    await interaction.editReply({ content: IMAGE_TOO_LARGE_MESSAGE });
    return;
  }
  if (!isImageAttachment(attachment)) {
    await interaction.editReply({ content: "Seules les images sont acceptées (png, jpg, webp — pas de gif)." });
    return;
  }

  try {
    // On telecharge les octets pour les posseder (stockes sur le CDN ou sur disque local selon
    // l'environnement, voir `setItemImage`) plutot que de garder l'URL CDN Discord de
    // l'attachment : celle-ci cesse de repondre (404) des que son message est supprime, meme
    // avant l'expiration du lien signe. Les possedant, on peut supprimer ce message tout de
    // suite sans rien casser.
    const data = await downloadImageBytes(attachment.url);
    await setItemImage(interaction.guildId, itemId, data, attachment);
    await photoMessage.delete().catch((error: unknown) => logger.warn("Echec suppression du message photo dans le panneau", error));
    await refreshServicePanelMessage(interaction.client, interaction.guildId, interaction.channelId);
    await interaction.editReply({ content: "Photo mise à jour." });
  } catch (error) {
    if (error instanceof ImageTooLargeError) {
      await interaction.editReply({ content: IMAGE_TOO_LARGE_MESSAGE });
      return;
    }
    logger.error("Echec du telechargement de la photo d'article", error);
    await interaction.editReply({ content: "Échec du téléchargement de l'image, réessaie avec le bouton." });
  }
}

/** Clic sur "Définir le poids d'un article" : menu natif des articles actifs. */
async function handlePanelServiceSetWeight(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId) return;

  const options = await buildItemOptions(interaction.guildId);
  if (options.length === 0) {
    await interaction.reply({ content: "Aucun article configuré.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder().setCustomId("panel:service:set-weight-select").setPlaceholder("Choisir un article").addOptions(options);
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

/** Article choisi : modal avec le poids unitaire courant pre-rempli (vide = retirer le poids). */
async function handleServiceSetWeightSelect(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu() || !interaction.guildId) return;

  const itemId = interaction.values[0];
  const item = await getItem(interaction.guildId, itemId);

  const modal = new ModalBuilder().setCustomId(`panel:service:set-weight-modal:${itemId}`).setTitle("Poids de l'article");
  const weightInput = new TextInputBuilder()
    .setCustomId("weightGrams")
    .setLabel("Poids unitaire (grammes, vide = aucun)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);
  if (item?.weightGrams != null) weightInput.setValue(String(item.weightGrams));

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(weightInput));
  await interaction.showModal(modal);
}

async function handleServiceSetWeightModal(interaction: Interaction, itemId: string): Promise<void> {
  if (!interaction.isModalSubmit() || !interaction.guildId || !interaction.channelId) return;

  const raw = interaction.fields.getTextInputValue("weightGrams").trim();
  if (raw === "") {
    await setItemWeight(interaction.guildId, itemId, null);
    await refreshServicePanelMessage(interaction.client, interaction.guildId, interaction.channelId);
    await interaction.reply({ content: "Poids retiré.", ephemeral: true });
    return;
  }

  const weightGrams = Number(raw);
  if (!Number.isInteger(weightGrams) || weightGrams < 0) {
    await interaction.reply({ content: "Poids invalide : entre un nombre entier de grammes positif, ou laisse vide.", ephemeral: true });
    return;
  }

  await setItemWeight(interaction.guildId, itemId, weightGrams);
  await refreshServicePanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.reply({ content: `Poids unitaire défini sur ${weightGrams}g.`, ephemeral: true });
}

/** Clic sur "Configurer la boutique" : modal regroupant RIB/telephone/message/capacite camion. */
async function handlePanelServiceSetShopProfile(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId) return;

  const config = await getGuildConfig(interaction.guildId);
  const modal = new ModalBuilder().setCustomId("panel:service:set-shop-profile-modal").setTitle("Configurer la boutique");

  const ribInput = new TextInputBuilder().setCustomId("rib").setLabel("RIB pour le règlement").setStyle(TextInputStyle.Short).setRequired(false);
  if (config?.shopRib) ribInput.setValue(config.shopRib);

  const phoneInput = new TextInputBuilder().setCustomId("phone").setLabel("Téléphone").setStyle(TextInputStyle.Short).setRequired(false);
  if (config?.shopPhone) phoneInput.setValue(config.shopPhone);

  const messageInput = new TextInputBuilder()
    .setCustomId("thankYouMessage")
    .setLabel("Message de remerciement")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);
  if (config?.shopThankYouMessage) messageInput.setValue(config.shopThankYouMessage);

  const truckCapacityInput = new TextInputBuilder()
    .setCustomId("truckCapacityKg")
    .setLabel("Capacité d'un camion (kg)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);
  if (config?.truckCapacityGrams) truckCapacityInput.setValue(String(config.truckCapacityGrams / 1000));

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(ribInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(phoneInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(messageInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(truckCapacityInput)
  );
  await interaction.showModal(modal);
}

async function handleServiceSetShopProfileModal(interaction: Interaction): Promise<void> {
  if (!interaction.isModalSubmit() || !interaction.guildId || !interaction.channelId) return;

  const rib = interaction.fields.getTextInputValue("rib").trim() || null;
  const phone = interaction.fields.getTextInputValue("phone").trim() || null;
  const thankYouMessage = interaction.fields.getTextInputValue("thankYouMessage").trim() || null;
  const truckCapacityRaw = interaction.fields.getTextInputValue("truckCapacityKg").trim();

  let truckCapacityKg: number | null = null;
  if (truckCapacityRaw !== "") {
    truckCapacityKg = Number(truckCapacityRaw);
    if (!Number.isFinite(truckCapacityKg) || truckCapacityKg <= 0) {
      await interaction.reply({ content: "Capacité de camion invalide : entre un nombre positif, ou laisse vide.", ephemeral: true });
      return;
    }
  }

  await setShopProfile(interaction.guildId, { rib, phone, thankYouMessage, truckCapacityKg });
  await refreshServicePanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.reply({ content: "Profil boutique mis à jour.", ephemeral: true });
}

/**
 * Clic sur "Définir la bannière" : attend un message avec piece jointe dans ce salon (60s) —
 * meme contournement que la photo d'un article (les modals ne supportent pas l'upload de fichier).
 */
async function handlePanelServiceSetBanner(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId || !interaction.channelId) return;

  const channel = await interaction.client.channels.fetch(interaction.channelId);
  if (!channel?.isTextBased() || channel.isDMBased()) return;

  await interaction.reply({ content: "Envoie la bannière en message dans ce salon (60 secondes)...", ephemeral: true });

  const collected = await channel
    .awaitMessages({
      filter: (m) => m.author.id === interaction.user.id && m.attachments.size > 0,
      max: 1,
      time: 60_000,
    })
    .catch(() => null);

  const photoMessage = collected?.first();
  const attachment = photoMessage?.attachments.first();
  if (!photoMessage || !attachment) {
    await interaction.editReply({ content: "Aucune image reçue à temps, réessaie avec le bouton." });
    return;
  }
  if (attachment.size > MAX_UPLOAD_SIZE_BYTES) {
    await interaction.editReply({ content: IMAGE_TOO_LARGE_MESSAGE });
    return;
  }
  if (!isImageAttachment(attachment)) {
    await interaction.editReply({ content: "Seules les images sont acceptées (png, jpg, webp — pas de gif)." });
    return;
  }

  try {
    // Meme raisonnement que la photo d'article : on possede les octets plutot que l'URL CDN
    // Discord, pour pouvoir supprimer ce message sans casser la banniere sur les factures.
    const data = await downloadImageBytes(attachment.url);
    await setShopBanner(interaction.guildId, data, attachment);
    await photoMessage.delete().catch((error: unknown) => logger.warn("Echec suppression du message banniere dans le panneau", error));
    await refreshServicePanelMessage(interaction.client, interaction.guildId, interaction.channelId);
    await interaction.editReply({ content: "Bannière mise à jour." });
  } catch (error) {
    if (error instanceof ImageTooLargeError) {
      await interaction.editReply({ content: IMAGE_TOO_LARGE_MESSAGE });
      return;
    }
    logger.error("Echec du telechargement de la banniere", error);
    await interaction.editReply({ content: "Échec du téléchargement de l'image, réessaie avec le bouton." });
  }
}

/** Clic sur "Retirer la bannière". */
async function handlePanelServiceClearBanner(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId || !interaction.channelId) return;

  await clearShopBanner(interaction.guildId);
  await refreshServicePanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.reply({ content: "Bannière retirée.", ephemeral: true });
}


/** Clic sur "Ajouter un champ" : d'abord choisir l'article concerne. */
async function handlePanelServiceAddField(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId) return;

  const options = await buildItemOptions(interaction.guildId);
  if (options.length === 0) {
    await interaction.reply({ content: "Aucun article configuré, ajoutez-en un d'abord.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder().setCustomId("panel:service:add-field-item").setPlaceholder("Choisir un article").addOptions(options);
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

/** Article choisi : ensuite le type de champ (texte court/long/quantité). */
async function handleServiceAddFieldItem(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu()) return;

  const itemId = interaction.values[0];
  const select = new StringSelectMenuBuilder()
    .setCustomId(`panel:service:add-field-style:${itemId}`)
    .setPlaceholder("Choisir un type")
    .addOptions(
      { label: "Texte court", value: "SHORT" },
      { label: "Texte long", value: "PARAGRAPH" },
      { label: "Quantité", value: "QUANTITY" }
    );
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.update({ content: "Quel type de champ ?", components: [row] });
}

/** Type choisi : modal pour l'intitule et si le champ est obligatoire. */
async function handleServiceAddFieldStyle(interaction: Interaction, itemId: string): Promise<void> {
  if (!interaction.isStringSelectMenu()) return;

  const style = interaction.values[0];
  const modal = new ModalBuilder().setCustomId(`panel:service:add-field-modal:${itemId}:${style}`).setTitle("Ajouter un champ");
  const labelInput = new TextInputBuilder().setCustomId("label").setLabel("Intitulé du champ").setStyle(TextInputStyle.Short).setRequired(true);
  const requiredInput = new TextInputBuilder()
    .setCustomId("required")
    .setLabel("Obligatoire ? (oui/non, par défaut oui)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(labelInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(requiredInput)
  );
  await interaction.showModal(modal);
}

async function handleServiceAddFieldModal(interaction: Interaction, itemId: string, style: string): Promise<void> {
  if (!interaction.isModalSubmit() || !interaction.guildId || !interaction.channelId) return;

  const label = interaction.fields.getTextInputValue("label");
  const required = interaction.fields.getTextInputValue("required").trim().toLowerCase() !== "non";

  try {
    // addField valide les regles metier (max 5 champs, au plus un QUANTITY) et leve une
    // Error au message deja redige pour l'utilisateur : on le relaie tel quel.
    await addField(interaction.guildId, itemId, { label, style: style as "SHORT" | "PARAGRAPH" | "QUANTITY", required });
    await refreshServicePanelMessage(interaction.client, interaction.guildId, interaction.channelId);
    await interaction.reply({ content: `Champ ajouté : **${label}**`, ephemeral: true });
  } catch (error) {
    await interaction.reply({ content: error instanceof Error ? error.message : "Erreur.", ephemeral: true });
  }
}

/** Clic sur "Retirer un champ" : d'abord choisir l'article (ceux qui ont au moins un champ). */
async function handlePanelServiceRemoveField(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId) return;

  const items = (await listActiveWithFields(interaction.guildId)).filter((i) => i.fields.length > 0);
  if (items.length === 0) {
    await interaction.reply({ content: "Aucun champ configuré pour le moment.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("panel:service:remove-field-item")
    .setPlaceholder("Choisir un article")
    .addOptions(items.slice(0, 25).map((i) => ({ label: i.name.slice(0, 100), value: i.id })));
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

/** Article choisi : liste ses champs sous forme de `StringSelectMenu`. */
async function handleServiceRemoveFieldItem(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu() || !interaction.guildId) return;

  const item = await getItem(interaction.guildId, interaction.values[0]);
  if (!item || item.fields.length === 0) {
    await interaction.update({ content: "Aucun champ sur cet article.", components: [] });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("panel:service:remove-field-select")
    .setPlaceholder("Choisir un champ à retirer")
    .addOptions(item.fields.map((f) => ({ label: `${f.label} (${f.style})`.slice(0, 100), value: f.id })));
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.update({ content: "Quel champ retirer ?", components: [row] });
}

async function handleServiceRemoveFieldSelect(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  await removeField(interaction.guildId, interaction.values[0]);
  await refreshServicePanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({ content: "Champ retiré.", components: [] });
}

/** Clic sur "Définir la catégorie" (Recrutement) : menu natif Discord pour choisir la catégorie. */
async function handlePanelRecruitmentSetCategory(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const select = new ChannelSelectMenuBuilder()
    .setCustomId("panel:recruitment:set-category-select")
    .setPlaceholder("Choisir une catégorie")
    .addChannelTypes(ChannelType.GuildCategory);
  const row = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handleRecruitmentSetCategorySelect(interaction: Interaction): Promise<void> {
  if (!interaction.isChannelSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  const categoryId = interaction.values[0];
  await setCategoryForType(interaction.guildId, "RECRUITMENT", categoryId);
  await refreshRecruitmentPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({ content: `Catégorie définie sur <#${categoryId}>.`, components: [] });
}

/** Clic sur "Retirer la catégorie" (Recrutement) : retire directement, un seul mapping possible par type. */
async function handlePanelRecruitmentClearCategory(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId || !interaction.channelId) return;

  await clearCategoryForType(interaction.guildId, "RECRUITMENT");
  await refreshRecruitmentPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.reply({ content: "Catégorie retirée.", ephemeral: true });
}

/** Clic sur le bouton (libelle dynamique) : bascule l'etat ouvert/ferme des recrutements. Remplace `/recruitment status`. */
async function handlePanelRecruitmentToggle(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId || !interaction.channelId) return;

  const config = await getGuildConfig(interaction.guildId);
  const nextOpen = !(config?.recruitmentOpen ?? true);
  await setRecruitmentOpen(interaction.guildId, nextOpen);
  await refreshRecruitmentPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await refreshRecruitmentStatusMessage(interaction.client, interaction.guildId);
  await interaction.reply({
    content: nextOpen
      ? "Recrutements ouverts : les nouveaux tickets affichent le formulaire de candidature."
      : "Recrutements fermés : les nouveaux tickets afficheront un message \"fermé\" au lieu du formulaire.",
    ephemeral: true,
  });
}

/** Clic sur "Définir le salon de suivi" : menu natif Discord filtre aux salons textuels. */
async function handlePanelRecruitmentSetLogChannel(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const select = new ChannelSelectMenuBuilder()
    .setCustomId("panel:recruitment:set-log-channel-select")
    .setPlaceholder("Choisir un salon")
    .addChannelTypes(ChannelType.GuildText);
  const row = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handleRecruitmentSetLogChannelSelect(interaction: Interaction): Promise<void> {
  if (!interaction.isChannelSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  const channelId = interaction.values[0];
  await setRecruitmentLogChannel(interaction.guildId, channelId);
  await refreshRecruitmentPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({ content: `Salon de suivi défini sur <#${channelId}>.`, components: [] });
}

/** Clic sur "Retirer le salon de suivi" : revient au comportement par defaut (recap poste dans le salon du ticket). */
async function handlePanelRecruitmentClearLogChannel(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId || !interaction.channelId) return;

  await setRecruitmentLogChannel(interaction.guildId, null);
  await refreshRecruitmentPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.reply({ content: "Salon de suivi retiré, le récap sera posté dans le salon de chaque ticket.", ephemeral: true });
}

/** Clic sur "Définir le salon de statut" : menu natif Discord filtre aux salons textuels. */
async function handlePanelRecruitmentSetStatusChannel(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const select = new ChannelSelectMenuBuilder()
    .setCustomId("panel:recruitment:set-status-channel-select")
    .setPlaceholder("Choisir un salon")
    .addChannelTypes(ChannelType.GuildText);
  const row = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handleRecruitmentSetStatusChannelSelect(interaction: Interaction): Promise<void> {
  if (!interaction.isChannelSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  const channelId = interaction.values[0];
  await setRecruitmentStatusChannel(interaction.guildId, channelId);
  await refreshRecruitmentPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await refreshRecruitmentStatusMessage(interaction.client, interaction.guildId);
  await interaction.update({ content: `Salon de statut défini sur <#${channelId}>.`, components: [] });
}

/** Clic sur "Retirer le salon de statut" : arrete les mises a jour (le dernier message poste reste tel quel). */
async function handlePanelRecruitmentClearStatusChannel(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId || !interaction.channelId) return;

  await clearRecruitmentStatusChannel(interaction.guildId);
  await refreshRecruitmentPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.reply({ content: "Salon de statut retiré.", ephemeral: true });
}

/** Clic sur "Définir la catégorie d'acceptation" : menu natif Discord pour choisir la catégorie. */
async function handlePanelRecruitmentSetAcceptedCategory(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const select = new ChannelSelectMenuBuilder()
    .setCustomId("panel:recruitment:set-accepted-category-select")
    .setPlaceholder("Choisir une catégorie")
    .addChannelTypes(ChannelType.GuildCategory);
  const row = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handleRecruitmentSetAcceptedCategorySelect(interaction: Interaction): Promise<void> {
  if (!interaction.isChannelSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  const categoryId = interaction.values[0];
  await setRecruitmentAcceptedCategory(interaction.guildId, categoryId);
  await refreshRecruitmentPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({ content: `Catégorie d'acceptation définie sur <#${categoryId}>.`, components: [] });
}

/** Clic sur "Retirer la catégorie d'acceptation" : retire directement, un seul mapping possible. */
async function handlePanelRecruitmentClearAcceptedCategory(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId || !interaction.channelId) return;

  await clearRecruitmentAcceptedCategory(interaction.guildId);
  await refreshRecruitmentPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.reply({ content: "Catégorie d'acceptation retirée.", ephemeral: true });
}

/** Clic sur "Définir le rôle d'acceptation" : menu natif Discord (RoleSelectMenu). */
async function handlePanelRecruitmentSetAcceptedRole(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const select = new RoleSelectMenuBuilder().setCustomId("panel:recruitment:set-accepted-role-select").setPlaceholder("Choisir un rôle");
  const row = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handleRecruitmentSetAcceptedRoleSelect(interaction: Interaction): Promise<void> {
  if (!interaction.isRoleSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  const roleId = interaction.values[0];
  await setRecruitmentAcceptedRole(interaction.guildId, roleId);
  await refreshRecruitmentPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({ content: `Rôle d'acceptation défini sur <@&${roleId}>.`, components: [] });
}

/** Clic sur "Retirer le rôle d'acceptation" : retire directement, un seul rôle possible. */
async function handlePanelRecruitmentClearAcceptedRole(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId || !interaction.channelId) return;

  await clearRecruitmentAcceptedRole(interaction.guildId);
  await refreshRecruitmentPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.reply({ content: "Rôle d'acceptation retiré.", ephemeral: true });
}

/** Clic sur "Ajouter une question" : d'abord choisir le type de champ (court/long). */
async function handlePanelRecruitmentAddQuestion(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const select = new StringSelectMenuBuilder()
    .setCustomId("panel:recruitment:add-question-style")
    .setPlaceholder("Choisir un type")
    .addOptions({ label: "Texte court", value: "SHORT" }, { label: "Texte long", value: "PARAGRAPH" });
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

/** Type choisi : modal pour l'intitule de la question. */
async function handleRecruitmentAddQuestionStyle(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu()) return;

  const style = interaction.values[0];
  const modal = new ModalBuilder().setCustomId(`panel:recruitment:add-question-modal:${style}`).setTitle("Ajouter une question");
  const labelInput = new TextInputBuilder().setCustomId("label").setLabel("Intitulé de la question").setStyle(TextInputStyle.Short).setRequired(true);
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(labelInput));
  await interaction.showModal(modal);
}

async function handleRecruitmentAddQuestionModal(interaction: Interaction, style: string): Promise<void> {
  if (!interaction.isModalSubmit() || !interaction.guildId || !interaction.channelId) return;

  const label = interaction.fields.getTextInputValue("label");

  try {
    // addQuestion valide la limite (5 max, contrainte Discord) et leve une Error au message
    // deja redige pour l'utilisateur : on le relaie tel quel.
    await addRecruitmentQuestion(interaction.guildId, label, style as "SHORT" | "PARAGRAPH");
    await refreshRecruitmentPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
    await interaction.reply({ content: `Question ajoutée : **${label}**`, ephemeral: true });
  } catch (error) {
    await interaction.reply({ content: error instanceof Error ? error.message : "Erreur.", ephemeral: true });
  }
}

/** Clic sur "Retirer une question" : menu natif des questions configurees (aucune = repli sur les questions par defaut, rien a retirer). */
async function handlePanelRecruitmentRemoveQuestion(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId) return;

  const questions = await listRecruitmentQuestions(interaction.guildId);
  if (questions.length === 0) {
    await interaction.reply({
      content: "Aucune question personnalisée configurée — le formulaire par défaut (5 questions) est utilisé.",
      ephemeral: true,
    });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("panel:recruitment:remove-question-select")
    .setPlaceholder("Choisir une question à retirer")
    .addOptions(questions.map((q) => ({ label: q.label.slice(0, 100), value: q.id })));
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handleRecruitmentRemoveQuestionSelect(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  await removeRecruitmentQuestion(interaction.guildId, interaction.values[0]);
  await refreshRecruitmentPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({ content: "Question retirée.", components: [] });
}

/** Clic sur "Définir l'entreprise (jobId)" : modal (texte libre, pas d'entite Discord a selectionner). */
async function handlePanelMonitoringSetJobId(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;
  if (!isGuildManager(interaction)) {
    await interaction.reply({ content: NOT_GUILD_MANAGER_MESSAGE, ephemeral: true });
    return;
  }

  const modal = new ModalBuilder().setCustomId("panel:monitoring:set-job-id-modal").setTitle("Définir l'entreprise");
  const jobIdInput = new TextInputBuilder()
    .setCustomId("jobId")
    .setLabel("jobId (identifiant côté script FiveM)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(jobIdInput));
  await interaction.showModal(modal);
}

async function handleMonitoringSetJobIdModal(interaction: Interaction): Promise<void> {
  if (!interaction.isModalSubmit() || !interaction.guildId || !interaction.channelId) return;

  const jobId = interaction.fields.getTextInputValue("jobId").trim();
  await setMonitoringJobId(interaction.guildId, jobId);
  await refreshMonitoringPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.reply({ content: `Entreprise définie sur jobId \`${jobId}\`.`, ephemeral: true });
}

/** Clic sur "Définir le rôle en service" : menu natif Discord (RoleSelectMenu). */
async function handlePanelMonitoringSetOnDutyRole(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;
  if (!isGuildManager(interaction)) {
    await interaction.reply({ content: NOT_GUILD_MANAGER_MESSAGE, ephemeral: true });
    return;
  }

  const select = new RoleSelectMenuBuilder().setCustomId("panel:monitoring:set-on-duty-role-select").setPlaceholder("Choisir un rôle");
  const row = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handleMonitoringSetOnDutyRoleSelect(interaction: Interaction): Promise<void> {
  if (!interaction.isRoleSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  const roleId = interaction.values[0];
  await setOnDutyRole(interaction.guildId, roleId);
  await refreshMonitoringPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({ content: `Rôle "en service" défini sur <@&${roleId}>.`, components: [] });
}

/** Clic sur "Salon <type>" : menu natif Discord pour choisir le salon webhook a surveiller. */
async function handlePanelMonitoringSetChannel(interaction: Interaction, type: MonitoringLogType): Promise<void> {
  if (!interaction.isButton()) return;
  if (!isGuildManager(interaction)) {
    await interaction.reply({ content: NOT_GUILD_MANAGER_MESSAGE, ephemeral: true });
    return;
  }

  const select = new ChannelSelectMenuBuilder()
    .setCustomId(`panel:monitoring:set-channel-select:${type}`)
    .setPlaceholder("Choisir un salon")
    .addChannelTypes(ChannelType.GuildText);
  const row = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handleMonitoringSetChannelSelect(interaction: Interaction, type: MonitoringLogType): Promise<void> {
  if (!interaction.isChannelSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  const channelId = interaction.values[0];
  await setMonitoringChannel(interaction.guildId, type, channelId);
  await refreshMonitoringPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({ content: `Salon ${MONITORING_TYPE_LABELS[type]} défini sur <#${channelId}>.`, components: [] });
}

/** Clic sur "Retirer salon <type>" : retire directement, un seul salon possible par type. */
async function handlePanelMonitoringClearChannel(interaction: Interaction, type: MonitoringLogType): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId || !interaction.channelId) return;
  if (!isGuildManager(interaction)) {
    await interaction.reply({ content: NOT_GUILD_MANAGER_MESSAGE, ephemeral: true });
    return;
  }

  await clearMonitoringChannel(interaction.guildId, type);
  await refreshMonitoringPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.reply({ content: `Salon ${MONITORING_TYPE_LABELS[type]} retiré.`, ephemeral: true });
}

/**
 * Clic sur "Ajouter un webhook" : d'abord choisir le type d'evenement concerne, parmi TOUS
 * les types existants (pas seulement `monitoring.*`) — ce panneau est le point unique de
 * gestion des webhooks sortants pour toute fonctionnalite du bot.
 */
async function handlePanelMonitoringAddWebhook(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;
  if (!isGuildManager(interaction)) {
    await interaction.reply({ content: NOT_GUILD_MANAGER_MESSAGE, ephemeral: true });
    return;
  }

  const options = (Object.keys(WEBHOOK_EVENT_LABELS) as WebhookEventType[]).map((eventType) => ({
    label: WEBHOOK_EVENT_LABELS[eventType],
    value: eventType,
  }));
  const select = new StringSelectMenuBuilder().setCustomId("panel:monitoring:add-webhook-type").setPlaceholder("Choisir un type").addOptions(options);
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

/**
 * Type choisi : modal pour l'URL de destination — avec un champ "nom" supplementaire pour le
 * type "custom", puisque plusieurs abonnements custom peuvent coexister (un par recepteur, ex:
 * un par Google Sheet) et doivent pouvoir se distinguer l'un de l'autre au moment de l'envoi.
 */
async function handleMonitoringAddWebhookType(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu()) return;

  const eventType = interaction.values[0];
  const modal = new ModalBuilder().setCustomId(`panel:monitoring:add-webhook-modal:${eventType}`).setTitle("Ajouter un webhook");

  if (eventType === "custom") {
    const labelInput = new TextInputBuilder()
      .setCustomId("label")
      .setLabel("Nom (pour le retrouver ensuite)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(labelInput));
  }

  const urlInput = new TextInputBuilder().setCustomId("url").setLabel("URL de destination").setStyle(TextInputStyle.Short).setRequired(true);
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(urlInput));
  await interaction.showModal(modal);
}

/**
 * Soumission de l'URL : cree l'abonnement et affiche le secret en clair — dernière fois qu'il
 * sera visible, il sert a l'externe pour verifier la signature HMAC des POST recus.
 */
async function handleMonitoringAddWebhookModal(interaction: Interaction, eventType: string): Promise<void> {
  if (!interaction.isModalSubmit() || !interaction.guildId || !interaction.channelId) return;

  const url = interaction.fields.getTextInputValue("url").trim();
  const label = eventType === "custom" ? interaction.fields.getTextInputValue("label").trim() : undefined;
  const { secret } = await createSubscription(interaction.guildId, eventType as WebhookEventType, url, label);
  await refreshMonitoringPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.reply({
    content:
      `Webhook \`${label ?? eventType}\` ajouté vers ${url}.\n` +
      `Secret de signature (header \`X-Signature-256\`, HMAC-SHA256) — **note-le, il ne sera plus jamais affiché** :\n\`${secret}\`\n\n` +
      "⚠️ Ce secret doit rester **côté serveur uniquement** (variable d'environnement du site, jamais dans du code envoyé au navigateur, jamais commité sur un dépôt public) — sinon n'importe quel visiteur du site pourrait le récupérer.",
    ephemeral: true,
  });
}

/** Clic sur "Retirer un webhook" : menu natif des abonnements existants. */
async function handlePanelMonitoringRemoveWebhook(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId) return;
  if (!isGuildManager(interaction)) {
    await interaction.reply({ content: NOT_GUILD_MANAGER_MESSAGE, ephemeral: true });
    return;
  }

  const subscriptions = await listSubscriptions(interaction.guildId);
  if (subscriptions.length === 0) {
    await interaction.reply({ content: "Aucun webhook configuré.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("panel:monitoring:remove-webhook-select")
    .setPlaceholder("Choisir un webhook à retirer")
    .addOptions(subscriptions.slice(0, 25).map((s) => ({ label: `${describeSubscription(s)} — ${s.url}`.slice(0, 100), value: s.id })));
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handleMonitoringRemoveWebhookSelect(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  await removeSubscription(interaction.guildId, interaction.values[0]);
  await refreshMonitoringPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({ content: "Webhook retiré.", components: [] });
}

/**
 * Clic sur "Synchroniser un Google Sheet" : choisir vers quel abonnement custom lier le Sheet
 * (un abonnement n'a au plus qu'une seule synchronisation active — ceux deja lies sont exclus).
 */
async function handlePanelMonitoringSyncSheet(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId) return;
  if (!isGuildManager(interaction)) {
    await interaction.reply({ content: NOT_GUILD_MANAGER_MESSAGE, ephemeral: true });
    return;
  }

  const [customSubs, existingSyncs] = await Promise.all([
    listCustomSubscriptions(interaction.guildId),
    listSheetSyncs(interaction.guildId),
  ]);
  const alreadyLinked = new Set(existingSyncs.map((s) => s.subscriptionId));
  const available = customSubs.filter((s) => !alreadyLinked.has(s.id));

  if (available.length === 0) {
    await interaction.reply({
      content:
        customSubs.length === 0
          ? 'Aucun webhook personnalisé configuré — ajoutez-en un avec "Ajouter un webhook" (type "Personnalisé") avant de lier un Google Sheet.'
          : "Tous les webhooks personnalisés existants ont déjà une synchronisation active.",
      ephemeral: true,
    });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("panel:monitoring:sync-sheet-select")
    .setPlaceholder("Choisir la destination")
    .addOptions(available.slice(0, 25).map((s) => ({ label: describeSubscription(s).slice(0, 100), value: s.id })));
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

/** Destination choisie : modal pour le lien du Google Sheet. */
async function handleMonitoringSyncSheetSelect(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu()) return;

  const subscriptionId = interaction.values[0];
  const modal = new ModalBuilder().setCustomId(`panel:monitoring:sync-sheet-modal:${subscriptionId}`).setTitle("Synchroniser un Google Sheet");
  const urlInput = new TextInputBuilder()
    .setCustomId("sheetUrl")
    .setLabel("Lien du Google Sheet")
    .setPlaceholder("Doit être partagé « Lecture » pour « Toute personne avec le lien »")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(urlInput));
  await interaction.showModal(modal);
}

/**
 * Soumission du lien : cree la synchronisation, ce qui envoie immediatement tout l'historique
 * deja present dans le Sheet (voir `createSheetSync`) — potentiellement plusieurs appels HTTP
 * sequentiels vers le recepteur externe, donc `deferReply` : ca peut largement depasser le
 * delai de 3s avant lequel Discord attend une premiere reponse a l'interaction. Erreur relayee
 * telle quelle si le Sheet n'est pas lisible.
 */
async function handleMonitoringSyncSheetModal(interaction: Interaction, subscriptionId: string): Promise<void> {
  if (!interaction.isModalSubmit() || !interaction.guildId || !interaction.channelId) return;

  const sheetUrl = interaction.fields.getTextInputValue("sheetUrl").trim();
  await interaction.deferReply({ ephemeral: true });
  try {
    const sync = await createSheetSync(interaction.guildId, subscriptionId, sheetUrl);
    await refreshMonitoringPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
    await interaction.editReply(
      `Synchronisation activée — ${sync.lastRowCount} ligne(s) déjà présente(s) envoyée(s) immédiatement, puis seules les nouvelles lignes seront envoyées (sondage toutes les 5 minutes).`
    );
  } catch (error) {
    logger.error(`Echec de creation de synchronisation Sheet pour la guilde ${interaction.guildId}`, error);
    await interaction.editReply(error instanceof Error ? error.message : "Impossible de lire ce Google Sheet.");
  }
}

/** Clic sur "Retirer une synchronisation" : menu natif des synchronisations existantes. */
async function handlePanelMonitoringRemoveSync(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId) return;
  if (!isGuildManager(interaction)) {
    await interaction.reply({ content: NOT_GUILD_MANAGER_MESSAGE, ephemeral: true });
    return;
  }

  const syncs = await listSheetSyncs(interaction.guildId);
  if (syncs.length === 0) {
    await interaction.reply({ content: "Aucune synchronisation configurée.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("panel:monitoring:remove-sync-select")
    .setPlaceholder("Choisir une synchronisation à retirer")
    .addOptions(syncs.slice(0, 25).map((s) => ({ label: describeSubscription(s.subscription).slice(0, 100), value: s.id })));
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handleMonitoringRemoveSyncSelect(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  await removeSheetSync(interaction.guildId, interaction.values[0]);
  await refreshMonitoringPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({ content: "Synchronisation retirée.", components: [] });
}

/**
 * Handler de l'evenement `interactionCreate`. Aiguille par type d'interaction puis par
 * `customId` vers le handler correspondant ci-dessus. Les customId parametres (contenant
 * un id de ticket, de catalogue ou de categorie) utilisent un prefixe fixe suivi de `:<id>`,
 * extrait via `startsWith`/`slice` — Discord ne permet pas de passer d'etat structure entre
 * l'affichage d'un composant et l'interaction qui le declenche, seulement une chaine de 100
 * caracteres max. Toute exception non geree par un handler est capturee ici (log + reponse
 * d'erreur generique) pour eviter qu'une interaction Discord ne reste "en attente"
 * indefiniment cote client si le bot plante en cours de traitement.
 */
export async function onInteractionCreate(interaction: Interaction): Promise<void> {
  try {
    if (interaction.isChatInputCommand()) {
      await handleChatInputCommand(interaction);
      return;
    }

    if (interaction.isAutocomplete()) {
      const command = commandsByName.get(interaction.commandName);
      await command?.autocomplete?.(interaction);
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId === "recruitment:start-form") return await handleRecruitmentStartForm(interaction);
      if (interaction.customId.startsWith("recruitment:assign:")) {
        return await handleRecruitmentAssign(interaction, interaction.customId.slice("recruitment:assign:".length));
      }
      if (interaction.customId.startsWith("recruitment:status:")) {
        return await handleRecruitmentStatusButton(interaction, interaction.customId.slice("recruitment:status:".length));
      }
      if (interaction.customId.startsWith("recruitment:finish-attachments:")) {
        return await handleRecruitmentFinishAttachments(interaction, interaction.customId.slice("recruitment:finish-attachments:".length));
      }
      if (interaction.customId === "order:add-more") return await handleOrderAddMore(interaction);
      if (interaction.customId.startsWith("order:confirm-item:")) {
        return await handleOrderConfirmItem(interaction, interaction.customId.slice("order:confirm-item:".length));
      }
      if (interaction.customId === "order:confirm") return await handleOrderConfirm(interaction);
      if (interaction.customId.startsWith("order:status:")) {
        return await handleOrderStatusButton(interaction, interaction.customId.slice("order:status:".length));
      }
      if (interaction.customId.startsWith("order:mark-paid:")) {
        return await handleOrderMarkPaid(interaction, interaction.customId.slice("order:mark-paid:".length));
      }
      if (interaction.customId.startsWith("order:invoice:")) {
        return await handleOrderInvoiceButton(interaction, interaction.customId.slice("order:invoice:".length));
      }
      if (interaction.customId.startsWith("order:remove-item:")) {
        return await handleOrderRemoveItemButton(interaction, interaction.customId.slice("order:remove-item:".length));
      }
      if (interaction.customId.startsWith("order:set-delivery:")) {
        return await handleOrderSetDeliveryButton(interaction, interaction.customId.slice("order:set-delivery:".length));
      }
      if (interaction.customId.startsWith("order:set-discount:")) {
        return await handleOrderSetDiscountButton(interaction, interaction.customId.slice("order:set-discount:".length));
      }
      if (interaction.customId === "panel:root:tickets") return await handlePanelRootButton(interaction, "TICKETS");
      if (interaction.customId === "panel:root:absences") return await handlePanelRootButton(interaction, "ABSENCES");
      if (interaction.customId === "panel:root:monitoring") return await handlePanelRootButton(interaction, "MONITORING");
      if (interaction.customId === "panel:tickets:service") return await handlePanelTicketsNested(interaction, "SERVICE");
      if (interaction.customId === "panel:tickets:recruitment") return await handlePanelTicketsNested(interaction, "RECRUITMENT");
      if (interaction.customId === "panel:tickets:set-roles") return await handlePanelTicketsSetRoles(interaction);
      if (interaction.customId === "panel:absences:set-approver-roles") return await handlePanelAbsencesSetApproverRoles(interaction);
      if (interaction.customId === "panel:absences:set-review-channel") return await handlePanelAbsencesSetReviewChannel(interaction);
      if (interaction.customId === "panel:absences:clear-review-channel") return await handlePanelAbsencesClearReviewChannel(interaction);
      if (interaction.customId.startsWith("absence:accept:")) {
        return await handleAbsenceResolve(interaction, interaction.customId.slice("absence:accept:".length), "ACCEPTED");
      }
      if (interaction.customId.startsWith("absence:refuse:")) {
        return await handleAbsenceResolve(interaction, interaction.customId.slice("absence:refuse:".length), "REFUSED");
      }
      if (interaction.customId === "panel:service:set-category") return await handlePanelServiceSetCategory(interaction);
      if (interaction.customId === "panel:service:clear-category") return await handlePanelServiceClearCategory(interaction);
      if (interaction.customId === "panel:service:add-item") return await handlePanelServiceAddItem(interaction);
      if (interaction.customId === "panel:service:remove-item") return await handlePanelServiceRemoveItem(interaction);
      if (interaction.customId === "panel:service:set-image") return await handlePanelServiceSetImage(interaction);
      if (interaction.customId === "panel:service:set-weight") return await handlePanelServiceSetWeight(interaction);
      if (interaction.customId === "panel:service:add-field") return await handlePanelServiceAddField(interaction);
      if (interaction.customId === "panel:service:remove-field") return await handlePanelServiceRemoveField(interaction);
      if (interaction.customId === "panel:service:set-shop-profile") return await handlePanelServiceSetShopProfile(interaction);
      if (interaction.customId === "panel:service:set-banner") return await handlePanelServiceSetBanner(interaction);
      if (interaction.customId === "panel:service:clear-banner") return await handlePanelServiceClearBanner(interaction);
      if (interaction.customId === "panel:recruitment:set-category") return await handlePanelRecruitmentSetCategory(interaction);
      if (interaction.customId === "panel:recruitment:clear-category") return await handlePanelRecruitmentClearCategory(interaction);
      if (interaction.customId === "panel:recruitment:toggle") return await handlePanelRecruitmentToggle(interaction);
      if (interaction.customId === "panel:recruitment:set-log-channel") return await handlePanelRecruitmentSetLogChannel(interaction);
      if (interaction.customId === "panel:recruitment:clear-log-channel") return await handlePanelRecruitmentClearLogChannel(interaction);
      if (interaction.customId === "panel:recruitment:set-status-channel") return await handlePanelRecruitmentSetStatusChannel(interaction);
      if (interaction.customId === "panel:recruitment:clear-status-channel") return await handlePanelRecruitmentClearStatusChannel(interaction);
      if (interaction.customId === "panel:recruitment:set-accepted-category") return await handlePanelRecruitmentSetAcceptedCategory(interaction);
      if (interaction.customId === "panel:recruitment:clear-accepted-category") return await handlePanelRecruitmentClearAcceptedCategory(interaction);
      if (interaction.customId === "panel:recruitment:set-accepted-role") return await handlePanelRecruitmentSetAcceptedRole(interaction);
      if (interaction.customId === "panel:recruitment:clear-accepted-role") return await handlePanelRecruitmentClearAcceptedRole(interaction);
      if (interaction.customId === "panel:recruitment:add-question") return await handlePanelRecruitmentAddQuestion(interaction);
      if (interaction.customId === "panel:recruitment:remove-question") return await handlePanelRecruitmentRemoveQuestion(interaction);
      if (interaction.customId === "panel:monitoring:set-job-id") return await handlePanelMonitoringSetJobId(interaction);
      if (interaction.customId === "panel:monitoring:set-on-duty-role") return await handlePanelMonitoringSetOnDutyRole(interaction);
      if (interaction.customId.startsWith("panel:monitoring:set-channel:")) {
        return await handlePanelMonitoringSetChannel(
          interaction,
          interaction.customId.slice("panel:monitoring:set-channel:".length) as MonitoringLogType
        );
      }
      if (interaction.customId.startsWith("panel:monitoring:clear-channel:")) {
        return await handlePanelMonitoringClearChannel(
          interaction,
          interaction.customId.slice("panel:monitoring:clear-channel:".length) as MonitoringLogType
        );
      }
      if (interaction.customId === "panel:monitoring:add-webhook") return await handlePanelMonitoringAddWebhook(interaction);
      if (interaction.customId === "panel:monitoring:remove-webhook") return await handlePanelMonitoringRemoveWebhook(interaction);
      if (interaction.customId === "panel:monitoring:sync-sheet") return await handlePanelMonitoringSyncSheet(interaction);
      if (interaction.customId === "panel:monitoring:remove-sync") return await handlePanelMonitoringRemoveSync(interaction);
      return;
    }

    if (interaction.isChannelSelectMenu()) {
      if (interaction.customId === "panel:service:set-category-select") return await handleServiceSetCategorySelect(interaction);
      if (interaction.customId === "panel:recruitment:set-category-select") return await handleRecruitmentSetCategorySelect(interaction);
      if (interaction.customId === "panel:recruitment:set-log-channel-select") return await handleRecruitmentSetLogChannelSelect(interaction);
      if (interaction.customId === "panel:recruitment:set-status-channel-select") return await handleRecruitmentSetStatusChannelSelect(interaction);
      if (interaction.customId === "panel:recruitment:set-accepted-category-select") return await handleRecruitmentSetAcceptedCategorySelect(interaction);
      if (interaction.customId === "panel:absences:set-review-channel-select") return await handlePanelAbsencesSetReviewChannelSelect(interaction);
      if (interaction.customId.startsWith("panel:monitoring:set-channel-select:")) {
        return await handleMonitoringSetChannelSelect(
          interaction,
          interaction.customId.slice("panel:monitoring:set-channel-select:".length) as MonitoringLogType
        );
      }
      return;
    }

    if (interaction.isRoleSelectMenu()) {
      if (interaction.customId.startsWith("panel:tickets:set-roles-select:")) {
        return await handlePanelTicketsSetRolesSelect(interaction, interaction.customId.slice("panel:tickets:set-roles-select:".length));
      }
      if (interaction.customId === "panel:absences:set-approver-roles-select") return await handlePanelAbsencesSetApproverRolesSelect(interaction);
      if (interaction.customId === "panel:monitoring:set-on-duty-role-select") return await handleMonitoringSetOnDutyRoleSelect(interaction);
      if (interaction.customId === "panel:recruitment:set-accepted-role-select") return await handleRecruitmentSetAcceptedRoleSelect(interaction);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === "order:select-item") return await handleOrderSelectItem(interaction);
      if (interaction.customId.startsWith("recruitment:set-status:")) {
        return await handleRecruitmentSetStatus(interaction, interaction.customId.slice("recruitment:set-status:".length));
      }
      if (interaction.customId.startsWith("order:set-status:")) {
        return await handleOrderSetStatus(interaction, interaction.customId.slice("order:set-status:".length));
      }
      if (interaction.customId.startsWith("order:remove-item-select:")) {
        return await handleOrderRemoveItemSelect(interaction, interaction.customId.slice("order:remove-item-select:".length));
      }
      if (interaction.customId === "panel:tickets:set-roles-category") return await handlePanelTicketsSetRolesCategory(interaction);
      if (interaction.customId === "panel:service:remove-item-select") return await handleServiceRemoveItemSelect(interaction);
      if (interaction.customId === "panel:service:set-image-select") return await handleServiceSetImageSelect(interaction);
      if (interaction.customId === "panel:service:set-weight-select") return await handleServiceSetWeightSelect(interaction);
      if (interaction.customId === "panel:service:add-field-item") return await handleServiceAddFieldItem(interaction);
      if (interaction.customId.startsWith("panel:service:add-field-style:")) {
        return await handleServiceAddFieldStyle(interaction, interaction.customId.slice("panel:service:add-field-style:".length));
      }
      if (interaction.customId === "panel:service:remove-field-item") return await handleServiceRemoveFieldItem(interaction);
      if (interaction.customId === "panel:service:remove-field-select") return await handleServiceRemoveFieldSelect(interaction);
      if (interaction.customId === "panel:recruitment:add-question-style") return await handleRecruitmentAddQuestionStyle(interaction);
      if (interaction.customId === "panel:recruitment:remove-question-select") return await handleRecruitmentRemoveQuestionSelect(interaction);
      if (interaction.customId === "panel:monitoring:add-webhook-type") return await handleMonitoringAddWebhookType(interaction);
      if (interaction.customId === "panel:monitoring:remove-webhook-select") return await handleMonitoringRemoveWebhookSelect(interaction);
      if (interaction.customId === "panel:monitoring:sync-sheet-select") return await handleMonitoringSyncSheetSelect(interaction);
      if (interaction.customId === "panel:monitoring:remove-sync-select") return await handleMonitoringRemoveSyncSelect(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === "recruitment:submit-form") return await handleRecruitmentSubmitForm(interaction);
      if (interaction.customId === "absence:submit-form") return await handleAbsenceSubmitForm(interaction);
      if (interaction.customId === "panel:service:add-item-modal") return await handleServiceAddItemModal(interaction);
      if (interaction.customId.startsWith("panel:service:add-field-modal:")) {
        const [itemId, style] = interaction.customId.slice("panel:service:add-field-modal:".length).split(":");
        return await handleServiceAddFieldModal(interaction, itemId, style);
      }
      if (interaction.customId.startsWith("panel:service:set-weight-modal:")) {
        return await handleServiceSetWeightModal(interaction, interaction.customId.slice("panel:service:set-weight-modal:".length));
      }
      if (interaction.customId === "panel:service:set-shop-profile-modal") return await handleServiceSetShopProfileModal(interaction);
      if (interaction.customId.startsWith("order:set-delivery-modal:")) {
        return await handleOrderSetDeliveryModal(interaction, interaction.customId.slice("order:set-delivery-modal:".length));
      }
      if (interaction.customId.startsWith("order:set-discount-modal:")) {
        return await handleOrderSetDiscountModal(interaction, interaction.customId.slice("order:set-discount-modal:".length));
      }
      if (interaction.customId.startsWith("panel:recruitment:add-question-modal:")) {
        return await handleRecruitmentAddQuestionModal(interaction, interaction.customId.slice("panel:recruitment:add-question-modal:".length));
      }
      if (interaction.customId === "panel:monitoring:set-job-id-modal") return await handleMonitoringSetJobIdModal(interaction);
      if (interaction.customId.startsWith("panel:monitoring:sync-sheet-modal:")) {
        return await handleMonitoringSyncSheetModal(interaction, interaction.customId.slice("panel:monitoring:sync-sheet-modal:".length));
      }
      if (interaction.customId.startsWith("panel:monitoring:add-webhook-modal:")) {
        return await handleMonitoringAddWebhookModal(interaction, interaction.customId.slice("panel:monitoring:add-webhook-modal:".length));
      }
      if (interaction.customId.startsWith("order:submit-item:")) {
        const catalogItemId = interaction.customId.slice("order:submit-item:".length);
        return await handleOrderSubmitItem(interaction, catalogItemId);
      }
    }
  } catch (error) {
    logger.error("Erreur lors du traitement d'une interaction", error);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "Une erreur est survenue.", ephemeral: true }).catch(() => undefined);
    }
  }
}
