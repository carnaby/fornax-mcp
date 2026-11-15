DROP INDEX `jobs_queue`;--> statement-breakpoint
ALTER TABLE `jobs` ADD `queue_rank` integer;--> statement-breakpoint
CREATE INDEX `jobs_queue` ON `jobs` (`state`,`queue_rank`);