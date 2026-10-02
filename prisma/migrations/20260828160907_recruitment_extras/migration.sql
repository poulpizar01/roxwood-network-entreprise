-- AlterTable
ALTER TABLE "GuildConfig" ADD COLUMN     "recruitmentOpen" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "RecruitmentAttachment" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecruitmentAttachment_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "RecruitmentAttachment" ADD CONSTRAINT "RecruitmentAttachment_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "RecruitmentApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
