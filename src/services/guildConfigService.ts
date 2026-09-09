import {
  Prisma,
  type GuildConfig,
  type MonitoringChannelConfig,
  type MonitoringLogType,
  type TicketCategoryConfig,
  type TicketType,
} from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { deleteStoredImage, storeImage } from "../utils/imageAttachment.js";

/**
 * Ce service centralise la lecture/ecriture de la configuration par serveur (`GuildConfig`)
 * et de ses mappings associes : categorie -> type de ticket + roles de gestion
 * (`TicketCategoryConfig`), salon -> type de log de monitoring (`MonitoringChannelConfig`).
 * Chaque fonction est scopee par `guildId`, ce qui garantit l'isolation multi-serveur : le
 * bot ne lit/ecrit jamais que les donnees du serveur sur lequel l'evenement/la commande a eu lieu.
 */

/**
 * GuildConfig avec ses categories de tickets et salons de monitoring deja charges (evite un
 * aller-retour DB supplementaire).
 */
type GuildConfigWithCategories = GuildConfig & {
  ticketCategories: TicketCategoryConfig[];
  monitoringChannels: MonitoringChannelConfig[];
};

/**
 * Cache memoire (process local) des configs par guilde, pour eviter une requete Postgres
 * a chaque evenement Discord (channelCreate, messageCreate...). Invalide/rafraichi explicitement
 * a chaque ecriture via `refresh()` — pas de TTL, la donnee change rarement (commandes de config).
 */
const cache = new Map<string, GuildConfigWithCategories>();

/**
 * Recupere la config d'une guilde (avec ses categories), en passant par le cache si possible.
 * Retourne `null` si la guilde n'a jamais ete configuree (aucune commande `/config` executee).
 */
export async function getGuildConfig(guildId: string): Promise<GuildConfigWithCategories | null> {
  const cached = cache.get(guildId);
  if (cached) return cached;

  const config = await prisma.guildConfig.findUnique({
    where: { guildId },
    include: { ticketCategories: true, monitoringChannels: true },
  });
  if (config) cache.set(guildId, config);
  return config;
}

/**
 * Recupere la banniere de facture (URL CDN ou reference au fichier local selon l'environnement,
 * voir `resolveImageDisplay`) — interrogee uniquement au moment de generer une facture
 * (`orderLogService.ts`). `null` si aucune banniere configuree.
 */
export async function getShopBanner(guildId: string): Promise<{ url: string | null; filename: string | null } | null> {
  const config = await prisma.guildConfig.findUnique({
    where: { guildId },
    select: { shopBannerUrl: true, shopBannerFilename: true },
  });
  if (!config?.shopBannerFilename) return null;
  return { url: config.shopBannerUrl, filename: config.shopBannerFilename };
}

/**
 * Retourne la config existante ou en cree une par defaut (categories vides).
 * Utilise en interne par les fonctions d'ecriture ci-dessous, pour ne jamais echouer
 * sur une guilde configuree pour la premiere fois.
 *
 * `upsert` plutot qu'un `findUnique` + `create` separes : deux commandes `/config`
 * lancees quasi simultanement sur une guilde jamais configuree verraient toutes les
 * deux "n'existe pas" avant que l'une des deux n'ait fini d'ecrire, et la seconde
 * `create()` echouerait alors sur la contrainte unique `guildId`. `upsert` reduit la
 * fenetre de course, mais l'`include` de relation force ici Prisma a retomber sur un
 * lire-puis-ecrire non atomique plutot qu'un `INSERT ... ON CONFLICT` natif — une vraie
 * collision (double clic, redelivrance d'une interaction par Discord) reste donc possible,
 * d'ou le catch ci-dessous : si on perd la course, la ligne existe deja, il suffit de la relire.
 */
async function ensureGuildConfig(guildId: string): Promise<GuildConfigWithCategories> {
  const cached = cache.get(guildId);
  if (cached) return cached;

  try {
    const config = await prisma.guildConfig.upsert({
      where: { guildId },
      create: { guildId },
      update: {},
      include: { ticketCategories: true, monitoringChannels: true },
    });
    cache.set(guildId, config);
    return config;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return refresh(guildId);
    }
    throw error;
  }
}

