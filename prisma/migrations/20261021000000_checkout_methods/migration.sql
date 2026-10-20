-- Checkout methods: buyers choose how to pay; each gateway can be kept off.
-- memberframe/docs/development-docs/29-checkout-methods.md
ALTER TABLE `gateway_configs` ADD COLUMN `enabled` BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE `payment_settings` ADD COLUMN `method_labels` JSON NULL;
