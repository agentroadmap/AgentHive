-- P514: Georgia Singer Tenant Database Bring-up
-- Manual operator bring-up (using pattern from P513 monkeyking-audio + P495 saga)
-- Date: 2026-06-12 (re-execution after 2026-06-10 disk-full recovery)

-- Step 1: Verify georgia_singer_owner role exists (should exist from prior create)
--         If not, create it. Password is stored in vault; here we use a placeholder.
--         Real password must match what's in vault://file/project/georgia-singer/db_password

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'georgia_singer_owner') THEN
    -- Role doesn't exist; we need to create it with the vault password
    -- This step is only needed if the registry/vault was preserved but the role was lost
    RAISE NOTICE 'georgia_singer_owner role not found; must be created manually with vault password';
  ELSE
    RAISE NOTICE 'georgia_singer_owner role exists; proceeding to database creation';
  END IF;
END $$;

-- Step 2: Create the georgia_singer database (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'georgia_singer') THEN
    CREATE DATABASE georgia_singer OWNER georgia_singer_owner;
    RAISE NOTICE 'georgia_singer database created';
  ELSE
    RAISE NOTICE 'georgia_singer database already exists';
  END IF;
END $$;

-- Step 3: Verify database owner (sanity check)
SELECT datname, pg_get_userbyid(datdba) as owner
FROM pg_database
WHERE datname = 'georgia_singer';