/** Recharge la config depuis Postgres et remet le cache a jour. A appeler apres toute ecriture. */
async function refresh(guildId: string): Promise<GuildConfigWithCategories> {
  const config = await prisma.guildConfig.findUniqueOrThrow({
    where: { guildId },
    include: { ticketCategories: true, monitoringChannels: true },
  });
  cache.set(guildId, config);
  return config;
}

/**
 * Definit (ou redefinit) la categorie Discord associee a un type de ticket pour cette guilde.
 * Un seul type = une seule categorie a la fois (pas de sens metier a en avoir plusieurs) :
 * si une autre categorie etait deja mappee a ce type, son mapping est supprime et ses roles
 * de gestion sont repris sur la nouvelle categorie (le role gere le "type" de ticket, pas
 * la categorie Discord en tant que telle, qui n'est qu'un contenant).
 *
 * @param guildId - id de la guilde Discord
 * @param type - RECRUITMENT ou SERVICE
 * @param categoryId - id de la categorie Discord a surveiller pour ce type
 */
export async function setCategoryForType(
  guildId: string,
  type: TicketType,
  categoryId: string
): Promise<GuildConfigWithCategories> {
  const config = await ensureGuildConfig(guildId);
  const existingForType = config.ticketCategories.find((c) => c.type === type);

  if (existingForType && existingForType.categoryId !== categoryId) {
    // `deleteMany` plutot que `delete` : si deux admins changent la categorie de ce type
    // presque simultanement, le second appel ne doit pas planter (P2025) parce que le premier
    // a deja supprime cette ligne — `deleteMany` ne trouve simplement rien a supprimer.
    await prisma.ticketCategoryConfig.deleteMany({
      where: { guildId, categoryId: existingForType.categoryId },
    });
  }

  await prisma.ticketCategoryConfig.upsert({
    where: { guildId_categoryId: { guildId, categoryId } },
    create: { guildId, categoryId, type, managerRoleIds: existingForType?.managerRoleIds ?? [] },
    update: { type },
  });
  return refresh(guildId);
}

/** Retire le mapping d'une categorie pour un type donne (elle redevient ignoree par le bot). */
export async function clearCategoryForType(guildId: string, type: TicketType): Promise<GuildConfigWithCategories> {
  const config = await ensureGuildConfig(guildId);
  const existing = config.ticketCategories.find((c) => c.type === type);
  if (existing) {
    await prisma.ticketCategoryConfig.deleteMany({ where: { guildId, categoryId: existing.categoryId } });
  }
  return refresh(guildId);
}

/**
 * Definit (remplace entierement) les roles de gestion d'une categorie de ticket, a partir
 * d'une selection multiple (RoleSelectMenu Discord, 0 a 25 roles). No-op si la categorie
 * n'existe pas (pas encore mappee).
 */
export async function setCategoryManagerRoles(guildId: string, categoryId: string, roleIds: string[]): Promise<GuildConfigWithCategories> {
  const config = await ensureGuildConfig(guildId);
  const category = config.ticketCategories.find((c) => c.categoryId === categoryId);
  if (!category) return config;

  await prisma.ticketCategoryConfig.update({
    where: { guildId_categoryId: { guildId, categoryId } },
    data: { managerRoleIds: roleIds },
  });
  return refresh(guildId);
}


/**
 * Definit le salon dedie au suivi des candidatures (recap + boutons Statut/S'assigner).
 * `null` revient au comportement par defaut (recap poste dans le salon du ticket).
 */
export async function setRecruitmentLogChannel(guildId: string, channelId: string | null): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.guildConfig.update({
    where: { guildId },
    data: { recruitmentLogChannelId: channelId },
  });
  return refresh(guildId);
}

/**
 * Ouvre ou ferme les recrutements pour cette guilde. Fermer n'affecte que les nouveaux
 * tickets RECRUITMENT (`onChannelCreate` affiche un message "recrutements fermes" au lieu
 * du bouton de formulaire) — les candidatures deja en cours ne sont pas impactees.
 */
export async function setRecruitmentOpen(guildId: string, open: boolean): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.guildConfig.update({
    where: { guildId },
    data: { recruitmentOpen: open },
  });
  return refresh(guildId);
}

/** Definit le salon designe pour les messages permanents du panneau d'administration. */
export async function setPanelChannel(guildId: string, channelId: string): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.guildConfig.update({
    where: { guildId },
    data: { panelChannelId: channelId },
  });
  return refresh(guildId);
}

