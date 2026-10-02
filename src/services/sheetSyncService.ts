import { prisma } from "../db/prisma.js";
import { dispatchToSubscription, findActiveSubscription } from "./webhookDispatcher.js";
import { logger } from "../utils/logger.js";

/**
 * Synchronisation reguliere d'un Google Sheet vers un abonnement webhook "custom" (voir
 * `webhookDispatcher.ts`). Lecture via l'export CSV public du Sheet — pas de compte de service
 * Google, pas d'identifiant a stocker cote VPS (l'utilisateur n'y a pas acces) : le Sheet doit
 * juste etre partage "lecture pour toute personne avec le lien", ce lien faisant alors office
 * de secret a proteger. La premiere ligne du Sheet sert d'en-tetes ; chaque ligne suivante
 * devient un objet cle/valeur envoye tel quel, sans schema impose.
 */

/** Sonde les Sheets actifs toutes les 5 minutes — assez reactif sans spammer les recepteurs. */
const POLL_INTERVAL_MS = 5 * 60 * 1000;
/** Delai maximum accorde a la lecture d'un Sheet avant d'abandonner cette synchronisation pour cette passe. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Convertit un lien Google Sheets classique (partage/edition, avec ou sans `#gid=`) en URL
 * d'export CSV direct. Si le format n'est pas reconnu, l'URL est renvoyee telle quelle — au cas
 * ou l'utilisateur a deja colle une URL d'export ou une autre source compatible CSV.
 */
