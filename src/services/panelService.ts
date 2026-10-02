import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Client } from "discord.js";
import type { MonitoringLogType, PanelMessageKey, TicketType } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { getGuildConfig } from "./guildConfigService.js";
import { listActiveWithFields } from "./catalogService.js";
import { listQuestions } from "./recruitmentQuestionService.js";
import { listSubscriptions } from "./webhookSubscriptionService.js";
import { describeSubscription } from "./webhookDispatcher.js";
import { listSheetSyncs } from "./sheetSyncService.js";
import { logger } from "../utils/logger.js";

/**
 * Panneau d'administration : messages permanents (avec boutons/menus) postes dans un salon
 * designe par la guilde (`GuildConfig.panelChannelId`), edites en place a chaque changement
 * plutot que reposte — meme principe que `recruitmentLogService`/`orderLogService`, generalise
 * a plusieurs messages distincts identifies par une cle (`PanelMessageKey`).
 */

/**
 * Reaction posee automatiquement sur chaque message dedie (tout sauf ROOT) pour permettre de
 * le supprimer manuellement (voir `messageReactionAdd.ts`). Le message racine ne la porte
 * jamais : c'est le seul point d'entree vers tout le reste du panneau, il ne doit pas pouvoir
 * etre supprime par erreur via la reaction.
 */
export const PANEL_DELETE_EMOJI = "🗑️";

/** Recupere l'enregistrement d'un message du panneau (id du message Discord, active ou non). */
export async function getPanelMessage(guildId: string, key: PanelMessageKey) {
  return prisma.panelMessage.findUnique({ where: { guildId_key: { guildId, key } } });
}

/** Retrouve l'enregistrement du panneau correspondant a un message Discord donne, si c'en est un. */
export async function findPanelMessageByMessageId(guildId: string, messageId: string) {
  return prisma.panelMessage.findFirst({ where: { guildId, messageId } });
}

/** Active/desactive une fonctionnalite du panneau (cree l'enregistrement si premiere activation). */
export async function setPanelEnabled(guildId: string, key: PanelMessageKey, enabled: boolean) {
  return prisma.panelMessage.upsert({
    where: { guildId_key: { guildId, key } },
    create: { guildId, key, enabled },
    update: { enabled },
  });
}

async function saveMessageRef(guildId: string, key: PanelMessageKey, messageId: string) {
  return prisma.panelMessage.upsert({
    where: { guildId_key: { guildId, key } },
    create: { guildId, key, messageId, enabled: true },
    update: { messageId, enabled: true },
  });
}

/**
 * Oublie la reference au message supprime (voir `messageReactionAdd.ts`) et desactive la
 * fonctionnalite : re-cliquer le bouton parent (racine ou "Tickets") la reactivera et
 * repostera un message dedie tout neuf.
 */
export async function clearPanelMessageRef(guildId: string, key: PanelMessageKey) {
  return prisma.panelMessage.update({ where: { guildId_key: { guildId, key } }, data: { messageId: null, enabled: false } });
}

/**
 * Cree ou edite en place le message dedie a une cle du panneau. Si un message existe deja
 * (memorise en base) et est toujours accessible, il est edite en place ; sinon (jamais
 * poste, ou supprime manuellement dans Discord) un nouveau message est envoye et sa
 * reference sauvegardee. Pose la reaction "poubelle" (sauf sur ROOT) a chaque fois — reagir
 * est un no-op cote Discord si deja present, donc pas de cout a le refaire a chaque edition.
 */
export async function upsertPanelMessage(
  client: Client,
  guildId: string,
  key: PanelMessageKey,
  channelId: string,
  payload: { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }
): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased() || channel.isDMBased()) return;

  const existing = await getPanelMessage(guildId, key);
  if (existing?.messageId) {
    try {
      const message = await channel.messages.fetch(existing.messageId);
      await message.edit(payload);
      if (key !== "ROOT") await message.react(PANEL_DELETE_EMOJI).catch(() => undefined);
      return;
    } catch (error) {
      logger.warn(`Message panneau ${key} (${existing.messageId}) introuvable, nouveau message poste`, error);
    }
  }

  const message = await channel.send(payload);
  if (key !== "ROOT") await message.react(PANEL_DELETE_EMOJI).catch(() => undefined);
  await saveMessageRef(guildId, key, message.id);
}

