import { ChannelType, type DMChannel, type NonThreadGuildBasedChannel } from "discord.js";
import { markTicketClosed } from "../services/ticketService.js";
import { logger } from "../utils/logger.js";

// Heuristique secondaire : certaines configs Ticket Tool renomment le canal
// (ex: prefixe "closed-" / "ferme-") au lieu de le supprimer. A confirmer sur le vrai serveur.
/** Prefixes de nom de canal consideres comme un signal de fermeture (comparaison insensible a la casse). */
const CLOSED_NAME_PREFIXES = ["closed-", "ferme-", "fermé-"];

/**
 * Signal secondaire de fermeture d'un ticket : si un canal suivi est renomme avec un
 * prefixe "ferme" connu, on le traite comme ferme meme s'il n'est pas supprime. Ignore
 * tout evenement qui n'est pas un vrai changement de nom sur un salon texte (ex: changement
 * de permissions, de topic...), pour eviter des appels DB inutiles.
 */
export async function onChannelUpdate(
  oldChannel: DMChannel | NonThreadGuildBasedChannel,
  newChannel: DMChannel | NonThreadGuildBasedChannel
): Promise<void> {
  if (newChannel.type !== ChannelType.GuildText) return;
  if (oldChannel.type !== ChannelType.GuildText) return;
  if (oldChannel.name === newChannel.name) return;

  const looksClosed = CLOSED_NAME_PREFIXES.some((prefix) => newChannel.name.toLowerCase().startsWith(prefix));
  if (!looksClosed) return;

  try {
    await markTicketClosed(newChannel.id, newChannel.guildId);
  } catch (error) {
    logger.error(`Erreur lors de la fermeture (renommage) du ticket ${newChannel.id}`, error);
  }
}