export function parseGoogleSheetUrl(input: string): string {
  const trimmed = input.trim();
  const idMatch = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(trimmed);
  if (!idMatch) return trimmed;

  const gidMatch = /[#&?]gid=(\d+)/.exec(trimmed);
  const gid = gidMatch ? gidMatch[1] : "0";
  return `https://docs.google.com/spreadsheets/d/${idMatch[1]}/export?format=csv&gid=${gid}`;
}

/**
 * Parseur CSV minimal (virgules, guillemets, guillemets echappes en doublon `""`, retours a la
 * ligne dans un champ quote) — suffisant pour l'export Google Sheets, pas de dependance externe
 * pour ca seul. Ignore les lignes entierement vides en fin de fichier (export Google frequent).
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i++;
    } else if (char === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (char === "\r") {
      i++;
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else {
      field += char;
      i++;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

/**
 * Recupere et parse l'export CSV d'un Sheet. Leve une erreur explicite (relayee a l'utilisateur
 * cote panneau) si le Sheet n'est pas accessible — cas le plus probable : pas partage "lecture
 * pour toute personne avec le lien".
 */
export async function fetchSheetRows(csvUrl: string): Promise<string[][]> {
  const response = await fetch(csvUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(
      `Impossible de lire le Sheet (HTTP ${response.status}) — vérifie qu'il est bien partagé "Lecture" pour "Toute personne avec le lien".`
    );
  }
  return parseCsv(await response.text());
}

/**
 * Cree une synchronisation et envoie immediatement tout l'historique deja present dans le
 * Sheet (une ligne = un envoi, meme format que le sondage periodique) — a la demande explicite
 * de l'utilisateur : au moment ou on branche un Sheet, on veut que le recepteur reparte avec
 * toutes les donnees deja saisies, pas seulement celles qui arriveront apres coup. Le compteur
 * `lastRowCount` n'est mis a jour qu'une fois cet envoi initial termine, pour que le sondage
 * periodique ne renvoie pas ces memes lignes une seconde fois.
 *
 * L'abonnement webhook cible est charge une seule fois avant la boucle (`findActiveSubscription`)
 * plutot que redemande a chaque ligne : sur un Sheet de plusieurs centaines/milliers de lignes,
 * ca evite autant de requetes en base pour retrouver a chaque fois le meme abonnement.
 */
export async function createSheetSync(guildId: string, subscriptionId: string, rawSheetUrl: string) {
  const sheetUrl = parseGoogleSheetUrl(rawSheetUrl);
  const rows = await fetchSheetRows(sheetUrl);
  const sync = await prisma.sheetSync.create({ data: { guildId, subscriptionId, sheetUrl, lastRowCount: 0 } });

  if (rows.length > 1) {
    const [headers, ...dataRows] = rows;
    const sub = await findActiveSubscription(guildId, subscriptionId);
    if (sub) {
      for (const rowValues of dataRows) {
        const payload: Record<string, string> = {};
        headers.forEach((header, index) => {
          if (header) payload[header] = rowValues[index] ?? "";
        });
        await dispatchToSubscription(sub, guildId, payload);
      }
    }
    await prisma.sheetSync.update({ where: { id: sync.id }, data: { lastRowCount: dataRows.length } });
  }

  return sync;
}

/** Liste les synchronisations d'une guilde, avec l'abonnement cible (pour afficher son libelle). */
export async function listSheetSyncs(guildId: string) {
  return prisma.sheetSync.findMany({ where: { guildId }, include: { subscription: true }, orderBy: { createdAt: "asc" } });
}

/** Supprime une synchronisation. No-op si l'id n'existe pas ou n'appartient pas a cette guilde. */
export async function removeSheetSync(guildId: string, id: string) {
  await prisma.sheetSync.deleteMany({ where: { id, guildId } });
}

/**
 * Sonde toutes les synchronisations actives (toutes guildes confondues) : pour chacune, relit
 * le Sheet, envoie une ligne par nouvelle donnee (au-dela de `lastRowCount`) a l'abonnement
 * cible, puis met a jour le compteur. Chaque synchronisation est independante — l'echec de
 * l'une (Sheet devenu inaccessible, etc.) est journalise sans empecher les autres.
 *
 * Assomption : les nouvelles lignes sont ajoutees a la fin du Sheet (usage normal d'un
 * journal de ventes/transactions). Si des lignes sont supprimees, le compteur est recale sur
 * le nombre actuel plutot que de rester bloque a un chiffre devenu trop haut.
 */
export async function pollAllSheetSyncs(): Promise<void> {
  const syncs = await prisma.sheetSync.findMany({ where: { enabled: true } });

  for (const sync of syncs) {
    try {
      const rows = await fetchSheetRows(sync.sheetUrl);
      if (rows.length === 0) continue;

      const [headers, ...dataRows] = rows;
      const currentCount = dataRows.length;

      if (currentCount > sync.lastRowCount) {
        const newRows = dataRows.slice(sync.lastRowCount);
        // Charge l'abonnement une seule fois pour tout ce lot de nouvelles lignes, plutot
        // qu'a chaque ligne (voir `findActiveSubscription`).
        const sub = await findActiveSubscription(sync.guildId, sync.subscriptionId);
        if (sub) {
          for (const rowValues of newRows) {
            const payload: Record<string, string> = {};
            headers.forEach((header, index) => {
              if (header) payload[header] = rowValues[index] ?? "";
            });
            await dispatchToSubscription(sub, sync.guildId, payload);
          }
        }
      }

      if (currentCount !== sync.lastRowCount) {
        await prisma.sheetSync.update({ where: { id: sync.id }, data: { lastRowCount: currentCount } });
      }
    } catch (error) {
      logger.error(`Echec de synchronisation du Sheet pour l'abonnement ${sync.subscriptionId}`, error);
    }
  }
}

/** Demarre le sondage periodique — a appeler une seule fois au demarrage du bot (voir `ready.ts`). */
export function startSheetSyncPolling(): void {
  // Verrou de re-entrance : sans lui, un Sheet volumineux ou lent a repondre pourrait faire
  // chevaucher deux passes et renvoyer certaines lignes en double (le compteur `lastRowCount`
  // n'est mis a jour qu'a la fin du traitement de chaque synchronisation).
  let isRunning = false;
  setInterval(() => {
    if (isRunning) return;
    isRunning = true;
    pollAllSheetSyncs()
      .catch((error) => logger.error("Erreur inattendue lors du sondage des Google Sheets", error))
      .finally(() => {
        isRunning = false;
      });
  }, POLL_INTERVAL_MS);
}
