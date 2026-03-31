# Design and Evaluation of Pulse/PulseVault: A Secure Video-First Platform for Institutional Knowledge Capture

Author: Priyam More  
Program: MSCS  
Draft: Dissertation (design-rationale and systems evaluation thesis)

**Citation style:** APA 7th edition, author–date (throughout).

---

## Abstract

Institutions lose procedural knowledge when expertise is not externalized in durable, shareable forms. Text-centric systems support policy and reference content but often underrepresent temporal, visual, and tool-mediated know-how (Davenport & Prusak, 1998; Nonaka, 1994). This dissertation treats Pulse/PulseVault not as a product demonstration but as the **outcome of a research-informed design process**: an end-to-end system for capturing, processing, and delivering short-form institutional knowledge video, whose architecture is justified through **synthesis of prior work** in knowledge management, multimedia learning, mobile collaboration, media pipeline design, security practice, and design-science norms for information systems research (Hevner et al., 2004).

The **research contribution** is threefold: (1) a **literature-grounded design rationale** for a capture-to-delivery pipeline (resumable ingest, asynchronous transcoding, adaptive HTTP live streaming, tokenized media access, gateway policy, and observability), with explicit alternatives and trade-offs tied to cited sources; (2) a **concrete instantiation** of that rationale in Pulse (capture clients) and PulseVault (backend, gateway, web tier); and (3) a **technical evaluation methodology** (benchmarks, security-correctness checks, scalability probes) that validates the design under stated assumptions. **If institutional review board (IRB) approval is obtained**, a **short user study** may be conducted to complement technical findings with limited usability or adoption-oriented evidence; the core thesis validity rests on design rationale and systems evaluation, not on that optional study.

**Keywords:** institutional knowledge; design rationale; systems architecture; resumable upload; HTTP live streaming; OAuth; observability; design science.

---

## Chapter 1. Introduction

### 1.1 Problem Context

Organizations depend on procedural knowledge: recurring tasks, failure recovery, handoffs, and onboarding. In practice, knowledge is fragmented across documents, tickets, chat, verbal explanation, and personal recordings. The result is **institutional memory decay** and repeated rediscovery of known procedures (Davenport & Prusak, 1998). Where work is **visual, sequential, and tool-mediated**, text alone often fails to preserve the cues that experts use in practice. Video can capture demonstration and context, but **consumer-oriented platforms** optimize for distribution and engagement, not for **governance, access control, and operability** inside an institution.

### 1.2 Research Positioning: Artifact Plus Rationale

A dissertation in computer science must articulate **research**, not only an implementation. Following **design science in information systems research** (Hevner et al., 2004), a valid contribution can take the form of an **innovative artifact** (construct, model, method, or instantiation) together with **clear problem relevance**, **rigor of design** (drawing on existing knowledge), and **evaluation** of utility for the problem class. Here, the artifact is **Pulse/PulseVault**; the **rigor of design** is demonstrated by **mapping major architectural choices to literature and standards** (see Chapters 2 and 5). **Evaluation** combines **technical measurement** (Chapter 8) with, **conditionally**, a **small IRB-approved user study** if timeline and approval allow (§3.4).

### 1.3 Research Questions

**RQ1 (Design synthesis).** What **architectural pattern** and **component responsibilities** best align with institutional requirements for short-form knowledge video—from capture through ingest, processing, secure delivery, and operation—according to prior research and practice?

**RQ2 (Rationale and trade-offs).** For each major design decision (e.g., resumable upload, separate finalize step, asynchronous transcode queue, HLS, signed URLs, reverse-proxy policy, OAuth, observability), what **alternatives** were considered, what **criteria** apply, and how does the **chosen design** relate to **cited** literature, standards, or established practice?

**RQ3 (Technical validation).** Under controlled conditions, how does the implemented system behave with respect to **upload reliability**, **processing latency**, **playback path performance**, **token enforcement**, and **scale-related indicators** (e.g., worker replication)?

**RQ4 (Evaluation design).** What **metrics and protocols** support **reproducible** technical evaluation without overstating generalizability?

**RQ5 (Optional human evidence).** *If IRB-approved:* What **minimal** user-facing evidence (e.g., task-based usability or short survey) can **complement**—not substitute for—the design rationale and technical results?

### 1.4 Contributions

