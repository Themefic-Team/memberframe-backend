-- F19 plugin billing: trial, subscriptions, payments, platform webhook events,
-- the hosted account page's hand-off. memberframe/docs/development-docs/19-pro-lock-and-trial.md
-- AlterTable
ALTER TABLE `users` ADD COLUMN `avatar_url` VARCHAR(1000) NULL,
    ADD COLUMN `google_id` VARCHAR(255) NULL,
    ADD COLUMN `stripe_customer_id` VARCHAR(255) NULL;

-- CreateTable
CREATE TABLE `plugin_trials` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `framer_user_id` VARCHAR(255) NULL,
    `framer_project_id` VARCHAR(255) NULL,
    `site_id` CHAR(36) NOT NULL,
    `project_name` VARCHAR(255) NOT NULL DEFAULT '',
    `started_at` DATETIME(3) NOT NULL,
    `ends_at` DATETIME(3) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'trialing',
    `ending_notified_at` DATETIME(3) NULL,
    `ended_notified_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `plugin_trials_user_id_key`(`user_id`),
    UNIQUE INDEX `plugin_trials_email_key`(`email`),
    UNIQUE INDEX `plugin_trials_framer_user_id_key`(`framer_user_id`),
    UNIQUE INDEX `plugin_trials_framer_project_id_key`(`framer_project_id`),
    INDEX `plugin_trials_site_id_idx`(`site_id`),
    INDEX `plugin_trials_status_ends_at_idx`(`status`, `ends_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plugin_subscriptions` (
    `id` CHAR(36) NOT NULL,
    `site_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `plan` VARCHAR(16) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `stripe_subscription_id` VARCHAR(255) NULL,
    `stripe_payment_intent_id` VARCHAR(255) NULL,
    `stripe_price_id` VARCHAR(255) NULL,
    `amount_minor` INTEGER NOT NULL,
    `currency` VARCHAR(3) NOT NULL,
    `started_at` DATETIME(3) NULL,
    `current_period_start` DATETIME(3) NULL,
    `current_period_end` DATETIME(3) NULL,
    `cancel_at_period_end` BOOLEAN NOT NULL DEFAULT false,
    `canceled_at` DATETIME(3) NULL,
    `cancel_reason` VARCHAR(500) NULL,
    `renewal_notified_for` DATETIME(3) NULL,
    `expired_notified_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `plugin_subscriptions_stripe_subscription_id_key`(`stripe_subscription_id`),
    UNIQUE INDEX `plugin_subscriptions_stripe_payment_intent_id_key`(`stripe_payment_intent_id`),
    INDEX `plugin_subscriptions_site_id_created_at_idx`(`site_id`, `created_at`),
    INDEX `plugin_subscriptions_status_current_period_end_idx`(`status`, `current_period_end`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plugin_payments` (
    `id` CHAR(36) NOT NULL,
    `subscription_id` CHAR(36) NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `amount_minor` INTEGER NOT NULL,
    `credit_minor` INTEGER NOT NULL DEFAULT 0,
    `currency` VARCHAR(3) NOT NULL,
    `stripe_invoice_id` VARCHAR(255) NULL,
    `stripe_payment_intent_id` VARCHAR(255) NULL,
    `paid_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `plugin_payments_stripe_invoice_id_key`(`stripe_invoice_id`),
    UNIQUE INDEX `plugin_payments_stripe_payment_intent_id_key`(`stripe_payment_intent_id`),
    INDEX `plugin_payments_subscription_id_paid_at_idx`(`subscription_id`, `paid_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `platform_webhook_events` (
    `id` CHAR(36) NOT NULL,
    `stripe_event_id` VARCHAR(255) NOT NULL,
    `type` VARCHAR(80) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `platform_webhook_events_stripe_event_id_key`(`stripe_event_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `creator_auth_handoffs` (
    `id` CHAR(36) NOT NULL,
    `session_id_hash` VARCHAR(255) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `consumed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `creator_auth_handoffs_session_id_hash_key`(`session_id_hash`),
    INDEX `creator_auth_handoffs_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `users_google_id_key` ON `users`(`google_id`);

-- CreateIndex
CREATE UNIQUE INDEX `users_stripe_customer_id_key` ON `users`(`stripe_customer_id`);

-- AddForeignKey
ALTER TABLE `plugin_subscriptions` ADD CONSTRAINT `plugin_subscriptions_site_id_fkey` FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plugin_payments` ADD CONSTRAINT `plugin_payments_subscription_id_fkey` FOREIGN KEY (`subscription_id`) REFERENCES `plugin_subscriptions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `creator_auth_handoffs` ADD CONSTRAINT `creator_auth_handoffs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

