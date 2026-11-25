CREATE TABLE `job_inputs` (
	`job_id` text NOT NULL,
	`file_id` text NOT NULL,
	PRIMARY KEY(`job_id`, `file_id`)
);
--> statement-breakpoint
CREATE INDEX `job_inputs_file` ON `job_inputs` (`file_id`);--> statement-breakpoint
INSERT OR IGNORE INTO `job_inputs` (`job_id`, `file_id`) SELECT `job_id`, `id` FROM `files` WHERE `kind` = 'input' AND `job_id` IS NOT NULL;--> statement-breakpoint
UPDATE `files` SET `job_id` = NULL WHERE `kind` = 'input';