-- AlterTable
ALTER TABLE "GuildConfig" ADD COLUMN     "recruitmentAcceptedCategoryId" TEXT,
ADD COLUMN     "recruitmentAcceptedRoleId" TEXT,
ADD COLUMN     "recruitmentStatusChannelId" TEXT,
ADD COLUMN     "recruitmentStatusMessageId" TEXT;
