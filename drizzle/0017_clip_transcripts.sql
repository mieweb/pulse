CREATE TABLE `clip_transcripts` (
	`segment_id` text NOT NULL,
	`model` text NOT NULL,
	`file` text NOT NULL,
	`status` text NOT NULL,
	`words` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`segment_id`, `model`),
	FOREIGN KEY (`segment_id`) REFERENCES `segments`(`id`) ON UPDATE no action ON DELETE cascade
);
