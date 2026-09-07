-- CreateEnum
CREATE TYPE "BurstState" AS ENUM ('running', 'done', 'stopped', 'interrupted');

-- AlterTable
ALTER TABLE "webhook_deliveries" ADD COLUMN     "burstId" TEXT;

-- CreateTable
CREATE TABLE "event_bursts" (
    "id" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "scenarioId" TEXT,
    "event" TEXT NOT NULL,
    "serviceCode" TEXT NOT NULL,
    "state" "BurstState" NOT NULL DEFAULT 'running',
    "count" INTEGER NOT NULL,
    "ratePerSec" INTEGER NOT NULL,
    "requestedCount" INTEGER NOT NULL,
    "requestedRatePerSec" INTEGER NOT NULL,
    "errorRate" INTEGER NOT NULL DEFAULT 0,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "event_bursts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "event_bursts_sandboxId_startedAt_idx" ON "event_bursts"("sandboxId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "event_bursts_sandboxId_state_idx" ON "event_bursts"("sandboxId", "state");

-- CreateIndex
CREATE INDEX "webhook_deliveries_burstId_idx" ON "webhook_deliveries"("burstId");

-- AddForeignKey
ALTER TABLE "event_bursts" ADD CONSTRAINT "event_bursts_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_bursts" ADD CONSTRAINT "event_bursts_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_bursts" ADD CONSTRAINT "event_bursts_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "scenarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;