/** Libelle affichable de chaque type de ticket (boutons, embeds, menus). */
export const TICKET_TYPE_LABELS: Record<TicketType, string> = {
  RECRUITMENT: "Recrutement",
  SERVICE: "Service client",
};

/** Embed du message racine du panneau : point d'entree vers chaque fonctionnalite. */
export function buildRootPanelEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Panneau d'administration")
    .setDescription("Choisissez une fonctionnalité à configurer.")
    .setColor(0x5865f2);
}

/** Boutons du message racine : un par fonctionnalite de premier niveau. */
export function buildRootPanelRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel:root:tickets").setLabel("Tickets").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel:root:absences").setLabel("Absences").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel:root:monitoring").setLabel("Monitoring").setStyle(ButtonStyle.Primary)
  );
}

/**
 * Embed du message dedie "Tickets" : recapitule, pour chacun des deux types (une seule
 * categorie possible par type — pas de sens metier a en avoir plusieurs), la categorie
 * mappee et ses roles de gestion. Utilise les mentions Discord (`<#id>`/`<@&id>`) pour
 * afficher noms de categorie/role sans avoir a les resoudre via l'API.
 */
export async function buildTicketsPanelEmbed(guildId: string): Promise<EmbedBuilder> {
  const config = await getGuildConfig(guildId);
  const categories = config?.ticketCategories ?? [];

  const describe = (type: TicketType) => {
    const category = categories.find((c) => c.type === type);
    if (!category) return "Non configurée";
    const roles = category.managerRoleIds.length ? category.managerRoleIds.map((r) => `<@&${r}>`).join(" ") : "aucun rôle";
    return `<#${category.categoryId}>\nGestion : ${roles}`;
  };

  return new EmbedBuilder()
    .setTitle("Tickets")
    .setColor(0x5865f2)
    .addFields(
      { name: "Recrutement", value: describe("RECRUITMENT"), inline: true },
      { name: "Service client", value: describe("SERVICE"), inline: true }
    );
}

/**
 * Boutons du message dedie "Tickets" : gestion des roles (la categorie de chaque type se
 * definit desormais directement depuis les messages "Service client"/"Recrutement", via
 * un bouton Definir/Retirer la categorie — meme principe que le bouton ouvrir/fermer les
 * recrutements), plus deux boutons qui ouvrent ces messages dedies imbriques.
 */
export function buildTicketsPanelRows(): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel:tickets:set-roles").setLabel("Définir les rôles de gestion").setStyle(ButtonStyle.Primary)
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel:tickets:service").setLabel("Service client").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel:tickets:recruitment").setLabel("Recrutement").setStyle(ButtonStyle.Secondary)
  );
  return [row1, row2];
}

/**
 * Embed du message dedie "Absences" : recapitule la configuration (role approbateur, salon
 * de suivi). La declaration elle-meme se fait via `/absence` (commande accessible a tout le
 * monde, pas un bouton ici — ce salon de panneau est reserve a la config, potentiellement
 * invisible aux membres non-staff). Les webhooks sortants ne se gerent plus ici : voir le
 * panneau "Monitoring", point unique de gestion pour tous les types d'evenements.
 */
export async function buildAbsencesPanelEmbed(guildId: string): Promise<EmbedBuilder> {
  const config = await getGuildConfig(guildId);
  const roleIds = config?.absenceApproverRoleIds ?? [];
  const roles = roleIds.length ? roleIds.map((r) => `<@&${r}>`).join(" ") : "Non configuré";
  const channel = config?.absenceReviewChannelId ? `<#${config.absenceReviewChannelId}>` : "Non configuré";
  const ready = Boolean(roleIds.length && config?.absenceReviewChannelId);

  return new EmbedBuilder()
    .setTitle("Absences")
    .setColor(0x5865f2)
    .addFields({ name: "Rôles approbateurs", value: roles, inline: true }, { name: "Salon de suivi", value: channel, inline: true })
    .setDescription(
      ready
        ? "Les membres peuvent déclarer une absence avec la commande /absence."
        : "Configurez au moins un rôle approbateur et le salon de suivi ci-dessous avant que /absence ne soit utilisable."
    );
}

