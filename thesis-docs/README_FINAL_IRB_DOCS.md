# Final IRB Documents for Pulse Vault Study

Use these two documents when filling in the Purdue HRP templates in **Word**. Do not convert to PDF for submission if the template instructs otherwise.

## 1. HRP-503c Exempt Study Protocol

**File:** `HRP_503c_FINAL_PROTOCOL.md`

- Open your **HRP-503c** Word template from Apollo/PERA.
- Copy each section from `HRP_503c_FINAL_PROTOCOL.md` into the matching section in the template.
- Keep all **Purdue standard language** (black font and gold instruction boxes) unchanged.
- **Delete** any red instruction text and replace with the black text from this file.
- **Check** in the template: Category (2) only; Section 4.1: Adults and Employees; Section 9.1: No (educational records).
- Fill the **table at the top**: Study title, PI (Adolfo Coronado), Student Investigator (Priyam More), departments, phones, emails.

## 2. HRP-502b Research Participant Information Sheet

**File:** `HRP_502b_INFORMATION_SHEET_FINAL.md`

- Open your **HRP-502b** Word template.
- Replace each placeholder in the template with the corresponding text from this file.
- Leave **`[insert IRB protocol number]`** blank until IRB assigns it; then add it to the header.
- Ensure the consent checkbox text matches: *"By clicking/checking this box, I agree to take part in this research. I am 18 years of age or older and understand the information above about my participation."*

## Key details (already in the final docs)

| Role | Name | Email | Phone |
|------|------|-------|-------|
| Principal Investigator | Adolfo Coronado | acoronad@pfw.edu | 260-481-6181 |
| Faculty Advisor | Romael Haque | mdromael.haque@pfw.edu | — |
| Student Investigator | Priyam More | morepr01@pfw.edu | 260-449-1394 |

- **Study title:** Adoption and Effectiveness of Pulse Vault for Institutional Knowledge Sharing: A Longitudinal User Study with Employees at Participating Organizations  
- **Exempt category:** (2) — survey procedures, interview procedures, observation of public behavior.  
- **Participants:** Adults, Employees; 5–25 total.  
- **Incentives:** None.  
- **Educational records:** No.

## Professor reference materials

The folder `professor/Evaluaion Study/` contains Consent Form and Study Protocol from a *different* study (mental health app recommender). They are useful for structure and tone only. To dump their text for reference:

```bash
python3 thesis-docs/parse_professor_irb_docs.py
```

This writes `thesis-docs/professor_irb_reference.txt`.

## After IRB approval

- Insert the IRB protocol number into HRP-502b and any other approved documents.
- Use only the **approved** protocol and information sheet for recruitment and consent.
- Keep a copy of the approved documents for your thesis appendix and records.
