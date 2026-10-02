import type { AbsenceRequest, AbsenceStatus } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { dispatchWebhook } from "./webhookDispatcher.js";

/**
 * Service dedie aux demandes d'absence : declarees par un membre via le panneau
 * ("Absences" -> "Declarer une absence"), validees ensuite par le role approbateur
 * configure (voir `guildConfigService.isAbsenceApprover`).
 */

/** Format attendu pour les dates saisies dans le modal de declaration. */
const DATE_REGEX = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/**
 * Parse une date au format `JJ/MM/AAAA` saisie dans un modal (simple champ texte, Discord
 * n'a pas de selecteur de date natif). Retourne `null` si le format ou la date elle-meme
 * est invalide (ex: `31/02/2026`) — a l'appelant de rejeter poliment plutot que de planter.
 */
export function parseFrenchDate(input: string): Date | null {
  const match = DATE_REGEX.exec(input.trim());
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  // `Date` normalise silencieusement les dates hors bornes (ex: 31/02 -> 3 mars) : on
  // verifie que les composants n'ont pas ete alteres pour detecter une date invalide.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;

  return date;
}

/** Formate une date au format `JJ/MM/AAAA` pour l'affichage dans l'embed de suivi. */
export function formatFrenchDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const year = date.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

/**
 * Envoie l'etat complet et courant d'une demande (declaration ou resolution, meme forme dans
 * les deux cas) sur l'unique evenement `absence.updated` — un recepteur qui construit un
 * planning n'a donc qu'un type d'evenement a ecouter pour toujours avoir la derniere version
 * de n'importe quelle demande, sans avoir a fusionner plusieurs evenements lui-meme.
 */
async function dispatchAbsenceUpdated(request: AbsenceRequest): Promise<void> {
  await dispatchWebhook(request.guildId, "absence.updated", {
    requestId: request.id,
    requesterId: request.requesterId,
    startDate: request.startDate.toISOString(),
    endDate: request.endDate.toISOString(),
    reason: request.reason,
    status: request.status,
    resolverId: request.resolverId,
    resolvedAt: request.resolvedAt?.toISOString() ?? null,
  });
}

/** Cree une demande d'absence (statut PENDING par defaut). */
export async function createAbsenceRequest(
  guildId: string,
  requesterId: string,
  startDate: Date,
  endDate: Date,
  reason: string
) {
  const request = await prisma.absenceRequest.create({ data: { guildId, requesterId, startDate, endDate, reason } });
  await dispatchAbsenceUpdated(request);
  return request;
}

/** Memorise ou vit le message de suivi, pour pouvoir l'editer en place a la resolution. */
export async function saveAbsenceMessageRef(id: string, messageId: string) {
  return prisma.absenceRequest.update({ where: { id }, data: { messageId } });
}

/**
 * Accepte ou refuse une demande d'absence encore en attente. `updateMany` avec `status:
 * "PENDING"` dans le `where` (pas un `findUnique` + `update` separes) rend l'operation
 * atomique : si deux membres du staff cliquent Accepter/Refuser sur la meme demande presque
 * simultanement, un seul appel trouve effectivement une ligne PENDING a modifier — l'autre
 * recoit `null` et sait qu'il est arrive trop tard, sans ecraser la decision du premier.
 */
export async function resolveAbsenceRequest(id: string, resolverId: string, status: AbsenceStatus) {
  const { count } = await prisma.absenceRequest.updateMany({
    where: { id, status: "PENDING" },
    data: { status, resolverId, resolvedAt: new Date() },
  });
  if (count === 0) return null;

  const request = await prisma.absenceRequest.findUniqueOrThrow({ where: { id } });
  await dispatchAbsenceUpdated(request);
  return request;
}

/** Recupere une demande d'absence par son id, ou `null` si elle n'existe pas. */
export async function getAbsenceRequest(id: string) {
  return prisma.absenceRequest.findUnique({ where: { id } });
}
