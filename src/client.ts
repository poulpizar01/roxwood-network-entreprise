import { Client, GatewayIntentBits, Partials } from "discord.js";

/**
 * Instance unique du client discord.js, configuree avec les intents/partials necessaires :
 * - `Guilds` : evenements de base (canaux, guildes) et enregistrement des commandes.
 * - `GuildMessages` + `MessageContent` : lire le contenu des messages (reponses auto, detection staff).
 * - `GuildMembers` : resoudre les roles d'un membre (staff, escalade) et son pseudo affiche (factures).
 * - `GuildMessageReactions` : reagir a la reaction "poubelle" sur les messages dedies du panneau
 *   (suppression manuelle, voir `messageReactionAdd.ts`).
 * Les `partials` Channel/Message/Reaction permettent de recevoir des evenements sur des objets non
 * entierement mis en cache (ex: message ou reaction plus vieux que le cache, notamment apres un
 * redemarrage) sans que discord.js les ignore silencieusement.
 * `sweepers.messages` : sans balayage, discord.js garde par defaut jusqu'a 200 messages par
 * salon en cache indefiniment — sur un serveur avec beaucoup de salons actifs, ca ne redescend
 * jamais. Les messages retires du cache restent recuperables via `Partials.Message` si un
 * evenement les reference encore (ex: reaction 🗑️ tardive sur un message de panneau).
 */
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  sweepers: {
    messages: {
      interval: 3600, // toutes les heures
      lifetime: 1800, // retire les messages en cache depuis plus de 30 minutes
    },
  },
});
