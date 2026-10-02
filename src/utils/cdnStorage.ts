import { env } from "../config/env.js";
import { logger } from "./logger.js";

/**
 * Client minimal pour le CDN de stockage d'images (storage.fbfa.fr) — production uniquement,
 * voir `imageStorage.ts` pour le point de decision dev/prod. Pas de dependance HTTP externe,
 * juste `fetch` (deja utilise partout ailleurs dans le bot pour les appels sortants).
 */

const CDN_BASE_URL = "https://storage.fbfa.fr";
/** Meme delai que les autres appels reseau du bot (voir `imageAttachment.ts`). */
const CDN_TIMEOUT_MS = 10_000;

/** `true` si un token CDN est configure — decide si le bot est en mode "stockage CDN" (prod) ou "octets en base" (dev, voir `imageStorage.ts`). */
export function isCdnEnabled(): boolean {
  return Boolean(env.CDN_TOKEN);
}

type CdnObjectResponse = { id: string; url: string; size: number; mimeType: string };

/**
 * Upload (ou remplace, meme cle = meme emplacement) un fichier sur le CDN. Retourne l'URL
 * publique de consultation (`https://storage.fbfa.fr/view/{id}`, aucun token requis pour la
 * lire) — c'est cette URL qui est stockee en base et donnee telle quelle a `embed.setImage`.
 *
 * @param key - chemin libre (les `/` creent des sous-dossiers), choisi deterministe par
 *   l'appelant a partir de l'id de sa propre ligne (ex: `catalog-items/<id>`) plutot que
 *   stocke separement : un re-upload sur la meme cle remplace l'ancien fichier de lui-meme,
 *   pas besoin de suivre/supprimer explicitement l'ancien a chaque remplacement.
 */
export async function uploadToCdn(key: string, data: Buffer, contentType: string): Promise<string> {
  const response = await fetch(`${CDN_BASE_URL}/api/object/${key}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.CDN_TOKEN}`,
      "Content-Type": contentType,
    },
    body: data,
    signal: AbortSignal.timeout(CDN_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Echec de l'upload CDN pour ${key} (HTTP ${response.status})`);
  }
  const result = (await response.json()) as CdnObjectResponse;
  return result.url;
}

/**
 * Supprime un fichier du CDN (ex: banniere retiree, article supprime, purge de retention).
 * Ne leve jamais d'exception : un echec de suppression sur le CDN ne doit pas faire echouer
 * l'action qui l'a declenchee (l'objet devient juste orphelin sur le CDN, pas grave en soi).
 */
export async function deleteFromCdn(key: string): Promise<void> {
  try {
    const response = await fetch(`${CDN_BASE_URL}/api/object/${key}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${env.CDN_TOKEN}` },
      signal: AbortSignal.timeout(CDN_TIMEOUT_MS),
    });
    if (!response.ok && response.status !== 404) {
      logger.warn(`Echec de suppression CDN pour ${key} (HTTP ${response.status})`);
    }
  } catch (error) {
    logger.warn(`Erreur reseau lors de la suppression CDN pour ${key}`, error);
  }
}