1. **Literature-structured design rationale** for an institutional short-form video pipeline, documented as explicit decisions, alternatives, and citations (Chapter 5 and Appendix C).
2. **Instantiation** of that rationale in Pulse/PulseVault (Chapter 6).
3. **Technical evaluation framework** and results narrative structure (Chapters 7–8).
4. **Methodological clarity**: core claims rest on design + technical evaluation; **optional** IRB study as supplementary evidence (Chapter 3).

### 1.5 Scope and Limitations of Claims

**In scope:** Requirements derived from the problem domain; design rationale tied to literature; implementation summary; technical evaluation; honest limits on generalizability.

**Out of scope as primary claims:** Broad conclusions about organizational ROI or long-term adoption **without** IRB-approved study. **AI-heavy** semantic retrieval or full **DRM** ecosystems are noted as future work.

### 1.6 Dissertation Roadmap

| Chapter | Content |
|--------|---------|
| 2 | **Literature review** (KM, learning, platforms, mobile/CSCW, pipelines, security, observability, design science, software architecture / rationale). |
| 3 | **Methodology** (design rationale method, technical evaluation, optional IRB path). |
| 4 | **Requirements and architectural context** (goals, NFRs, high-level structure). |
| 5 | **Design rationale** (decision-by-decision, literature-linked). |
| 6 | **Implementation** (mapping rationale to concrete stack). |
| 7 | **Evaluation methodology** (experiments, metrics, validity). |
| 8 | **Results** (to be filled with measured data). |
| 9 | **Discussion** (interpretation, threats, relation to literature). |
| 10 | **Conclusion, limitations, future work** (including IRB study if approved). |

---

## Chapter 2. Literature Review

This chapter establishes the knowledge base (Hevner et al., 2004) against which design choices in Chapters 4–6 are justified. It is organized by theme rather than as an annotated bibliography; each subsection closes with implications for system design.

### 2.1 Organizational Knowledge and Knowledge Creation

Knowledge management research distinguishes tacit and explicit knowledge and emphasizes organizational mechanisms for externalization and combination of knowledge (Nonaka, 1994). Practice-oriented accounts stress that institutions lose know-how when it remains personal or informally stored (Davenport & Prusak, 1998). *Implication.* A knowledge-capture system should lower the cost of contributing durable representations of procedure and should fit workflows where experts already work—for example, mobile capture.

### 2.2 Procedural Knowledge, Multimedia, and Video-Based Learning

Cognitive theory of multimedia learning holds that meaningful learning from words and pictures depends on limited cognitive capacity and active integration of verbal and pictorial models (Mayer, 2005, 2009). For skills and knowledge outcomes in structured training domains, video-based interventions have shown positive effects in meta-analytic work, with caveats about study quality (Kumar et al., 2024). *Implication.* Short-form video is a plausible medium for procedural institutional knowledge, provided the platform does not impose unacceptable friction in capture, processing, and playback.

### 2.3 Short-Form Video Platforms and Design Tensions

Research on short-form ecosystems (e.g., creator economies and platform dynamics) highlights engagement and format shifts (Rajendran et al., 2024). Such work does not prescribe enterprise architecture, but it supports the design relevance of concise video for attention and information throughput. *Implication.* An institutional system may borrow format strengths while rejecting consumer-platform assumptions (open social graph, long-lived public URLs, weak operational isolation).

### 2.4 Mobile Capture, CSCW, and Cross-Platform Engineering

Mobile CSCW and groupware literature documents hardware and software-engineering constraints on collaboration from mobile devices (Johnson, 2013). *Implication.* Separating client-side capture concerns (codec variance, resource limits) from server-side normalization (transcoding to predictable adaptive streams) aligns with prior emphasis on engineering for heterogeneous clients.

### 2.5 Media Ingest, Resumable Transfer, and Asynchronous Processing

Large uploads over unreliable networks motivate resumable HTTP-level protocols (tus.io contributors, 2016-present). HTTP Live Streaming (HLS) specifies playlist and segment semantics for adaptive delivery over HTTP (Pantos & May, 2017). *Implication.* Pairing resumable ingest with asynchronous, compute-heavy transcoding follows separation-of-concerns common in media systems: ingest stays responsive; quality and bitrate ladders are produced off the critical upload path.

### 2.6 Security, Identity, and Regulated Contexts

