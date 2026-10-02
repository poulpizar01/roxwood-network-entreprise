-- Retrait complet de la fonctionnalite FAQ (categorie de ticket + reponses automatiques par
-- mot-cle) : jugee inutile, retiree du produit sur demande explicite. Purge des donnees liees
-- avant de retirer FAQ des enums (Postgres n'autorise pas un cast implicite d'une valeur qui
-- n'existe plus dans le type cible).

-- 1. Tickets/categories/messages panneau FAQ existants (aucune donnee de production a ce jour).
DELETE FROM "Ticket" WHERE "type" = 'FAQ';
DELETE FROM "TicketCategoryConfig" WHERE "type" = 'FAQ';
DELETE FROM "PanelMessage" WHERE "key" = 'FAQ';

-- 2. Table des regles de reponse automatique, qui n'existait que pour FAQ.
DROP TABLE "AutoReplyRule";

-- 3. Retirer FAQ de TicketType (recreation de l'enum, Postgres n'a pas de DROP VALUE direct).
ALTER TYPE "TicketType" RENAME TO "TicketType_old";
CREATE TYPE "TicketType" AS ENUM ('RECRUITMENT', 'SERVICE');
ALTER TABLE "Ticket" ALTER COLUMN "type" TYPE "TicketType" USING ("type"::text::"TicketType");
ALTER TABLE "TicketCategoryConfig" ALTER COLUMN "type" TYPE "TicketType" USING ("type"::text::"TicketType");
DROP TYPE "TicketType_old";

-- 4. Retirer FAQ de PanelMessageKey, meme procede.
ALTER TYPE "PanelMessageKey" RENAME TO "PanelMessageKey_old";
CREATE TYPE "PanelMessageKey" AS ENUM ('ROOT', 'TICKETS', 'SERVICE', 'RECRUITMENT', 'ABSENCES', 'MONITORING');
ALTER TABLE "PanelMessage" ALTER COLUMN "key" TYPE "PanelMessageKey" USING ("key"::text::"PanelMessageKey");
DROP TYPE "PanelMessageKey_old";
