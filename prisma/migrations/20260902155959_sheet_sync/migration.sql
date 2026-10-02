-- CreateTable
-- Nouvelle table, purement additive, aucune donnee existante affectee.
CREATE TABLE "SheetSync" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "sheetUrl" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "lastRowCount" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SheetSync_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SheetSync_subscriptionId_key" ON "SheetSync"("subscriptionId");

-- CreateIndex
CREATE INDEX "SheetSync_guildId_enabled_idx" ON "SheetSync"("guildId", "enabled");

-- AddForeignKey
ALTER TABLE "SheetSync" ADD CONSTRAINT "SheetSync_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "GuildConfig"("guildId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SheetSync" ADD CONSTRAINT "SheetSync_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "WebhookSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
