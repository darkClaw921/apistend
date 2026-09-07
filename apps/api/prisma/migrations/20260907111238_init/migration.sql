-- CreateEnum
CREATE TYPE "DataVolume" AS ENUM ('min', 'medium', 'full');

-- CreateEnum
CREATE TYPE "Readiness" AS ENUM ('ready', 'updating', 'planned');

-- CreateEnum
CREATE TYPE "ApiKeyStatus" AS ENUM ('active', 'expiring', 'revoked');

-- CreateEnum
CREATE TYPE "ApiKeyKind" AS ENUM ('sandbox', 'server');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('active', 'paused', 'failing', 'disabled');

-- CreateEnum
CREATE TYPE "DeliveryTarget" AS ENUM ('public', 'local');

-- CreateEnum
CREATE TYPE "DeliveryState" AS ENUM ('queued', 'dispatched', 'succeeded', 'failed', 'no_response', 'dropped');

-- CreateEnum
CREATE TYPE "CustomMockStatus" AS ENUM ('active', 'draft', 'disabled');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "initials" TEXT NOT NULL,
    "planLabel" TEXT NOT NULL DEFAULT 'Бесплатный доступ',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sandboxes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "project" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "dataVolume" "DataVolume" NOT NULL DEFAULT 'medium',
    "latencyMs" INTEGER NOT NULL DEFAULT 250,
    "errorRate" INTEGER NOT NULL DEFAULT 5,
    "lastResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sandboxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_methods" (
    "id" TEXT NOT NULL,
    "serviceCode" TEXT NOT NULL,
    "httpMethod" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "readiness" "Readiness" NOT NULL DEFAULT 'ready',
    "deprecated" BOOLEAN NOT NULL DEFAULT false,
    "latencyMs" INTEGER NOT NULL DEFAULT 180,
    "callsCount" INTEGER NOT NULL DEFAULT 0,
    "params" JSONB NOT NULL,
    "scenarios" JSONB NOT NULL,
    "responseSource" TEXT NOT NULL,
    "extraction" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "snapshotDate" TEXT NOT NULL,
    "license" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_stats" (
    "serviceCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "methodsCount" INTEGER NOT NULL DEFAULT 0,
    "eventsCount" INTEGER NOT NULL DEFAULT 0,
    "snapshotDate" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_stats_pkey" PRIMARY KEY ("serviceCode")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subtitle" TEXT,
    "kind" "ApiKeyKind" NOT NULL DEFAULT 'sandbox',
    "prefix" TEXT NOT NULL,
    "suffix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "services" TEXT[],
    "status" "ApiKeyStatus" NOT NULL DEFAULT 'active',
    "rotationDays" INTEGER NOT NULL DEFAULT 90,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "requestsPerDay" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_logs" (
    "id" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "publicId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "serviceCode" TEXT NOT NULL,
    "httpMethod" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "upstreamUrl" TEXT,
    "clientIp" TEXT,
    "scenario" TEXT NOT NULL DEFAULT 'success',
    "responseSource" TEXT NOT NULL DEFAULT 'example',
    "requestHeaders" JSONB NOT NULL,
    "requestBody" TEXT,
    "responseHeaders" JSONB NOT NULL,
    "responseBody" TEXT,

    CONSTRAINT "request_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks" (
    "id" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "serviceCode" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "httpMethod" TEXT NOT NULL DEFAULT 'POST',
    "target" "DeliveryTarget" NOT NULL DEFAULT 'public',
    "targetUrl" TEXT,
    "targetPath" TEXT,
    "status" "WebhookStatus" NOT NULL DEFAULT 'active',
    "secret" TEXT NOT NULL,
    "lastAttemptAt" TIMESTAMP(3),
    "successRate24h" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "serviceCode" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "state" "DeliveryState" NOT NULL DEFAULT 'queued',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "maxAttempts" INTEGER NOT NULL DEFAULT 1,
    "statusCode" INTEGER,
    "durationMs" INTEGER,
    "nextRetryAt" TIMESTAMP(3),
    "targetDisplay" TEXT NOT NULL,
    "rawBody" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "requestHeaders" JSONB NOT NULL,
    "responseBody" TEXT,
    "errorKind" TEXT,
    "errorMessage" TEXT,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tunnel_sessions" (
    "id" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "displayId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deviceName" TEXT,
    "agentVersion" TEXT NOT NULL,
    "forwardUrl" TEXT NOT NULL,
    "signingSecret" TEXT NOT NULL,
    "connected" BOOLEAN NOT NULL DEFAULT false,
    "latencyMs" INTEGER,
    "gwNodeId" TEXT NOT NULL DEFAULT 'gw-0',
    "connectedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tunnel_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenarios" (
    "id" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serviceCode" TEXT NOT NULL,
    "stepsCount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "delayMs" INTEGER NOT NULL DEFAULT 5000,
    "repeats" INTEGER NOT NULL DEFAULT 1,
    "errorRate" INTEGER NOT NULL DEFAULT 0,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "lastRunNote" TEXT,
    "steps" JSONB NOT NULL,

    CONSTRAINT "scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_mocks" (
    "id" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "httpMethod" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "CustomMockStatus" NOT NULL DEFAULT 'draft',
    "responseStatusCode" INTEGER NOT NULL DEFAULT 200,
    "contentType" TEXT NOT NULL DEFAULT 'application/json',
    "delayMs" INTEGER NOT NULL DEFAULT 250,
    "templatingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "responseBody" TEXT NOT NULL,
    "headers" JSONB NOT NULL,
    "rules" JSONB NOT NULL,
    "callsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_mocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "meta" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "link" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dataset_entities" (
    "serviceCode" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "externalId" TEXT NOT NULL,
    "volume" "DataVolume" NOT NULL DEFAULT 'min',
    "data" JSONB NOT NULL,

    CONSTRAINT "dataset_entities_pkey" PRIMARY KEY ("serviceCode","entityType","ordinal")
);

-- CreateTable
CREATE TABLE "sandbox_overlays" (
    "id" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "serviceCode" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "data" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sandbox_overlays_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_tokenHash_key" ON "auth_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "auth_sessions_userId_idx" ON "auth_sessions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "sandboxes_userId_name_key" ON "sandboxes"("userId", "name");

-- CreateIndex
CREATE INDEX "api_methods_serviceCode_group_idx" ON "api_methods"("serviceCode", "group");

-- CreateIndex
CREATE INDEX "api_methods_serviceCode_readiness_idx" ON "api_methods"("serviceCode", "readiness");

-- CreateIndex
CREATE UNIQUE INDEX "api_methods_serviceCode_httpMethod_path_key" ON "api_methods"("serviceCode", "httpMethod", "path");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");

-- CreateIndex
CREATE INDEX "api_keys_sandboxId_status_idx" ON "api_keys"("sandboxId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "request_logs_publicId_key" ON "request_logs"("publicId");

-- CreateIndex
CREATE INDEX "request_logs_sandboxId_timestamp_idx" ON "request_logs"("sandboxId", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "request_logs_sandboxId_statusCode_idx" ON "request_logs"("sandboxId", "statusCode");

-- CreateIndex
CREATE INDEX "request_logs_sandboxId_serviceCode_idx" ON "request_logs"("sandboxId", "serviceCode");

-- CreateIndex
CREATE INDEX "webhooks_sandboxId_serviceCode_idx" ON "webhooks"("sandboxId", "serviceCode");

-- CreateIndex
CREATE INDEX "webhook_deliveries_sandboxId_timestamp_idx" ON "webhook_deliveries"("sandboxId", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "webhook_deliveries_sandboxId_state_timestamp_idx" ON "webhook_deliveries"("sandboxId", "state", "timestamp");

-- CreateIndex
CREATE INDEX "webhook_deliveries_webhookId_idx" ON "webhook_deliveries"("webhookId");

-- CreateIndex
CREATE UNIQUE INDEX "tunnel_sessions_tokenHash_key" ON "tunnel_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "tunnel_sessions_sandboxId_connected_idx" ON "tunnel_sessions"("sandboxId", "connected");

-- CreateIndex
CREATE INDEX "tunnel_sessions_sandboxId_displayId_idx" ON "tunnel_sessions"("sandboxId", "displayId");

-- CreateIndex
CREATE INDEX "scenarios_sandboxId_idx" ON "scenarios"("sandboxId");

-- CreateIndex
CREATE INDEX "custom_mocks_sandboxId_status_idx" ON "custom_mocks"("sandboxId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "custom_mocks_sandboxId_httpMethod_path_key" ON "custom_mocks"("sandboxId", "httpMethod", "path");

-- CreateIndex
CREATE INDEX "alerts_sandboxId_idx" ON "alerts"("sandboxId");

-- CreateIndex
CREATE INDEX "dataset_entities_serviceCode_entityType_externalId_idx" ON "dataset_entities"("serviceCode", "entityType", "externalId");

-- CreateIndex
CREATE INDEX "sandbox_overlays_sandboxId_serviceCode_entityType_idx" ON "sandbox_overlays"("sandboxId", "serviceCode", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_overlays_sandboxId_serviceCode_entityType_externalI_key" ON "sandbox_overlays"("sandboxId", "serviceCode", "entityType", "externalId");

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tunnel_sessions" ADD CONSTRAINT "tunnel_sessions_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tunnel_sessions" ADD CONSTRAINT "tunnel_sessions_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_mocks" ADD CONSTRAINT "custom_mocks_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_overlays" ADD CONSTRAINT "sandbox_overlays_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