OAuth 2.0 defines a framework for delegated access (Hardt, 2012); security best-current-practice documents address evolved threats and deployment patterns (Lodderstedt et al., 2025). For health or regulated-adjacent deployments, HIPAA Security Rule implementation guidance and high-level summaries frame administrative, physical, and technical safeguards (Marron, 2024; U.S. Department of Health and Human Services, n.d.). Security knowledge sharing in organizations further motivates layered controls and attention to human factors (Alahmari & Renaud, 2020). *Implication.* Web-tier OAuth, short-lived media tokens, gateway policy, and defense in depth align with standards and security knowledge-management literature rather than ad hoc choices.

### 2.7 Observability and Site Reliability

Operating distributed services without telemetry impedes debugging and capacity decisions. Site reliability engineering practice emphasizes measurement, SLO-oriented thinking, and tooling for production systems (Google, 2016). Prometheus-style metrics are a common implementation pattern (Prometheus Authors, n.d.). *Implication.* Observability belongs in the design argument, not as an afterthought: it supports evaluation and operational validity of the architecture.

### 2.8 Design Science, Software Architecture, and Explicit Rationale

Design science in information systems research (Hevner et al., 2004) requires that an artifact be new or significantly improved, grounded in prior knowledge, and evaluated against utility for a problem. In software engineering, architecture is typically described in terms of structures, behaviors, and *quality attributes* (performance, security, modifiability, availability), with design choices justified against stakeholder concerns rather than left implicit (Bass et al., 2012). Multi-view descriptions (e.g., logical, process, physical) help separate concerns so that one diagram does not overload every stakeholder question (Kruchten, 1995). Together, these traditions support treating **documented rationale**—alternatives, criteria, and trade-offs—as part of the research output, not an informal appendix. *Implication.* Chapter 5’s decision template is aligned with both design-science expectations (Hevner et al., 2004) and architecture-practice norms (Bass et al., 2012; Kruchten, 1995): the committee can trace *why* Pulse/PulseVault is decomposed as it is.

### 2.9 Non-Linear Editing and Future Automation (Secondary)

Recent work on automated non-linear editing (e.g., multi-agent editing) points to future enhancements rather than core institutional minimum-viable requirements (Sandoval-Castaneda et al., 2025). *Implication.* Cited as horizon research; not central to current design commitments.

### 2.10 Synthesis: Research Gap

Prior work provides fragments: knowledge-management theory, learning evidence, mobile constraints, media standards, OAuth- and HIPAA-oriented security framing, observability practice, and norms for justifying artifacts and architectures (Hevner et al., 2004; Bass et al., 2012). Few published designs integrate these into a single coherent institutional short-form video pipeline with explicit rationale and technical evaluation. This dissertation addresses that integration gap.

---

## Chapter 3. Research Methodology

### 3.1 Overview

The methodology comprises three strands: (1) literature-informed design rationale; (2) technical evaluation of the instantiation; (3) an optional IRB-governed user study if approved and feasible.

### 3.2 Design Rationale as a Research Method

For each major architectural decision, the thesis documents:

- Decision (what was chosen).
- Alternatives (credible options not chosen).
- Criteria (e.g., reliability, security, latency, operability, complexity).
- Knowledge inputs (Chapter 2 themes and specific citations).
- Trade-offs accepted.

This structure aligns with transparent design argumentation expected in design-science work (Hevner et al., 2004) and with architecture practice that ties structures to quality attributes and stakeholder concerns (Bass et al., 2012), so that rationale—the “why”—is as visible as the artifact—the “what.”

### 3.3 Technical Evaluation Method

Evaluation emphasizes reproducibility: defined environment, stated workloads, repeated runs, and metrics mapped to requirements (Chapter 7). No human-subject data are required for the core claims.

### 3.4 Optional User Study (Conditional on IRB)

If IRB approval is obtained before any human-subject data collection:

- **Purpose.** Complement technical results with limited evidence on usability, task completion, or perceived utility—not to replace design rationale or benchmarks.
- **Scope.** Short protocol (e.g., think-aloud tasks or a standardized usability instrument), small sample, consistent with committee and IRB constraints.
- **Thesis placement.** A dedicated subsection in Results or Discussion, clearly labeled as supplementary, with limitations stated explicitly.

If IRB approval is not obtained in time, the thesis rests on §3.2–3.3 only; §3.4 is omitted or deferred to future work.

### 3.5 Validity at a Glance

- **Design validity.** Traceability from claims to Chapter 2 sources.
- **Technical validity.** Controlled measurement and explicit limits on generalization.
- **Optional user validity (if applicable).** IRB compliance and small-*n* limitations.

