-- Webhooks: member events posted to a creator's third-party URLs.
-- memberframe/docs/development-docs/20-webhooks.md
CREATE TABLE `outbound_webhooks` (
    `id` CHAR(36) NOT NULL,
    `site_id` CHAR(36) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `url` VARCHAR(1000) NOT NULL,
    `events` JSON NOT NULL,
    `tiers` JSON NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `secret` VARCHAR(100) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `outbound_webhooks_site_id_idx`(`site_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `outbound_deliveries` (
    `id` CHAR(36) NOT NULL,
    `webhook_id` CHAR(36) NOT NULL,
    `site_id` CHAR(36) NOT NULL,
    `event` VARCHAR(40) NOT NULL,
    `payload` JSON NOT NULL,
    `status` VARCHAR(12) NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `next_attempt_at` DATETIME(3) NULL,
    `last_status` INTEGER NULL,
    `last_error` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `delivered_at` DATETIME(3) NULL,

    INDEX `outbound_deliveries_status_next_attempt_at_idx`(`status`, `next_attempt_at`),
    INDEX `outbound_deliveries_webhook_id_created_at_idx`(`webhook_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `outbound_webhooks` ADD CONSTRAINT `outbound_webhooks_site_id_fkey` FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `outbound_deliveries` ADD CONSTRAINT `outbound_deliveries_webhook_id_fkey` FOREIGN KEY (`webhook_id`) REFERENCES `outbound_webhooks`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
