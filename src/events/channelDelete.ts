import { ChannelType, type DMChannel, type NonThreadGuildBasedChannel } from "discord.js";
import { markTicketClosed } from "../services/ticketService.js";
import { logger } from "../utils/logger.js";

/**
 * Signal principal de fermeture d'un ticket : Ticket Tool supprime le canal a la fermeture
 * (dans la config par defaut). `markTicketClosed` est lui-meme un no-op si ce canal n'etait
 * pas un ticket suivi, donc aucune verification supplementaire n'est necessaire ici.
 */
export async function onChannelDelete(channel: DMChannel | NonThreadGuildBasedChannel): Promise<void> {
  if (channel.type !== ChannelType.GuildText) return;

  try {
    await markTicketClosed(channel.id, channel.guildId);
  } catch (error) {
    logger.error(`Erreur lors de la fermeture du ticket ${channel.id}`, error);
  }
}
