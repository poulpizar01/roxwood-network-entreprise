/*
  Warnings:

  - You are about to drop the column `escalationMinutes` on the `GuildConfig` table. All the data in the column will be lost.
  - You are about to drop the column `escalatedAt` on the `Ticket` table. All the data in the column will be lost.
  - You are about to drop the column `lastActivityAt` on the `Ticket` table. All the data in the column will be lost.
  - You are about to drop the column `priority` on the `Ticket` table. All the data in the column will be lost.
  - You are about to drop the `TicketTag` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "TicketTag" DROP CONSTRAINT "TicketTag_ticketId_fkey";

-- AlterTable
ALTER TABLE "GuildConfig" DROP COLUMN "escalationMinutes";

-- AlterTable
ALTER TABLE "Ticket" DROP COLUMN "escalatedAt",
DROP COLUMN "lastActivityAt",
DROP COLUMN "priority";

-- DropTable
DROP TABLE "TicketTag";

-- DropEnum
DROP TYPE "TicketPriority";
