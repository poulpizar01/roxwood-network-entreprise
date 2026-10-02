import type { MessageReaction, PartialMessageReaction, User, PartialUser } from "discord.js";
import { PANEL_DELETE_EMOJI, clearPanelMessageRef, findPanelMessageByMessageId } from "../services/panelService.js";
import { logger } from "../utils/logger.js";

/**
 * Handler de l'evenement `messageReactionAdd`, dedie a la reaction "poubelle" posee par le
 * bot sur ses messages dedies du panneau (voir `panelService.upsertPanelMessage`). Reagir
 * avec cet emoji supprime le message et oublie sa reference en base — le message ROOT n'a
 * jamais cette reaction (voir `PANEL_DELETE_EMOJI`), donc il ne peut pas etre supprime ainsi.
 * Ignore tout le reste (reactions du bot lui-meme, autres emojis, messages non lies au panneau).
 */
export async function onMessageReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser
): Promise<void> {
  if (user.bot || reaction.emoji.name !== PANEL_DELETE_EMOJI) return;

  try {
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    if (!message.guildId) return;

    const panelMessage = await findPanelMessageByMessageId(message.guildId, message.id);
    if (!panelMessage || panelMessage.key === "ROOT") return;

    await message.delete().catch(() => undefined);
    await clearPanelMessageRef(message.guildId, panelMessage.key);
  } catch (error) {
    logger.error("Erreur lors du traitement d'une reaction de suppression sur le panneau", error);
  }
}