---

## Chapter 4. Requirements and Architectural Context

### 4.1 Stakeholders and Use Scenarios

Primary actors are content creators (mobile or desktop), consumers (web), and operators (deployment and monitoring). Typical scenarios include recording a short procedure, uploading with tolerance for interruption, waiting for transcode completion, playing content via adaptive streaming, and accessing media only with valid credentials and tokens.

### 4.2 Functional Requirements (Summary)

Functional expectations align with Chapter 5: resumable upload, finalize, queued transcode, HLS output, signed playback URLs, web authentication and management interfaces, and health or metrics endpoints.

### 4.3 Non-Functional Requirements

Non-functional requirements include reliability under network interruption, layered security, performance separation between ingest and batch compute, operability via logs and metrics, and deployability through reproducible containerized stacks.

### 4.4 High-Level Architecture (Preview)

The platform comprises capture clients, an API server, a Redis-backed queue, transcode workers, an Nginx gateway, a web application, an observability stack, and durable storage with metadata sidecars. Detailed rationale for each boundary appears in Chapter 5.

---

## Chapter 5. Design Rationale (Literature-Linked Decisions)

This chapter is the principal research documentation of architectural choice: each decision is tied to quality attributes and constraints discussed in Chapter 2 (Bass et al., 2012; Kruchten, 1995) and to the design-science expectation that grounding be explicit (Hevner et al., 2004). Each subsection follows §3.2.

### 5.1 Resumable Upload (tus-Compatible Semantics)

- **Decision.** Chunked resumable upload with offset tracking before finalize.
- **Alternatives.** Single-shot multipart only; full-file retry on failure; proprietary binary protocol.
- **Criteria.** Reliability on lossy networks; interoperability with HTTP infrastructure.
- **Knowledge inputs.** Resumable upload specification and practice (tus.io contributors, 2016-present).
- **Trade-off.** Greater server state and complexity than single-shot upload; higher completion rates for large video.

### 5.2 Separate Finalize Step and Immutable Video Identity

- **Decision.** After upload completion, an explicit finalize operation commits storage layout, checksum, metadata sidecar, and enqueue of transcode work.
- **Alternatives.** Implicit finalize on last byte without application validation; synchronous transcode on the upload request path.
- **Criteria.** Atomicity of commit; separation of transport from processing (§2.5).
- **Trade-off.** Small additional latency before queueing; clearer failure semantics and auditability.

### 5.3 Asynchronous Transcoding and Work Queue (Redis)

- **Decision.** Background workers consume jobs from Redis; FFmpeg produces renditions and playlists.
- **Alternatives.** Synchronous transcode in the API process; reliance solely on external SaaS encoders.
- **Criteria.** API responsiveness; horizontal scaling of compute; consistency with asynchronous batch patterns in large-scale systems (§2.5; Google, 2016).
- **Trade-off.** Eventual consistency until transcode completes; need to monitor queue depth.

### 5.4 Adaptive Delivery via HLS

- **Decision.** HLS master and media playlists and segments per Pantos and May (2017).
- **Alternatives.** Progressive MP4 only; DASH-only stack; proprietary player protocol.
- **Criteria.** Firewall-friendly HTTP delivery; broad player support; documented standard.
- **Trade-off.** Segment latency and packaging overhead versus simplicity of progressive download.

### 5.5 Tokenized Media URLs and Gateway Policy

- **Decision.** HMAC-bound tokens with expiry and path scope; reverse proxy routes separate public playback from restricted control paths.
- **Alternatives.** Long-lived public URLs; session cookie only without URL binding; DRM-only stack (heavier operations).
- **Knowledge inputs.** Layered security and OAuth ecosystem (Hardt, 2012; Lodderstedt et al., 2025); regulated-context framing (Marron, 2024; U.S. Department of Health and Human Services, n.d.); security knowledge sharing (Alahmari & Renaud, 2020).
- **Trade-off.** Token validation cost and short URL lifetime management versus reduced casual link-sharing risk.

### 5.6 Web Authentication (OAuth 2.0)

- **Decision.** OAuth-based SSO for the web tier (Hardt, 2012), with implementation informed by current security best practice (Lodderstedt et al., 2025).
- **Alternatives.** Local password store only; custom token format without standard authorization flows.
- **Trade-off.** Dependency on identity-provider availability; gains in standard security analysis and integration.

### 5.7 Observability (Metrics and Logs)

