# Thesis Plan Context and Execution (Pulse/PulseVault)

Date: 2026-04-09  
Owner: Priyam More  
Status: Active execution context for thesis finalization and professor re-review

## 1) Context Captured from Planning Chat

This document records the agreed direction and constraints from the planning conversation so thesis writing decisions stay consistent.

### 1.1 Agreed Direction

- Thesis should **closely mirror** the successful Purdue structure style used in Maleeha Sheikh's thesis, while remaining a **system-design thesis**.
- Structural mode selected: **close but flexible** (mirror chapter rhythm and polish, adapt chapter internals for Pulse/PulseVault).
- Evaluation mode selected: **minimal technical validation now**, with broader empirical/user-study evaluation moved to **future work**.
- Citation strategy selected: **broad search**, **balanced source policy**.
- Discovery workflow selected: use **Consensus for discovery**, then verify each paper via web/DOI/publisher before using in dissertation.

### 1.2 Page-Length Target

- Target dissertation length: about **120 pages**.
- Acceptable range: **118-126 pages**.

## 2) Structural Reference and Core Draft Inputs

### 2.1 Structural Mirror Reference

- `thesis-docs/INVESTIGATING HUMAN VALUES AND LINGUISTIC PATTERNS IN MENTAL HEALTH CHATBOTS.pdf`
  - Extracted length: 123 pages.
  - Strong template signals: front matter completeness, section granularity, figure/table density, chapter pacing.

### 2.2 Primary Draft to Transform

- `thesis-docs/dissertation-draft-v3-purdue-style.md`

### 2.3 Legacy and Supporting Inputs

- `thesis-docs/thesis.txt`
- `thesis-docs/papers.txt`
- `thesis-docs/citation-map-and-new-sources.md`
- `thesis-docs/reference-verification-audit.md`
- `thesis-docs/CONSENSUS_SEARCH_AND_PAPER_VERIFICATION_LOG.md`

### 2.4 Architecture Grounding Inputs

- `pulse-vault/SYSTEM_ARCHITECTURE.md`
- `pulse-vault/README.md`
- Mobile/client architecture from `app/`, `utils/`, `hooks/`, and native concat module folders.

## 3) Research Quality Policy (Locked)

### 3.1 Load-Bearing Sources (Core)

Use for central architectural and research claims:

- Hevner et al. (2004), design science.
- Bass, Clements, Kazman (software architecture quality attributes).
- Kruchten (4+1 model).
- RFC 8216 (HLS).
- RFC 6749 + RFC 9700 (OAuth + modern security BCP).
- tus resumable upload protocol.
- NIST SP 800-66r2 + HHS HIPAA Security Rule summary.
- Google SRE + Prometheus docs.
- Nonaka + Davenport/Prusak.
- Mayer (2005, 2009), bounded use.
- Kumar et al. (2024), bounded use.

### 3.2 Context-Only Sources

Use only for background or future work context:

- Short-form platform trend papers.
- Living lab/SUS adoption studies unless corresponding empirical chapter is actually included.
- Lower-rigor niche journals when stronger sources exist.

### 3.3 Exclusion Rule

If a source is not confidently verified or has weak claim fit, do not use it for load-bearing claims.

## 4) Current Verification State Snapshot

Reference: `thesis-docs/CONSENSUS_SEARCH_AND_PAPER_VERIFICATION_LOG.md`.

- Core standards/protocols and foundational theory: mostly verified.
- Consensus discovery papers: many verified, some partially verified.
- Consensus pages themselves are login-gated; citation should point to publisher/DOI-level sources.

### 4.1 Items still requiring manual final check

- "Transferring Expert Knowledge through Video Instructions" (exact canonical record not confirmed).
- "Barriers to the Adoption of Visual Knowledge Management Tools" (exact canonical paper unresolved).
- Smart-glass and some visual-KM adjacent records need final bibliographic disambiguation.

## 5) Claim Boundary for This Thesis

