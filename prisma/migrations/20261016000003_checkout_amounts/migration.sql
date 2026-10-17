-- AlterTable
ALTER TABLE `checkouts` ADD COLUMN `amount_minor` INTEGER NULL,
    ADD COLUMN `currency` CHAR(3) NULL,
    ADD COLUMN `replaces_subscription_id` CHAR(36) NULL;
