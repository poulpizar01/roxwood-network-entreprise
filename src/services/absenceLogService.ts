import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Client } from "discord.js";
import type { AbsenceStatus } from "@prisma/client";
import { formatFrenchDate, saveAbsenceMessageRef } from "./absenceService.js";
import { getGuildConfig } from "./guildConfigService.js";
import { logger } from "../utils/logger.js";
import { prisma } from "../db/prisma.js";

/**
 * Construction et mise a jour du message de suivi d'une demande d'absence (recap + boutons
 * Accepter/Refuser), edite en place a la resolution — meme principe que
 * `recruitmentLogService`.
 */

const STATUS_LABELS: Record<AbsenceStatus, string> = {
  PENDING: "En attente",
  ACCEPTED: "Acceptée",
  REFUSED: "Refusée",
};

type AbsenceRequestData = {
  id: string;
  requesterId: string;
  startDate: Date;
  endDate: Date;
  reason: string;
  status: AbsenceStatus;
  resolverId: string | null;
};

/** Construit l'embed de suivi d'une demande d'absence. */
export function buildAbsenceEmbed(request: AbsenceRequestData): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("Demande d'absence")
    .setColor(request.status === "ACCEPTED" ? 0x57f287 : request.status === "REFUSED" ? 0xed4245 : 0x5865f2)
    .addFields(
      { name: "Demandeur", value: `<@${request.requesterId}>`, inline: true },
      { name: "Statut", value: `**${STATUS_LABELS[request.status]}**`, inline: true },
      { name: "Du", value: formatFrenchDate(request.startDate), inline: true },
      { name: "Au", value: formatFrenchDate(request.endDate), inline: true },
      { name: "Motif", value: request.reason }
    );

  if (request.resolverId) {
    embed.addFields({ name: "Traitée par", value: `<@${request.resolverId}>` });
  }

  return embed;
}

/** Boutons Accepter/Refuser — retires une fois la demande resolue (plus rien a faire dessus). */
export function buildAbsenceActionRow(requestId: string): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`absence:accept:${requestId}`).setLabel("Accepter").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`absence:refuse:${requestId}`).setLabel("Refuser").setStyle(ButtonStyle.Danger)
  );
  return [row];
}

/**
 * Poste le message de suivi d'une nouvelle demande dans le salon dedie (`absenceReviewChannelId`),
 * en pingant le role approbateur configure. Retourne `false` si la guilde n'a pas encore
 * configure de salon de suivi (l'appelant doit avoir deja verifie que le role approbateur est
 * defini avant d'accepter la declaration).
 */
export async function postAbsenceRequest(
  client: Client,
  guildId: string,
  request: AbsenceRequestData
): Promise<boolean> {
  const config = await getGuildConfig(guildId);
  const channelId = config?.absenceReviewChannelId;
  if (!channelId) return false;

  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased() || channel.isDMBased()) return false;

  const mention = config?.absenceApproverRoleIds.map((roleId) => `<@&${roleId}>`).join(" ") ?? "";
  const message = await channel.send({
    content: mention || undefined,
    embeds: [buildAbsenceEmbed(request)],
    components: buildAbsenceActionRow(request.id),
  });

  await saveAbsenceMessageRef(request.id, message.id);
  await prisma.absenceRequest.update({ where: { id: request.id }, data: { channelId: channel.id } });
  return true;
}

/**
 * Recharge la demande depuis la base et met a jour en place son message de suivi (embed +
 * boutons) apres resolution. No-op silencieux si le message n'a jamais ete envoye ou n'est
 * plus accessible (salon/message supprime).
 */
export async function refreshAbsenceMessage(client: Client, requestId: string): Promise<void> {
  const request = await prisma.absenceRequest.findUnique({ where: { id: requestId } });
  if (!request || !request.channelId || !request.messageId) return;

  try {
    const channel = await client.channels.fetch(request.channelId);
    if (!channel?.isTextBased() || channel.isDMBased()) return;
    const message = await channel.messages.fetch(request.messageId);
    await message.edit({
      embeds: [buildAbsenceEmbed(request)],
      components: request.status === "PENDING" ? buildAbsenceActionRow(request.id) : [],
    });
  } catch (error) {
    logger.error(`Echec de mise a jour du message de suivi pour la demande d'absence ${requestId}`, error);
  }
}
