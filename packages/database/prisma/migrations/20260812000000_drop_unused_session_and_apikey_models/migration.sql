-- DropForeignKey
ALTER TABLE "ApiKey" DROP CONSTRAINT IF EXISTS "ApiKey_providerId_fkey";

-- DropForeignKey
ALTER TABLE "Session" DROP CONSTRAINT IF EXISTS "Session_providerId_fkey";

-- DropTable
DROP TABLE IF EXISTS "ApiKey";

-- DropTable
DROP TABLE IF EXISTS "Session";
