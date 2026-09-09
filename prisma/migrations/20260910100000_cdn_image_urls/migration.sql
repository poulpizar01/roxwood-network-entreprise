-- AlterTable: additive nullable columns for CDN image URLs (production), no data affected.
ALTER TABLE "GuildConfig" ADD COLUMN "shopBannerUrl" TEXT;
ALTER TABLE "CatalogItem" ADD COLUMN "imageUrl" TEXT;
ALTER TABLE "RecruitmentAttachment" ADD COLUMN "imageUrl" TEXT;

-- AlterTable: relax RecruitmentAttachment.data to nullable — production rows will store the
-- image on the CDN instead (imageUrl) and never populate this column. Existing rows keep
-- their data untouched, only the NOT NULL constraint is lifted.
ALTER TABLE "RecruitmentAttachment" ALTER COLUMN "data" DROP NOT NULL;
