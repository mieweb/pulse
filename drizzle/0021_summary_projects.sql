ALTER TABLE `drafts` ADD `is_summary` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `drafts` ADD `summary_cutoff_at` integer;--> statement-breakpoint
ALTER TABLE `segments` ADD `added_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Older releases have no beat-level timestamps. Their project's last modification is the
-- best available approximation, frozen here so future renames/edits cannot change the date.
UPDATE `segments` SET `added_at` = CAST(COALESCE((
  SELECT `last_modified` FROM `drafts` WHERE `drafts`.`id` = `segments`.`draft_id`
), 0) AS integer);
