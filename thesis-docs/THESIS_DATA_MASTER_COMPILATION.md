# Thesis Data Master Compilation

Date: 2026-03-30
Owner: Priyam More
Purpose: Single source of truth that consolidates prior literature, new Consensus searches, data-collection instruments, and current study data status.

## 1) What this compilation includes

This file merges data from:

- Prior paper inventory and RQ mapping.
- Verified/cleaned citation set and standards references.
- New Consensus evidence searches for data-collection justification.
- Existing IRB-aligned data-collection instruments and study protocol.
- Current evidence of available collected data artifacts in the repo.

Primary source files:

- thesis-docs/papers.txt
- thesis-docs/citation-map-and-new-sources.md
- thesis-docs/reference-verification-audit.md
- thesis-docs/CONSENSUS_DATA_COLLECTION_BRIEF.md
- thesis-docs/USER_STUDY.txt
- thesis-docs/VIDEO_VS_TEXT_METRICS.txt
- thesis-docs/Survey_All_Questions.txt
- thesis-docs/surveys/01_Baseline_Survey.md
- thesis-docs/surveys/02_Midpoint_Survey.md
- thesis-docs/surveys/03_End_of_Study_Survey.md
- thesis-docs/IRB_Protocol.txt
- thesis-docs/HRP_503c_FINAL_PROTOCOL.md

## 2) Current data readiness snapshot (toward 95%)

### 2.1 What is already in place (strong)

- Study design and protocol are fully specified (longitudinal mixed-methods, living-labs style).
- Data sources are clearly defined:
  - Usage and behavior logs (backend/database/audit events)
  - Prometheus technical metrics
  - Baseline/midpoint/end surveys
  - Optional interviews
- Survey instruments are complete and versioned (baseline, midpoint, endline, SUS scoring guidance).
- RQ1 video-vs-text metric set is operationalized with low-overhead questions.
- Literature basis exists in three layers:
  - Legacy broad paper set
  - Verified core references/standards
  - New Consensus targeted evidence

### 2.2 What is not yet present as raw collected outputs (current gap)

No concrete participant-level result exports were found in thesis-related folders during scan (no obvious survey response CSVs, interview transcripts, or analytics export tables dedicated to thesis results).

Interpretation:

- You are high on study-design readiness.
- You are not yet high on finalized collected-results packaging.

### 2.3 Practical readiness estimate

- Methodology + instruments + literature readiness: high (about 90%+).
- Final analyzable dataset packaging readiness: moderate (depends on exports and interview transcripts).
- Overall toward your requested target: approximately 85-90% now, and can reach 95% quickly once exports are consolidated.

## 3) Unified literature set for data collection (merged)

## 3.1 Core verified backbone (use these as primary citations)

From verification and citation-map files:

- SUS and usability rigor:
  - Lewis (SUS past/present/future)
  - Bangor et al. (empirical SUS evaluation)
- Knowledge and learning theory:
  - Nonaka (1994)
  - Davenport and Prusak (1998)
  - Mayer (2005, 2009)
- Systems/security/standards:
  - RFC 8216 (HLS)
  - RFC 6749 (OAuth 2.0)
  - RFC 9700 (OAuth BCP)
  - tus protocol
  - NIST SP 800-66r2
  - HHS HIPAA Security Rule summary
- Reliability/operations:
  - Google SRE
  - Prometheus docs

## 3.2 Prior thesis paper bank (secondary pool)

From papers.txt and thesis.txt:

- Video and KM papers for RQ1 support.
- CSCW/mobile UX papers for adoption/usability context.
- Short-form ecosystem papers for context (not core claims).
- Security and governance papers for architecture framing.

Note: keep weaker or less-rigorous entries as contextual only, not core claim anchors.

## 3.3 New Consensus additions (data-collection-focused)

From CONSENSUS_DATA_COLLECTION_BRIEF.md:

- Video vs text procedural learning and transfer papers.
- SUS validity/benchmarking papers.
- Adoption barrier/enabler papers for organizational knowledge sharing.
- Living-labs effectiveness and limitations papers.

