# DESIGN, IMPLEMENTATION, AND EVALUATION OF PULSEVAULT:
# A SECURE VIDEO-FIRST PLATFORM FOR INSTITUTIONAL KNOWLEDGE CAPTURE

by  
Priyam More

A Thesis  
Submitted to the Faculty of Purdue University  
In Partial Fulfillment of the Requirements for the degree of  
Master of Science in Computer Science

Department of Computer Science  
Fort Wayne, Indiana  
2026

---

# THE PURDUE UNIVERSITY GRADUATE SCHOOL
# STATEMENT OF COMMITTEE APPROVAL

Dr. [Committee Chair Name], Chair  
Department of Computer Science

Dr. [Committee Member Name]  
Department of [Department]

Dr. [Committee Member Name]  
Department of [Department]

Approved by:  
Dr. [Advisor Name]

---

# DEDICATION

To my family.

---

# ACKNOWLEDGMENTS

I thank my advisor and committee members for their guidance, feedback, and encouragement. Their support made it possible to frame this work as a rigorous systems dissertation rather than only an implementation report.

I also thank colleagues and collaborators who provided technical feedback during the design and deployment of Pulse and PulseVault.

I am deeply grateful to my family for their patience and support throughout this process.

---

**Citation style:** APA 7th edition (author-date).

---

## ABSTRACT

Institutions routinely lose procedural knowledge when expertise remains tacit, fragmented, or weakly externalized. Text-based documentation remains necessary for policy and reference content, but often undercaptures temporal, visual, and tool-mediated details required for procedural transfer (Nonaka, 1994; Davenport & Prusak, 1998). This thesis presents Pulse and PulseVault as a research-informed systems artifact: a mobile-first capture client and secure backend pipeline for ingesting, processing, and delivering short-form institutional knowledge video.

The thesis contribution is structured around design rationale rather than product demonstration. First, it provides a literature-grounded architecture argument for key decisions, including resumable ingest, explicit finalize boundaries, asynchronous transcoding, adaptive HTTP delivery, tokenized media access, gateway policy, and observability. Second, it maps these decisions to concrete implementation evidence in the current codebase. Third, it provides bounded technical validation checks that establish implementation correctness envelopes while explicitly deferring large-scale human-subject and organizational adoption studies to future work.

Methodologically, the thesis follows design-science expectations for artifact-oriented information systems research by making the rationale chain explicit, grounding decisions in standards and high-quality references, and documenting trade-offs and non-claims (Hevner et al., 2004). Core claims are supported by standards-track and foundational sources, including RFC 8216 (HLS), RFC 6749 and RFC 9700 (OAuth), the tus resumable upload protocol, NIST SP 800-66r2, and reliability/observability practice literature.

**Keywords:** institutional knowledge, design rationale, software architecture, resumable upload, HLS, OAuth, observability, secure media systems

---

## CHAPTER 1. INTRODUCTION

### 1.1 Background and Context

Organizations depend on procedural knowledge for onboarding, incident recovery, and routine operations. In many environments, this knowledge is spread across documents, chat, tickets, and verbal guidance. The result is frequent rediscovery costs, inconsistent procedure execution, and avoidable delays when expertise is unavailable.

Knowledge management theory distinguishes tacit and explicit knowledge and emphasizes the need for systematic externalization pathways (Nonaka, 1994). Practice-oriented work further shows that institutional capability is constrained when operational know-how remains person-bound rather than durable and transferable (Davenport & Prusak, 1998).

### 1.2 Problem Statement and Research Objectives

This thesis addresses the following problem:

How should an institution design and justify a secure, operable, and reproducible short-form video system for procedural knowledge capture and delivery, when full-scale human-subject evaluation is out of current scope?

The objectives are:

1. Design a coherent end-to-end architecture for capture, ingest, processing, delivery, and operations.
2. Provide explicit decision rationale with alternatives and trade-offs.
3. Demonstrate implementation traceability to the argued architecture.
4. Provide bounded technical validation and clearly separate deferred empirical claims.

### 1.3 Significance of the Study

The significance is methodological and practical:

