# Thesis Context Snapshot

## Project
- Candidate: Priyam More (MSCS, Purdue University Fort Wayne)
- Working title: Design and Evaluation of Pulse/PulseVault: A Secure Video-First Platform for Institutional Knowledge Capture
- Thesis type: systems/design-rationale thesis (not product demo only)

## Core Framing
- Primary contribution is a literature-grounded architecture/design rationale.
- System implementation (Pulse/PulseVault) is the artifact instantiation.
- Evaluation is primarily technical (benchmarks, correctness checks, scalability indicators).
- Optional IRB user study is supplementary if approved; core validity does not depend on it.

## Current Dissertation Structure (v2)
- Ch 1: Introduction, problem, positioning, revised RQs
- Ch 2: Literature review (KM, multimedia learning, short-form video, mobile/CSCW, pipelines, security/OAuth/HIPAA framing, observability, design science, software architecture rationale)
- Ch 3: Methodology (design rationale method + technical evaluation + optional IRB path)
- Ch 4: Requirements and architecture context
- Ch 5: Design rationale (decision/alternatives/criteria/sources/trade-offs)
- Ch 6: Implementation mapping
- Ch 7: Evaluation methodology
- Ch 8: Results (placeholders pending measured data)
- Ch 9: Discussion
- Ch 10: Conclusion, limitations, future work

## Research Questions: Old vs New
### Initial RQs (earlier draft)
- RQ1: Video vs text effectiveness
- RQ2: Cross-platform video processing challenges
- RQ3: User adoption/interaction patterns
- RQ4: Security/compliance considerations
- RQ5: EDL architecture impact on workflow

### Revised RQs (current)
- RQ1: Design synthesis (end-to-end architecture fit)
- RQ2: Rationale and trade-offs for major decisions
- RQ3: Technical validation under controlled conditions
- RQ4: Reproducible evaluation design
- RQ5: Optional human evidence (if IRB approved)

## Key References/Standards Anchoring the Argument
- Hevner et al. (2004) design science
- Bass, Clements, Kazman (software architecture in practice)
- Kruchten (4+1 architectural views)
- Nonaka (1994), Davenport & Prusak (1998)
- Mayer (2005, 2009), Kumar et al. (2024)
- RFC 8216 (HLS), RFC 6749 (OAuth 2.0), RFC 9700 (OAuth BCP)
- tus resumable upload protocol
- NIST SP 800-66r2 + HHS HIPAA Security Rule summary
- Google SRE (2016), Prometheus docs

## Current Status
- Draft docs exist in `thesis-docs/`:
  - `dissertation-draft-v2.md`
  - `presentation-draft-v2.md`
  - `reference-verification-audit.md`
  - `citation-map-and-new-sources.md`
- Major narrative and chapter restructuring is complete.
- Main outstanding task: fill Chapter 8 with actual measured results and figures/tables.

## Committee/Defense Communication Context
- Need committee alignment meeting next week.
- Goal is to secure defense presentation date before April 28.
- Messaging: thesis is committee-aligned as design-rationale + technical evaluation, with IRB as supplementary if approved.

## IRB Operational Context (Mar 2026)
- Study: `STUDY2026-00000327` (Pulse Vault User Study), submission type `Initial Study`.
- Entered IRB: 13/03/2026 08:32; current workflow state: `IRB - STUDY - In-review` (Pre-Review view).
- Coordinator assignment history: initially IRB Unassigned Specialist, reassigned to Sandra Mason on 23/03/2026.
- Practical follow-up guidance: send a brief, respectful status-check email to the assigned coordinator with a concrete timeline reason and an offer to provide any missing materials.
- Positioning reminder: avoid framing as pressure; frame as scheduling coordination and readiness to respond quickly to requested revisions.

## Overleaf/PurdueThesis Notes
- Metadata has been updated in `thesis.tex`.
- Still need to replace template/demo chapter and appendix includes with actual thesis chapter files.
- Confirm bibliography style with advisor/committee (APA vs default CS style); enable `\ZZoverridebibstyle{apa}` only if approved.
