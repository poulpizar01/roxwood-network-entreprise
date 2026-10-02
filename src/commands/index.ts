import type { Command } from "./types.js";
import { configCommand } from "./config.js";
import { statsCommand } from "./stats.js";
import { absenceCommand } from "./absence.js";

/**
 * Registre central de toutes les commandes slash du bot. `onReady` s'en sert pour les
 * enregistrer aupres de l'API Discord (`commands`), et `onInteractionCreate` pour retrouver
 * le handler a executer a partir du nom de la commande invoquee (`commandsByName`).
 *
 * Le catalogue (`/catalog`), l'etat des recrutements (`/recruitment status`) et les regles de
 * reponse automatique (`/autoreply`) sont entierement geres par le panneau d'administration
 * par boutons (voir `panelService.ts`, prefixe "panel:" dans interactionCreate.ts) — plus de
 * commandes slash pour ces trois fonctionnalites. `/ticket` (info/priority/tag) et l'escalade
 * ont ete retires (jamais utilises) — voir memoire projet si besoin de les reintroduire.
 * `/stock` a aussi ete retire (2026-08-29) : elle etait accessible a tout membre du serveur
 * sans aucun role requis, exposant le stock d'entreprise (donnee sensible) a n'importe qui —
 * l'utilisateur a prefere la supprimer plutot que la restreindre a un role.
 */
export const commands: Command[] = [configCommand, statsCommand, absenceCommand];

/** Index des commandes par nom (`data.name`), pour une resolution O(1) a chaque interaction. */
export const commandsByName = new Map(commands.map((c) => [c.data.name, c]));
