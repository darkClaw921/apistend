-- DropForeignKey
ALTER TABLE "webhooks" DROP CONSTRAINT "webhooks_appId_fkey";

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_appId_fkey" FOREIGN KEY ("appId") REFERENCES "b24_apps"("id") ON DELETE SET NULL ON UPDATE CASCADE;
