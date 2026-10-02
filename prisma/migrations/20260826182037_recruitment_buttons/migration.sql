-- AlterTable
ALTER TABLE "GuildConfig" ADD COLUMN     "recruitmentLogChannelId" TEXT;

-- AlterTable
ALTER TABLE "RecruitmentApplication" ADD COLUMN     "logChannelId" TEXT,
ADD COLUMN     "logMessageId" TEXT;
