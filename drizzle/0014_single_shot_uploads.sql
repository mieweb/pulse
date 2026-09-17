DROP TABLE `upload_artifacts`;--> statement-breakpoint
ALTER TABLE `upload_destinations` ADD `direct_upload` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `drafts` DROP COLUMN `captions_upload_status`;--> statement-breakpoint
ALTER TABLE `drafts` DROP COLUMN `upload_merged_path`;--> statement-breakpoint
ALTER TABLE `drafts` DROP COLUMN `upload_merged_duration_ms`;--> statement-breakpoint
UPDATE `drafts` SET `upload_status` = NULL, `upload_server` = NULL, `upload_artifact_id` = NULL, `upload_resource_url` = NULL WHERE `upload_status` = 'failed';
