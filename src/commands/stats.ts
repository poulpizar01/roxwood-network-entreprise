import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { prisma } from "../db/prisma.js";

/**
 * `/stats` : commande de consultation, tous types de tickets confondus (recrutement et
 * service). Calcule les compteurs directement en base (agregats Prisma) plutot que de
 * charger tous les tickets en memoire.
 */
export const statsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Statistiques des tickets")
    .addSubcommand((sub) => sub.setName("overview").setDescription("Vue d'ensemble des tickets")) as SlashCommandBuilder,

  async execute(interaction) {
    if (!interaction.inGuild()) return;

    const [open, closed] = await Promise.all([
      prisma.ticket.count({ where: { guildId: interaction.guildId, status: "OPEN" } }),
      prisma.ticket.count({ where: { guildId: interaction.guildId, status: "CLOSED" } }),
    ]);

    // Moyenne du delai (creation -> 1ere reponse staff) en minutes, sur les seuls tickets qui
    // ont deja recu une reponse (sinon la moyenne n'aurait pas de sens) — calculee directement
    // en base (AVG) plutot que de charger tous les tickets concernes pour moyenner en JS,
    // Postgres fait deja ce calcul nativement et bien plus efficacement a grande echelle.
    const [{ avg_minutes }] = await prisma.$queryRaw<{ avg_minutes: number | null }[]>`
      SELECT AVG(EXTRACT(EPOCH FROM ("firstStaffReplyAt" - "createdAt")) / 60) as avg_minutes
      FROM "Ticket"
      WHERE "guildId" = ${interaction.guildId} AND "firstStaffReplyAt" IS NOT NULL
    `;
    const avgResponseMinutes = avg_minutes !== null ? Math.round(Number(avg_minutes)) : null;

    const embed = new EmbedBuilder()
      .setTitle("Statistiques des tickets")
      .addFields(
        { name: "Ouverts", value: String(open), inline: true },
        { name: "Fermés", value: String(closed), inline: true },
        {
          name: "Temps de réponse moyen (staff)",
          value: avgResponseMinutes !== null ? `${avgResponseMinutes} min` : "pas de données",
        }
      )
      .setColor(0x5865f2);

    await interaction.reply({ embeds: [embed] });
  },
};
