-- Drop the Postgres bytes columns for images: dev local now stores image bytes on disk
-- (`data/dev-images/`, see `localImageStorage.ts`) instead of in the database, so the
-- production schema no longer carries columns that only ever existed for dev's benefit and
-- were always NULL in production. Any existing dev-local bytes were exported to disk under
-- the same deterministic keys (`catalog-items/<id>`, `shop-banners/<guildId>`,
-- `recruitment-attachments/<id>`) before this migration ran, so no image is lost.
ALTER TABLE "CatalogItem" DROP COLUMN "imageData";
ALTER TABLE "GuildConfig" DROP COLUMN "shopBannerData";
ALTER TABLE "RecruitmentAttachment" DROP COLUMN "data";
