-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateTable
CREATE TABLE "GuildConfig" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "ticketCategoryIds" TEXT[],
    "closedCategoryId" TEXT,
    "staffRoleIds" TEXT[],
    "escalationMinutes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuildConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "openerId" TEXT,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "TicketPriority" NOT NULL DEFAULT 'NORMAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "firstStaffReplyAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "escalatedAt" TIMESTAMP(3),

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketTag" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,

    CONSTRAINT "TicketTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoReplyRule" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutoReplyRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookSubscription" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuildConfig_guildId_key" ON "GuildConfig"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_channelId_key" ON "Ticket"("channelId");

-- CreateIndex
CREATE INDEX "Ticket_guildId_status_idx" ON "Ticket"("guildId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TicketTag_ticketId_tag_key" ON "TicketTag"("ticketId", "tag");

-- CreateIndex
CREATE INDEX "AutoReplyRule_guildId_enabled_idx" ON "AutoReplyRule"("guildId", "enabled");

-- CreateIndex
CREATE INDEX "WebhookSubscription_guildId_eventType_enabled_idx" ON "WebhookSubscription"("guildId", "eventType", "enabled");

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "GuildConfig"("guildId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketTag" ADD CONSTRAINT "TicketTag_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoReplyRule" ADD CONSTRAINT "AutoReplyRule_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "GuildConfig"("guildId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "GuildConfig"("guildId") ON DELETE RESTRICT ON UPDATE CASCADE;