- **Decision.** Prometheus metrics, Grafana dashboards, and Loki/Promtail (or equivalent) following operational practice (Google, 2016; Prometheus Authors, n.d.).
- **Alternatives.** Ad hoc logging only; no dashboards.
- **Trade-off.** Stack complexity versus evaluability and debuggability.

### 5.8 Metadata Sidecars and Disk-First Consistency

- **Decision.** A `meta.json` sidecar per video as authoritative processing state alongside blobs.
- **Alternatives.** Database-only metadata without a filesystem anchor; implicit state in logs only.
- **Criteria.** Recoverability, operator inspectability, alignment with object-storage-style layouts.
- **Trade-off.** If a database also holds application state, dual-consistency concerns must be documented (Chapter 6).

### 5.9 Containerized Deployment

- **Decision.** Docker Compose (or equivalent) for reproducible multi-service deployment.
- **Alternatives.** Bare-metal scripts only; mandatory Kubernetes for all environments.
- **Criteria.** Thesis reproducibility and clear boundary documentation for the committee.
- **Trade-off.** This thesis does not claim a full production Kubernetes reference architecture unless scope is expanded.

---

## Chapter 6. Implementation

This chapter instantiates the design rationale (Chapter 5) in the Pulse/PulseVault codebase. It is subordinate to Chapter 5: implementation details **support** the argued architecture; they do not replace explicit rationale.

### 6.1 Backend Service Layer

The PulseVault API uses **Fastify** for low overhead and a plugin-oriented structure. Responsibilities are separated across route modules and utilities so that ingest, media signing, metadata handling, and queue operations remain testable and operable independently—consistent with modular boundaries argued in §5.

Representative endpoint groups:

- Health and metrics: root health, Prometheus scrape target.
- Upload lifecycle: `POST /uploads`, `PATCH` / `HEAD /uploads/:id`, `POST /uploads/finalize` (tus-compatible flow per §5.1–5.2).
- Media: `POST /media/sign`, `GET /media/videos/:videoId/*`, metadata retrieval (§5.4–5.5).
- Optional QR/deeplink flows for authenticated mobile upload initiation.

### 6.2 Upload Ingest and Finalize

Resumable uploads follow **tus-compatible** semantics (tus.io contributors, 2016-present). Finalization performs: validation of the upload artifact; allocation of a stable video identifier; atomic move into permanent storage; checksum and **`meta.json`** sidecar; enqueue of transcode work; audit and metric updates. This mirrors the **separate finalize** decision in §5.2.

### 6.3 Queue and Worker Pipeline

**Redis** backs the transcode job queue. Workers run **FFmpeg** / **ffprobe** to probe sources, emit **HLS** renditions and playlists (Pantos & May, 2017), and update sidecar metadata. Horizontal scaling is achieved by increasing worker replica count (§5.3).

### 6.4 Media Signing, Gateway, and Delivery

Signed URLs bind video identifier, relative media path, and expiry; the backend verifies tokens before serving byte ranges. **Nginx** (`nginx.conf`, `conf.d/pulsevault-locations.conf`) terminates public routes, applies upload/streaming timeouts and headers, proxies to the API and frontend, and can restrict direct exposure of sensitive control routes—implementing **gateway policy** from §5.5.

### 6.5 Frontend Integration

The web application (Next.js) provides OAuth-based session management (Hardt, 2012; Lodderstedt et al., 2025), upload and playback UI, and administrative views. Playback uses short-lived signed URLs for HLS manifests and segments rather than static public URLs (§5.5–5.6).

### 6.6 Storage and Metadata Layout

Each video lives under a deterministic directory: original asset, **`meta.json`**, and post-transcode **`hls/`** tree. This supports operator inspection and recovery aligned with §5.8.

### 6.7 Deployment and Observability

**Docker Compose** coordinates API, workers, Redis, Nginx, frontend, and observability components (Prometheus, Grafana, Loki/Promtail), supporting reproducible evaluation environments (§5.7, §5.9). Health checks and volume mounts should be documented in the final thesis with version pins for reproducibility.

### 6.8 Traceability to Design Decisions

| Implementation area | Primary rationale sections |
|--------------------|----------------------------|
| tus + finalize | §5.1, §5.2 |
| Redis + FFmpeg workers | §5.3 |
| HLS output | §5.4 |
| Signed URLs + Nginx | §5.5 |
| OAuth web tier | §5.6 |
| Metrics/logs | §5.7 |
| `meta.json` sidecars | §5.8 |
| Compose deployment | §5.9 |

