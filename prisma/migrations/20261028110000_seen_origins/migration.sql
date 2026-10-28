-- Domains a site's own components have called from, so Profile can show a
-- domain as working and suggest one the creator has not added yet. Recorded
-- from requests to this server, never read from Framer (Marketplace review,
-- memberframe/docs/development-docs/35-marketplace-review-report.md).
ALTER TABLE `sites` ADD COLUMN `seen_origins` JSON NULL;
