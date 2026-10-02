import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Stockage disque des images en dev local (pas de `CDN_TOKEN`, voir `imageAttachment.ts`) —
 * jamais utilise en production. Remplace l'ancien stockage en octets dans Postgres : garder
 * ces octets en base aurait force le schema de production a porter des colonnes qui n'y sont
 * jamais remplies, uniquement pour le confort du dev local. Le disque du VPS de prod n'a lui
 * jamais ce dossier peuple, `CDN_TOKEN` y etant toujours configure.
 */
const LOCAL_IMAGE_DIR = path.join(process.cwd(), "data", "dev-images");

/**
 * `key` est toujours une valeur deterministe choisie par l'appelant (ex: `catalog-items/<id>`,
 * jamais une entree utilisateur libre), meme convention que `uploadToCdn` — pas de risque de
 * traversee de chemin a valider ici.
 */
function resolvePath(key: string): string {
  return path.join(LOCAL_IMAGE_DIR, key);
}

/** Ecrit une image sur disque a la cle donnee, en creant les dossiers intermediaires si besoin. */
export async function writeLocalImage(key: string, data: Buffer): Promise<void> {
  const filePath = resolvePath(key);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, data);
}

/** Relit une image stockee sur disque, ou `null` si aucun fichier n'existe a cette cle. */
export async function readLocalImage(key: string): Promise<Buffer | null> {
  try {
    return await readFile(resolvePath(key));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Supprime une image stockee sur disque. No-op silencieux si le fichier n'existe deja plus. */
export async function deleteLocalImage(key: string): Promise<void> {
  await rm(resolvePath(key), { force: true });
}
