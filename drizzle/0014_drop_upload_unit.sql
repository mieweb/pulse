-- A draft paired under the removed `segment` upload unit and not yet uploaded can't resume: its
-- anchor was an ordering manifest, not a video. Unpair it (back to an editable draft) and drop its
-- sub-artifact resume rows, plus any per-clip `:video` rows segment uploads left behind.
DELETE FROM `upload_artifacts` WHERE `draft_id` IN (SELECT `id` FROM `drafts` WHERE `upload_unit` = 'segment' AND `upload_status` IS NOT 'uploaded') OR `local_key` LIKE '%:video';--> statement-breakpoint
UPDATE `drafts` SET `upload_server` = NULL, `upload_artifact_id` = NULL, `upload_resource_url` = NULL, `upload_status` = NULL, `captions_upload_status` = NULL WHERE `upload_unit` = 'segment' AND `upload_status` IS NOT 'uploaded';--> statement-breakpoint
ALTER TABLE `drafts` DROP COLUMN `upload_unit`;--> statement-breakpoint
ALTER TABLE `upload_destinations` DROP COLUMN `upload_unit`;
