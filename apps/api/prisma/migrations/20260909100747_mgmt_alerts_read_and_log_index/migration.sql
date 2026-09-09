-- AlterTable
ALTER TABLE "alerts" ADD COLUMN     "readAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "alerts_sandboxId_readAt_idx" ON "alerts"("sandboxId", "readAt");

-- CreateIndex
CREATE INDEX "request_logs_sandboxId_apiKeyId_timestamp_idx" ON "request_logs"("sandboxId", "apiKeyId", "timestamp" DESC);
