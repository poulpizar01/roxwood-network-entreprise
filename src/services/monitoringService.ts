import type { Message } from "discord.js";
import type { MonitoringLogType } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { getGuildConfig } from "./guildConfigService.js";
import { findLatestRecruitmentTicketByOpener } from "./ticketService.js";
import { getApplicationSummary, setStatus as setApplicationStatus } from "./recruitmentService.js";
import { applyRecruitmentAcceptance, refreshRecruitmentLogMessage } from "./recruitmentLogService.js";
import { getItemStock, recordSafeMovement } from "./monitoringSafeService.js";
import { dispatchWebhook, type WebhookEventType } from "./webhookDispatcher.js";
import {
  parseInvoice,
  parseRecruitment,
  parseSafe,
  parseSale,
  parseShift,
  type RecruitmentParseResult,
  type SafeParseResult,
  type ShiftParseResult,
} from "./monitoringParsers.js";
import { logger } from "../utils/logger.js";

/**
 * Ingestion des logs webhook FiveM (voir `MonitoringChannelConfig`) : detecte si un message
 * arrive dans un salon de monitoring configure, parse son embed, applique les effets de bord
 * specifiques au type (role "en service", finalisation de candidature, ledger de coffre), et
 * relaie toujours l'evenement brut (stockage + webhook sortant) meme quand le parsing du
 * texte libre echoue — voir le detail des motifs geres dans `monitoringParsers.ts`.
 */

const WEBHOOK_EVENT_BY_TYPE: Record<MonitoringLogType, WebhookEventType> = {
  SHIFT: "monitoring.duty",
  RECRUITMENT: "monitoring.recruitment",
  SAFE: "monitoring.storage",
  INVOICE: "monitoring.invoice",
  SALE: "monitoring.sale",
};

/**
 * Point d'entree appele par `messageCreate.ts` avant toute logique de ticket (un salon de
 * monitoring n'est jamais un salon de ticket). Retourne `true` si le message a ete reconnu
 * comme un log de monitoring (que le parsing/les effets de bord aient reussi ou non) — dans
 * ce cas l'appelant doit s'arreter la, `false` sinon (laisser le traitement normal continuer).
 *
 * Toute la fonction est enveloppee dans un try/catch : `messageCreate` est un listener
 * d'evenement discord.js, et une exception non rattrapee ici tuerait tout le process (voir
 * le correctif `captureRejections` dans `index.ts`) — mieux vaut logger et ignorer ce log
 * precis que de faire planter le bot pour toutes les guildes.
 */
export async function ingestMonitoringMessage(message: Message<true>): Promise<boolean> {
  try {
    const config = await getGuildConfig(message.guildId);
    if (!config || !config.monitoringJobId) return false;

    const channelConfig = config.monitoringChannels.find((c) => c.channelId === message.channelId);
    if (!channelConfig) return false;

    if (message.embeds.length === 0) return false;

    // Le webhook FiveM peut regrouper plusieurs evenements (ex: fin de service + prise de
    // service consecutives) dans un seul message Discord portant plusieurs embeds — il faut
    // donc tous les traiter, pas seulement le premier (`message.embeds[0]`), sous peine de
    // perdre silencieusement les evenements suivants et de desynchroniser les effets de bord
    // (ex: le role "en service" se retrouve retire par le dernier embed traite au lieu du
    // dernier evenement reellement survenu).
    for (const embed of message.embeds) {
      const description = embed.description ?? "";
      const fields = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));

      if (fields.jobId !== config.monitoringJobId) continue;

      const parsed = parseByType(channelConfig.type, description);
      if (!parsed) {
        logger.warn(`Log de monitoring ${channelConfig.type} non reconnu (guilde ${message.guildId}) : "${description}"`);
      }

      await prisma.monitoringEvent.create({
        data: {
          guildId: message.guildId,
          type: channelConfig.type,
          rawFields: { ...fields, description, parsed: parsed ?? null },
        },
      });

      // Certains effets de bord calculent une donnee derivee utile au webhook sortant (ex: le
      // niveau de stock apres un mouvement de coffre) que le parsing seul ne peut pas connaitre
      // (il faut interroger la base) — fusionnee dans `parsed` plutot que d'exposer un objet
      // separe, le recepteur externe n'a qu'un seul endroit a regarder pour les donnees calculees.
      let sideEffectExtra: Record<string, unknown> | undefined;
      if (parsed) {
        sideEffectExtra = await applySideEffect(message, config, channelConfig.type, fields, parsed);
      }

      await dispatchWebhook(message.guildId, WEBHOOK_EVENT_BY_TYPE[channelConfig.type], {
        ...fields,
        description,
        parsed: parsed ? { ...parsed, ...sideEffectExtra } : null,
      });
    }

    return true;
  } catch (error) {
    logger.error(`Erreur lors de l'ingestion d'un log de monitoring dans ${message.channelId}`, error);
    return true;
  }
}