/**
 * Definit (remplace entierement) les roles autorises a accepter/refuser les demandes
 * d'absence, a partir d'une selection multiple (RoleSelectMenu Discord, 0 a 25 roles).
 * Liste vide = personne configure (equivalent de l'ancien "retirer").
 */
export async function setAbsenceApproverRoles(guildId: string, roleIds: string[]): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.guildConfig.update({
    where: { guildId },
    data: { absenceApproverRoleIds: roleIds },
  });
  return refresh(guildId);
}

/** Definit le salon de suivi dedie aux demandes d'absence (separe du salon panneau). */
export async function setAbsenceReviewChannel(guildId: string, channelId: string): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.guildConfig.update({
    where: { guildId },
    data: { absenceReviewChannelId: channelId },
  });
  return refresh(guildId);
}

/** Retire le salon de suivi des demandes d'absence. */
export async function clearAbsenceReviewChannel(guildId: string): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.guildConfig.update({
    where: { guildId },
    data: { absenceReviewChannelId: null },
  });
  return refresh(guildId);
}

/**
 * Determine le type de ticket associe a une categorie Discord donnee, a partir d'une config
 * deja chargee. Retourne `null` si la categorie n'est pas suivie (pas de config, pas d'id,
 * ou categorie non mappee) — dans ce cas le bot doit ignorer completement le canal.
 */
export function getCategoryType(
  config: GuildConfigWithCategories | null,
  categoryId: string | null
): TicketType | null {
  if (!config || !categoryId) return null;
  return config.ticketCategories.find((c) => c.categoryId === categoryId)?.type ?? null;
}

/**
 * Indique si au moins un des roles donnes (typiquement ceux d'un membre) fait partie des
 * roles de gestion de la categorie d'un ticket donne. Remplace l'ancien `isStaffMember`
 * (role staff global) : la gestion est desormais scopee par categorie de ticket, chaque
 * categorie ayant sa propre equipe.
 */
export function isTicketManager(
  config: GuildConfigWithCategories | null,
  categoryId: string,
  memberRoleIds: string[]
): boolean {
  if (!config) return false;
  const category = config.ticketCategories.find((c) => c.categoryId === categoryId);
  if (!category) return false;
  return category.managerRoleIds.some((roleId) => memberRoleIds.includes(roleId));
}

/** Indique si un des roles donnes fait partie des roles approbateurs des demandes d'absence de cette guilde. */
export function isAbsenceApprover(config: GuildConfigWithCategories | null, memberRoleIds: string[]): boolean {
  if (!config?.absenceApproverRoleIds.length) return false;
  return config.absenceApproverRoleIds.some((roleId) => memberRoleIds.includes(roleId));
}

/**
 * Definit le jobId (cote script FiveM) sur lequel porte le monitoring de cette guilde — les
 * logs d'autres entreprises passant par les memes salons webhook sont ignores.
 */
export async function setMonitoringJobId(guildId: string, jobId: string): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.guildConfig.update({ where: { guildId }, data: { monitoringJobId: jobId } });
  return refresh(guildId);
}

/** Definit le role Discord ajoute a la prise de service, retire a la fin de service. */
export async function setOnDutyRole(guildId: string, roleId: string): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.guildConfig.update({ where: { guildId }, data: { onDutyRoleId: roleId } });
  return refresh(guildId);
}

/**
 * Definit (ou redefinit) le salon webhook surveille pour un type de log de monitoring donne.
 * Un seul salon par type et par guilde — meme simplification que `setCategoryForType`.
 */
export async function setMonitoringChannel(
  guildId: string,
  type: MonitoringLogType,
  channelId: string
): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.monitoringChannelConfig.upsert({
    where: { guildId_type: { guildId, type } },
    create: { guildId, type, channelId },
    update: { channelId },
  });
  return refresh(guildId);
}

/** Retire le salon surveille pour un type de log de monitoring donne. */
export async function clearMonitoringChannel(guildId: string, type: MonitoringLogType): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.monitoringChannelConfig.deleteMany({ where: { guildId, type } });
  return refresh(guildId);
}

