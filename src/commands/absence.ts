import { ActionRowBuilder, ModalBuilder, SlashCommandBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import type { Command } from "./types.js";

/**
 * `/absence` : accessible a tout le monde (pas de `setDefaultMemberPermissions`), contrairement
 * aux autres commandes qui sont des outils d'administration. Declarer une absence est une
 * action personnelle, pas une action sur la config du serveur — elle n'a donc pas sa place
 * en tant que bouton dans le salon du panneau d'administration (potentiellement invisible aux
 * membres non-staff). Ouvre le meme modal que gererait un bouton, traite ensuite par
 * `handleAbsenceSubmitForm` dans `interactionCreate.ts` (customId `absence:submit-form`).
 */
export const absenceCommand: Command = {
  data: new SlashCommandBuilder().setName("absence").setDescription("Déclarer une absence") as SlashCommandBuilder,

  async execute(interaction) {
    if (!interaction.inGuild()) return;

    const modal = new ModalBuilder().setCustomId("absence:submit-form").setTitle("Déclarer une absence");
    const startInput = new TextInputBuilder()
      .setCustomId("startDate")
      .setLabel("Date de début (JJ/MM/AAAA)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);
    const endInput = new TextInputBuilder()
      .setCustomId("endDate")
      .setLabel("Date de fin (JJ/MM/AAAA)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);
    const reasonInput = new TextInputBuilder().setCustomId("reason").setLabel("Motif").setStyle(TextInputStyle.Paragraph).setRequired(true);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(startInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(endInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput)
    );
    await interaction.showModal(modal);
  },
};
