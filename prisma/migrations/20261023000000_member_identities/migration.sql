-- Sign-in methods: how each member signed up, and the social identities linked to them.
-- memberframe/docs/development-docs/31-sign-in-methods.md
ALTER TABLE `members` ADD COLUMN `signup_method` VARCHAR(20) NULL;

CREATE TABLE `member_identities` (
    `id` CHAR(36) NOT NULL,
    `site_id` CHAR(36) NOT NULL,
    `member_id` CHAR(36) NOT NULL,
    `provider` VARCHAR(20) NOT NULL,
    `provider_user_id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_used_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `member_identities_site_id_provider_provider_user_id_key`(`site_id`, `provider`, `provider_user_id`),
    INDEX `member_identities_member_id_idx`(`member_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `member_identities` ADD CONSTRAINT `member_identities_member_id_fkey` FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
