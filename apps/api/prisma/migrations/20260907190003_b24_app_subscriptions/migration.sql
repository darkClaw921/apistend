/*
  Warnings:

  - You are about to drop the `b24_app_event_handlers` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "b24_app_event_handlers" DROP CONSTRAINT "b24_app_event_handlers_appId_fkey";

-- AlterTable
ALTER TABLE "webhooks" ADD COLUMN     "appId" TEXT;

-- DropTable
DROP TABLE "b24_app_event_handlers";

-- CreateIndex
CREATE INDEX "webhooks_appId_idx" ON "webhooks"("appId");

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_appId_fkey" FOREIGN KEY ("appId") REFERENCES "b24_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
