-- Fair plan changes: upgrade credit given as a discount, downgrades at period end.
-- memberframe/docs/development-docs/30-plan-changes.md
ALTER TABLE `checkouts` ADD COLUMN `credit_minor` INTEGER NULL;
ALTER TABLE `subscriptions` ADD COLUMN `scheduled_tier_key` VARCHAR(50) NULL, ADD COLUMN `scheduled_interval` VARCHAR(10) NULL;