/**
 * Boutons de configuration du message dedie "Absences" : roles approbateurs (multi-select
 * Discord natif, remplace la selection entiere a chaque usage — voir
 * `panel:absences:set-approver-roles`) et salon de suivi (bouton unique Definir/Retirer selon
 * l'etat courant, meme convention que les categories de ticket).
 */
export function buildAbsencesPanelRows(reviewChannelId: string | null): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel:absences:set-approver-roles").setLabel("Définir les rôles approbateurs").setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(reviewChannelId ? "panel:absences:clear-review-channel" : "panel:absences:set-review-channel")
      .setLabel(reviewChannelId ? "Retirer le salon de suivi" : "Définir le salon de suivi")
      .setStyle(reviewChannelId ? ButtonStyle.Danger : ButtonStyle.Success)
  );
  return [row1];
}

/**
 * Embed du message dedie "Service client" : categorie mappee et catalogue actif (nom, prix,
 * photo configuree ou non, champs client). Remplace entierement `/catalog list`/`view`.
 */
export async function buildServicePanelEmbed(guildId: string): Promise<EmbedBuilder> {
  const config = await getGuildConfig(guildId);
  const category = config?.ticketCategories.find((c) => c.type === "SERVICE");
  const items = await listActiveWithFields(guildId);
  const embed = new EmbedBuilder()
    .setTitle("Service client")
    .setColor(0x5865f2)
    .addFields({ name: "Catégorie", value: category ? `<#${category.categoryId}>` : "Non configurée" });

  if (items.length === 0) {
    embed.addFields({ name: "Catalogue", value: "Aucun article configuré." });
  } else {
    embed.addFields({
      name: "Catalogue",
      value: items
        .slice(0, 25)
        .map((item) => {
          const fields = item.fields.length ? item.fields.map((f) => f.label).join(", ") : "aucun";
          const weight = item.weightGrams !== null ? `${(item.weightGrams / 1000).toFixed(1)}kg` : "non renseigné";
          return `**${item.name}** — ${item.price.toLocaleString("fr-FR")} $ (photo : ${item.imageFilename ? "oui" : "non"}, poids : ${weight})\nChamps : ${fields}`;
        })
        .join("\n\n"),
    });
  }

  embed.addFields({
    name: "Profil boutique (facture)",
    value: [
      `RIB : ${config?.shopRib ?? "non configuré"}`,
      `Téléphone : ${config?.shopPhone ?? "non configuré"}`,
      `Message de remerciement : ${config?.shopThankYouMessage ?? "non configuré"}`,
      `Capacité d'un camion : ${config?.truckCapacityGrams ? `${(config.truckCapacityGrams / 1000).toFixed(1)}kg` : "non configurée"}`,
      `Bannière : ${config?.shopBannerFilename ? "configurée" : "non configurée"}`,
    ].join("\n"),
  });

  return embed;
}

/**
 * Boutons du message dedie "Service client" : categorie (bouton unique, libelle Definir/Retirer
 * selon l'etat courant — meme principe que le bouton ouvrir/fermer les recrutements) et profil
 * boutique (RIB/telephone/message/capacite camion regroupes dans un seul modal, banniere via
 * le meme mecanisme d'upload que la photo d'un article) sur la meme ligne ; gestion des
 * articles (ajout/retrait/photo/poids) et de leurs champs. Les webhooks sortants ne se gerent
 * plus ici : voir le panneau "Monitoring", point unique de gestion pour tous les types
 * d'evenements. Remplace entierement `/catalog add`/`remove`/`field-add`/`field-remove`.
 */
