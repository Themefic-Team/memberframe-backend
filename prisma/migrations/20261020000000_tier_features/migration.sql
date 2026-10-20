-- Tier features: each tier's own pricing card lines, [{ text, included }].
-- memberframe/docs/development-docs/28-tier-features.md
ALTER TABLE `tiers` ADD COLUMN `features` JSON NULL;
