ALTER TABLE `drafts` ADD `merged_signature` text;--> statement-breakpoint
ALTER TABLE `drafts` ADD `merged_duration_ms` integer;--> statement-breakpoint
ALTER TABLE `drafts` DROP COLUMN `upload_merged_path`;--> statement-breakpoint
ALTER TABLE `drafts` DROP COLUMN `upload_merged_duration_ms`;