/**
 * Definit (remplace entierement) le profil boutique affiche en pied des factures : RIB,
 * telephone, message de remerciement, capacite d'un camion (en kg, convertie en grammes pour
 * le stockage — voir `truckCapacityGrams`). Chaque champ absent/vide efface la valeur
 * existante (`null`) — un seul modal regroupe les 4 champs, voir `panel:service:set-shop-profile`.
 */
export async function setShopProfile(
  guildId: string,
  data: { rib: string | null; phone: string | null; thankYouMessage: string | null; truckCapacityKg: number | null }
): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.guildConfig.update({
    where: { guildId },
    data: {
      shopRib: data.rib,
      shopPhone: data.phone,
      shopThankYouMessage: data.thankYouMessage,
      truckCapacityGrams: data.truckCapacityKg !== null ? Math.round(data.truckCapacityKg * 1000) : null,
    },
  });
  return refresh(guildId);
}

/** Definit la banniere affichee en bas de chaque facture — sur le CDN en production, sur disque local en dev (voir `storeImage`). */
export async function setShopBanner(
  guildId: string,
  data: Buffer,
  attachment: { contentType?: string | null; name?: string | null }
): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  const stored = await storeImage(`shop-banners/${guildId}`, data, attachment);
  await prisma.guildConfig.update({
    where: { guildId },
    data: { shopBannerUrl: stored.url, shopBannerFilename: attachment.name ?? "banniere.png" },
  });
  return refresh(guildId);
}

/** Retire la banniere des factures, y compris sur le CDN/disque local si elle y etait (voir `deleteStoredImage`). */
export async function clearShopBanner(guildId: string): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await deleteStoredImage(`shop-banners/${guildId}`);
  await prisma.guildConfig.update({ where: { guildId }, data: { shopBannerUrl: null, shopBannerFilename: null } });
  return refresh(guildId);
}

/** Definit la categorie vers laquelle deplacer le salon d'une candidature acceptee. */
export async function setRecruitmentAcceptedCategory(guildId: string, categoryId: string): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.guildConfig.update({ where: { guildId }, data: { recruitmentAcceptedCategoryId: categoryId } });
  return refresh(guildId);
}

/** Retire le deplacement automatique de salon a l'acceptation d'une candidature. */
export async function clearRecruitmentAcceptedCategory(guildId: string): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.guildConfig.update({ where: { guildId }, data: { recruitmentAcceptedCategoryId: null } });
  return refresh(guildId);
}

/** Definit le role ajoute automatiquement au candidat quand sa candidature est acceptee. */
export async function setRecruitmentAcceptedRole(guildId: string, roleId: string): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.guildConfig.update({ where: { guildId }, data: { recruitmentAcceptedRoleId: roleId } });
  return refresh(guildId);
}

/** Retire l'ajout automatique de role a l'acceptation d'une candidature. */
export async function clearRecruitmentAcceptedRole(guildId: string): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.guildConfig.update({ where: { guildId }, data: { recruitmentAcceptedRoleId: null } });
  return refresh(guildId);
}

/**
 * Definit le salon ou poster le message permanent de statut des recrutements. Le message
 * lui-meme (cree/edite en place) est gere par `refreshRecruitmentStatusMessage` (voir
 * `recruitmentLogService.ts`), pas ici — cette fonction ne touche que la configuration.
 */
export async function setRecruitmentStatusChannel(guildId: string, channelId: string): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  // Changer de salon invalide l'ancien messageId (il vit dans l'ancien salon) : un nouveau
  // message sera poste dans le nouveau salon au prochain refresh.
  await prisma.guildConfig.update({
    where: { guildId },
    data: { recruitmentStatusChannelId: channelId, recruitmentStatusMessageId: null },
  });
  return refresh(guildId);
}

/** Retire le salon de statut recrutement : arrete les mises a jour, ne supprime pas le dernier message poste. */
export async function clearRecruitmentStatusChannel(guildId: string): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.guildConfig.update({
    where: { guildId },
    data: { recruitmentStatusChannelId: null, recruitmentStatusMessageId: null },
  });
  return refresh(guildId);
}

/** Memorise l'id du message de statut recrutement, pour pouvoir l'editer en place la prochaine fois. */
export async function setRecruitmentStatusMessageId(guildId: string, messageId: string): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.guildConfig.update({ where: { guildId }, data: { recruitmentStatusMessageId: messageId } });
  return refresh(guildId);
}
