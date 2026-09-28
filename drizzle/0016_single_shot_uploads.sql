-- There is no failed state and no retry any more: a draft is paired only while `uploading` or
-- `uploaded`, and a link is spent the moment a draft claims it. The old model kept a link in the
-- pool until its upload succeeded, so first remove every link a draft has used; then unpair every
-- draft that isn't uploading or uploaded (`failed`, cancelled `idle`, and NULL rows a clip edit
-- left paired). `uploading` drafts are failed by the launch check.
DELETE FROM `upload_destinations` WHERE `artifact_id` IN (SELECT `upload_artifact_id` FROM `drafts` WHERE `upload_artifact_id` IS NOT NULL);--> statement-breakpoint
UPDATE `drafts` SET `upload_server` = NULL, `upload_artifact_id` = NULL, `upload_status` = NULL WHERE `upload_status` IS NOT 'uploading' AND `upload_status` IS NOT 'uploaded';--> statement-breakpoint
DROP TABLE `upload_artifacts`;--> statement-breakpoint
ALTER TABLE `drafts` DROP COLUMN `upload_resource_url`;--> statement-breakpoint
ALTER TABLE `drafts` DROP COLUMN `captions_upload_status`;
