import { Events } from "discord.js";
import { env } from "./config/env.js";
import { client } from "./client.js";
import { onReady } from "./events/ready.js";
import { onChannelCreate } from "./events/channelCreate.js";
import { onChannelDelete } from "./events/channelDelete.js";
import { onChannelUpdate } from "./events/channelUpdate.js";
import { onMessageCreate } from "./events/messageCreate.js";
import { onMessageReactionAdd } from "./events/messageReactionAdd.js";
import { onInteractionCreate } from "./events/interactionCreate.js";
import { logger } from "./utils/logger.js";

// Point d'entree du bot : branche chaque evenement Discord ecoute sur son handler dedie
// (un fichier par evenement dans src/events/), puis se connecte a la gateway Discord.

/**
 * Filet de securite : le client discord.js active `captureRejections`, donc toute promesse
 * rejetee et non rattrapee dans un listener d'evenement (ex: un handler d'interaction qui
 * plante) est convertie en evenement `error` sur le client. Sans listener dessus, EventEmitter
 * la relance en exception non geree et **tue tout le process** (donc le bot pour toutes les
 * guildes) au lieu de simplement rater cette interaction. On logge et on continue.
 */
client.on(Events.Error, (error) => {
  logger.error("Erreur non geree sur le client Discord", error);
});

/** Une seule fois au demarrage : enregistre les commandes slash et lance le job d'escalade. */
client.once(Events.ClientReady, onReady);
/** Nouveau canal cree : detecte l'ouverture d'un ticket si sa categorie est suivie. */
client.on(Events.ChannelCreate, onChannelCreate);
/** Canal supprime : signal principal de fermeture d'un ticket suivi. */
client.on(Events.ChannelDelete, onChannelDelete);
/** Canal modifie (ex: renomme) : signal secondaire de fermeture d'un ticket suivi. */
client.on(Events.ChannelUpdate, onChannelUpdate);
/** Nouveau message : suivi d'activite/1ere reponse staff, reponses automatiques. */
client.on(Events.MessageCreate, onMessageCreate);
/** Reaction ajoutee : la poubelle sur un message dedie du panneau le supprime. */
client.on(Events.MessageReactionAdd, onMessageReactionAdd);
/** Toute interaction (commande slash, bouton, menu, modal) : routee vers le bon handler. */
client.on(Events.InteractionCreate, onInteractionCreate);

client.login(env.DISCORD_TOKEN).catch((error) => {
  logger.error("Echec de connexion du bot", error);
  process.exit(1);
});
