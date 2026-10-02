import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type NonThreadGuildBasedChannel,
} from "discord.js";
import { getGuildConfig, getCategoryType } from "../services/guildConfigService.js";
import { trackTicketChannel } from "../services/ticketService.js";
import { createApplication } from "../services/recruitmentService.js";
import { getOrCreateOrder } from "../services/orderService.js";
import { buildCatalogSelectOptions, listActive } from "../services/catalogService.js";
import { logger } from "../utils/logger.js";

/**
 * Poste le message d'accueil d'un ticket de recrutement : un bouton qui, une fois clique,
 * ouvre le modal de candidature (voir `handleRecruitmentStartForm` dans interactionCreate.ts).
 */
async function postRecruitmentIntro(channel: NonThreadGuildBasedChannel): Promise<void> {
  if (!channel.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setTitle("Candidature")
    .setDescription("Merci pour votre intérêt ! Cliquez sur le bouton ci-dessous pour remplir le formulaire de candidature.")
    .setColor(0x5865f2);

  const button = new ButtonBuilder()
    .setCustomId("recruitment:start-form")
    .setLabel("Remplir le formulaire")
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);
  await channel.send({ embeds: [embed], components: [row] });
}

/**
 * Poste le message affiche a la place du formulaire quand les recrutements sont fermes
 * (`GuildConfig.recruitmentOpen === false`, voir `/config set-recruitment-open`).
 */
async function postRecruitmentClosed(channel: NonThreadGuildBasedChannel): Promise<void> {
  if (!channel.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setTitle("Candidature")
    .setDescription("Les recrutements sont actuellement fermés. Revenez plus tard, ou contactez le staff si besoin.")
    .setColor(0xed4245);

  await channel.send({ embeds: [embed] });
}

/**
 * Poste le message d'accueil d'un ticket de service : un menu deroulant listant le
 * catalogue actif, point de depart du flux de commande self-service cote client
 * (voir `handleOrderSelectItem` dans interactionCreate.ts). Si le catalogue est vide,
 * affiche un message simple sans menu (rien a commander tant que le staff n'a rien configure).
 */
async function postServiceIntro(channel: NonThreadGuildBasedChannel): Promise<void> {
  if (!channel.isTextBased()) return;

  const items = await listActive(channel.guildId);
  if (items.length === 0) {
    await channel.send("Bienvenue ! Le catalogue n'est pas encore configuré, un membre du staff va vous assister.");
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("Catalogue")
    .setDescription("Choisissez un article dans le menu ci-dessous pour passer commande.")
    .setColor(0x5865f2);

  const select = new StringSelectMenuBuilder()
    .setCustomId("order:select-item")
    .setPlaceholder("Choisir un article")
    .addOptions(buildCatalogSelectOptions(items));

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await channel.send({ embeds: [embed], components: [row] });
}

/**
 * Handler de l'evenement `channelCreate` : coeur de la detection de ticket puisque
 * Ticket Tool n'a pas d'API. Ignore tout canal qui n'est ni un salon texte, ni situe
 * dans une categorie mappee a un type de ticket (`getCategoryType`) — c'est ce qui
 * permet au bot de laisser les autres boutons du panel Ticket Tool (ex: "Partenariat",
 * "Article") geres par Ticket Tool seul, hors de son perimetre.
 *
 * Une fois le ticket detecte et enregistre (`trackTicketChannel`), cree l'enregistrement
 * specifique au type (candidature ou commande) et poste le message d'accueil correspondant.
 */
export async function onChannelCreate(channel: NonThreadGuildBasedChannel): Promise<void> {
  if (channel.type !== ChannelType.GuildText) return;

  const config = await getGuildConfig(channel.guildId);
  const type = getCategoryType(config, channel.parentId);
  if (!type) return;

  try {
    const ticket = await trackTicketChannel(channel, channel.parentId!, type);
    if (!ticket) return;

    if (type === "RECRUITMENT") {
      await createApplication(ticket.id);
      if (config?.recruitmentOpen === false) {
        await postRecruitmentClosed(channel);
      } else {
        await postRecruitmentIntro(channel);
      }
    } else {
      await getOrCreateOrder(ticket.id);
      await postServiceIntro(channel);
    }
  } catch (error) {
    logger.error(`Erreur lors du suivi du nouveau canal ${channel.id}`, error);
  }
}
