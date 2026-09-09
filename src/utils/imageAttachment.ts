import { AttachmentBuilder } from "discord.js";
import { deleteFromCdn, isCdnEnabled, uploadToCdn } from "./cdnStorage.js";
import { deleteLocalImage, readLocalImage, writeLocalImage } from "./localImageStorage.js";

/**
 * Taille maximale acceptee pour un fichier telecharge depuis un attachment Discord et stocke
 * en base (photo de catalogue, banniere de facture, piece jointe de candidature) — evite
 * qu'un envoi (volontaire ou non) de fichier volumineux ne gonfle la base sans limite.
 */
export const MAX_UPLOAD_SIZE_BYTES = 8 * 1024 * 1024;

/** Extensions acceptees pour tout upload d'image dans le bot (photo d'article, banniere, piece jointe de candidature). */
const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp)$/i;

/**
 * Verifie qu'un attachment Discord est bien une image — seul type de fichier accepte par le
 * bot, quel que soit l'endroit (photo d'article, banniere, piece jointe de candidature).
 * Le `contentType` fourni par Discord (quand connu) est plus fiable qu'une extension de nom de
 * fichier (qui peut mentir), d'ou la priorite ; repli sur l'extension s'il est absent.
 */
export function isImageAttachment(attachment: { contentType?: string | null; name?: string | null }): boolean {
  if (attachment.contentType) return attachment.contentType.startsWith("image/");
  return IMAGE_EXTENSION_REGEX.test(attachment.name ?? "");
}

/** Content-Type a envoyer au CDN pour cet attachment — celui de Discord si connu, sinon devine depuis l'extension. */
function resolveContentType(attachment: { contentType?: string | null; name?: string | null }): string {
  if (attachment.contentType) return attachment.contentType;
  const name = (attachment.name ?? "").toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

/**
 * Stocke une image a l'endroit approprie selon l'environnement (voir `isCdnEnabled`) : sur le
 * CDN en production (l'appelant ne garde que l'URL renvoyee), sur disque local en dev (voir
 * `localImageStorage.ts`) — jamais en base, pour ne jamais faire dependre le schema Postgres
 * (partage entre dev et prod) d'un besoin propre au dev local. L'appelant n'a jamais a savoir
 * lequel des deux a ete utilise : en mode CDN, `url` est la valeur a persister ; en mode disque
 * local, rien de plus a garder que le `filename` deja connu (voir `resolveImageDisplay` pour la
 * relecture, avec la meme `key`).
 *
 * @param key - chemin deterministe (ex: `catalog-items/<id>`), utilise a la fois comme chemin
 *   CDN et comme chemin sur le disque local — voir `uploadToCdn` pour pourquoi c'est a
 *   l'appelant de le choisir plutot qu'un id genere.
 */
export async function storeImage(
  key: string,
  data: Buffer,
  attachment: { contentType?: string | null; name?: string | null }
): Promise<{ url: string | null }> {
  if (isCdnEnabled()) {
    const url = await uploadToCdn(key, data, resolveContentType(attachment));
    return { url };
  }
  await writeLocalImage(key, data);
  return { url: null };
}

/**
 * Supprime une image precedemment stockee (retrait d'une banniere, suppression d'un article,
 * purge de retention...) — sur le CDN en production (voir `deleteFromCdn`), sur disque local en
 * dev (voir `deleteLocalImage`).
 */
export async function deleteStoredImage(key: string): Promise<void> {
  if (isCdnEnabled()) await deleteFromCdn(key);
  else await deleteLocalImage(key);
}

/**
 * Delai maximum accorde au telechargement d'un attachment Discord (photo de catalogue,
 * banniere, piece jointe de candidature) avant d'abandonner — `fetch` n'a pas de timeout par
 * defaut, un CDN qui accepte la connexion sans jamais repondre bloquerait sinon l'interaction
 * indefiniment (jusqu'a expiration du token, ~15 min), sans retour utile pour l'utilisateur.
 */
export const FETCH_TIMEOUT_MS = 10_000;

/**
 * Construit une piece jointe Discord a partir d'octets (releus sur disque local en dev, voir
 * `readLocalImage`) et l'URL `attachment://` a donner a `EmbedBuilder.setImage`/`setThumbnail`
 * pour l'afficher — le fichier doit etre inclus dans le `files` du meme message que l'embed
 * pour que la reference resolve. Uploader a nouveau les octets a chaque envoi (plutot que de
 * reutiliser une URL CDN Discord) evite toute dependance a la duree de vie d'un message
 * anterieur, qui pourrait avoir ete supprime.
 */
export function buildImageAttachment(data: Buffer, filename: string): { attachment: AttachmentBuilder; url: string } {
  return {
    attachment: new AttachmentBuilder(data, { name: filename }),
    url: `attachment://${filename}`,
  };
}

/**
 * Determine comment afficher une image deja stockee (voir `storeImage`), quel que soit le mode
 * dans lequel elle a ete enregistree : si une URL CDN existe, elle est directement utilisable
 * par `embed.setImage`, sans aucun fichier a joindre au message. Sinon (dev local), relit les
 * octets sur disque (voir `readLocalImage`) et reconstruit une piece jointe Discord fraiche —
 * l'appelant doit alors inclure `attachment` dans le `files` du meme message. Centralise ici
 * pour ne pas dupliquer ce choix a chaque endroit qui affiche une image (confirmation
 * d'article, facture, recap de candidature). Retourne `null` si aucune image n'est configuree.
 *
 * @param key - meme cle que celle passee a `storeImage` au moment de l'enregistrement, pour
 *   retrouver le fichier sur disque en mode dev local (ignoree en mode CDN).
 * @param attachmentName - nom a donner a la piece jointe Discord reconstruite (mode dev local
 *   uniquement) ; par defaut `stored.filename`, a surcharger quand plusieurs images d'un meme
 *   message pourraient sinon partager le meme nom (voir `finalizeRecruitmentAttachments`).
 */
export async function resolveImageDisplay(
  stored: { url: string | null; filename: string | null },
  key: string,
  attachmentName?: string
): Promise<{ url: string; attachment: AttachmentBuilder | null } | null> {
  if (stored.url) return { url: stored.url, attachment: null };
  if (!stored.filename) return null;
  const data = await readLocalImage(key);
  if (!data) return null;
  const built = buildImageAttachment(data, attachmentName ?? stored.filename);
  return { url: built.url, attachment: built.attachment };
}