function parseByType(type: MonitoringLogType, description: string) {
  switch (type) {
    case "SHIFT":
      return parseShift(description);
    case "RECRUITMENT":
      return parseRecruitment(description);
    case "SAFE":
      return parseSafe(description);
    case "INVOICE":
      return parseInvoice(description);
    case "SALE":
      return parseSale(description);
  }
}

async function applySideEffect(
  message: Message<true>,
  config: NonNullable<Awaited<ReturnType<typeof getGuildConfig>>>,
  type: MonitoringLogType,
  fields: Record<string, string>,
  parsed: NonNullable<ReturnType<typeof parseByType>>
): Promise<Record<string, unknown> | undefined> {
  // `type` (deduit du salon, voir `ingestMonitoringMessage`) et `parsed` (issu de
  // `parseByType(type, ...)`) sont deux parametres distincts du point de vue de TypeScript,
  // qui ne peut pas prouver leur correlation — on force le type ici plutot que de compter sur
  // un narrowing structurel par `in`, la correlation etant garantie par construction (meme
  // `type` utilise dans `parseByType` juste avant l'appel).
  if (type === "SHIFT") {
    const shift = parsed as ShiftParseResult;
    if (!config.onDutyRoleId || !fields.playerDiscord) return;
    try {
      const member = await message.guild.members.fetch(fields.playerDiscord);
      if (shift.direction === "in") await member.roles.add(config.onDutyRoleId);
      else await member.roles.remove(config.onDutyRoleId);
      logger.info(
        `Role "en service" ${shift.direction === "in" ? "ajoute a" : "retire de"} ${fields.playerDiscord} (guilde ${message.guildId})`
      );
    } catch (error) {
      logger.warn(`Echec de bascule du role "en service" pour ${fields.playerDiscord}`, error);
    }
    return;
  }

  if (type === "RECRUITMENT") {
    const recruitment = parsed as RecruitmentParseResult;
    if (recruitment.action !== "hired" || !fields.targetPlayerDiscord) return;

    const ticket = await findLatestRecruitmentTicketByOpener(message.guildId, fields.targetPlayerDiscord);
    if (!ticket) return;

    const application = await getApplicationSummary(ticket.id);
    if (!application || application.status === "ACCEPTED") return;

    await setApplicationStatus(ticket.id, "ACCEPTED");
    await refreshRecruitmentLogMessage(message.client, ticket.id);
    await applyRecruitmentAcceptance(message.client, ticket.id);
    return;
  }

  if (type === "SAFE") {
    const safe = parsed as SafeParseResult;
    if (!fields.targetPosition || !fields.itemId) return;
    const signedQuantity = safe.direction === "in" ? safe.quantity : -safe.quantity;
    const movement = await recordSafeMovement(message.guildId, fields.targetPosition, fields.itemId, signedQuantity, {
      discordId: fields.playerDiscord,
      name: fields.playerName,
    });
    const stockAfter = await getItemStock(movement.safeId, fields.itemId);
    return { stockAfter };
  }

  return undefined;
}