export function buildServicePanelRows(categoryId: string | null, bannerConfigured: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const categoryRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(categoryId ? "panel:service:clear-category" : "panel:service:set-category")
      .setLabel(categoryId ? "Retirer la catégorie" : "Définir la catégorie")
      .setStyle(categoryId ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId("panel:service:set-shop-profile").setLabel("Configurer la boutique").setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(bannerConfigured ? "panel:service:clear-banner" : "panel:service:set-banner")
      .setLabel(bannerConfigured ? "Retirer la bannière" : "Définir la bannière")
      .setStyle(bannerConfigured ? ButtonStyle.Danger : ButtonStyle.Success)
  );
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel:service:add-item").setLabel("Ajouter un article").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel:service:remove-item").setLabel("Retirer un article").setStyle(ButtonStyle.Danger)
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel:service:set-image").setLabel("Changer la photo d'un article").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel:service:set-weight").setLabel("Définir le poids d'un article").setStyle(ButtonStyle.Secondary)
  );
  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel:service:add-field").setLabel("Ajouter un champ").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel:service:remove-field").setLabel("Retirer un champ").setStyle(ButtonStyle.Danger)
  );
  return [categoryRow, row1, row2, row3];
}

/**
 * Embed du message dedie "Recrutement" : categorie mappee, etat (ouvert/ferme), salon de suivi
 * des candidatures et questions du formulaire (configurees par le staff, ou les 5 questions
 * par defaut si aucune n'est configuree). Remplace entierement `/recruitment status` et
 * `/config set-recruitment-channel`.
 */
export async function buildRecruitmentPanelEmbed(guildId: string): Promise<EmbedBuilder> {
  const config = await getGuildConfig(guildId);
  const category = config?.ticketCategories.find((c) => c.type === "RECRUITMENT");
  const questions = await listQuestions(guildId);
  const open = config?.recruitmentOpen ?? true;

  const questionsText =
    questions.length > 0
      ? questions.map((q) => `${q.label} (${q.style === "SHORT" ? "court" : "long"})`).join("\n")
      : "Questions par défaut (5) : Nom RP, Âge, Expérience RP, Disponibilités, Motivation";

  return new EmbedBuilder()
    .setTitle("Recrutement")
    .setColor(0x5865f2)
    .addFields(
      { name: "Catégorie", value: category ? `<#${category.categoryId}>` : "Non configurée" },
      { name: "État", value: open ? "**Ouvert**" : "**Fermé**" },
      {
        name: "Salon de suivi des candidatures",
        value: config?.recruitmentLogChannelId ? `<#${config.recruitmentLogChannelId}>` : "Salon du ticket (par défaut)",
      },
      {
        name: "Salon de statut public",
        value: config?.recruitmentStatusChannelId ? `<#${config.recruitmentStatusChannelId}>` : "Non configuré",
      },
      {
        name: "Catégorie à l'acceptation",
        value: config?.recruitmentAcceptedCategoryId ? `<#${config.recruitmentAcceptedCategoryId}>` : "Non configurée",
      },
      {
        name: "Rôle à l'acceptation",
        value: config?.recruitmentAcceptedRoleId ? `<@&${config.recruitmentAcceptedRoleId}>` : "Non configuré",
      },
      { name: "Questions du formulaire", value: questionsText }
    );
}

/**
 * Boutons du message dedie "Recrutement" : categorie (bouton unique Definir/Retirer selon
 * l'etat courant), bascule ouvert/ferme + salon de statut public (meme message edite en place
 * a chaque bascule, voir `refreshRecruitmentStatusMessage`), salon de suivi des candidatures +
 * effets a l'acceptation (categorie de destination, role), et gestion des questions du
 * formulaire. 4 lignes au total (limite Discord : 5 lignes par message).
 */
