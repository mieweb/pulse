# Claim-to-Citation Matrix (System-Design Thesis)

Date: 2026-04-09  
Purpose: Map dissertation claims to high-confidence sources and chapter placement.

## 1) Core Claims (Load-Bearing)

| Claim ID | Claim Statement | Primary Evidence | Chapter Placement | Status |
|---|---|---|---|---|
| C01 | Design-science research accepts artifact-centered contribution when rigor and evaluation are explicit. | Hevner et al. (2004), MISQ | Ch1, Ch3 | ready |
| C02 | Architectural decisions should be justified by quality attributes and stakeholder concerns. | Bass, Clements, Kazman (2012) | Ch2, Ch5 | ready |
| C03 | Multi-view architectural representation improves communication across stakeholders. | Kruchten (1995) | Ch2, Ch4 | ready |
| C04 | Institutional knowledge loss is tied to weak externalization of tacit know-how. | Nonaka (1994); Davenport & Prusak (1998) | Ch1, Ch2 | ready |
| C05 | Video is a plausible medium for procedural knowledge transfer when designed with cognitive constraints in mind. | Mayer (2005, 2009); Kumar et al. (2024) | Ch1, Ch2 | ready |
| C06 | Resumable upload is appropriate for unreliable networks and large objects. | tus protocol 1.0.0 | Ch2, Ch5 | ready |
| C07 | Adaptive HTTP streaming requires playlist-segment semantics and bitrate adaptation behavior. | RFC 8216 | Ch2, Ch5 | ready |
| C08 | OAuth-based identity and delegated authorization should follow modern threat mitigations. | RFC 6749; RFC 9700 | Ch2, Ch5 | ready |
| C09 | Regulated-context security claims should be framed through official HIPAA implementation guidance. | NIST SP 800-66r2; HHS HIPAA Security Rule summary | Ch2, Ch5 | ready |
| C10 | Observability is part of system operability and reliability reasoning, not post-hoc tooling. | Google SRE; Prometheus docs | Ch2, Ch5, Ch7 | ready |
| C11 | Separation of ingest path and transcode path reduces coupling and supports scalable processing. | Google SRE (data processing pipelines); queue-worker architecture practice | Ch4, Ch5 | ready |
| C12 | Signed, short-lived media URLs provide bounded capability access compared to static public links. | RFC 6749, RFC 9700, implementation token checks | Ch4, Ch5 | ready |
| C13 | Disk-first metadata plus atomic write strategy supports crash-consistent media state transitions. | ACM Queue crash consistency guidance; POSIX fsync/rename durability practice + implementation evidence | Ch4, Ch5 | ready |
| C14 | Tamper-evident append-only logging is suitable for audit integrity narratives in secure systems. | Logcrypt forward security/public verification + implementation evidence | Ch4, Ch5 | ready |
| C15 | Core thesis validity can rest on design rationale + technical validation without mandatory user-study evidence. | Hevner (artifact + evaluation framing); methodological scope declaration | Ch1, Ch3, Ch7 | ready |

## 2) Implementation-Traceability Claims (Pulse/PulseVault Specific)

| Claim ID | Implementation-Linked Claim | Local Evidence | Literature Anchor | Chapter Placement | Status |
|---|---|---|---|---|---|
| I01 | Upload flow uses resumable protocol and explicit finalize boundary. | `pulse-vault/pulsevault/routes/uploads.js` | tus protocol | Ch4 | ready |
| I02 | Finalize commits durable identity, metadata sidecar, queue job. | `routes/uploads.js`, `lib/metadata-writer.js` | architecture decision rationale | Ch4 | ready |
| I03 | Transcoding is asynchronous via Redis-backed worker pipeline. | `workers/transcode-worker.js`, `plugins/redis.js` | SRE operations; queue architecture literature | Ch4 | ready |
| I04 | Delivery path uses signed media URLs with token validation checks. | `routes/media.js` | OAuth/security guidance context | Ch4 | ready |
| I05 | Gateway blocks unsafe public signing paths and fronts media/API routes. | `nginx/conf.d/pulsevault-locations.conf` | defense-in-depth framing | Ch4 | ready |
| I06 | Observability stack provides metric/log evidence paths for validation. | compose + Prometheus + Grafana + Loki configs | Google SRE; Prometheus docs | Ch4, Ch5 | ready |
| I07 | Mobile client applies segment-based non-destructive edit model before export/upload. | `app/(camera)/shorts.tsx`, `utils/draftStorage.ts`, `utils/tusUpload.ts` | mobile/CSCW and editing context (bounded) | Ch4 | ready |

## 3) Context-Only Claims (Do Not Overweight)

| Claim ID | Context Claim | Supporting Sources | Placement | Status |
|---|---|---|---|---|
| X01 | Short-form ecosystem trends motivate format relevance, not enterprise architecture proof. | Rajendran et al. (arXiv) | Ch2 (brief) | ready |
| X02 | SUS and living-lab literature inform optional future empirical methods. | Lewis; Bangor; living-lab papers | Ch7/Ch10 (conditional) | ready |
| X03 | Organizational knowledge-sharing barriers involve socio-technical and trust factors. | Ardichvili papers; Choi/Kang; related studies | Ch2/Ch10 | ready |

## 4) Claims to Avoid Without Additional Evidence

| Risky Claim Pattern | Reason | Required Action |
|---|---|---|
| "Pulse improves adoption by X%" | No finalized study dataset in core thesis scope | Move to future work or remove |
| "Video is universally superior to text" | Over-generalization across contexts | Keep bounded, domain-qualified wording |
| "HIPAA compliant by default in all deployments" | Compliance depends on operational controls/process | Use "supports compliance-aligned architecture" |
| "Full production security guarantee" | Out of scope for thesis implementation envelope | Frame as design rationale and implementation boundary |

## 5) Next Writing Use

Use this matrix while drafting each chapter section:

1. Start paragraph with claim.
2. Add 1-2 strongest citations from this table.
3. Tie claim to concrete Pulse/PulseVault decision.
4. End with scope/limitation where needed.

## 6) Weak-Source Removal Policy Applied

- Excluded as load-bearing: marketing-only short-form engagement papers, weakly verified legacy records, and non-authoritative web articles.
- Retained as load-bearing: standards-track RFCs, NIST/HHS guidance, foundational peer-reviewed works, and implementation evidence.

