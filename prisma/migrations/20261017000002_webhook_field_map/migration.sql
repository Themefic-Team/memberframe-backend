-- Webhooks: a custom body, chosen fields under the creator's own keys.
-- memberframe/docs/development-docs/20-webhooks.md
ALTER TABLE `outbound_webhooks` ADD COLUMN `field_map` JSON NULL;