- Methodological: it demonstrates how to produce a defendable systems dissertation using design-rationale rigor and bounded technical validation.
- Practical: it provides an implementation blueprint for institutions that need self-hosted, security-aware video workflows without adopting consumer platform assumptions.

### 1.4 Overview of Methodological Approach

The thesis follows design-science principles where artifact creation, grounding, and evaluation are treated as a coherent research process (Hevner et al., 2004). Architectural decisions are documented using a decision template: decision, alternatives, criteria, evidence, and accepted trade-offs.

### 1.5 Structure of the Thesis

- Chapter 1 introduces context, objectives, and scope.
- Chapter 2 synthesizes literature and standards used for decision grounding.
- Chapter 3 defines the design-rationale method and validation boundaries.
- Chapter 4 presents system design, implementation traceability, and minimal technical validation.
- Chapter 5 discusses implications, threats, and non-claims.
- Chapter 6 concludes and defines future work.

---

## CHAPTER 2. LITERATURE REVIEW

### 2.1 Overview

This review is organized around decision-relevant themes, not an encyclopedic bibliography. Each subsection supports architectural reasoning used later in Chapter 4.

### 2.2 Organizational Knowledge and Externalization

Nonaka (1994) and Davenport and Prusak (1998) provide the conceptual basis for treating procedural knowledge capture as an infrastructure problem, not only a documentation formatting problem.

Design consequence: capture workflows must minimize friction and preserve context-rich procedural signals.

### 2.3 Procedural Learning and Video as Medium

Mayer (2005, 2009) offers a bounded theoretical basis for multimedia learning: dual-channel processing, limited capacity, and active integration. Kumar et al. (2024) report positive effects of video-based interventions in health-education contexts, with caution regarding heterogeneity and bias.

Design consequence: short-form video is justified as a plausible medium, but claims should remain bounded to architecture readiness and technical feasibility unless stronger domain-matched evidence is produced.

### 2.4 Mobile Capture and Cross-Platform Constraints

Mobile CSCW and groupware literature identifies heterogeneity, resource variance, and deployment constraints across clients (Johnson, 2013).

Architectural consequence: capture responsibilities should remain client-friendly while normalization and delivery standardization occur server-side.

### 2.5 Media Ingest, Streaming, and Pipeline Standards

The tus protocol defines resumable upload semantics over HTTP. RFC 8216 defines HLS playlist and segment behavior for adaptive delivery.

Architectural consequence: reliable ingest under unstable connectivity and adaptive playback can be justified with standards-based architecture rather than platform-specific ad hoc patterns.

### 2.6 Security, Identity, and Regulated Context Framing

RFC 6749 provides OAuth 2.0 framework baseline, while RFC 9700 provides modern security best current practice updates. NIST SP 800-66r2 and HHS HIPAA Security Rule resources provide implementation-oriented compliance framing for systems handling sensitive health-adjacent data.

Architectural consequence: identity, tokenization, and gateway policy should be treated as first-class architectural decisions.

### 2.7 Observability and Reliability Operations

Google SRE and Prometheus documentation emphasize explicit telemetry, operational diagnostics, and reliability-oriented measurement.

Architectural consequence: observability must be embedded in architecture and validation planning, not added after deployment.

### 2.8 Architecture Rationale and Research Positioning

Software architecture practice highlights quality-attribute trade-offs and stakeholder communication needs (Bass et al., 2012; Kruchten, 1995). Design-science framing requires explicit contribution articulation and evaluation boundaries (Hevner et al., 2004).

Implication for this thesis: explicit rationale is part of the research output.

### 2.9 Research Gap

Existing literature provides components of the problem space, but fewer works present an integrated, standards-grounded, institution-oriented short-form video architecture with explicit design rationale and implementation traceability.

This thesis addresses that integration gap.

---

## CHAPTER 3. METHODOLOGY

### 3.1 Overview

The methodology contains three layers:

1. Design-rationale method for architecture decisions.
2. Implementation traceability method to connect decisions to code/system behavior.
3. Minimal technical validation method to test core system properties without overclaiming human-subject outcomes.

### 3.2 Design-Rationale Method

Each major decision is documented with:

