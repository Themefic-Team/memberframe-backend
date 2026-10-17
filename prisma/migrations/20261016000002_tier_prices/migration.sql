-- CreateTable
CREATE TABLE `tier_prices` (
    `id` CHAR(36) NOT NULL,
    `tier_id` CHAR(36) NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `interval` VARCHAR(10) NOT NULL,
    `amount_minor` INTEGER NOT NULL,

    UNIQUE INDEX `uniq_tier_prices_tier_currency_interval`(`tier_id`, `currency`, `interval`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `tier_prices` ADD CONSTRAINT `tier_prices_tier_id_fkey` FOREIGN KEY (`tier_id`) REFERENCES `tiers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
