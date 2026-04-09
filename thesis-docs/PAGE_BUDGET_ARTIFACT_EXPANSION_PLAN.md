# Page Budget and Artifact Expansion Plan (120-Page Target)

Date: 2026-04-09  
Target length: 118-126 pages  
Goal: Increase scholarly density through evidence artifacts, not repeated prose.

## 1) Chapter-Level Page Targets

| Section | Target Pages | Primary Growth Lever |
|---|---:|---|
| Front matter | 10-12 | Purdue-required pages + clean formatting |
| Chapter 1 | 12-16 | Problem framing table, objective-to-RQ map |
| Chapter 2 | 22-28 | Thematic literature synthesis tables |
| Chapter 3 | 16-20 | Method flow diagrams + validity matrix |
| Chapter 4 | 24-30 | Architecture figures, decision tables, validation matrices |
| Chapter 5 | 12-16 | Trade-off and implication matrices |
| Chapter 6 | 8-10 | Contribution and future-work roadmap figures |
| References + appendices + vita | 14-18 | Dense appendices and reference completeness |

## 2) Artifact Targets by Type

| Artifact Type | Target Count | Placement Strategy |
|---|---:|---|
| Tables | 14-20 | Mostly Chapters 2, 4, 5; a few in 3 |
| Figures/Diagrams | 16-22 | Architecture and flow-heavy in Chapters 3 and 4 |
| Appendices | 5-9 | Decision log, endpoint matrix, validation details, glossary |

## 3) High-Value Tables to Add

1. **RQ-to-Claim Boundary Table** (Ch1)
2. **Literature-to-Design-Decision Traceability Table** (Ch2)
3. **Source Tiering Table (core vs context)** (Ch2)
4. **Method Scope and Non-Claim Table** (Ch3)
5. **Threats to Validity and Controls Matrix** (Ch3)
6. **Design Decision Matrix (decision/alternatives/criteria/trade-off)** (Ch4)
7. **Endpoint Security Controls Matrix** (Ch4)
8. **Upload/Finalize Check Matrix** (Ch4)
9. **Transcode Lifecycle Validation Matrix** (Ch4)
10. **Token Validation and Access-Control Matrix** (Ch4)
11. **Observability Coverage Matrix** (Ch4)
12. **Research Objective vs Outcome Table** (Ch5)
13. **Practical Deployment Implications Table** (Ch5)
14. **Future Work Prioritization Table** (Ch6)

## 4) High-Value Figures to Add

1. End-to-end Pulse/PulseVault architecture.
2. Upload and finalize sequence diagram.
3. Redis worker transcode pipeline.
4. HLS token signing and playlist rewrite flow.
5. Gateway trust-zone boundary diagram.
6. Metadata write durability workflow (temp, fsync, rename).
7. Audit chain verification concept.
8. Mobile draft lifecycle (capture-edit-export-upload).
9. Technical validation protocol flow.
10. Proven-versus-deferred claim boundary diagram.
11. Discussion trade-off radar (security/reliability/operability/complexity).
12. Future-work phased roadmap.

## 5) Appendix Expansion Plan

### Appendix A: Design Decision Log
- Full D1-D9 records with alternatives and criteria.

### Appendix B: Endpoint and Security Matrix
- Route-by-route controls and expected behavior.

### Appendix C: Validation Protocol Details
- Check procedures, expected outcomes, and limitations.

### Appendix D: Abbreviations and Terminology Glossary
- Ensure consistent vocabulary across chapters.

### Appendix E: Citation Verification Summary
- Core-source verification and context-only source list.

## 6) Anti-Repetition Rules

- No paragraph should restate a previous paragraph without new evidence.
- Growth must come from:
  - new evidence,
  - new decision rationale,
  - explicit trade-off analysis,
  - diagrams/tables with interpretation.

## 7) Final Length Control

If draft is short:
- Expand decision matrix depth before expanding prose.
- Add one additional implementation-traceability table per major subsystem.

If draft is long:
- Compress descriptive narrative and preserve only evidence-bearing paragraphs.
- Move low-priority detail to appendices.

