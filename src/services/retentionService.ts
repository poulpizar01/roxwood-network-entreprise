import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";

/**
 * Purge periodique des donnees qui n'ont pas vocation a s'accumuler indefiniment. Deux cibles,
 * chacune avec sa propre justification :
 *
 * - `MonitoringEvent` : journal brut de chaque log FiveM traite, jamais relu nulle part dans
 *   le code (audit/rejeu uniquement) — sur un serveur RP actif, plusieurs milliers de lignes
 *   par jour ecrites pour rien au-dela d'une fenetre de retention raisonnable.
 * - `RecruitmentAttachment` : les octets des pieces jointes de candidature restent en base
 *   pour toujours par defaut, meme apres fermeture du ticket, alors que plus personne n'a de
 *   raison d'y acceder passe un delai raisonnable.
 *
 * Ne touche jamais `MonitoringSafeMovement` (ledger de stock des coffres) : contrairement a
 * `MonitoringEvent`, ces lignes sont sommees a la demande pour calculer le stock courant
 * (`monitoringSafeService.getItemStock`) — en supprimer sans d'abord figer un solde de report
 * fausserait silencieusement le stock affiche. A traiter separement si besoin (ex: solde de
 * report mensuel), hors perimetre ici.
 */

const MONITORING_EVENT_RETENTION_DAYS = 90;
const RECRUITMENT_ATTACHMENT_RETENTION_DAYS = 30;
const RETENTION_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function purgeOldMonitoringEvents(): Promise<number> {
  const { count } = await prisma.monitoringEvent.deleteMany({
    where: { createdAt: { lt: daysAgo(MONITORING_EVENT_RETENTION_DAYS) } },
  });
  return count;
}

async function purgeOldRecruitmentAttachments(): Promise<number> {
  const { count } = await prisma.recruitmentAttachment.deleteMany({
    where: {
      application: {
        ticket: {
          status: "CLOSED",
          closedAt: { lt: daysAgo(RECRUITMENT_ATTACHMENT_RETENTION_DAYS) },
        },
      },
    },
  });
  return count;
}

/** Execute une passe de purge complete. Chaque cible est independante : l'echec de l'une n'empeche pas l'autre. */
export async function runRetentionJob(): Promise<void> {
  try {
    const count = await purgeOldMonitoringEvents();
    if (count > 0) logger.info(`Retention : ${count} MonitoringEvent(s) de plus de ${MONITORING_EVENT_RETENTION_DAYS}j supprime(s)`);
  } catch (error) {
    logger.error("Echec de la purge des MonitoringEvent", error);
  }

  try {
    const count = await purgeOldRecruitmentAttachments();
    if (count > 0) {
      logger.info(
        `Retention : ${count} RecruitmentAttachment(s) de ticket(s) ferme(s) depuis plus de ${RECRUITMENT_ATTACHMENT_RETENTION_DAYS}j supprime(s)`
      );
    }
  } catch (error) {
    logger.error("Echec de la purge des RecruitmentAttachment", error);
  }
}

/**
 * Demarre le sondage periodique (toutes les 24h, la retention n'a pas besoin d'etre plus
 * reactive) — a appeler une seule fois au demarrage du bot (voir `ready.ts`). Verrou de
 * re-entrance : une purge trop longue (grosse volumetrie au premier lancement) ne doit jamais
 * se chevaucher avec la suivante.
 */
export function startRetentionPolling(): void {
  let isRunning = false;
  setInterval(() => {
    if (isRunning) return;
    isRunning = true;
    runRetentionJob()
      .catch((error) => logger.error("Erreur inattendue lors de la purge de retention", error))
      .finally(() => {
        isRunning = false;
      });
  }, RETENTION_POLL_INTERVAL_MS);
}
