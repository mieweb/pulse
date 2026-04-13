# Remaining Manual TODO (For Professor Review)

## 1) Title and Front Matter

- [ ] Fill `\approvedby{...}` in `PurdueThesis/ch-front.tex` if your program office requires a specific Form 9 thesis head name.

## 2) Chapter 4 Validation Evidence (highest priority)

- [ ] Add runtime evidence for **all** validation families:
  - upload/finalize runtime logs + screenshot evidence,
  - transcode lifecycle runtime logs + screenshot evidence,
  - token/access-control negative/positive check evidence,
  - observability evidence (metrics, logs, audit chain examples).
- [ ] Add one short interpretation paragraph under each validation family:
  - what passed,
  - what is bounded/limited,
  - what is explicitly deferred.
- [ ] Sync runtime evidence references between:
  - `PurdueThesis/ch-system-design-validation.tex`,
  - `PurdueThesis/ap-validation-evidence-packet.tex`,
  - `PurdueThesis/ap-screenshot-catalog.tex` (if new images are added).

## 3) Remaining Figures/Screenshots

- [ ] QR/deeplink flow screenshots:
  - app scan result.
- [ ] Ops screenshots:
  - metrics endpoint (or dashboard panels),
  - logs/audit examples.

## 4) Advisor-Review Packet

- [ ] Prepare one 1-page “what changed” summary:
  - removed evaluation from title,
  - scope bounded to design + implementation + minimal validation,
  - future work carries full empirical evaluation.
- [ ] Send chapter-wise delta summary and request targeted feedback.

## 5) Additions to Strengthen Professor Review

- [ ] Add a 1-page "Claim vs Evidence vs Non-Claim" matrix for quick committee scanning.
- [ ] Prepare a runtime evidence mini-pack (3-5 snippets/screenshots) mirroring bounded validation tables.
- [ ] Draft a short "Known limits + deferred empirical plan" handout.
- [ ] Include a targeted feedback block with 3 specific review questions for professors.

## 6) Manual-Only Items

- [ ] Confirm exact `\approvedby{...}` value with your program office and enter the official name.
- [ ] Capture environment-specific runtime screenshots/logs from your real deployment/test runs.
- [ ] Verify confidential/sensitive operational data is redacted before sharing evidence with professors.
- [ ] Send the email/review packet to professors and collect targeted feedback responses.

