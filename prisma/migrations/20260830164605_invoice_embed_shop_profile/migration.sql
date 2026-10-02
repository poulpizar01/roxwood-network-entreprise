-- AlterTable
ALTER TABLE "CatalogItem" ADD COLUMN     "weightGrams" INTEGER;

-- AlterTable
ALTER TABLE "GuildConfig" ADD COLUMN     "shopBannerUrl" TEXT,
ADD COLUMN     "shopPhone" TEXT,
ADD COLUMN     "shopRib" TEXT,
ADD COLUMN     "shopThankYouMessage" TEXT,
ADD COLUMN     "truckCapacityGrams" INTEGER;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "weightGrams" INTEGER;

-- AlterTable
ALTER TABLE "ServiceOrder" ADD COLUMN     "deliveryFee" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "discount" INTEGER NOT NULL DEFAULT 0;