## 4) Unified data model (what to collect and how to use it)

## 4.1 Behavioral usage data (system side)

Source:

- Backend logs/database/audit events (uploads, views, shares)
- Prometheus metrics

Core fields:

- user_id (or de-identified key)
- timestamp
- event_type (upload, view, share, login)
- video_id
- optional watch_time/completion

Derived metrics:

- Active users
- Time to first upload
- Retention/churn
- Videos created per user
- Views per user
- Sharing frequency

Mapped RQs:

- RQ3 primary, RQ1 secondary (video adoption behavior)

## 4.2 Survey data (participant side)

Source:

- Baseline, midpoint, endline instruments

Core fields:

- role and prior video usage (baseline)
- SUS items (midpoint + endline)
- Satisfaction Likert items
- RQ1 video-vs-text preference/usefulness/use-frequency/creation
- Barriers/enablers checklist + open text

Derived outputs:

- SUS score 0-100
- Preference distribution (video/text/neutral)
- Perceived helpfulness means and SD
- Relative use categories
- Video-vs-text creation comparison

Mapped RQs:

- RQ1 and RQ3 primary

## 4.3 Optional interview data (qualitative)

Source:

- Audio recordings and transcripts (if collected)

Coding frame (from Consensus + prior docs):

- Technical barriers
- Workflow fit
- Organizational support and trust
- Social/cultural enablers
- Perceived value vs text documentation

Mapped RQs:

- RQ3 primary, RQ1 explanatory context

## 5) Master metric dictionary (final)

### Adoption and engagement

- Active users
- Time to first upload
- Retention/churn
- Videos per user
- Views/watch/completion
- Sharing frequency

### Usability

- SUS total score (midpoint and endline)
- Satisfaction score
- Optional task-based completion/time/error if available

### Video vs text (minimum viable RQ1 set)

- Preference score
- Perceived helpfulness vs text
- Relative use (text vs video)
- Created artifacts (video count vs text count)

### Technical performance

- Upload success/failure
- Transcode success/failure
- Queue depth
- API latency

## 6) Analysis package you can run immediately

Quantitative:

- Descriptives (mean/median/SD)
- Time trend plots for adoption metrics
- SUS midpoint vs endline comparison
- RQ1 bar charts (preference, use split, creation split)

Qualitative:

- Thematic coding for open-text and interviews
- Barrier/enabler summary table

Mixed-methods integration:

- Use qualitative themes to explain quantitative adoption patterns.

## 7) Data quality and risk controls

- Keep one canonical participant key mapping policy (consent-compliant).
- Separate identifying link file from analysis dataset.
- Report aggregated/de-identified thesis outputs.
- Explicitly state limitations:
  - single organizational context
  - self-report bias for text-side behavior
  - non-randomized naturalistic design

## 8) Remaining 5-10% to reach near-complete dataset readiness

1. Export and freeze one usage dataset snapshot for the study window.
2. Export baseline/midpoint/endline survey responses in analyzable format.
3. Compute SUS scores and add one cleaned analysis table.
4. Create one integrated participant-level analysis table (de-identified) linking usage + survey where consented.
5. If interviews are available, produce transcript files and coded-theme summary.

## 9) Suggested folder outputs for final thesis analysis

Create and maintain:

- thesis-docs/data/raw/
  - usage_events_export.csv
  - survey_baseline.csv
  - survey_midpoint.csv
  - survey_endline.csv
  - interview_transcripts/ (if any)
- thesis-docs/data/processed/
  - usage_metrics_by_user.csv
  - sus_scores.csv
  - rq1_video_vs_text_metrics.csv
  - merged_analysis_dataset.csv
- thesis-docs/data/analysis/
  - data_dictionary.md
  - analysis_notes.md

## 10) Final consolidation notes

- New Consensus searches significantly strengthened RQ1/RQ3 and methodology evidence.
- Verified standards and architecture references remain the right backbone for system/security claims.
- Your biggest final gap is packaging actual collected outputs into stable analysis files, not study design.

This file should be treated as the canonical merger document for data collection and analysis readiness.
