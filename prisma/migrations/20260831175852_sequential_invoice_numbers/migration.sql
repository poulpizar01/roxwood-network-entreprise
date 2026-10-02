-- AlterTable
-- Compteur sequentiel de numero de facture, propre a chaque guilde. Purement additif (nouvelle
-- colonne avec valeur par defaut), aucune donnee existante affectee.
ALTER TABLE "GuildConfig" ADD COLUMN "lastInvoiceNumber" INTEGER NOT NULL DEFAULT 0;
