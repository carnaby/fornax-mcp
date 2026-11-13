CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_token_id` text NOT NULL,
	`kind` text NOT NULL,
	`job_id` text,
	`name` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`mime` text NOT NULL,
	`meta` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `files_job` ON `files` (`job_id`);--> statement-breakpoint
CREATE INDEX `files_owner` ON `files` (`owner_token_id`);--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`expires_at` integer NOT NULL,
	`token_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_types` (
	`name` text PRIMARY KEY NOT NULL,
	`contract` text NOT NULL,
	`contract_hash` text NOT NULL,
	`offered` integer NOT NULL,
	`last_offered_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_token_id` text NOT NULL,
	`type` text NOT NULL,
	`params` text NOT NULL,
	`inputs` text NOT NULL,
	`priority` integer NOT NULL,
	`group` text,
	`callback_url` text,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`run_after` integer NOT NULL,
	`lease_id` text,
	`lease_expires_at` integer,
	`progress` real,
	`progress_message` text,
	`error` text,
	`manifest` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_queue` ON `jobs` (`state`,`priority`,`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_owner` ON `jobs` (`owner_token_id`);--> statement-breakpoint
CREATE INDEX `jobs_group` ON `jobs` (`group`);--> statement-breakpoint
CREATE TABLE `tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`hash` text NOT NULL,
	`fingerprint` text NOT NULL,
	`webhook_key` text,
	`status` text NOT NULL,
	`invite_id` text,
	`created_at` integer NOT NULL,
	`approved_at` integer,
	`last_seen_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_hash_unique` ON `tokens` (`hash`);--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_token_id` text NOT NULL,
	`name` text NOT NULL,
	`file_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worker` (
	`id` integer PRIMARY KEY NOT NULL,
	`token_id` text NOT NULL,
	`hostname` text NOT NULL,
	`version` text,
	`last_seen_at` integer NOT NULL
);
