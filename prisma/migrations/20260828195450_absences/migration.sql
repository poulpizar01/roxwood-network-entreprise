-- CreateEnum
CREATE TYPE "AbsenceStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REFUSED');

-- AlterTable
ALTER TABLE "GuildConfig" ADD COLUMN     "absenceApproverRoleId" TEXT,
ADD COLUMN     "absenceReviewChannelId" TEXT;

-- CreateTable
CREATE TABLE "AbsenceRequest" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "AbsenceStatus" NOT NULL DEFAULT 'PENDING',
    "resolverId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "channelId" TEXT,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbsenceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AbsenceRequest_guildId_status_idx" ON "AbsenceRequest"("guildId", "status");

-- AddForeignKey
ALTER TABLE "AbsenceRequest" ADD CONSTRAINT "AbsenceRequest_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "GuildConfig"("guildId") ON DELETE RESTRICT ON UPDATE CASCADE;
