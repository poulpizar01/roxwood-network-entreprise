import type { NonThreadGuildBasedChannel, PermissionOverwrites } from "discord.js";
import type { Ticket, TicketType } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";

/**
 * Service central du cycle de vie d'un ticket : creation/detection, fermeture, suivi d'activite.
 * Ticket Tool n'ayant pas d'API, tout est deduit d'evenements Discord (voir src/events/).
 */

/**
 * Devine l'utilisateur ayant ouvert le ticket a partir des permission overwrites du canal.
 * Ticket Tool accorde un acces explicite (overwrite de type "membre") au client qui ouvre
 * le ticket ; on prend donc le premier overwrite de type membre qui n'est pas le bot lui-meme.
 * Best-effort : retourne `null` si aucun overwrite pertinent n'est trouve.
 */
function guessOpenerId(channel: NonThreadGuildBasedChannel): string | null {
  const botUserId = channel.client.user?.id;
  const overwrites = [...channel.permissionOverwrites.cache.values()] as PermissionOverwrites[];
  // type === 1 correspond a OverwriteType.Member (0 = Role) dans discord.js.
  const memberOverwrite = overwrites.find((overwrite) => overwrite.type === 1 && overwrite.id !== botUserId);
  return memberOverwrite?.id ?? null;
}

/**
 * Enregistre un nouveau canal comme ticket suivi, si ce n'est pas deja fait.
 * Appele depuis `onChannelCreate` une fois qu'on sait (via `getCategoryType`) que la
 * categorie du canal correspond a un type de ticket connu (RECRUITMENT ou SERVICE).
 *
 * @param channel - canal Discord nouvellement cree
 * @param categoryId - id de la categorie parente (deja verifiee comme suivie par l'appelant)
 * @param type - type de ticket determine par la config de la guilde
 * @returns le `Ticket` cree, ou `null` si ce canal etait deja suivi (evite les doublons
 *   si l'evenement channelCreate est re-livre par Discord)
 */
export async function trackTicketChannel(
  channel: NonThreadGuildBasedChannel,
  categoryId: string,
  type: TicketType
): Promise<Ticket | null> {
  const existing = await prisma.ticket.findUnique({ where: { channelId: channel.id } });
  if (existing) return null;

  const ticket = await prisma.ticket.create({
    data: {
      guildId: channel.guildId,
      channelId: channel.id,
      categoryId,
      type,
      openerId: guessOpenerId(channel),
    },
  });

  logger.info(`Nouveau ticket suivi (${type}) : ${channel.id} (guild ${channel.guildId})`);

  return ticket;
}

/**
 * Marque un ticket comme ferme (statut CLOSED + horodatage). No-op silencieux si le canal
 * n'est pas un ticket suivi, ou s'il est deja marque ferme (evite les doubles traitements si
 * plusieurs signaux de fermeture se declenchent, ex: renommage puis suppression du canal).
 */
export async function markTicketClosed(channelId: string, guildId: string): Promise<void> {
  const ticket = await prisma.ticket.findUnique({ where: { channelId } });
  if (!ticket || ticket.status === "CLOSED") return;

  await prisma.ticket.update({
    where: { channelId },
    data: { status: "CLOSED", closedAt: new Date() },
  });

  logger.info(`Ticket ferme : ${channelId} (guild ${guildId})`);
}

/**
 * Renseigne `firstStaffReplyAt` la premiere fois qu'un membre du staff repond dans le ticket.
 * La clause `firstStaffReplyAt: null` dans le `where` rend l'operation idempotente : les
 * appels suivants (2e, 3e reponse staff...) ne modifient plus rien.
 */
export async function recordFirstStaffReply(channelId: string): Promise<void> {
  await prisma.ticket.updateMany({
    where: { channelId, firstStaffReplyAt: null },
    data: { firstStaffReplyAt: new Date() },
  });
}

/**
 * Recupere le ticket associe a un canal Discord, ou `undefined`/`null` si ce canal n'est pas
 * suivi. Point d'entree utilise par la quasi-totalite des commandes et handlers d'interaction
 * pour savoir "sur quel ticket suis-je en train d'agir ?".
 */
export async function getTicketByChannel(channelId: string) {
  return prisma.ticket.findUnique({
    where: { channelId },
  });
}

/**
 * Recupere un ticket par son id (pas son channelId). Utilise quand l'interaction ne se
 * produit pas dans le salon du ticket lui-meme — ex: boutons Statut/S'assigner sur le
 * message poste dans le salon dedie "suivi recrutement" — auquel cas l'id du ticket est
 * encode dans le `customId` du composant plutot que deduit du salon courant.
 */
export async function getTicketById(ticketId: string) {
  return prisma.ticket.findUnique({
    where: { id: ticketId },
  });
}

/**
 * Retrouve le ticket de candidature le plus recent ouvert par un Discord donne (utilise par
 * le monitoring pour rattacher un log d'embauche externe (`targetPlayerDiscord`) a une
 * candidature deja en cours, si elle existe — voir `monitoringService.ts`).
 */
export async function findLatestRecruitmentTicketByOpener(guildId: string, openerId: string) {
  return prisma.ticket.findFirst({
    where: { guildId, openerId, type: "RECRUITMENT" },
    orderBy: { createdAt: "desc" },
  });
}
