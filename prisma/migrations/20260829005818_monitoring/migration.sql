-- CreateEnum
CREATE TYPE "MonitoringLogType" AS ENUM ('SHIFT', 'RECRUITMENT', 'SAFE', 'INVOICE', 'SALE');

-- AlterEnum
ALTER TYPE "PanelMessageKey" ADD VALUE 'MONITORING';

-- AlterTable
ALTER TABLE "GuildConfig" ADD COLUMN     "monitoringJobId" TEXT,
ADD COLUMN     "onDutyRoleId" TEXT;

-- CreateTable
CREATE TABLE "MonitoringChannelConfig" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "type" "MonitoringLogType" NOT NULL,
    "channelId" TEXT NOT NULL,

    CONSTRAINT "MonitoringChannelConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitoringEvent" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "type" "MonitoringLogType" NOT NULL,
    "rawFields" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonitoringEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitoringSafe" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "positionKey" TEXT NOT NULL,
    "label" TEXT,

    CONSTRAINT "MonitoringSafe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitoringSafeMovement" (
    "id" TEXT NOT NULL,
    "safeId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "playerDiscordId" TEXT,
    "playerName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonitoringSafeMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MonitoringChannelConfig_guildId_type_key" ON "MonitoringChannelConfig"("guildId", "type");

-- CreateIndex
CREATE INDEX "MonitoringEvent_guildId_type_createdAt_idx" ON "MonitoringEvent"("guildId", "type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MonitoringSafe_guildId_positionKey_key" ON "MonitoringSafe"("guildId", "positionKey");

-- CreateIndex
CREATE INDEX "MonitoringSafeMovement_safeId_itemId_idx" ON "MonitoringSafeMovement"("safeId", "itemId");

-- AddForeignKey
ALTER TABLE "MonitoringChannelConfig" ADD CONSTRAINT "MonitoringChannelConfig_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "GuildConfig"("guildId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitoringEvent" ADD CONSTRAINT "MonitoringEvent_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "GuildConfig"("guildId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitoringSafe" ADD CONSTRAINT "MonitoringSafe_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "GuildConfig"("guildId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitoringSafeMovement" ADD CONSTRAINT "MonitoringSafeMovement_safeId_fkey" FOREIGN KEY ("safeId") REFERENCES "MonitoringSafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
