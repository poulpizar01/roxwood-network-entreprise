import { prisma } from "../db/prisma.js";

/**
 * Ledger des mouvements de coffre d'entreprise (`MonitoringSafe`/`MonitoringSafeMovement`),
 * alimente par `monitoringService.ingestMonitoringMessage` sur les logs de type SAFE. Pas de
 * lecture cote Discord (l'ancienne commande `/stock` a ete retiree — accessible a tout membre
 * du serveur sans role requis, jugee trop exposee pour une donnee d'entreprise) : le stock
 * n'est aujourd'hui consultable que via le webhook sortant `monitoring.storage` (voir
 * `webhookDispatcher.ts`), cote site externe.
 */

/**
 * Retrouve le coffre correspondant a une position (le cree s'il n'existe pas encore — premier
 * mouvement observe sur ce coffre).
 */
async function findOrCreateSafe(guildId: string, positionKey: string) {
  return prisma.monitoringSafe.upsert({
    where: { guildId_positionKey: { guildId, positionKey } },
    create: { guildId, positionKey },
    update: {},
  });
}

/** Enregistre un mouvement (depot positif ou retrait negatif) sur le coffre identifie par sa position. */
export async function recordSafeMovement(
  guildId: string,
  positionKey: string,
  itemId: string,
  quantity: number,
  player: { discordId?: string; name?: string }
) {
  const safe = await findOrCreateSafe(guildId, positionKey);
  return prisma.monitoringSafeMovement.create({
    data: {
      safeId: safe.id,
      itemId,
      quantity,
      playerDiscordId: player.discordId,
      playerName: player.name,
    },
  });
}

/**
 * Stock courant d'un seul item dans un coffre, juste apres un mouvement — utilise pour
 * enrichir le webhook sortant `monitoring.storage` d'un niveau de stock plutot que du seul
 * mouvement ponctuel (voir `monitoringService.applySideEffect`).
 */
export async function getItemStock(safeId: string, itemId: string): Promise<number> {
  const result = await prisma.monitoringSafeMovement.aggregate({
    where: { safeId, itemId },
    _sum: { quantity: true },
  });
  return result._sum.quantity ?? 0;
}
