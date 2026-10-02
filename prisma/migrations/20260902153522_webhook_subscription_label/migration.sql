-- AlterTable
-- Libelle optionnel pour distinguer plusieurs abonnements webhook "custom" entre eux. Purement
-- additif (nouvelle colonne nullable), aucune donnee existante affectee.
ALTER TABLE "WebhookSubscription" ADD COLUMN "label" TEXT;
