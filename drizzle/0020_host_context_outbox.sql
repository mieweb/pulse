CREATE TABLE `local_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `upload_jobs` (
	`draft_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`client_key` text NOT NULL,
	`draft_key` text NOT NULL,
	`merged_signature` text NOT NULL,
	`sent_at` integer NOT NULL,
	`upload_id` text,
	`artifact_id` text,
	`endpoint` text,
	`parts_json` text,
	`bytes_total` integer,
	`bytes_sent` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`token_exp` integer,
	`last_error_code` text,
	`last_error_message` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `upload_jobs_client_key_unique` ON `upload_jobs` (`client_key`);--> statement-breakpoint
CREATE TABLE `upload_receipts` (
	`draft_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`context_key` text,
	`context_label` text,
	`context_json` text,
	`upload_type_json` text,
	`outcome` text NOT NULL,
	`note` text,
	`reason` text,
	`upload_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`client_key` text NOT NULL,
	`clip_count` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`sent_at` integer NOT NULL,
	`delivered_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`dismissed_at` integer,
	`media_deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `upload_receipts_context_key_idx` ON `upload_receipts` (`context_key`);--> statement-breakpoint
ALTER TABLE `drafts` ADD `context_key` text;--> statement-breakpoint
ALTER TABLE `drafts` ADD `context_label` text;--> statement-breakpoint
ALTER TABLE `drafts` ADD `context_json` text;--> statement-breakpoint
ALTER TABLE `drafts` ADD `upload_type_json` text;--> statement-breakpoint
ALTER TABLE `drafts` ADD `created_via` text DEFAULT 'app' NOT NULL;--> statement-breakpoint
ALTER TABLE `drafts` ADD `host_confirmed_at` integer;--> statement-breakpoint
ALTER TABLE `drafts` ADD `sent_at` integer;--> statement-breakpoint
CREATE INDEX `drafts_context_key_idx` ON `drafts` (`context_key`);