### 5.1 Claims in Scope (Can defend now)

- Literature-grounded architectural rationale for Pulse/PulseVault.
- Clear decomposition and design decisions with alternatives/trade-offs.
- Concrete implementation traceability from design decisions to actual stack/components.
- Limited technical validation evidence based on implemented behavior and system checks.

### 5.2 Claims out of Scope (Defer)

- Broad adoption effectiveness claims based on human-subject evidence.
- Full comparative video-vs-text organizational impact claims without completed study data.
- Large-scale empirical user conclusions.

## 6) Mirror-Aligned Chapter Execution Plan

This is the active chapter plan, tuned to mirror the reference structure while preserving system-design emphasis.

1. **Introduction**
2. **Literature Review**
3. **Methodology** (design-rationale method + validation protocol)
4. **System Design and Minimal Technical Validation Results**
5. **Discussion and Implications**
6. **Conclusion and Future Work**

Front/back matter should mirror Purdue style sequence: statement, dedication, acknowledgments, TOC, list of tables/figures, abbreviations, abstract, references, appendices, vita.

## 7) Deliverables to Produce Next

1. Mirror-structured rewritten draft (replace current chapter architecture where needed).
2. Claim-to-citation matrix (chapter-level, load-bearing only).
3. Figure/table/appendix expansion map for 120-page target.
4. Future-work subsection explicitly capturing deferred evaluation.

## 8) Execution Sequence (Operational)

### Phase A: Structure Lock

- Freeze chapter skeleton and section hierarchy to mirror target style.
- Remove contradictory old evaluation-heavy language in legacy sections.

### Phase B: Evidence Lock

- Build claim-to-citation matrix.
- Resolve remaining partially verified citations.
- Drop weak citations from core arguments.

### Phase C: Content Rewrite

- Rewrite Introduction, Methodology, and Design Rationale around claim-evidence-implication flow.
- Integrate architecture specifics from Pulse/PulseVault implementation.

### Phase D: Validation + Discussion

- Add minimal technical validation chapter section with explicit limits.
- Expand discussion and future work with deferred evaluation plan.

### Phase E: Page-Shaping

- Add disciplined tables, architecture figures, decision matrices, and appendices.
- Tune chapter lengths toward 118-126 page target without repetitive prose.

## 9) Risks and Controls

### Risk 1: drift back into user-study-heavy narrative

Control: keep optional IRB/user-study language clearly marked as supplementary/future work unless final data included.

### Risk 2: weak sources in core claims

Control: enforce tiered source policy and verified-only load-bearing rule.

### Risk 3: inflated page count via repetition

Control: increase evidence artifacts (tables/figures/appendices) instead of duplicate prose.

## 10) Immediate Next Action List

1. Fill `\approvedby{...}` in `PurdueThesis/ch-front.tex` after program-office confirmation.
2. Add runtime evidence for all validation families (upload/finalize, transcode, token/access, observability) and cross-link in Chapter 4 + appendices.
3. Capture pending QR/deeplink scan-result screenshots and ops screenshots (metrics/log/audit).
4. Prepare one-page "what changed" summary and chapter-wise delta summary for professor review.
5. Add a one-page Claim/Evidence/Non-Claim matrix and targeted 3-question feedback block for committee responses.
6. Keep this file updated as execution context at each milestone.

## 11) Professor Re-Review Submission Readiness

### 11.1 Mandatory Before Sending

- Complete manual-only fields required by Purdue (`\approvedby{...}` if required).
- Ensure evidence packet includes runtime artifacts, not only code-inspection statements.
- Confirm screenshot catalog and Chapter 4 references are synchronized after adding new evidence.

### 11.2 Recommended Strengthening Additions

- 1-page "Claim vs Evidence vs Non-Claim" matrix.
- Runtime evidence mini-pack (3-5 representative snippets).
- 1-page "Known limits + deferred empirical plan" handout.
- Targeted feedback prompt with three specific professor questions.

