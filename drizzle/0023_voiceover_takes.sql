CREATE TABLE `voiceover_takes` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`filename` text NOT NULL,
	`start_ms` real NOT NULL,
	`duration_ms` real NOT NULL,
	`trim_start_ms` real NOT NULL,
	`trim_end_ms` real NOT NULL,
	`sequence` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `voiceover_takes_draft_sequence_unique` ON `voiceover_takes` (`draft_id`,`sequence`);--> statement-breakpoint
ALTER TABLE `drafts` ADD `source_audio_muted` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `drafts` ADD `voiceover_muted` integer DEFAULT false NOT NULL;