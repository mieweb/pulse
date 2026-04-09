# Consensus Search and Paper Verification Log

Date: 2026-04-09  
Owner: Priyam More  
Purpose: Consolidated log of search queries, paper candidates, and online verification status for thesis citation decisions.

## 1) Scope and Method

- Source sets covered:
  - Existing `thesis-docs` Consensus papers list.
  - Core architecture/system-design references for Pulse/PulseVault.
- Process:
  1. Start from paper titles already documented in `thesis-docs`.
  2. Run web search for each title (title-first search).
  3. Capture strongest accessible authoritative link (publisher, DOI, RFC, NIST, HHS, journal, or repository).
  4. Classify status:
     - `verified`: paper/source found with strong bibliographic match.
     - `partially_verified`: related source found but title/version/quality mismatch exists.
     - `needs_manual_access`: likely valid but direct full record requires login/paywall/manual library access.

## 2) Core Architecture Reference Searches (System-Design Load-Bearing)

| Query | Best Link | Status | Thesis Use |
|---|---|---|---|
| design science research information systems artifact evaluation architecture rationale Hevner | https://aisel.aisnet.org/misq/vol28/iss1/6/ | verified | Core |
| RFC 9700 OAuth BCP | https://www.rfc-editor.org/rfc/rfc9700 | verified | Core |
| RFC 8216 HLS | https://www.rfc-editor.org/rfc/rfc8216 | verified | Core |
| RFC 6749 OAuth 2.0 | https://www.rfc-editor.org/rfc/rfc6749 | verified | Core |
| tus resumable upload protocol | https://tus.io/protocols/resumable-upload.html | verified | Core |
| NIST SP 800-66 Rev.2 HIPAA | https://doi.org/10.6028/NIST.SP.800-66r2 | verified | Core |
| HHS HIPAA Security Rule summary | https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html | verified | Core |
| Prometheus overview | https://prometheus.io/docs/introduction/overview/ | verified | Core |
| Google SRE book | https://sre.google/sre-book/table-of-contents/ | verified | Core |
| Kruchten 4+1 DOI search | https://doi.org/10.1109/52.469759 | verified | Core |
| Nonaka 1994 DOI search | https://doi.org/10.1287/orsc.5.1.14 | verified | Core |
| Mayer 2005 multimedia learning chapter | https://www.cambridge.org/core/books/cambridge-handbook-of-multimedia-learning/cognitive-theory-of-multimedia-learning/A49922ACB5BC6A37DDCCE4131AC217E5 | verified | Core background |
| Mayer 2009 Multimedia Learning | https://www.cambridge.org/core/books/multimedia-learning/7A62F072A71289E1E262980CB026A3F9 | verified | Core background |
| Kumar 2024 video-based meta-analysis | https://www.nature.com/articles/s41598-024-73671-7 | verified | Core background (bounded claim) |

## 3) Consensus Papers from Thesis Docs: Online Verification

Note: direct `consensus.app` page fetches are account-gated. Verification below uses independent web search.

| # | Consensus-listed Title (short) | Best Online Match | Status | Recommended Use |
|---|---|---|---|---|
| 1 | Video vs. text effectiveness (production workers) | https://essay.utwente.nl/72445/1/Scheurwater_MA_EST.pdf | verified | Context/support |
| 2 | Interactive Videos vs Hypertext Documents | http://hdl.handle.net/10125/59443 | verified | Support |
| 3 | Smart-glass video tutorials and knowledge transfer | https://dblp.org/rec/conf/infrahealth/GutzmannBP23 | partially_verified | Support/future |
| 4 | Comparative textual vs audiovisual technical knowledge diffusion | https://aaltodoc.aalto.fi/items/b7cdff8d-774b-4716-82f1-5115a7e42d0f | partially_verified | Context only |
| 5 | Transferring Expert Knowledge through Video Instructions | (no exact robust match found in this pass) | needs_manual_access | Manual check required |
| 6 | The System Usability Scale: Past, Present, and Future | https://doi.org/10.1080/10447318.2018.1455307 | verified | Optional (if SUS used) |
| 7 | An Empirical Evaluation of SUS | https://doi.org/10.1080/10447310802205776 | verified | Optional (if SUS used) |
| 8 | SUS Benchmarking for Digital Health Apps | https://doi.org/10.2196/37290 | verified | Optional (if SUS used) |
| 9 | Perceived usability evaluation of educational technology using SUS | https://doi.org/10.1080/15391523.2020.1867938 | verified | Optional |
| 10 | EHR usability, burnout, turnover (6 months post go-live) | https://informatics.bmj.com/content/32/1/e101200 | verified | Optional/context |
| 11 | Motivation and barriers in virtual CoP | https://doi.org/10.1108/13673270310463626 | verified | Context |
| 12 | Learning and knowledge sharing in virtual CoP | https://doi.org/10.1177/1523422308319536 | verified | Context |
| 13 | Barriers to adoption of visual KM tools | (results were adjacent but not exact canonical record) | partially_verified | Context only |
| 14 | Effects of socio-technical enablers on knowledge sharing | https://doi.org/10.1177/0165551507087710 | verified | Support |
| 15 | Enabling digital technologies adoption via trust/knowledge sharing | https://doi.org/10.1016/j.techfore.2023.123294 | verified | Support |
| 16 | Systematic Review of Living Lab Literature | https://doi.org/10.1016/j.jclepro.2018.10.257 | verified | Context/method |
| 17 | Are living labs effective? | https://doi.org/10.1016/j.techsoc.2021.101579 | verified | Context/method |
| 18 | Living lab approach and healthcare innovation implementation | https://doi.org/10.1136/bmjopen-2021-058630 | verified | Context/method |
| 19 | Lessons from living lab for eHealth adoption (primary care) | https://doi.org/10.2196/jmir.9923 | verified | Context/method |
| 20 | Moving toward generalizability? impact of living labs | https://doi.org/10.3390/su13020502 | verified | Context/method |

## 4) Consensus Platform Access Note

- Attempted direct page retrieval from consensus.app returned sign-in gate for paper pages.
- Practical workflow for this thesis:
  1. Use Consensus for discovery.
  2. Verify each candidate via DOI/publisher/open repository.
  3. Cite the authoritative source (not Consensus card URL) in dissertation references.

## 5) Recommended Citation Policy for Current Thesis Direction

- Since thesis is now system-design + design-rationale focused:
  - Keep Sections 2 and 3 papers as background/context where relevant.
  - Avoid making central claims dependent on SUS/living-lab/user-study literature unless you include actual study results.
  - Use standards and architecture literature as primary evidence for core chapters.

## 6) Immediate Next Actions

1. For each `partially_verified` and `needs_manual_access` item, do one library/Google Scholar pass and either:
   - upgrade to `verified`, or
   - remove from load-bearing citations.
2. Build final `claim -> citation` mapping for:
   - design-science framing,
   - upload/transcode/delivery architecture,
   - security and observability rationale,
   - future work methods (if no full evaluation chapter evidence).