---

## Chapter 7. Evaluation Methodology

### 7.1 Goals

Validate design claims from Chapter 5 under controlled conditions: upload robustness, pipeline timings, security correctness of tokens, streaming behavior, and scaling behavior (e.g., worker replication).

### 7.2 Environment and Corpus

Document hardware, operating system, service versions, network topology, and the test video corpus (duration, resolution, codec).

### 7.3 Metrics

Align metrics with §4.3, for example: session creation latency, upload throughput, finalize time, queue wait, transcode duration, time-to-playable, token accept/reject matrix, playback startup latency, resource usage, and backlog as a function of worker count.

### 7.4 Experimental Protocols

Protocols include upload sweep, pipeline latency, token tests, playback and seek, and worker replication. Where feasible, run at least three repetitions per condition.

### 7.5 Validity and Ethics

State internal and external validity limits explicitly. Core evaluation is non-human-subject. If §3.4 applies, insert IRB-compliant language here and in Chapter 8.

---

## Chapter 8. Results

**Note.** Replace the subsections below with measured numbers, tables, and figures after experiments are complete. If an IRB-approved user study is conducted, add a subsection reporting instrument, sample size (*n*), and limitations.

### 8.1 Upload and Resilience

Report stability, throughput, and resume behavior with reference to §5.1–5.2.

### 8.2 Processing and Queue Behavior

Report transcode times, backlog, and worker scaling with reference to §5.3.

### 8.3 Security and Playback

Report token validation matrix and startup latency with reference to §5.4–5.5.

### 8.4 Resource and Operational Observations

Report CPU, memory, and gateway overhead with reference to §5.7.

### 8.5 Mapping Results to Research Questions

Summarize how §8.1–8.4 address RQ3 and RQ4; relate RQ2 to traceability to Chapter 5; address RQ5 only if IRB data exist.

---

## Chapter 9. Discussion

### 9.1 Interpretation

Relate findings to design trade-offs anticipated in Chapter 5 and to literature themes in Chapter 2.

### 9.2 Threats to Validity

Discuss single deployment profile, synthetic workload, limited codec diversity, and (if applicable) limited generalizability of optional user-study results.

### 9.3 Practical Implications for Institutions

Clarify when this architecture pattern is appropriate and when stronger DRM, multi-tenant isolation, or formal compliance audits remain necessary beyond this thesis scope.

---

## Chapter 10. Conclusion, Limitations, and Future Work

### 10.1 Summary of Contributions

The thesis contributes literature-grounded design rationale, a concrete instantiation, technical evaluation, and optional user evidence if IRB-approved.

### 10.2 Limitations

Limitations include those in §9.2 and constraints imposed by the thesis timeline.

### 10.3 Future Work

Future work may include multi-tenant governance, semantic search, disaster recovery, deeper compliance artifacts, an IRB-backed user study if not completed during the thesis window, and automation along the lines of Sandoval-Castaneda et al. (2025).

---

## References

Alahmari, S., & Renaud, K. (2020). Implement a model for describing and maximising security knowledge sharing. *15th International Conference for Internet Technology and Secured Transactions (ICITST)*.

Bass, L., Clements, P., & Kazman, R. (2012). *Software architecture in practice* (3rd ed.). Addison-Wesley Professional.

Davenport, T. H., & Prusak, L. (1998). *Working knowledge: How organizations manage what they know*. Harvard Business School Press.

Google. (2016). *Site reliability engineering: How Google runs production systems*. O'Reilly Media.

Hardt, D. (Ed.). (2012). *RFC 6749: The OAuth 2.0 authorization framework*. IETF. https://www.rfc-editor.org/rfc/rfc6749

Hevner, A. R., March, S. T., Park, J., & Ram, S. (2004). Design science in information systems research. *MIS Quarterly*, *28*(1), 75–105. https://doi.org/10.2307/25148625

Johnson, D. (2013). Mobile support in CSCW applications and groupware development frameworks. *International Journal of Interactive Mobile Technologies*, *7*(2), 54–62. https://doi.org/10.3991/ijim.v7i2.2469

Kruchten, P. (1995). The 4+1 view model of architecture. *IEEE Software*, *12*(6), 42–50. https://doi.org/10.1109/52.469759

