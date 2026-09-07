import { AttachmentBuilder } from "discord.js";

/**
 * Taille maximale acceptee pour un fichier telecharge depuis un attachment Discord et stocke
 * en base (photo de catalogue, banniere de facture, piece jointe de candidature) — evite
 * qu'un envoi (volontaire ou non) de fichier volumineux ne gonfle la base sans limite.
 */
export const MAX_UPLOAD_SIZE_BYTES = 8 * 1024 * 1024;

/**
 * Delai maximum accorde au telechargement d'un attachment Discord (photo de catalogue,
 * banniere, piece jointe de candidature) avant d'abandonner — `fetch` n'a pas de timeout par
 * defaut, un CDN qui accepte la connexion sans jamais repondre bloquerait sinon l'interaction
 * indefiniment (jusqu'a expiration du token, ~15 min), sans retour utile pour l'utilisateur.
 */
export const FETCH_TIMEOUT_MS = 10_000;

/**
 * Construit une piece jointe Discord a partir d'octets stockes en base (voir
 * `CatalogItem.imageData`/`GuildConfig.shopBannerData`) et l'URL `attachment://` a donner a
 * `EmbedBuilder.setImage`/`setThumbnail` pour l'afficher — le fichier doit etre inclus dans le
 * `files` du meme message que l'embed pour que la reference resolve. Uploader a nouveau les
 * octets a chaque envoi (plutot que de reutiliser une URL CDN Discord) evite toute dependance
 * a la duree de vie d'un message anterieur, qui pourrait avoir ete supprime.
 */
export function buildImageAttachment(data: Buffer, filename: string): { attachment: AttachmentBuilder; url: string } {
  return {
    attachment: new AttachmentBuilder(data, { name: filename }),
    url: `attachment://${filename}`,
  };
}
