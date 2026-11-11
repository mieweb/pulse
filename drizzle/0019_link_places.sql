ALTER TABLE `drafts` ADD `context_server` text;--> statement-breakpoint
ALTER TABLE `drafts` ADD `context_ref` text;--> statement-breakpoint
ALTER TABLE `upload_destinations` ADD `ref` text;--> statement-breakpoint
ALTER TABLE `upload_destinations` ADD `label` text;--> statement-breakpoint
ALTER TABLE `upload_destinations` ADD `app` text;--> statement-breakpoint
ALTER TABLE `upload_destinations` ADD `return_url` text;--> statement-breakpoint
CREATE UNIQUE INDEX `upload_destinations_server_ref_unique` ON `upload_destinations` (`server`,`ref`);