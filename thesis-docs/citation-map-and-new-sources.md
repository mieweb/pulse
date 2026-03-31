# Citation Map and New Sources (Thesis Upgrade Pack)

This file maps high-quality references to dissertation sections so you can quickly finalize a comprehensive manuscript with traceable evidence.

---

## 1) High-Confidence New Sources to Add

### Standards and Protocols (core systems evidence)

1. Pantos, R., & May, W. (2017). RFC 8216: HTTP Live Streaming. IETF.  
   Use for: HLS architecture, playlists/segments, adaptive delivery.

2. Hardt, D. (2012). RFC 6749: OAuth 2.0 Authorization Framework. IETF.  
   Use for: OAuth model terminology and auth flow baseline.

3. Lodderstedt, T., et al. (2025). RFC 9700: Best Current Practice for OAuth 2.0 Security (BCP 240). IETF.  
   Use for: modern OAuth security hardening recommendations.

4. tus.io contributors. Resumable Upload Protocol 1.0.0.  
   Use for: resumable upload behavior, offset recovery semantics.

5. draft-ietf-httpbis-resumable-upload (IETF draft).  
   Use for: standards trajectory beyond tus ecosystem.

### Security and Compliance

6. Marron, J. (2024). NIST SP 800-66r2.  
   Use for: HIPAA Security Rule safeguards mapping and implementation framing.

7. Miles, G., & Quinlan, A. HIPAA and video recordings in the clinical setting.  
   Use for: healthcare video handling policy context.

8. Nadella, D. (2024). Privacy and governance frameworks under HIPAA.  
   Use for: governance posture and policy framing.

### Knowledge Management and Learning Theory

9. Nonaka, I. (1994). A Dynamic Theory of Organizational Knowledge Creation.  
   Use for: tacit/explicit conversion and organizational knowledge lifecycle.

10. Davenport, T. H., & Prusak, L. (1998). Working Knowledge.  
    Use for: institutional knowledge loss and management practice framing.

11. Mayer, R. E. (2005). Cognitive Theory of Multimedia Learning.  
    Use for: why visual + verbal procedural content can outperform text-only contexts.

12. Mayer, R. E. (2009). Multimedia Learning (2nd ed.).  
    Use for: instructional design principles tied to short procedural videos.

13. Kumar et al. (2024). Video-based approaches in health education (systematic review/meta-analysis).  
    Use for: evidence that video-based interventions improve knowledge/skills outcomes.

### Operations / Reliability / Observability

14. Beyer et al. (2016). Site Reliability Engineering (Google).  
    Use for: reliability practices, monitoring, and operational correctness framing.

15. Prometheus official documentation and design docs.  
    Use for: metrics model, pull-based scraping rationale, instrumentation context.

### Video Systems / Transcoding

16. FastTTPS (2020). Transcoding time prediction and scheduling for HTTP adaptive streaming.  
    Use for: rationale behind queueing/scheduling and transcode optimization.

17. EditDuet (2025 arXiv).  
    Use for: non-linear editing architecture context and future extension links.

---

## 2) Section-by-Section Citation Placement

### Chapter 1 (Problem + Motivation)
- Add Nonaka (1994), Davenport & Prusak (1998) when discussing tacit knowledge loss.
- Add Mayer (2005, 2009) + Kumar et al. (2024) when motivating video as procedural medium.

### Chapter 2 (Related Work)
- 2.1 Knowledge systems: Nonaka + Davenport.
- 2.2 Short-form video: Rajendran et al. + platform engagement literature.
- 2.4 Resumable upload: tus protocol + IETF resumable draft.
- 2.5 Secure delivery: RFC 6749 + RFC 9700 + NIST SP 800-66r2.
- 2.6 Observability: SRE book + Prometheus references.

### Chapter 3 (Architecture Requirements)
- Cite RFC 8216 in adaptive streaming requirements.
- Cite RFC 9700 for auth/session security requirement framing.
- Cite NIST SP 800-66r2 for technical safeguards language.

### Chapter 4 (Implementation)
- Upload pipeline: tus protocol citation.
- Streaming pipeline: RFC 8216.
- OAuth implementation rationale: RFC 6749 + RFC 9700.
- Compliance framing: NIST SP 800-66r2.

### Chapter 5 (Methodology)
- Benchmark/evidence framing: SRE practices for measurable SLO/operational metrics.
- Transcode experiment justification: FastTTPS.

### Chapter 6 (Results Discussion)
- Tie findings back to queueing/transcoding literature and observability reliability literature.

### Chapter 7-8 (Discussion/Future Work)
- Use standards trajectory (IETF resumable draft, OAuth BCP evolution) to justify future hardening path.

---

## 3) Bibliography Quality Notes (Important)

- Prior list has some weak/unclear records; keep but reduce dependence on them.
- For final submission, prioritize peer-reviewed and standards-track references.
- Verify each DOI/URL manually before final formatting.
- Keep arXiv references as supplementary, not primary evidence for core claims.

---

## 4) Recommended Citation Mix for a 50-page CS Dissertation

- 8-10 foundational/theory references
- 10-15 systems/security/protocol standards and technical references
- 8-12 recent empirical papers (2020+)
- 3-5 implementation ecosystem docs (only where necessary)

Target total: 30-40 references, with most claims in Chapters 1-2 and 5-7 explicitly cited.