export function buildRecruitmentPanelRows(
  open: boolean,
  categoryId: string | null,
  logChannelId: string | null,
  statusChannelId: string | null,
  acceptedCategoryId: string | null,
  acceptedRoleId: string | null
): ActionRowBuilder<ButtonBuilder>[] {
  const categoryRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(categoryId ? "panel:recruitment:clear-category" : "panel:recruitment:set-category")
      .setLabel(categoryId ? "Retirer la catégorie" : "Définir la catégorie")
      .setStyle(categoryId ? ButtonStyle.Danger : ButtonStyle.Success)
  );
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("panel:recruitment:toggle")
      .setLabel(open ? "Fermer les recrutements" : "Ouvrir les recrutements")
      .setStyle(open ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(statusChannelId ? "panel:recruitment:clear-status-channel" : "panel:recruitment:set-status-channel")
      .setLabel(statusChannelId ? "Retirer le salon de statut" : "Définir le salon de statut")
      .setStyle(statusChannelId ? ButtonStyle.Danger : ButtonStyle.Success)
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(logChannelId ? "panel:recruitment:clear-log-channel" : "panel:recruitment:set-log-channel")
      .setLabel(logChannelId ? "Retirer le salon de suivi" : "Définir le salon de suivi")
      .setStyle(logChannelId ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(acceptedCategoryId ? "panel:recruitment:clear-accepted-category" : "panel:recruitment:set-accepted-category")
      .setLabel(acceptedCategoryId ? "Retirer la catégorie d'acceptation" : "Définir la catégorie d'acceptation")
      .setStyle(acceptedCategoryId ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(acceptedRoleId ? "panel:recruitment:clear-accepted-role" : "panel:recruitment:set-accepted-role")
      .setLabel(acceptedRoleId ? "Retirer le rôle d'acceptation" : "Définir le rôle d'acceptation")
      .setStyle(acceptedRoleId ? ButtonStyle.Danger : ButtonStyle.Success)
  );
  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel:recruitment:add-question").setLabel("Ajouter une question").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel:recruitment:remove-question").setLabel("Retirer une question").setStyle(ButtonStyle.Danger)
  );
  return [categoryRow, row1, row2, row3];
}

/** Libelle affichable de chaque type de log de monitoring (boutons, embeds, menus). */
export const MONITORING_TYPE_LABELS: Record<MonitoringLogType, string> = {
  SHIFT: "Prise de service",
  RECRUITMENT: "Recrutement",
  SAFE: "Coffre",
  INVOICE: "Facture",
  SALE: "Vente run",
};

/**
 * Embed du message dedie "Monitoring" : jobId surveille, role "en service", salon configure
 * pour chaque type de log, et abonnements webhook sortants actifs — TOUS les types
 * d'evenements, pas seulement `monitoring.*` : ce panneau est le point unique de gestion des
 * webhooks pour l'ensemble du bot (choix explicite de l'utilisateur, plutot qu'un bouton
 * "Ajouter un webhook" disperse sur chaque panneau concerne).
 */
export async function buildMonitoringPanelEmbed(guildId: string): Promise<EmbedBuilder> {
  const config = await getGuildConfig(guildId);
  const subscriptions = await listSubscriptions(guildId);
  const sheetSyncs = await listSheetSyncs(guildId);

  const channelsText = (Object.keys(MONITORING_TYPE_LABELS) as MonitoringLogType[])
    .map((type) => {
      const channel = config?.monitoringChannels.find((c) => c.type === type);
      return `${MONITORING_TYPE_LABELS[type]} : ${channel ? `<#${channel.channelId}>` : "Non configuré"}`;
    })
    .join("\n");

  const webhooksText = subscriptions.length
    ? subscriptions.map((s) => `\`${describeSubscription(s)}\` → ${s.url.slice(0, 60)} (${s.enabled ? "actif" : "inactif"})`).join("\n")
    : "Aucun webhook configuré.";

  const embed = new EmbedBuilder()
    .setTitle("Monitoring")
    .setColor(0x5865f2)
    .addFields(
      { name: "Entreprise (jobId)", value: config?.monitoringJobId ?? "Non configuré", inline: true },
      { name: "Rôle \"en service\"", value: config?.onDutyRoleId ? `<@&${config.onDutyRoleId}>` : "Non configuré", inline: true },
      { name: "Salons surveillés", value: channelsText },
      { name: "Webhooks sortants", value: webhooksText }
    );

  if (sheetSyncs.length > 0) {
    embed.addFields({
      name: "Google Sheets synchronisés",
      value: sheetSyncs.map((s) => `${describeSubscription(s.subscription)} — ${s.lastRowCount} ligne(s) envoyée(s)`).join("\n"),
    });
  }

  return embed;
}

