-- Add PayoutProposal model for multisig payout automation.
CREATE TABLE "PayoutProposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "asset" TEXT NOT NULL DEFAULT 'USDC',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "signerApprovals" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "threshold" INTEGER NOT NULL DEFAULT 1,
    "multisigTxHash" TEXT,
    "executedAt" TIMESTAMP,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PayoutProposal_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE
);

CREATE INDEX "PayoutProposal_providerId_idx" ON "PayoutProposal"("providerId");
CREATE INDEX "PayoutProposal_status_idx" ON "PayoutProposal"("status");
CREATE INDEX "PayoutProposal_createdAt_idx" ON "PayoutProposal"("createdAt");
