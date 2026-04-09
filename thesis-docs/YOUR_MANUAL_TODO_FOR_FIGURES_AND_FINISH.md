# Your Manual TODO (Figures, Screenshots, Final Finish)

This checklist is for items only you can supply manually (screenshots, deployment evidence, committee fields, and final polish artifacts).

## 1) Title and Front Matter

- [x] Confirm final title everywhere:
  - dissertation draft title page
  - `PurdueThesis/thesis.tex` `\ZZtitle`
  - PDF metadata title
- [x] Fill committee names/departments/advisor fields.
- [x] Finalize graduation month/year and any campus/program details.

## 2) Chapter 4 Evidence Inserts (high priority)

- [ ] Fill all `[fill]` cells in validation tables (upload, transcode, token, observability).
- [ ] Add run logs/screenshots proving each check.
- [ ] Add one short narrative paragraph under each result table:
  - what passed
  - what failed/limited
  - what is deferred

## 3) Figures to Insert (status updated)

- [x] Mobile app screenshots:
  - capture flow
  - segment edit/reorder
  - upload state
- [x] PulseVault website screenshots:
  - auth/login
  - upload/dashboard
  - playback views
- [ ] QR/deeplink flow screenshots:
  - generated QR (done)
  - app scan result
  - tokenized upload initiation (done)
- [ ] Ops screenshots:
  - metrics endpoint (or dashboard panels)
  - logs/audit examples

Notes:
- Replaced older app/iPad screenshot set with current UI screenshots.
- Added renamed current assets to `appstore_screenshots` and synced to
  `PurdueThesis/graphics/appstore_screenshots`.
- Updated Chapter 4 and screenshot catalog to reference the new files.

## 4) Table and Figure Numbering Pass

- [x] Ensure each figure/table is referenced in prose before/near placement.
- [x] Keep caption style consistent (short title + analytic takeaway).
- [x] Verify no orphan figures/tables without interpretation text.

## 5) References and Citation Integrity

- [x] Replace working references block with final bibliography list.
- [x] Ensure all in-text citations appear in references and vice versa.
- [x] Remove weak/context-only sources from load-bearing arguments.

## 6) Purdue Finish Pass

- [x] Ensure lists (TOC, tables, figures, abbreviations) compile cleanly.
- [x] Confirm appendix order and labels.
- [x] Final PDF margin, heading, and spacing checks per Purdue template.

## 7) Advisor-Review Packet

- [ ] Prepare one 1-page “what changed” summary:
  - removed evaluation from title
  - scope bounded to design + implementation + minimal validation
  - future work carries full empirical evaluation
- [ ] Send chapter-wise delta summary and request targeted feedback.

