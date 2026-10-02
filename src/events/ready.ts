import { REST, Routes, type Client } from "discord.js";
import { env } from "../config/env.js";
import { commands } from "../commands/index.js";
import { refreshAllPanelsAcrossGuilds } from "../services/panelService.js";
import { refreshAllRecruitmentStatusMessages } from "../services/recruitmentLogService.js";
import { startSheetSyncPolling } from "../services/sheetSyncService.js";
import { startWebhookRetryPolling } from "../services/webhookDispatcher.js";
import { runRetentionJob, startRetentionPolling } from "../services/retentionService.js";
import { logger } from "../utils/logger.js";

/**
 * Handler `ClientReady`, declenche une seule fois quand le bot est connecte a la gateway.
 * Enregistre les commandes slash aupres de l'API Discord, puis rafraichit le panneau
 * d'administration de toutes les guildes.
 *
 * L'enregistrement se fait soit sur une seule guilde de dev (`DEV_GUILD_ID`, propagation
 * instantanee — pratique en developpement), soit globalement (propagation jusqu'a ~1h,
 * a utiliser en production). Un echec d'enregistrement est logge mais ne bloque pas le
 * demarrage : le bot reste fonctionnel pour tout ce qui ne depend pas des commandes slash.
 */
export async function onReady(readyClient: Client<true>): Promise<void> {
  logger.info(`Connecte en tant que ${readyClient.user.tag}`);

  const rest = new REST().setToken(env.DISCORD_TOKEN);
  const body = commands.map((c) => c.data.toJSON());

  try {
    if (env.DEV_GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(env.CLIENT_ID, env.DEV_GUILD_ID), { body });
      logger.info(`Commandes slash enregistrees sur la guilde de dev ${env.DEV_GUILD_ID}`);
    } else {
      await rest.put(Routes.applicationCommands(env.CLIENT_ID), { body });
      logger.info("Commandes slash enregistrees globalement (peut prendre jusqu'a 1h)");
    }
  } catch (error) {
    logger.error("Echec de l'enregistrement des commandes slash", error);
  }

  // Reconstruit chaque message dedie du panneau a partir du code courant : une mise a jour
  // du bot qui change un embed/des boutons se propage donc automatiquement aux messages
  // deja postes, sans qu'un admin ait a recliquer chaque bouton ou relancer
  // `/config set-panel-channel` pour voir apparaitre les changements.
  try {
    await refreshAllPanelsAcrossGuilds(readyClient);
    logger.info("Panneau d'administration rafraichi pour toutes les guildes configurees");
  } catch (error) {
    logger.error("Echec du rafraichissement du panneau d'administration au demarrage", error);
  }

  try {
    await refreshAllRecruitmentStatusMessages(readyClient);
    logger.info("Message de statut recrutement rafraichi pour toutes les guildes configurees");
  } catch (error) {
    logger.error("Echec du rafraichissement du message de statut recrutement au demarrage", error);
  }

  startSheetSyncPolling();
  logger.info("Sondage des synchronisations Google Sheets demarre");

  startWebhookRetryPolling();
  logger.info("Sondage des livraisons webhook a reessayer demarre");

  runRetentionJob().catch((error) => logger.error("Echec de la premiere purge de retention au demarrage", error));
  startRetentionPolling();
  logger.info("Purge de retention demarree (logs monitoring, pieces jointes de tickets fermes)");
}