Kumar, A., et al. (2024). Video-based approaches in health education: A systematic review and meta-analysis. *Scientific Reports*. https://doi.org/10.1038/s41598-024-73671-7

Lodderstedt, T., Bradley, J., Labunets, A., & Fett, D. (2025). *RFC 9700: Best current practice for OAuth 2.0 security* (BCP 240). IETF. https://www.rfc-editor.org/rfc/rfc9700

Marron, J. (2024). *NIST SP 800-66 Rev. 2: Implementing the Health Insurance Portability and Accountability Act (HIPAA) Security Rule: A cybersecurity resource guide*. National Institute of Standards and Technology. https://doi.org/10.6028/NIST.SP.800-66r2

Mayer, R. E. (2005). Cognitive theory of multimedia learning. In R. E. Mayer (Ed.), *The Cambridge handbook of multimedia learning* (pp. 31–48). Cambridge University Press.

Mayer, R. E. (2009). *Multimedia learning* (2nd ed.). Cambridge University Press.

Nonaka, I. (1994). A dynamic theory of organizational knowledge creation. *Organization Science*, *5*(1), 14–37. https://doi.org/10.1287/orsc.5.1.14

Pantos, R., & May, W. (2017). *RFC 8216: HTTP live streaming*. IETF. https://www.rfc-editor.org/rfc/rfc8216

Prometheus Authors. (n.d.). *Prometheus documentation: Introduction to Prometheus*. https://prometheus.io/docs/introduction/overview/

Rajendran, P. T., Creusy, K., & Garnes, V. (2024). Shorts on the rise: Assessing the effects of YouTube Shorts on long-form video content. *arXiv*. https://arxiv.org/abs/2402.18208

Sandoval-Castaneda, M., Russell, B., Sivic, J., Shakhnarovich, G., & Caba Heilbron, F. (2025). EditDuet: A multi-agent system for video non-linear editing. *arXiv*. https://arxiv.org/abs/2509.10761

tus.io contributors. (2016-present). *Resumable upload protocol 1.0.0*. https://tus.io/protocols/resumable-upload.html

U.S. Department of Health and Human Services. (n.d.). *Summary of the HIPAA Security Rule*. https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html

---

## Appendix A. Figure and Table Plan

1. End-to-end architecture (aligned with Chapter 4–5).  
2. Upload and finalize sequence diagram.  
3. Transcode and queue lifecycle.  
4. Signed URL validation and gateway policy sketch.  
5. Deployment topology (Compose/services).  
6. Observability data flow.  
7–10. Evaluation figures (throughput, backlog, time-to-playable, token matrix).

---

## Appendix B. Suggested Page Budget (≈50 pages)

| Chapter | Pages (approx.) |
|--------|-----------------|
| 1 Introduction | 5–7 |
| 2 Literature review | 12–16 |
| 3 Methodology | 4–6 |
| 4 Requirements / context | 4–6 |
| 5 Design rationale | 10–14 |
| 6 Implementation | 6–8 |
| 7 Evaluation | 4–6 |
| 8 Results | 6–8 |
| 9 Discussion | 3–5 |
| 10 Conclusion | 2–4 |
| References + appendices | 4–6 |

---

## Appendix C. Design Decision Log (Checklist for Chapter 5)

Use this checklist to ensure every row is expanded in prose in Chapter 5:

| ID | Decision | Primary citations |
|----|----------|---------------------|
| D1 | Resumable upload (tus-compatible) | tus.io contributors, 2016-present |
| D2 | Explicit finalize + sidecar metadata | Ch. 2 §2.5 pipeline theme |
| D3 | Async transcode + Redis queue | Pantos & May, 2017; Google, 2016 |
| D4 | HLS adaptive delivery | Pantos & May, 2017 |
| D5 | Signed URLs + gateway policy | Hardt, 2012; Lodderstedt et al., 2025; Marron, 2024; HHS, n.d.; Alahmari & Renaud, 2020 |
| D6 | OAuth for web tier | Hardt, 2012; Lodderstedt et al., 2025 |
| D7 | Observability stack | Google, 2016; Prometheus Authors, n.d. |
| D8 | Disk-first metadata sidecars | Operational / recovery rationale (tie to SRE Ch. 2) |
| D9 | Containerized deployment | Reproducibility (Hevner et al., 2004 evaluation norms) |

---

*End of draft structure. Expand Chapter 6 with your repository-specific paths and endpoint names as in prior versions; expand Chapter 8 with measured results when available.*
