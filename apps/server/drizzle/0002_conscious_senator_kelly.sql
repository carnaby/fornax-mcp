CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`owner_token_id` text NOT NULL,
	`url` text NOT NULL,
	`payload` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`next_at` integer NOT NULL,
	`status` text NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhook_due` ON `webhook_deliveries` (`status`,`next_at`);--> statement-breakpoint
CREATE INDEX `webhook_job` ON `webhook_deliveries` (`job_id`);