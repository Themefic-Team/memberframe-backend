-- Protected downloads uploaded on the canvas: a rule as long as "only:a,b,c",
-- and a shared password instead of a membership.
-- memberframe/docs/development-docs/32-canvas-downloads.md
ALTER TABLE `assets` MODIFY `required_tier` VARCHAR(255) NOT NULL DEFAULT 'signed_in';
ALTER TABLE `assets` ADD COLUMN `password_hash` VARCHAR(255) NULL;