- Decision statement
- Alternatives considered
- Decision criteria
- Literature/standards backing
- Trade-offs accepted

This structure aligns with architecture decision quality practices and design-science expectations.

### 3.3 Claim Boundary and Non-Claims

In-scope claims:

- Architecture coherence and rationale quality.
- Implementation traceability for key subsystems.
- Bounded technical checks for reliability/security pathways.

Out-of-scope claims:

- Large-scale user adoption outcomes.
- Broad video-versus-text performance superiority.
- Generalized organizational ROI.

### 3.4 Data and Evidence Protocol

Evidence sources:

- Repository implementation artifacts.
- Deployment architecture/configuration files.
- Standards and peer-reviewed references.
- Reproducible technical checks.

### 3.5 Minimal Technical Validation Procedure

Validation focuses on four check families:

1. Upload/finalize correctness.
2. Async transcode lifecycle correctness.
3. Signed URL and access control checks.
4. Operational visibility checks (metrics/logs availability).

### 3.6 Validity, Limitations, and Reproducibility

- Internal validity strengthened through standards-grounded decision criteria and code traceability.
- External validity is intentionally bounded.
- Reproducibility is supported by explicit component paths and service-level flow descriptions.

---

## CHAPTER 4. SYSTEM DESIGN AND MINIMAL TECHNICAL VALIDATION RESULTS

### 4.1 Overview

This chapter presents the architecture, rationale, implementation mapping, and minimal technical validation checks for Pulse/PulseVault.

### 4.2 End-to-End Architecture

The platform includes:

- Pulse mobile capture client.
- PulseVault backend (Fastify routes/plugins).
- Redis-backed queue for transcode jobs.
- Worker pipeline (FFmpeg/ffprobe).
- Nginx gateway.
- Frontend layer for authenticated web interactions.
- Observability stack (Prometheus/Grafana/Loki).
- Filesystem storage with per-video metadata sidecars.

### 4.3 Design Decision A: Resumable Ingest and Explicit Finalize

**Decision:** use resumable upload semantics and a separate finalize step.

**Alternatives:** single-shot upload; implicit finalize at upload completion.

**Rationale:** better interruption tolerance, clearer failure boundaries, explicit commit transition.

**Implementation evidence:**

- `pulse-vault/pulsevault/routes/uploads.js` initializes `@tus/server` with `FileStore`.
- `/uploads/finalize` validates token, enforces draft/video identity, moves file, computes checksum, writes metadata, enqueues transcode.

### 4.4 Design Decision B: Asynchronous Transcode Pipeline

**Decision:** isolate transcode in worker process with queue mediation.

**Alternatives:** synchronous transcode in API path; monolithic process.

**Rationale:** protects ingest latency and enables horizontal worker scaling.

**Implementation evidence:**

- `pulse-vault/pulsevault/plugins/redis.js` queue keying.
- `pulse-vault/pulsevault/workers/transcode-worker.js` `BRPOP` loop, rendition generation, metadata update.

### 4.5 Design Decision C: Adaptive Delivery and Tokenized Access

**Decision:** HLS delivery with short-lived HMAC tokenization.

**Alternatives:** static public URLs; long-lived direct media links.

**Rationale:** standards-aligned adaptive delivery with bounded capability access.

**Implementation evidence:**

- `pulse-vault/pulsevault/routes/media.js` signs `videoId:path:expiresAt`, verifies token, rewrites playlist URLs with tokenized segment URLs, supports range streaming.

### 4.6 Design Decision D: Gateway Policy and Trust-Zone Separation

**Decision:** edge proxy enforces route behavior and separates signing from public media retrieval.

**Implementation evidence:**

- `pulse-vault/nginx/conf.d/pulsevault-locations.conf` blocks unsafe public access paths and fronts upload/media routing.

### 4.7 Design Decision E: Disk-First Metadata with Atomic Durability

**Decision:** sidecar metadata as local source-of-truth with atomic write protocol.

**Rationale:** recoverability, inspectability, and crash-consistency-aware state transitions.

**Implementation evidence:**

