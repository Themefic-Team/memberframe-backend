-- Visitor IP addresses are no longer collected (Framer Marketplace audit I5).
-- The code stopped writing them; this clears what earlier versions stored.
-- The columns stay, always NULL, and are dropped in a later release so a
-- rollback to the previous build still finds them.
-- memberframe/docs/framer-marketplace-audit.md
UPDATE `member_sessions` SET `ip_address` = NULL WHERE `ip_address` IS NOT NULL;
UPDATE `creator_sessions` SET `ip_address` = NULL WHERE `ip_address` IS NOT NULL;
