-- CreateEnum
CREATE TYPE "B24AppKind" AS ENUM ('server_ui', 'api_only');

-- CreateEnum
CREATE TYPE "B24AppState" AS ENUM ('awaiting_install', 'installed', 'uninstalled');

-- CreateTable
CREATE TABLE "b24_apps" (
    "id" TEXT NOT NULL,
    "sandboxId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT NOT NULL,
    "kind" "B24AppKind" NOT NULL DEFAULT 'server_ui',
    "state" "B24AppState" NOT NULL DEFAULT 'awaiting_install',
    "scope" TEXT[],
    "handlerUrl" TEXT,
    "installUrl" TEXT,
    "menuTitle" TEXT,
    "applicationToken" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "installedAt" TIMESTAMP(3),
    "lastInstallNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "b24_apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "b24_app_tokens" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "portalUserId" INTEGER NOT NULL DEFAULT 1,
    "scope" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "refreshExpiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "b24_app_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "b24_auth_codes" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "portalUserId" INTEGER NOT NULL DEFAULT 1,
    "state" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "b24_auth_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "b24_app_placements" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "placement" TEXT NOT NULL,
    "handler" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "groupName" TEXT,
    "options" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "b24_app_placements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "b24_app_event_handlers" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "handler" TEXT NOT NULL,
    "authType" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "b24_app_event_handlers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "b24_app_sessions" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "appSid" TEXT NOT NULL,
    "tokenId" TEXT,
    "placement" TEXT NOT NULL DEFAULT 'DEFAULT',
    "placementOptions" JSONB NOT NULL,
    "isInstall" BOOLEAN NOT NULL DEFAULT false,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "b24_app_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "b24_apps_clientId_key" ON "b24_apps"("clientId");

-- CreateIndex
CREATE INDEX "b24_apps_sandboxId_state_idx" ON "b24_apps"("sandboxId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "b24_apps_sandboxId_code_key" ON "b24_apps"("sandboxId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "b24_app_tokens_accessToken_key" ON "b24_app_tokens"("accessToken");

-- CreateIndex
CREATE UNIQUE INDEX "b24_app_tokens_refreshToken_key" ON "b24_app_tokens"("refreshToken");

-- CreateIndex
CREATE INDEX "b24_app_tokens_appId_revokedAt_idx" ON "b24_app_tokens"("appId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "b24_auth_codes_code_key" ON "b24_auth_codes"("code");

-- CreateIndex
CREATE INDEX "b24_app_placements_appId_idx" ON "b24_app_placements"("appId");

-- CreateIndex
CREATE UNIQUE INDEX "b24_app_placements_appId_placement_handler_key" ON "b24_app_placements"("appId", "placement", "handler");

-- CreateIndex
CREATE UNIQUE INDEX "b24_app_event_handlers_appId_event_handler_key" ON "b24_app_event_handlers"("appId", "event", "handler");

-- CreateIndex
CREATE UNIQUE INDEX "b24_app_sessions_appSid_key" ON "b24_app_sessions"("appSid");

-- CreateIndex
CREATE INDEX "b24_app_sessions_appId_createdAt_idx" ON "b24_app_sessions"("appId", "createdAt");

-- AddForeignKey
ALTER TABLE "b24_apps" ADD CONSTRAINT "b24_apps_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b24_app_tokens" ADD CONSTRAINT "b24_app_tokens_appId_fkey" FOREIGN KEY ("appId") REFERENCES "b24_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b24_auth_codes" ADD CONSTRAINT "b24_auth_codes_appId_fkey" FOREIGN KEY ("appId") REFERENCES "b24_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b24_app_placements" ADD CONSTRAINT "b24_app_placements_appId_fkey" FOREIGN KEY ("appId") REFERENCES "b24_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b24_app_event_handlers" ADD CONSTRAINT "b24_app_event_handlers_appId_fkey" FOREIGN KEY ("appId") REFERENCES "b24_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b24_app_sessions" ADD CONSTRAINT "b24_app_sessions_appId_fkey" FOREIGN KEY ("appId") REFERENCES "b24_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
