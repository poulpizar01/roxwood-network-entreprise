-- AlterTable
-- No existing rows at time of writing (verified before authoring this migration), so a
-- straight DROP+ADD is safe: no data to backfill from the old (already unreliable) CDN URL.
ALTER TABLE "RecruitmentAttachment" DROP COLUMN "url",
ADD COLUMN     "data" BYTEA NOT NULL;

-- CreateTable
CREATE TABLE "WebhookDeliveryAttempt" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDeliveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookDeliveryAttempt_nextAttemptAt_idx" ON "WebhookDeliveryAttempt"("nextAttemptAt");

-- AddForeignKey
ALTER TABLE "WebhookDeliveryAttempt" ADD CONSTRAINT "WebhookDeliveryAttempt_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "WebhookSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