/**
 * Boutons du message dedie "Monitoring" : jobId (modal), role "en service" (RoleSelectMenu),
 * un bouton par type de log (libelle dynamique Definir/Retirer selon l'etat courant — meme
 * convention que les categories Service/Recrutement), et gestion des webhooks sortants.
 */
export function buildMonitoringPanelRows(config: { monitoringChannels: { type: MonitoringLogType }[] } | null): ActionRowBuilder<ButtonBuilder>[] {
  const configuredTypes = new Set(config?.monitoringChannels.map((c) => c.type) ?? []);
  const types = Object.keys(MONITORING_TYPE_LABELS) as MonitoringLogType[];

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel:monitoring:set-job-id").setLabel("Définir l'entreprise (jobId)").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel:monitoring:set-on-duty-role").setLabel("Définir le rôle \"en service\"").setStyle(ButtonStyle.Secondary)
  );

  const channelButtons = types.map((type) => {
    const configured = configuredTypes.has(type);
    return new ButtonBuilder()
      .setCustomId(configured ? `panel:monitoring:clear-channel:${type}` : `panel:monitoring:set-channel:${type}`)
      .setLabel(configured ? `Retirer salon ${MONITORING_TYPE_LABELS[type]}` : `Salon ${MONITORING_TYPE_LABELS[type]}`)
      .setStyle(configured ? ButtonStyle.Danger : ButtonStyle.Success);
  });
  // Un ActionRow accepte au plus 5 boutons ; 5 types tiennent sur une seule ligne.
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(...channelButtons);

  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel:monitoring:add-webhook").setLabel("Ajouter un webhook").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel:monitoring:remove-webhook").setLabel("Retirer un webhook").setStyle(ButtonStyle.Danger)
  );

  const row4 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel:monitoring:sync-sheet").setLabel("Synchroniser un Google Sheet").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel:monitoring:remove-sync").setLabel("Retirer une synchronisation").setStyle(ButtonStyle.Danger)
  );

  return [row1, row2, row3, row4];
}

/**
 * Un `refresh*PanelMessage` par cle : reconstruit l'embed/les boutons a partir de l'etat
 * courant de la config et les applique au message dedie (cree ou edite en place). Regroupes
 * ici (plutot que duplique pres de chaque handler d'interaction) pour une seule raison :
 * `refreshAllPanelMessages` (voir plus bas, appelee au demarrage du bot) doit pouvoir
 * rafraichir n'importe quel message existant a partir de sa seule cle, sans dependre du
 * contexte d'une interaction Discord precise.
 */
export async function refreshRootPanelMessage(client: Client, guildId: string, channelId: string): Promise<void> {
  await upsertPanelMessage(client, guildId, "ROOT", channelId, {
    embeds: [buildRootPanelEmbed()],
    components: [buildRootPanelRow()],
  });
}

export async function refreshTicketsPanelMessage(client: Client, guildId: string, channelId: string): Promise<void> {
  await upsertPanelMessage(client, guildId, "TICKETS", channelId, {
    embeds: [await buildTicketsPanelEmbed(guildId)],
    components: buildTicketsPanelRows(),
  });
}

export async function refreshServicePanelMessage(client: Client, guildId: string, channelId: string): Promise<void> {
  const config = await getGuildConfig(guildId);
  const categoryId = config?.ticketCategories.find((c) => c.type === "SERVICE")?.categoryId ?? null;
  await upsertPanelMessage(client, guildId, "SERVICE", channelId, {
    embeds: [await buildServicePanelEmbed(guildId)],
    components: buildServicePanelRows(categoryId, Boolean(config?.shopBannerFilename)),
  });
}

