-- FP-10 bookmarks
CREATE TABLE `bookmarks` (
    `id` CHAR(36) NOT NULL,
    `site_id` CHAR(36) NOT NULL,
    `member_id` CHAR(36) NOT NULL,
    `item_slug` VARCHAR(191) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `url` VARCHAR(1000) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `bookmarks_site_id_idx`(`site_id`),
    UNIQUE INDEX `uniq_bookmarks_member_slug`(`member_id`, `item_slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- FP-07 server-side meter
CREATE TABLE `meter_cycles` (
    `member_id` CHAR(36) NOT NULL,
    `site_id` CHAR(36) NOT NULL,
    `cycle_start` DATETIME(3) NOT NULL,
    `period_days` INTEGER NOT NULL,
    `slugs` JSON NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `meter_cycles_site_id_idx`(`site_id`),
    PRIMARY KEY (`member_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- FP-12 protected files
CREATE TABLE `assets` (
    `id` VARCHAR(40) NOT NULL,
    `site_id` CHAR(36) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `file_name` VARCHAR(255) NOT NULL,
    `mime_type` VARCHAR(127) NOT NULL,
    `size_bytes` BIGINT NOT NULL DEFAULT 0,
    `source` VARCHAR(10) NOT NULL,
    `storage_key` VARCHAR(255) NULL,
    `remote_url` TEXT NULL,
    `required_tier` VARCHAR(50) NOT NULL DEFAULT 'signed_in',
    `download_count` INTEGER NOT NULL DEFAULT 0,
    `last_download_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `assets_site_id_idx`(`site_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `bookmarks` ADD CONSTRAINT `bookmarks_member_id_fkey` FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `meter_cycles` ADD CONSTRAINT `meter_cycles_member_id_fkey` FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `assets` ADD CONSTRAINT `assets_site_id_fkey` FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
