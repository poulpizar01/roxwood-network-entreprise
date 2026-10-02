import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";

/**
 * Contrat commun a toutes les commandes slash du bot (voir src/commands/*.ts).
 * `data` decrit la commande pour l'enregistrement aupres de l'API Discord (nom, description,
 * sous-commandes/options), `execute` contient la logique declenchee quand un utilisateur
 * l'invoque. Chaque fichier de commande exporte un objet conforme a cette interface, et
 * `src/commands/index.ts` les rassemble dans un registre unique.
 *
 * `autocomplete` est optionnel : a fournir seulement si la commande a une option marquee
 * `.setAutocomplete(true)` (ex: choisir un article de catalogue par nom plutot que de
 * devoir connaitre/copier son id).
 */
export interface Command {
  data: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction): Promise<void>;
}
