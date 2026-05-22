-- AlterTable
ALTER TABLE "ShareLink" ADD COLUMN     "folderId" TEXT,
ALTER COLUMN "fileId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "ShareLink_folderId_idx" ON "ShareLink"("folderId");

-- AddForeignKey
ALTER TABLE "ShareLink" ADD CONSTRAINT "ShareLink_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
