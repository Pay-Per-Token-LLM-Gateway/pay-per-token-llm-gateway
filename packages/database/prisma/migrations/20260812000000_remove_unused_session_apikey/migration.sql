-- Remove unused Session and ApiKey models.
-- Sessions live in Redis (AuthStore) and no code path reads or writes ApiKey,
-- so these tables are dead and only add migration surface.

-- Drop the ApiKey table (FK to Provider handled by onDelete: Cascade at the app level).
DROP TABLE IF EXISTS "ApiKey";

-- Drop the Session table (FK to Provider handled by onDelete: Cascade at the app level).
DROP TABLE IF EXISTS "Session";