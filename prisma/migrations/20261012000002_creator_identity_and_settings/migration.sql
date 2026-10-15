-- MySQL specifics for the connect flow's new tables.
--
-- Second hand-written migration, and it exists for the same reason as the
-- first: Prisma models a column's type, not its collation. Prisma generates
-- `creator_otps` and `creator_sessions` with the database default, which in
-- MySQL 8 is utf8mb4_0900_ai_ci. That is accent INsensitive, so without this
-- file jose@example.com and the accented spelling would be one address.
--
-- A creator OTP is looked up by (email, framer_project_id), so an accent
-- insensitive collation here is not a cosmetic problem: a code minted for one
-- address could be verified by a different one.
--
-- Run AFTER the generated migration that creates these tables. If you edit
-- this file after it has applied, Prisma refuses; create a new migration.

-- ---------------------------------------------------------------------------
-- 1. Email collation on the new table
-- ---------------------------------------------------------------------------

ALTER TABLE `creator_otps`
  MODIFY `email` VARCHAR(255)
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_ci NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. The settings document is checked, not trusted
-- ---------------------------------------------------------------------------
-- `site_settings.settings` is a JSON column, and MySQL 8 validates that a JSON
-- column holds well-formed JSON but says nothing about its shape. It will
-- happily store `7`, `"hello"`, or `null`.
--
-- `lib/siteSettings.ts` already survives all three, because `withDefaults` is
-- total and returns a complete document for any input. This constraint is the
-- cheap half of the same guarantee: it stops a scalar reaching the column at
-- all, so the application only ever has to cope with a wrong-shaped OBJECT and
-- never with a document that is not one.
--
-- JSON_TYPE on a NULL column value returns NULL, which is neither TRUE nor
-- FALSE, so a CHECK constraint accepts it. The column is NOT NULL, so that
-- case cannot arise here, but it is the reason this reads as it does rather
-- than needing an explicit null branch.

ALTER TABLE `site_settings`
  ADD CONSTRAINT `chk_site_settings_is_object`
  CHECK (JSON_TYPE(`settings`) = 'OBJECT');

-- ---------------------------------------------------------------------------
-- 3. One live connect code per address and project
-- ---------------------------------------------------------------------------
-- `startConnect` consumes every outstanding code before minting a new one, so
-- in practice there is one. This index is what makes finding it cheap, and it
-- is deliberately NOT unique: consumed rows accumulate under the same pair and
-- a unique key would reject the second code anyone ever requests.

CREATE INDEX `idx_creator_otps_live`
  ON `creator_otps` (`email`, `framer_project_id`, `consumed_at`, `expires_at`);
