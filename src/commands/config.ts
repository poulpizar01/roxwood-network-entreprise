import { PermissionFlagsBits, SlashCommandBuilder, ChannelType } from "discord.js";
import type { Command } from "./types.js";
import { setPanelChannel } from "../services/guildConfigService.js";
import { refreshRootPanelMessage } from "../services/panelService.js";

/**
 * `/config` : commande d'administration (reservee `ManageGuild`). La majorite des reglages
 * (categories de tickets, roles de gestion, catalogue, recrutement...) se font desormais via
 * le panneau par boutons (voir `panelService.ts`, `interactionCreate.ts` prefixe `panel:`) —
 * `set-panel-channel` designe justement le salon qui l'accueille. Seuls les reglages pas
 * encore migres vers le panneau restent des commandes slash pour cette phase.
 */
export const configCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("config")
    .setDescription("Configurer la sur-couche de tickets pour ce serveur")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName("set-panel-channel")
        .setDescription("Salon qui accueille le panneau d'administration par boutons")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Salon du panneau")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    ) as SlashCommandBuilder,

  async execute(interaction) {
    if (!interaction.inGuild()) return;
    const sub = interaction.options.getSubcommand();

    if (sub === "set-panel-channel") {
      const channel = interaction.options.getChannel("channel", true);
      await setPanelChannel(interaction.guildId, channel.id);
      await refreshRootPanelMessage(interaction.client, interaction.guildId, channel.id);
      await interaction.reply({ content: `Panneau d'administration installé dans <#${channel.id}>.`, ephemeral: true });
    }
  },
};
