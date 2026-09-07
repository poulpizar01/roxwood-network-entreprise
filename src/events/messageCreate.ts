import type { Message } from "discord.js";
import { getGuildConfig, isTicketManager } from "../services/guildConfigService.js";
import { getTicketByChannel, recordFirstStaffReply } from "../services/ticketService.js";
import { ingestMonitoringMessage } from "../services/monitoringService.js";
import { logger } from "../utils/logger.js";

/**
 * Handler de l'evenement `messageCreate`. Deux responsabilites bien separees :
 *
 * A. Si le salon est un salon de monitoring configure (logs webhook FiveM, voir
 *    `monitoringService.ts`), le message y est entierement traite et le reste de ce handler
 *    est court-circuite — un salon de monitoring n'est jamais un salon de ticket.
 *
 * B. Sinon, restreint aux canaux qui sont des tickets suivis et encore ouverts :
 * 1. supprimer les messages purement informatifs postes par d'autres bots pour garder le
 *    salon propre autour de notre propre intro — mais jamais un message qui porte un bouton
 *    ou un menu (typiquement le bouton "Close" de Ticket Tool) : impossible de simuler un
 *    clic sur un composant d'un autre bot (Discord ne le permet pas), donc ce bouton reste
 *    le seul moyen reel de fermer un ticket cote Ticket Tool et doit rester accessible au staff ;
 * 2. detecter la premiere reponse d'un membre du staff.
 *
 * Les pieces jointes d'une candidature de recrutement ne sont plus traitees ici au fil des
 * messages : le candidat clique "J'ai terminé d'envoyer mes fichiers" une fois ses fichiers
 * envoyes, ce qui declenche un chargement en une seule fois (voir `handleRecruitmentFinishAttachments`
 * dans `interactionCreate.ts` et `finalizeRecruitmentAttachments` dans `recruitmentLogService.ts`).
 *
 * Ignore les messages hors guilde (DMs).
 */
export async function onMessageCreate(message: Message): Promise<void> {
  if (!message.inGuild()) return;

  if (await ingestMonitoringMessage(message)) return;

  const ticket = await getTicketByChannel(message.channelId);
  if (!ticket || ticket.status !== "OPEN") return;

  if (message.author.bot) {
    // Necessite la permission Discord "Gerer les messages" sur le role du bot ; echoue
    // silencieusement (juste logge) sinon.
    if (message.author.id !== message.client.user?.id && message.components.length === 0) {
      await message.delete().catch((error) => logger.warn(`Echec suppression du message de ${message.author.id} dans ${message.channelId}`, error));
    }
    return;
  }

  const config = await getGuildConfig(message.guildId);
  const memberRoleIds = message.member ? [...message.member.roles.cache.keys()] : [];
  const authorIsStaff = isTicketManager(config, ticket.categoryId, memberRoleIds);

  if (authorIsStaff) {
    await recordFirstStaffReply(message.channelId);
  }
}
