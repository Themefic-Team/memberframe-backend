-- CreateTable
CREATE TABLE `payment_settings` (
    `site_id` CHAR(36) NOT NULL,
    `mode` VARCHAR(8) NOT NULL DEFAULT 'test',
    `default_gateway` VARCHAR(20) NOT NULL DEFAULT '',
    `auto_detect_geolocation` BOOLEAN NOT NULL DEFAULT true,
    `default_currency` CHAR(3) NOT NULL DEFAULT 'USD',
    `grace_days` INTEGER NOT NULL DEFAULT 3,
    `after_purchase_path` VARCHAR(255) NOT NULL DEFAULT '/dashboard',
    `pricing_path` VARCHAR(255) NOT NULL DEFAULT '/pricing',
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`site_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `gateway_configs` (
    `id` CHAR(36) NOT NULL,
    `site_id` CHAR(36) NOT NULL,
    `gateway` VARCHAR(20) NOT NULL,
    `mode` VARCHAR(8) NOT NULL,
    `public_id` VARCHAR(255) NULL,
    `secrets_encrypted` TEXT NOT NULL,
    `webhook_secret_encrypted` TEXT NULL,
    `webhook_endpoint_id` VARCHAR(255) NULL,
    `options` JSON NULL,
    `account_name` VARCHAR(255) NULL,
    `masked_suffix` VARCHAR(8) NULL,
    `verified_at` DATETIME(3) NULL,
    `last_webhook_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uniq_gateway_configs_site_gateway_mode`(`site_id`, `gateway`, `mode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `gateway_prices` (
    `id` CHAR(36) NOT NULL,
    `site_id` CHAR(36) NOT NULL,
    `tier_key` VARCHAR(50) NOT NULL,
    `interval` VARCHAR(10) NOT NULL,
    `amount_minor` INTEGER NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `gateway` VARCHAR(20) NOT NULL,
    `mode` VARCHAR(8) NOT NULL,
    `external_id` VARCHAR(255) NOT NULL,
    `external_product_id` VARCHAR(255) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uniq_gateway_prices_lookup`(`site_id`, `tier_key`, `interval`, `amount_minor`, `currency`, `gateway`, `mode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `checkouts` (
    `id` CHAR(36) NOT NULL,
    `site_id` CHAR(36) NOT NULL,
    `member_id` CHAR(36) NOT NULL,
    `tier_key` VARCHAR(50) NOT NULL,
    `interval` VARCHAR(10) NOT NULL,
    `gateway` VARCHAR(20) NOT NULL,
    `mode` VARCHAR(8) NOT NULL,
    `external_id` VARCHAR(255) NULL,
    `state` VARCHAR(10) NOT NULL DEFAULT 'open',
    `return_path` VARCHAR(255) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completed_at` DATETIME(3) NULL,

    INDEX `checkouts_site_id_member_id_idx`(`site_id`, `member_id`),
    INDEX `checkouts_gateway_external_id_idx`(`gateway`, `external_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `subscriptions` (
    `id` CHAR(36) NOT NULL,
    `site_id` CHAR(36) NOT NULL,
    `member_id` CHAR(36) NOT NULL,
    `tier_key` VARCHAR(50) NOT NULL,
    `interval` VARCHAR(10) NOT NULL,
    `gateway` VARCHAR(20) NOT NULL,
    `mode` VARCHAR(8) NOT NULL,
    `external_id` VARCHAR(255) NOT NULL,
    `external_customer_id` VARCHAR(255) NULL,
    `status` VARCHAR(12) NOT NULL,
    `current_period_end` DATETIME(3) NULL,
    `grace_period_ends_at` DATETIME(3) NULL,
    `cancel_at_period_end` BOOLEAN NOT NULL DEFAULT false,
    `amount_minor` INTEGER NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `manage_url` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `ended_at` DATETIME(3) NULL,

    INDEX `subscriptions_site_id_member_id_status_idx`(`site_id`, `member_id`, `status`),
    INDEX `subscriptions_status_current_period_end_idx`(`status`, `current_period_end`),
    INDEX `subscriptions_status_grace_period_ends_at_idx`(`status`, `grace_period_ends_at`),
    UNIQUE INDEX `uniq_subscriptions_gateway_external`(`gateway`, `external_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payments` (
    `id` CHAR(36) NOT NULL,
    `site_id` CHAR(36) NOT NULL,
    `member_id` CHAR(36) NOT NULL,
    `subscription_id` CHAR(36) NULL,
    `gateway` VARCHAR(20) NOT NULL,
    `mode` VARCHAR(8) NOT NULL,
    `external_id` VARCHAR(255) NOT NULL,
    `amount_minor` INTEGER NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `status` VARCHAR(10) NOT NULL,
    `receipt_url` TEXT NULL,
    `paid_at` DATETIME(3) NOT NULL,

    INDEX `payments_site_id_member_id_idx`(`site_id`, `member_id`),
    UNIQUE INDEX `uniq_payments_gateway_external`(`gateway`, `external_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhook_events` (
    `id` CHAR(36) NOT NULL,
    `gateway` VARCHAR(20) NOT NULL,
    `event_id` VARCHAR(255) NOT NULL,
    `site_id` CHAR(36) NULL,
    `type` VARCHAR(100) NOT NULL,
    `received_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processed_at` DATETIME(3) NULL,
    `error` TEXT NULL,

    UNIQUE INDEX `uniq_webhook_events_gateway_event`(`gateway`, `event_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `payment_settings` ADD CONSTRAINT `payment_settings_site_id_fkey` FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `gateway_configs` ADD CONSTRAINT `gateway_configs_site_id_fkey` FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_site_id_fkey` FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_member_id_fkey` FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

