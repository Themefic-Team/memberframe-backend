-- Initial schema: every table in schema.prisma, generated with
-- `prisma migrate diff --from-empty --to-schema-datamodel`. The two hand-written
-- migrations after this one alter these tables, so it must sort first.

-- CreateTable
CREATE TABLE `users` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `email_verified_at` DATETIME(3) NULL,
    `password_hash` VARCHAR(255) NULL,
    `framer_user_id` VARCHAR(255) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `users_email_key`(`email`),
    INDEX `users_framer_user_id_idx`(`framer_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sites` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `site_name` VARCHAR(255) NOT NULL,
    `site_key` VARCHAR(64) NOT NULL,
    `allowed_origins` JSON NOT NULL,
    `framer_site_id` VARCHAR(255) NULL,
    `grant_salt` CHAR(64) NOT NULL,
    `shared_password_hash` VARCHAR(255) NULL,
    `default_locale` VARCHAR(10) NOT NULL DEFAULT 'en',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `sites_site_key_key`(`site_key`),
    UNIQUE INDEX `sites_framer_site_id_key`(`framer_site_id`),
    INDEX `sites_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tiers` (
    `id` CHAR(36) NOT NULL,
    `site_id` CHAR(36) NOT NULL,
    `key` VARCHAR(50) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `rank` INTEGER NOT NULL,
    `monthly_price_minor` INTEGER NULL,
    `annual_price_minor` INTEGER NULL,
    `lifetime_price_minor` INTEGER NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'USD',
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uniq_tiers_site_key`(`site_id`, `key`),
    UNIQUE INDEX `uniq_tiers_site_rank`(`site_id`, `rank`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `members` (
    `id` CHAR(36) NOT NULL,
    `site_id` CHAR(36) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `email_verified_at` DATETIME(3) NULL,
    `name` VARCHAR(255) NULL,
    `avatar_url` TEXT NULL,
    `password_hash` VARCHAR(255) NULL,
    `password_updated_at` DATETIME(3) NULL,
    `active_tier` VARCHAR(50) NOT NULL DEFAULT 'free_member',
    `status` VARCHAR(20) NOT NULL DEFAULT 'active',
    `metadata` JSON NULL,
    `failed_login_count` INTEGER NOT NULL DEFAULT 0,
    `locked_until` DATETIME(3) NULL,
    `last_login_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `members_site_id_status_idx`(`site_id`, `status`),
    INDEX `members_site_id_active_tier_idx`(`site_id`, `active_tier`),
    INDEX `members_locked_until_idx`(`locked_until`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `member_sessions` (
    `id` CHAR(36) NOT NULL,
    `member_id` CHAR(36) NOT NULL,
    `site_id` CHAR(36) NOT NULL,
    `token_hash` VARCHAR(255) NOT NULL,
    `user_agent` VARCHAR(512) NULL,
    `ip_address` VARCHAR(45) NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `revoked_at` DATETIME(3) NULL,
    `last_seen_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `member_sessions_token_hash_key`(`token_hash`),
    INDEX `member_sessions_member_id_idx`(`member_id`),
    INDEX `member_sessions_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `member_password_resets` (
    `id` CHAR(36) NOT NULL,
    `site_id` CHAR(36) NOT NULL,
    `member_id` CHAR(36) NOT NULL,
    `token_hash` VARCHAR(255) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `consumed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `member_password_resets_token_hash_key`(`token_hash`),
    INDEX `member_password_resets_member_id_idx`(`member_id`),
    INDEX `member_password_resets_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `member_otps` (
    `id` CHAR(36) NOT NULL,
    `site_id` CHAR(36) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `code_hash` VARCHAR(255) NOT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `expires_at` DATETIME(3) NOT NULL,
    `resend_available_at` DATETIME(3) NOT NULL,
    `consumed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `member_otps_site_id_email_expires_at_idx`(`site_id`, `email`, `expires_at`),
    INDEX `member_otps_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `email_logs` (
    `id` CHAR(36) NOT NULL,
    `site_id` CHAR(36) NULL,
    `to_address` VARCHAR(255) NOT NULL,
    `subject` VARCHAR(255) NOT NULL,
    `template` VARCHAR(64) NOT NULL,
    `driver` VARCHAR(32) NOT NULL,
    `message_id` VARCHAR(255) NULL,
    `sent_at` DATETIME(3) NULL,
    `error` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `email_logs_to_address_created_at_idx`(`to_address`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `site_settings` (
    `site_id` CHAR(36) NOT NULL,
    `settings` JSON NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`site_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `creator_otps` (
    `id` CHAR(36) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `code_hash` VARCHAR(255) NOT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `framer_project_id` VARCHAR(255) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `resend_available_at` DATETIME(3) NOT NULL,
    `consumed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `creator_otps_email_framer_project_id_expires_at_idx`(`email`, `framer_project_id`, `expires_at`),
    INDEX `creator_otps_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `creator_sessions` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `token_hash` VARCHAR(255) NOT NULL,
    `user_agent` VARCHAR(512) NULL,
    `ip_address` VARCHAR(45) NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `revoked_at` DATETIME(3) NULL,
    `last_seen_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `creator_sessions_token_hash_key`(`token_hash`),
    INDEX `creator_sessions_user_id_idx`(`user_id`),
    INDEX `creator_sessions_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sites` ADD CONSTRAINT `sites_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tiers` ADD CONSTRAINT `tiers_site_id_fkey` FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `members` ADD CONSTRAINT `members_site_id_fkey` FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `member_sessions` ADD CONSTRAINT `member_sessions_member_id_fkey` FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `member_password_resets` ADD CONSTRAINT `member_password_resets_site_id_fkey` FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `member_password_resets` ADD CONSTRAINT `member_password_resets_member_id_fkey` FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `member_otps` ADD CONSTRAINT `member_otps_site_id_fkey` FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `email_logs` ADD CONSTRAINT `email_logs_site_id_fkey` FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `site_settings` ADD CONSTRAINT `site_settings_site_id_fkey` FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `creator_sessions` ADD CONSTRAINT `creator_sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

