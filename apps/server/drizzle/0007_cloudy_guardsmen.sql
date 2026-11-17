ALTER TABLE `jobs` ADD `stopped_lease_id` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `idle_since` integer;--> statement-breakpoint
UPDATE `jobs` SET `priority` = 1 WHERE `priority` = 0;