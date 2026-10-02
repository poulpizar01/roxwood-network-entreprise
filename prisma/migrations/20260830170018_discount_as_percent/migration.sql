-- AlterTable
-- Remplace discount (montant absolu) par discountPercent (0-100) sans perte de donnees : pour
-- toute commande ayant deja une reduction non nulle, le pourcentage equivalent est recalcule a
-- partir du sous-total de ses lignes au moment de la migration (plutot qu'un DROP+ADD naif qui
-- remettrait silencieusement toutes les reductions existantes a zero). Resultat borne a [0, 100]
-- par securite (LEAST/GREATEST) au cas ou une reduction depassait deja le sous-total.
ALTER TABLE "ServiceOrder" ADD COLUMN "discountPercent" INTEGER NOT NULL DEFAULT 0;

UPDATE "ServiceOrder" so
SET "discountPercent" = LEAST(100, GREATEST(0, ROUND(100.0 * so."discount" / NULLIF(subtotal.total, 0))))
FROM (
  SELECT "orderId", SUM("unitPrice" * "quantity") AS total
  FROM "OrderItem"
  GROUP BY "orderId"
) AS subtotal
WHERE so."id" = subtotal."orderId" AND so."discount" > 0;

ALTER TABLE "ServiceOrder" DROP COLUMN "discount";