- `pulse-vault/pulsevault/lib/metadata-writer.js` writes temp file, fsyncs file, atomically renames, fsyncs directory.

### 4.8 Design Decision F: Tamper-Evident Audit Logging

**Decision:** append-only hash-chained audit entries.

**Rationale:** integrity signaling for post-event review and operational accountability.

**Implementation evidence:**

- `pulse-vault/pulsevault/lib/audit-logger.js` stores `prevHash` and `hash`, includes chain verification routine.

### 4.9 Design Decision G: Mobile Draft and Segment Workflow

**Decision:** segment-based, non-destructive client draft model prior to final export/upload.

**Rationale:** capture/edit flexibility without destructive source mutation during authoring.

**Implementation evidence:**

- `app/(camera)/shorts.tsx` segmented capture, trim-aware effective duration, draft mode handling.
- `utils/draftStorage.ts` AsyncStorage draft persistence with metadata.
- `utils/tusUpload.ts` upload session creation, chunked patching, finalize call.

### 4.10 Minimal Technical Validation (Bounded)

#### 4.10.1 Upload/Finalize Path Checks

Observed implementation properties:

- Upload session creation and chunked transfer endpoints exist.
- Finalize enforces upload token policy (configurable), draft-to-video identity binding, checksum computation, and metadata write.

Validation interpretation:

- Confirms architectural intent for reliable ingest and explicit commit boundaries.
- Does not by itself quantify large-sample field reliability.

#### 4.10.2 Transcode Lifecycle Checks

Observed implementation properties:

- Queue dequeue and job execution loop implemented.
- Rendition selection and playlist generation logic implemented.
- Metadata status transitions (`uploaded` to `transcoded` / failure states) implemented.

Validation interpretation:

- Confirms asynchronous lifecycle behavior and state update plumbing.
- Throughput and scale saturation remain future benchmarking tasks.

#### 4.10.3 Token and Access-Control Checks

Observed implementation properties:

- HMAC signing and expiry validation implemented.
- Path traversal checks implemented.
- Playlist rewriting ensures child media requests include signed paths.

Validation interpretation:

- Confirms bounded-token access mechanism behavior.
- Formal adversarial security evaluation is out of current scope.

#### 4.10.4 Observability Availability Checks

Observed implementation properties:

- Prometheus scrape endpoint and ecosystem config present.
- Audit logs and log shipping configs present.

Validation interpretation:

- Confirms architecture supports operational telemetry pathways.
- SLO calibration and long-window operational analytics remain future work.

### 4.11 Summary: Proven vs Deferred

Proven in this thesis scope:

- Coherent architecture rationale chain.
- Concrete implementation traceability.
- Minimal correctness checks for key pathways.

Deferred:

- Full empirical user studies.
- Broad adoption outcome claims.
- Large-scale comparative evaluation.

---

## CHAPTER 5. DISCUSSION AND IMPLICATIONS

### 5.1 Overview

This chapter interprets the design and validation outcomes against research objectives while preserving scope discipline.

### 5.2 Design Trade-Offs by Research Objective

#### Objective 1: Architecture Coherence

The architecture prioritizes separation of concerns: capture, ingest, processing, delivery, and observability. This improves modularity and evolvability but increases deployment coordination complexity.

#### Objective 2: Explicit Rationale

Decision transparency is improved by standards-backed justifications and alternative analysis. The cost is added documentation overhead that must be maintained as implementation evolves.

#### Objective 3: Implementation Traceability

Repository-level evidence supports a strong traceability narrative. The risk is drift if undocumented changes occur after thesis freeze.

#### Objective 4: Bounded Validation

Minimal technical checks establish system plausibility and implementation consistency. They do not establish generalized organizational impact.

### 5.3 Practical Implications for Institutional Deployments

- Institutions can adapt this architecture where secure procedural media workflows are needed.
- Tokenized delivery and explicit finalize boundaries are useful control points for governance.
- Observability should be considered deployment-critical from day one.

### 5.4 Threats to Validity

- Single codebase and deployment profile.
- Limited benchmark depth in this thesis version.
- No completed human-subject evidence included in core claims.

### 5.5 Scope Boundaries and Non-Claims

