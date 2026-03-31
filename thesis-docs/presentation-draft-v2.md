# Thesis Defense Presentation Draft (Pulse/PulseVault)

Duration target: 20-25 minutes  
Slide count target: 19-23 slides  
Style: Design-rationale thesis (literature review + justified architecture + technical evaluation; optional IRB study)

---

## Slide 1 - Title

**Title**  
Design and Evaluation of Pulse/PulseVault: A Secure Video-First Platform for Institutional Knowledge Capture

**Footer**  
Priyam More, MSCS  
Department / University  
Defense Date

**Speaker notes (20-30 sec)**  
Introduce the core problem: institutional knowledge is lost or fragmented, and this thesis presents a full system built to capture and deliver short-form procedural knowledge videos securely.

---

## Slide 2 - Motivation and Problem

**Key points**
- Teams lose procedural knowledge during transitions.
- Text documentation misses visual and temporal detail.
- Existing video tools are not designed for institutional controls.

**Speaker notes (45 sec)**  
Frame the cost of relearning and inconsistency. Emphasize that the challenge is not just recording, but having reliable, secure, and governed video workflows.

---

## Slide 3 - Research Framing (Not “Just a Product”)

**Key points**
- Design science in IS: **artifact** + **grounding in prior knowledge** + **evaluation** (Hevner et al., 2004).
- This thesis: **literature-grounded design rationale** (why each major choice) + **Pulse/PulseVault instantiation** + **technical evaluation**.
- Optional: **short IRB-approved user study** to complement—not replace—rationale and benchmarks.

**Speaker notes (30–45 sec)**  
Emphasize that the committee should see **research through justified design**, not only a demo. Core validity = Chapters 2, 5, 7–8; user study is conditional.

---

## Slide 4 - Research Questions

1. **RQ1.** What architectural pattern fits institutional short-form video end-to-end, per prior work?
2. **RQ2.** For each major decision, what alternatives, criteria, and citations justify the choice?
3. **RQ3.** Under controlled tests, how does the system behave (upload, transcode, playback, tokens, scale)?
4. **RQ4.** What reproducible metrics and protocols support evaluation without overstating claims?
5. **RQ5 (if IRB).** What minimal user evidence can complement rationale and benchmarks?

**Speaker notes (45 sec)**  
Map RQ1–RQ2 to literature review + design rationale chapter; RQ3–RQ4 to evaluation and results; RQ5 only if approved.

---

## Slide 5 - Contributions

- **Literature review** structured for design decisions (KM, learning, mobile/CSCW, media, security, observability, design science, software architecture / rationale).
- **Design rationale chapter**: explicit decisions, alternatives, trade-offs, citations (the core “research” thread).
- **Implementation** mapping rationale to Pulse/PulseVault.
- **Technical evaluation** methodology and results.
- **Optional** IRB user study as supplementary evidence.

**Speaker notes (45 sec)**  
Lead with rationale + literature; implementation and benchmarks support the argument. Avoid sounding like “we built an app” only.

---

## Slide 5b - Design Rationale (Examples)

**Per-decision template**  
Decision → Alternatives → Criteria → Literature/standards → Trade-off.

**Examples (say 2 aloud)**  
- Resumable upload + finalize (tus; reliability vs. state complexity).  
- Async transcode queue (responsive ingest vs. eventual consistency).  
- Signed HLS URLs + gateway policy (security vs. token churn).

**Speaker notes (45 sec)**  
This slide answers “where is the research?”—in **documented justification**, not only code.

---

## Slide 6 - System Overview

**Visual:** high-level architecture diagram
- Pulse clients (mobile/desktop workflow)
- PulseVault backend
- Redis + transcode workers
- Nginx gateway
- Frontend app
- Observability stack

**Speaker notes (60 sec)**  
Walk left-to-right. Capture, ingest, process, deliver, monitor.

---

## Slide 7 - Upload Pipeline (tus)

**Flow**
1. Create upload session.
2. Send chunks with offset.
3. Resume on interruption.
4. Finalize upload.

**Speaker notes (60 sec)**  
Explain why resumable transport is essential for large media and unstable networks.

---

## Slide 8 - Finalization and Metadata

