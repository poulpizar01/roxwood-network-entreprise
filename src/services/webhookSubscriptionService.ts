import { randomBytes } from "node:crypto";
import { prisma } from "../db/prisma.js";
import type { WebhookEventType } from "./webhookDispatcher.js";

/**
 * Gestion des abonnements webhook sortants (`WebhookSubscription`) — jusqu'ici cette table
 * n'etait lue que par `webhookDispatcher.ts`, sans aucune commande/UI pour en creer :
 * ce service comble ce manque pour que l'utilisateur (sans acces direct a la base) puisse
 * en gerer depuis le panneau (voir "Monitoring" -> "Ajouter/Retirer un webhook").
 */

/**
 * Cree un nouvel abonnement avec un secret genere aleatoirement, retourne le secret en clair
 * (a n'afficher qu'une seule fois a l'utilisateur — il n'est plus jamais reaffiche ensuite).
 * `label` n'a de sens que pour les abonnements "custom" (voir le schema) : les evenements
 * integres du bot sont deja identifies sans ambiguite par leur `eventType`.
 */
export async function createSubscription(guildId: string, eventType: WebhookEventType, url: string, label?: string) {
  const secret = randomBytes(32).toString("hex");
  const subscription = await prisma.webhookSubscription.create({
    data: { guildId, eventType, url, secret, label },
  });
  return { subscription, secret };
}

/** Liste les abonnements d'une guilde. */
export async function listSubscriptions(guildId: string) {
  return prisma.webhookSubscription.findMany({ where: { guildId }, orderBy: { createdAt: "asc" } });
}

/** Liste uniquement les abonnements "custom" d'une guilde — utilise pour choisir la cible d'un envoi manuel. */
export async function listCustomSubscriptions(guildId: string) {
  return prisma.webhookSubscription.findMany({ where: { guildId, eventType: "custom" }, orderBy: { createdAt: "asc" } });
}

/** Supprime un abonnement. No-op si l'id n'existe pas ou n'appartient pas a cette guilde. */
export async function removeSubscription(guildId: string, id: string) {
  await prisma.webhookSubscription.deleteMany({ where: { id, guildId } });
}
