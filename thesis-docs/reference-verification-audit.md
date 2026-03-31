# Reference Verification Audit

Date: 2026-03-24  
Scope: `thesis-docs/dissertation-draft-v2.md` working bibliography

Status legend:
- **Verified**: citation exists and core claim alignment confirmed.
- **Partially verified**: citation exists, but claim fit is weak/broad or source quality is limited.
- **Unverified**: not confirmed with sufficient confidence; should be replaced.

---

## Audit Results

1. **Alahmari & Renaud (2020), ICITST**
- Status: **Verified**
- Evidence: Conference record and institutional repositories show paper exists.
- Claim fit: Supports security knowledge-sharing framing in organizations.

2. **Davenport & Prusak (1998), Working Knowledge**
- Status: **Verified**
- Evidence: Widely cataloged foundational KM book.
- Claim fit: Strong for institutional knowledge loss/management framing.

3. **Fatimah & Nasir (2025), short-form brand engagement**
- Status: **Removed from dissertation draft**
- Reason: Source quality/claim fit weaker for core systems thesis argument.

4. **Google SRE Book (2016)**
- Status: **Verified**
- Evidence: Published O'Reilly title.
- Claim fit: Strong for reliability/observability operational framing.

5. **Johnson (2013), iJIM CSCW mobile support**
- Status: **Verified**
- Evidence: DOI and journal article confirmed.
- Claim fit: Good for mobile-CSCW historical context.

6. **Scientific Reports (2024), DOI 10.1038/s41598-024-73671-7**
- Status: **Verified**
- Evidence: Nature + PMC + DOI confirmed.
- Claim fit: Strong for video-based learning effectiveness.

7. **NIST SP 800-66r2 (2024)**
- Status: **Verified**
- Evidence: NIST publication page + DOI confirmed.
- Claim fit: Strong for HIPAA Security Rule implementation guidance.

8. **Mayer (2005), CTML chapter**
- Status: **Verified**
- Evidence: Cambridge Handbook chapter exists.
- Claim fit: Strong for multimedia learning theory.

9. **Mayer (2009), Multimedia Learning**
- Status: **Verified**
- Evidence: Cambridge publication exists.
- Claim fit: Strong for instructional multimedia rationale.

10. **HHS HIPAA Security Rule summary (replacement for Nadella entry)**
- Status: **Verified**
- Evidence: Official HHS page exists.
- Claim fit: Strong for regulatory baseline statements.

11. **Nonaka (1994), Organization Science**
- Status: **Verified**
- Evidence: DOI and publication confirmed.
- Claim fit: Strong for tacit/explicit knowledge creation theory.

12. **RFC 8216 (HLS)**
- Status: **Verified**
- Evidence: RFC Editor and IETF entries confirmed.
- Claim fit: Strong for HLS technical grounding.

13. **Prometheus official docs**
- Status: **Verified**
- Evidence: Official docs site exists.
- Claim fit: Good for implementation context; pair with peer-reviewed/standards where possible.

14. **Rajendran et al. (2024), Shorts on the Rise**
- Status: **Verified (corrected)**
- Evidence: arXiv title exists at `2402.18208`.
- Claim fit: Good for short-form platform trend context (not primary enterprise evidence).

15. **RFC 9700 OAuth BCP**
- Status: **Verified (corrected authors)**
- Evidence: RFC info page confirms authors and BCP status.
- Claim fit: Strong for modern OAuth security practices.

16. **EditDuet arXiv**
- Status: **Verified (corrected arXiv ID)**
- Evidence: arXiv exists at `2509.10761`.
- Claim fit: Reasonable for NLE architecture context/future work.

17. **RFC 6749 OAuth 2.0**
- Status: **Verified (corrected attribution)**
- Evidence: RFC text confirms editor D. Hardt.
- Claim fit: Strong for OAuth framework baseline.

18. **tus resumable upload protocol**
- Status: **Verified**
- Evidence: Official protocol spec page exists.
- Claim fit: Strong for resumable upload design rationale.

19. **Wilson (1990), CSCW overview**
- Status: **Removed from dissertation draft**
- Reason: Accessibility and verification confidence lower than preferred threshold.

---

## Fixes Applied to Draft

Updated in `dissertation-draft-v2.md`:
- Corrected Rajendran arXiv URL (`2402.18208`).
- Corrected EditDuet arXiv URL (`2509.10761`).
- Corrected RFC 9700 authors.
- Corrected RFC 6749 attribution to Hardt (Ed.).
- Replaced uncertain Nadella entry with official HHS HIPAA Security Rule page.

---

## Current Policy Applied

The dissertation draft now follows this rule: if a citation is not fully verified for existence and claim fit, it is excluded from use.

---

## Recommended Next Cleanup

1. Reduce dependence on lower-rigor sources for core claims (e.g., marketing-oriented short-form paper).
2. Keep standards (RFC/NIST/HHS) for security/protocol claims.
3. For each chapter-critical claim, ensure at least one high-quality source (peer-reviewed or standards-track).
4. Add DOIs where available in final formatting pass.

