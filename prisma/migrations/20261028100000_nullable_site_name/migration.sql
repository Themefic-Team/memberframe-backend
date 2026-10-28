-- The plugin no longer reads the Framer project name, the Framer user, the
-- Framer project id, or the published domains (Framer Marketplace review,
-- memberframe/docs/development-docs/35-marketplace-review-report.md).
-- A site created from now on has no name, so the column takes NULL.
-- Existing values are kept, as decided on 2026-10-28.
ALTER TABLE `sites` MODIFY `site_name` VARCHAR(255) NULL;
ALTER TABLE `plugin_trials` MODIFY `project_name` VARCHAR(255) NULL;
