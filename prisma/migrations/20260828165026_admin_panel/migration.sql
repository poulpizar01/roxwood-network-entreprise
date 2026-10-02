/*
  Warnings:

  - You are about to drop the column `staffRoleIds` on the `GuildConfig` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "PanelMessageKey" AS ENUM ('ROOT', 'TICKETS', 'SERVICE', 'RECRUITMENT', 'ABSENCES', 'FAQ');

-- AlterTable
ALTER TABLE "GuildConfig" ADD COLUMN     "panelChannelId" TEXT;

-- AlterTable
ALTER TABLE "TicketCategoryConfig" ADD COLUMN     "managerRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Reprend l'ancien role staff global (GuildConfig.staffRoleIds) comme role de gestion sur
-- chaque categorie deja mappee de cette guilde, avant de supprimer la colonne : le nouveau
-- modele est "role par categorie" plutot que "role staff unique pour toute la guilde", donc
-- l'ancien role global est applique a toutes les categories existantes en attendant que le
-- staff affine via le panneau d'administration.
UPDATE "TicketCategoryConfig" tc
SET "managerRoleIds" = gc."staffRoleIds"
FROM "GuildConfig" gc
WHERE gc."guildId" = tc."guildId" AND array_length(gc."staffRoleIds", 1) > 0;

-- AlterTable
ALTER TABLE "GuildConfig" DROP COLUMN "staffRoleIds";

-- CreateTable
CREATE TABLE "PanelMessage" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "key" "PanelMessageKey" NOT NULL,
    "messageId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PanelMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PanelMessage_guildId_key_key" ON "PanelMessage"("guildId", "key");

-- AddForeignKey
ALTER TABLE "PanelMessage" ADD CONSTRAINT "PanelMessage_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "GuildConfig"("guildId") ON DELETE RESTRICT ON UPDATE CASCADE;
