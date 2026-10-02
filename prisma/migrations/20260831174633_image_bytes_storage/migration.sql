/*
  Warnings:

  - You are about to drop the column `imageUrl` on the `CatalogItem` table. All the data in the column will be lost.
  - You are about to drop the column `shopBannerUrl` on the `GuildConfig` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "CatalogItem" DROP COLUMN "imageUrl",
ADD COLUMN     "imageData" BYTEA,
ADD COLUMN     "imageFilename" TEXT;

-- AlterTable
ALTER TABLE "GuildConfig" DROP COLUMN "shopBannerUrl",
ADD COLUMN     "shopBannerData" BYTEA,
ADD COLUMN     "shopBannerFilename" TEXT;
