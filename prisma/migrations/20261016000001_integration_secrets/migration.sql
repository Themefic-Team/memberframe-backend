-- CreateTable
CREATE TABLE `integration_secrets` (
    `site_id` CHAR(36) NOT NULL,
    `integration_id` VARCHAR(40) NOT NULL,
    `secrets_encrypted` TEXT NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`site_id`, `integration_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
