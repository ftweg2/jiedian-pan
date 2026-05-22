-- CreateTable
CREATE TABLE "NodeProbe" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ok" BOOLEAN NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "error" TEXT,

    CONSTRAINT "NodeProbe_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NodeProbe_nodeId_observedAt_idx" ON "NodeProbe"("nodeId", "observedAt");

-- AddForeignKey
ALTER TABLE "NodeProbe" ADD CONSTRAINT "NodeProbe_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "StorageNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
