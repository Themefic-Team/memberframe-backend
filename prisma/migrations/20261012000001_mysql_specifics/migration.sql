-- MySQL specifics Prisma cannot express in schema.prisma.
--
-- Run AFTER the initial migration that creates the tables. This file is
-- hand written and `prisma migrate dev` will not regenerate or overwrite it,
-- which is why it lives in its own migration rather than being edited into
-- the generated one.
--
-- If you reset the database with `prisma migrate reset`, this replays with the
-- rest. If you edit it after it has been applied, Prisma will refuse: create a
-- new migration instead.

-- ---------------------------------------------------------------------------
-- 1. Email collation: case insensitive, accent SENSITIVE
-- ---------------------------------------------------------------------------
-- PostgreSQL gave us this with CITEXT. MySQL 8's default collation
-- (utf8mb4_0900_ai_ci) is case insensitive, which is what we want, but it is
-- also accent insensitive, which we do not: under `ai` the addresses
-- jose@example.com and jos<e-acute>@example.com compare equal and the unique
-- index would treat them as one mailbox. They are two different mailboxes.
--
-- `as_ci` is accent sensitive and case insensitive, which is exactly the rule
-- email addresses follow in practice.

ALTER TABLE `members`
  MODIFY `email` VARCHAR(255)
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_ci NOT NULL;

ALTER TABLE `member_otps`
  MODIFY `email` VARCHAR(255)
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_ci NOT NULL;

ALTER TABLE `users`
  MODIFY `email` VARCHAR(255)
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_ci NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Soft-delete-aware unique email, via a generated column
-- ---------------------------------------------------------------------------
-- The requirement is two rules at once, from PRD section 11.2:
--   a. `Member.email` is unique per site
--   b. members are soft deleted, so invoice history survives
--
-- PostgreSQL expresses that with a partial index:
--   CREATE UNIQUE INDEX ... ON members (site_id, email) WHERE deleted_at IS NULL
--
-- MySQL has no partial indexes, and the obvious workaround is WRONG. A unique
-- key over (site_id, email, deleted_at) permits unlimited active duplicates,
-- because MySQL treats every NULL in a unique index as distinct from every
-- other NULL. Three live members could share an address and the constraint
-- would not complain.
--
-- A generated column inverts the problem. `active_email` holds the address
-- while the row is live and NULL once it is deleted, so the unique index
-- constrains live rows only and the many NULLs of deleted rows never collide.
-- A soft-deleted member releases their address and can register again.

ALTER TABLE `members`
  ADD COLUMN `active_email` VARCHAR(255)
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_ci
  GENERATED ALWAYS AS (IF(`deleted_at` IS NULL, `email`, NULL)) STORED;

CREATE UNIQUE INDEX `uniq_members_site_active_email`
  ON `members` (`site_id`, `active_email`);

-- STORED rather than VIRTUAL because MySQL cannot build a unique index on a
-- virtual column. The cost is one extra copy of the address per live row.
--
-- The expression uses only IF() and a column reference. MySQL requires a
-- generated column expression to be deterministic, so NOW() or any
-- session-dependent function would be rejected here.

-- ---------------------------------------------------------------------------
-- 3. A plain index on members.email
-- ---------------------------------------------------------------------------
-- `active_email` covers lookups for live members, which is almost every query.
-- This one covers the case that is not: deciding whether an address was ever
-- registered on this site, including rows that have been deleted.

CREATE INDEX `idx_members_site_email` ON `members` (`site_id`, `email`);