**What finalize does**
- Validate upload completion.
- Commit permanent video ID and storage path.
- Compute checksum and write metadata sidecar.
- Queue transcode job.

**Speaker notes (45 sec)**  
Highlight separation: ingest responsiveness stays fast while heavy compute is deferred.

---

## Slide 9 - Asynchronous Transcoding

**Worker responsibilities**
- Pull from Redis queue.
- Probe source media.
- Generate HLS renditions.
- Write playlists and update metadata.

**Speaker notes (60 sec)**  
Mention horizontal scaling and backlog control via worker replicas.

---

## Slide 10 - Secure Media Delivery

**Mechanism**
- Signed URL token includes video ID, path, expiry.
- Backend verifies signature and timestamp.
- Gateway enforces route policy and range support.

**Speaker notes (60 sec)**  
State that short-lived signed links reduce unauthorized reuse risk.

---

## Slide 11 - Web Layer and Auth

**Frontend features**
- OAuth-based login/session.
- Upload + playback management.
- Admin/profile functions.

**Speaker notes (40 sec)**  
Keep this short; your thesis focus is systems pipeline and security/performance behavior.

---

## Slide 12 - Observability Stack

**Components**
- Prometheus metrics
- Grafana dashboards
- Loki/Promtail logging

**Speaker notes (45 sec)**  
Emphasize observability as both production necessity and evaluation evidence source.

---

## Slide 13 - Evaluation Method

**No-user-study technical evaluation**
- Controlled workloads
- Repeated runs
- Metrics from services and logs

**Experiments**
- Upload performance
- Finalize and transcode latency
- Signed token correctness
- Playback startup behavior
- Worker scaling impact

**Speaker notes (60 sec)**  
Explicitly justify non-IRB methodology as valid for systems thesis scope.

---

## Slide 14 - Results: Upload and Processing

**Visuals to include**
- Throughput vs file size
- Time-to-playable breakdown
- Queue wait vs worker count

**Speaker notes (60 sec)**  
Point out trends, not only numbers. Example: where bottlenecks shift under concurrency.

---

## Slide 15 - Results: Security and Delivery

**Visuals**
- Token validation matrix (valid/expired/tampered)
- Playback startup and seek response timings

**Speaker notes (45 sec)**  
Demonstrate that security checks are effective while playback remains practical.

---

## Slide 16 - Trade-offs and Lessons

**Key lessons**
- Async pipeline improves ingest responsiveness.
- Worker scaling helps until CPU/storage limits dominate.
- Tokenized delivery adds small overhead for meaningful control.
- Observability is required from day one.

**Speaker notes (60 sec)**  
Present these points candidly and with an engineering focus, emphasizing measured trade-offs rather than broad claims.

---

## Slide 17 - Limitations

**Limitations**
- Single deployment profile.
- No IRB user-adoption experiment in final evaluation.
- Security model is strong but not full DRM ecosystem.

**Speaker notes (35 sec)**  
Show realism. Committees value honest boundary definitions.

---

## Slide 18 - Future Work

**Next steps**
- Multi-tenant governance and policy controls.
- Semantic retrieval and metadata enrichment.
- Multi-region resilience.
- IRB-backed comparative adoption studies.

**Speaker notes (35 sec)**  
Link directly to what your current architecture enables next.

---

## Slide 19 - Conclusion

**Takeaway**
Pulse/PulseVault demonstrates a practical, secure, and measurable architecture for institutional short-form video knowledge workflows.

**Speaker notes (30 sec)**  
Re-state contribution and validation method in one crisp line.

---

## Slide 20 - Q&A

**Prompt**
Questions and discussion

**Backup note**  
Prepare three backup slides: API flow, queue internals, and token format/validation.

---

## Optional Backup Slides

### Backup A - Endpoint Map
- Upload, media, metadata, QR/deeplink, health/metrics

### Backup B - Deployment Topology
- Compose services, ports, dependencies, health checks

### Backup C - Experiment Setup Details
- Hardware profile, file corpus, run count, metric collection scripts

---

## Delivery Tips for Defense

- Spend most time on architecture and results, not broad background.
- Keep every chart tied to a research question.
- If asked about missing user study, answer: "This thesis evaluates systems performance and architecture; human-subject evaluation is planned as future work pending IRB approval."
- End with what is implemented today, not only what is planned.