export async function refreshRecruitmentPanelMessage(client: Client, guildId: string, channelId: string): Promise<void> {
  const config = await getGuildConfig(guildId);
  const categoryId = config?.ticketCategories.find((c) => c.type === "RECRUITMENT")?.categoryId ?? null;
  await upsertPanelMessage(client, guildId, "RECRUITMENT", channelId, {
    embeds: [await buildRecruitmentPanelEmbed(guildId)],
    components: buildRecruitmentPanelRows(
      config?.recruitmentOpen ?? true,
      categoryId,
      config?.recruitmentLogChannelId ?? null,
      config?.recruitmentStatusChannelId ?? null,
      config?.recruitmentAcceptedCategoryId ?? null,
      config?.recruitmentAcceptedRoleId ?? null
    ),
  });
}

export async function refreshAbsencesPanelMessage(client: Client, guildId: string, channelId: string): Promise<void> {
  const config = await getGuildConfig(guildId);
  await upsertPanelMessage(client, guildId, "ABSENCES", channelId, {
    embeds: [await buildAbsencesPanelEmbed(guildId)],
    components: buildAbsencesPanelRows(config?.absenceReviewChannelId ?? null),
  });
}

export async function refreshMonitoringPanelMessage(client: Client, guildId: string, channelId: string): Promise<void> {
  const config = await getGuildConfig(guildId);
  await upsertPanelMessage(client, guildId, "MONITORING", channelId, {
    embeds: [await buildMonitoringPanelEmbed(guildId)],
    components: buildMonitoringPanelRows(config),
  });
}

const REFRESH_BY_KEY: Record<PanelMessageKey, (client: Client, guildId: string, channelId: string) => Promise<void>> = {
  ROOT: refreshRootPanelMessage,
  TICKETS: refreshTicketsPanelMessage,
  SERVICE: refreshServicePanelMessage,
  RECRUITMENT: refreshRecruitmentPanelMessage,
  ABSENCES: refreshAbsencesPanelMessage,
  MONITORING: refreshMonitoringPanelMessage,
};

/**
 * Recharge (edite en place) tous les messages dedies actives d'une guilde a partir du code
 * courant. Appelee au demarrage du bot (voir `refreshAllPanelsAcrossGuilds`) pour qu'une
 * evolution des boutons/embeds cote code (ex: un nouveau bouton ajoute sur le message racine)
 * se propage automatiquement aux messages deja postes sans action manuelle — avant ce
 * correctif, il fallait recliquer chaque bouton (ou relancer `/config set-panel-channel`)
 * pour voir apparaitre les changements, ce que l'utilisateur a signale comme trompeur
 * ("je dois reconfigurer le channel et du coup je perds tout", alors qu'en realite rien
 * n'etait perdu — juste l'affichage qui restait perime).
 */
export async function refreshAllPanelMessages(client: Client, guildId: string): Promise<void> {
  const config = await getGuildConfig(guildId);
  if (!config?.panelChannelId) return;

  const messages = await prisma.panelMessage.findMany({ where: { guildId, enabled: true } });
  for (const message of messages) {
    try {
      await REFRESH_BY_KEY[message.key](client, guildId, config.panelChannelId);
    } catch (error) {
      logger.error(`Echec du rafraichissement du message panneau ${message.key} pour la guilde ${guildId}`, error);
    }
  }
}

/** Rafraichit le panneau de toutes les guildes ayant un salon panneau configure — appelee une seule fois au demarrage du bot. */
export async function refreshAllPanelsAcrossGuilds(client: Client): Promise<void> {
  const configs = await prisma.guildConfig.findMany({ where: { panelChannelId: { not: null } }, select: { guildId: true } });
  for (const config of configs) {
    await refreshAllPanelMessages(client, config.guildId);
  }
}
