import type { CatalogFieldStyle } from "@prisma/client";
import { prisma } from "../db/prisma.js";

/**
 * Service de gestion du catalogue produits/services (`CatalogItem`) et de ses champs
 * personnalises (`CatalogItemField`) — ce que le staff configure en amont pour que le
 * client puisse ensuite composer sa commande lui-meme (voir `orderService.ts`).
 * Toutes les fonctions sont scopees par `guildId` pour l'isolation multi-serveur.
 */

/**
 * Nombre maximum de champs personnalises par article. Contrainte technique de Discord :
 * un modal (formulaire) ne peut afficher que 5 `TextInputComponent` au plus.
 */
const MAX_FIELDS_PER_ITEM = 5;

/** Cree un nouvel article de catalogue (actif par defaut). La photo se definit ensuite separement (voir `setItemImage`). */
export async function addItem(guildId: string, data: { name: string; price: number; description?: string }) {
  return prisma.catalogItem.create({
    data: {
      guildId,
      name: data.name,
      price: data.price,
      description: data.description,
    },
  });
}

/** Supprime un article du catalogue. No-op si l'id n'existe pas ou n'appartient pas a cette guilde. */
export async function removeItem(guildId: string, id: string) {
  await prisma.catalogItem.deleteMany({ where: { id, guildId } });
}

/**
 * Liste les articles actifs d'une guilde, dans l'ordre de creation (utilise pour le menu
 * deroulant client). `omit: { imageData: true }` : aucun appelant n'affiche la photo depuis
 * cette liste (juste nom/prix/description dans un menu), inutile de charger potentiellement
 * plusieurs Mo d'octets par article a chaque ouverture de ticket Service.
 */
export async function listActive(guildId: string) {
  return prisma.catalogItem.findMany({
    where: { guildId, active: true },
    orderBy: { createdAt: "asc" },
    omit: { imageData: true },
  });
}

/**
 * Construit les options du menu deroulant catalogue vu par le client (`order:select-item`),
 * prix et description combines dans le sous-texte de l'option (le seul endroit ou Discord
 * permet d'afficher plus que le nom d'un article dans un menu) : un `StringSelectMenuOption`
 * n'a que 100 caracteres de description, tronquee ici plutot que de forcer un choix entre les
 * deux (le prix seul, deja affiche partout ailleurs, cede la place a la description si les
 * deux ne tiennent pas).
 */
export function buildCatalogSelectOptions(items: { id: string; name: string; price: number; description: string | null }[]) {
  return items.slice(0, 25).map((item) => {
    const priceLabel = `${item.price.toLocaleString("fr-FR")} $`;
    const full = item.description ? `${priceLabel} — ${item.description}` : priceLabel;
    return {
      label: item.name.slice(0, 100),
      description: full.length <= 100 ? full : `${full.slice(0, 97)}...`,
      value: item.id,
    };
  });
}

/**
 * Comme `listActive`, avec les champs personnalises inclus — pour le recapitulatif du
 * panneau. Meme raisonnement pour `omit: { imageData: true }` : la presence d'une photo se
 * verifie via `imageFilename` (toujours defini en meme temps que `imageData`, voir
 * `setItemImage`), pas besoin des octets eux-memes pour ce simple indicateur.
 */
export async function listActiveWithFields(guildId: string) {
  return prisma.catalogItem.findMany({
    where: { guildId, active: true },
    orderBy: { createdAt: "asc" },
    include: { fields: { orderBy: { position: "asc" } } },
    omit: { imageData: true },
  });
}

/**
 * Definit (ou remplace) la photo d'un article, stockee en octets bruts plutot qu'une URL
 * Discord (voir le commentaire sur `imageData` dans le schema). Separee de `addItem` : les
 * modals Discord ne supportant pas l'upload de fichier, la photo est envoyee dans un second
 * temps en message classique dans le salon du panneau (voir `handleServiceSetImageSelect`),
 * dont les octets sont telecharges puis le message peut etre supprime sans rien casser.
 */
export async function setItemImage(guildId: string, id: string, imageData: Buffer, imageFilename: string) {
  await prisma.catalogItem.updateMany({ where: { id, guildId }, data: { imageData, imageFilename } });
}

/**
 * Definit (ou retire, si `weightGrams` vaut `null`) le poids unitaire d'un article, utilise
 * pour calculer le poids total/nombre de camions requis sur la facture (voir `orderLogService.ts`).
 * Optionnel : un article sans poids configure est simplement ignore dans ce calcul.
 */
export async function setItemWeight(guildId: string, id: string, weightGrams: number | null) {
  await prisma.catalogItem.updateMany({ where: { id, guildId }, data: { weightGrams } });
}

/**
 * Recupere un article (avec ses champs personnalises, ordonnes par `position`) en verifiant
 * qu'il appartient bien a la guilde donnee — evite qu'un id d'article d'un autre serveur
 * puisse etre utilise par erreur ou malveillance. `omit: { imageData: true }` : la quasi
 * totalite des appelants (composition de commande, gestion du poids/des champs...) n'ont
 * besoin que du nom/prix/champs, jamais des octets de la photo — voir `getItemWithImage` pour
 * le seul appelant qui en a reellement besoin (confirmation d'article cote client).
 */
export async function getItem(guildId: string, id: string) {
  return prisma.catalogItem.findFirst({
    where: { id, guildId },
    include: { fields: { orderBy: { position: "asc" } } },
    omit: { imageData: true },
  });
}

/** Comme `getItem`, avec les octets de la photo inclus — pour l'affichage de la confirmation d'article. */
export async function getItemWithImage(guildId: string, id: string) {
  return prisma.catalogItem.findFirst({
    where: { id, guildId },
    include: { fields: { orderBy: { position: "asc" } } },
  });
}

/**
 * Ajoute un champ personnalise a un article (ce que le client devra remplir en le commandant).
 * La `position` est deduite du nombre de champs existants, pour preserver l'ordre d'ajout
 * dans le modal genere dynamiquement.
 *
 * @throws si l'article n'existe pas, s'il a deja atteint `MAX_FIELDS_PER_ITEM`, ou si on
 *   tente d'ajouter un 2e champ de style QUANTITY (au plus un par article : sa reponse
 *   alimente directement `OrderItem.quantity`, en avoir deux serait ambigu).
 */
export async function addField(
  guildId: string,
  itemId: string,
  data: { label: string; style: CatalogFieldStyle; required: boolean }
) {
  const item = await getItem(guildId, itemId);
  if (!item) throw new Error("Article introuvable.");
  if (item.fields.length >= MAX_FIELDS_PER_ITEM) {
    throw new Error(`Un article ne peut pas avoir plus de ${MAX_FIELDS_PER_ITEM} champs (limite Discord).`);
  }
  if (data.style === "QUANTITY" && item.fields.some((f) => f.style === "QUANTITY")) {
    throw new Error("Cet article a déjà un champ de type quantité.");
  }

  return prisma.catalogItemField.create({
    data: {
      catalogItemId: itemId,
      label: data.label,
      style: data.style,
      required: data.required,
      position: item.fields.length,
    },
  });
}

/**
 * Supprime un champ personnalise. Le filtre `catalogItem: { guildId }` empeche de supprimer
 * un champ appartenant a un article d'une autre guilde meme si son id est devine/reutilise.
 */
export async function removeField(guildId: string, fieldId: string) {
  await prisma.catalogItemField.deleteMany({
    where: { id: fieldId, catalogItem: { guildId } },
  });
}