This thesis does not claim universal superiority of video over text, full compliance certification, or large-scale adoption impact. It claims a rigorous design-rationale artifact with bounded technical validation.

---

## CHAPTER 6. CONCLUSION AND FUTURE WORK

### 6.1 Overview

This thesis presented Pulse/PulseVault as a system-design artifact and documented the rationale and implementation of its core architecture.

### 6.2 Summary of Contributions

1. A literature- and standards-grounded architecture rationale for secure institutional short-form video systems.
2. Implementation traceability across ingest, processing, delivery, and observability subsystems.
3. A bounded validation framework suited to current time and scope constraints.

### 6.3 Methodological and Systems Contributions

Methodologically, the thesis demonstrates a defensible path for system-design dissertations where rigorous rationale and explicit non-claims are prioritized.

Systemically, it provides an operational architecture pattern that can be extended in institutional environments requiring governance and secure media handling.

### 6.4 Limitations

- No broad empirical user adoption study in current scope.
- No formal security proof or red-team evaluation.
- Limited quantitative benchmarking depth.

### 6.5 Future Work

Future work should include:

1. Full technical benchmarking under varied workloads and worker scaling scenarios.
2. Optional IRB-approved user study for usability and adoption evidence.
3. Extended governance features (multi-tenant controls, deeper compliance artifacts).
4. Advanced retrieval/editing workflows (for example, semantic indexing and AI-assisted editing) after core operational maturity.

---

## REFERENCES (WORKING SET)

Alahmari, S., & Renaud, K. (2020). Implement a model for describing and maximising security knowledge sharing. *ICITST*.

Bass, L., Clements, P., & Kazman, R. (2012). *Software architecture in practice* (3rd ed.). Addison-Wesley.

Davenport, T. H., & Prusak, L. (1998). *Working knowledge*. Harvard Business School Press.

Google. (2016). *Site reliability engineering*. O'Reilly.

Hardt, D. (Ed.). (2012). RFC 6749: OAuth 2.0 authorization framework. IETF.

Hevner, A. R., March, S. T., Park, J., & Ram, S. (2004). Design science in information systems research. *MIS Quarterly*.

Johnson, D. (2013). Mobile support in CSCW applications and groupware development frameworks. *iJIM*.

Kruchten, P. (1995). The 4+1 view model of architecture. *IEEE Software*.

Kumar, A., et al. (2024). Video-based approaches in health education: A systematic review and meta-analysis. *Scientific Reports*.

Lodderstedt, T., Bradley, J., Labunets, A., & Fett, D. (2025). RFC 9700: Best current practice for OAuth 2.0 security. IETF.

Marron, J. (2024). NIST SP 800-66 Rev. 2. NIST.

Mayer, R. E. (2005). Cognitive theory of multimedia learning. In *The Cambridge handbook of multimedia learning*.

Mayer, R. E. (2009). *Multimedia learning* (2nd ed.). Cambridge University Press.

Nonaka, I. (1994). A dynamic theory of organizational knowledge creation. *Organization Science*.

Pantos, R., & May, W. (2017). RFC 8216: HTTP live streaming. IETF.

Prometheus Authors. (n.d.). *Prometheus documentation*.

Rajendran, P. T., Creusy, K., & Garnes, V. (2024). Shorts on the rise. *arXiv*.

tus.io contributors. (2016-present). *Resumable upload protocol 1.0.0*.

U.S. Department of Health and Human Services. (n.d.). *HIPAA Security Rule summary*.

---

## APPENDIX A. FIGURE PLAN (WORKING)

1. End-to-end architecture diagram.
2. Upload and finalize sequence.
3. Transcode worker lifecycle.
4. Signed URL validation flow.
5. Gateway trust-zone routing.
6. Observability data paths.

## APPENDIX B. DESIGN DECISION LOG (WORKING)

- D1 Resumable ingest
- D2 Explicit finalize
- D3 Async transcode queue
- D4 HLS adaptive delivery
- D5 Tokenized media access
- D6 OAuth-aligned identity
- D7 Observability-first operations
- D8 Disk-first metadata integrity
- D9 Tamper-evident audit logging

