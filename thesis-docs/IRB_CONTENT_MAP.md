# IRB Content Map: What We Have and What You Add Where

This document explains **what content we already have** for IRB and **exactly what you will be adding** into the Purdue Word templates (HRP-502b and HRP-503c). Use it as your full reference before you fill in the Word docs.

---

## Part 1: What content we HAVE (thesis-docs)

All of this lives in your `thesis-docs/` folder (and one script in the repo root).

### 1.1 Your protocol text (the “source of truth” for the protocol)

| File | What it is | Use it for |
|------|------------|------------|
| **IRB_Protocol.txt** | Full research protocol: purpose, objectives, background, study design, participants, procedures, data collection, storage, confidentiality, risks/benefits, consent, system description, investigators. | **HRP-503c (Protocol)** — you will **copy sections from here** into the Word template. |

**IRB_Protocol.txt sections (for pasting into HRP-503c):**

- **§1** – Purpose and Objectives (1.1 Purpose, 1.2 Objectives, 1.3 Research Questions)
- **§2** – Background and Significance (2.1 Problem, 2.2 Pulse/PulseVault, 2.3 Significance)
- **§3** – Study Design (design, setting, duration, comparison, no deception)
- **§4** – Participants (population, recruitment, eligibility, sample size)
- **§5** – Procedures (recruitment, consent, account/onboarding, naturalistic use, surveys, interviews, usage data)
- **§6** – Data Collection (6.1 Overview table, 6.2 Metrics, 6.3 Analysis Plan)
- **§7** – Data Storage, Access, and Retention
- **§8** – Confidentiality and Privacy
- **§9** – Risks and Benefits (9.1 Risks, 9.2 Benefits)
- **§10** – Consent (what the consent form will include)
- **§11** – System Description (PulseVault)
- **§12** – Investigator and Oversight (PI, advisor, institution, IRB)

**Note:** IRB_Protocol.txt still says “Principal Investigator: Priyam More” at the top; for IRB submission the **PI is Adolfo Coronado** and **Student Investigator is Priyam More**. You’ll fix that when you fill the Word template (see Part 3).

---

### 1.2 Your consent / information sheet text (participant-facing)

| File | What it is | Use it for |
|------|------------|------------|
| **Consent_Form.txt** | Full participant-facing consent/information sheet: intro, purpose, what they’ll do, risks, benefits, confidentiality, voluntary/withdrawal, contacts, consent statement. | **HRP-502b (Information Sheet)** — you will use this **plus** the fill-in guide to replace placeholders in the Word template. |

**Consent_Form.txt has the same structure as HRP-502b:** Introduction and Purpose, What Will I Do, Risks, Benefits, Confidentiality, Voluntary Participation and Withdrawal, Contacts, Consent. The Word template (HRP-502b) has **placeholders** like `[insert Title...]` and `[DESCRIBE RESEARCH PURPOSE]`; we’ve already written the exact text for each of those in the fill-in guide.

---

### 1.3 The fill-in guide (ready-to-paste text for placeholders)

| File | What it is | Use it for |
|------|------------|------------|
| **IRB_fill_in_guide.md** | Generated from `fill_irb_from_thesis.py`. For each placeholder in HRP-502b it says “Replace [X] **With:** [exact text].” Also has a short section mapping for HRP-503c. | **HRP-502b** — open this next to Word and **replace each placeholder** with the “With” text. **HRP-503c** — use the section list to know which IRB_Protocol.txt section goes where. |

**To regenerate the guide after editing the script:**  
`python3 thesis-docs/fill_irb_from_thesis.py`

---

### 1.4 The script that generates the fill-in guide

| File | What it is | Use it for |
|------|------------|------------|
| **fill_irb_from_thesis.py** | Python script that holds: study title, PI/advisor names and emails, purpose, why asked, what asked, time, benefits, payment, retention, contact text, consent agreement. It **outputs** IRB_fill_in_guide.md. | Edit this if you change PI/advisor, emails, or any of the short “replace with” texts; then run the script to refresh IRB_fill_in_guide.md. |

---

### 1.5 Parsed template text (optional reference)

| File | What it is | Use it for |
|------|------------|------------|
| **IRB_parsed_output.txt** | Output of `parse_irb_docs.py`: full text extracted from HRP-502b (.doc) and HRP-503c (.docx). | Optional: see every line of the Word templates in plain text (all placeholders and instructions). |

---

## Part 2: What the IRB templates ARE (what you will be adding TO)

You download these from **Apollo IRB Library** and fill them in **Word**.

### 2.1 HRP-502b – Exempt Research Information Sheet (.doc)

- **What it is:** Purdue’s **participant information sheet** template for exempt studies. Participants read this (and optionally check a box) instead of signing a long consent form.
- **What’s in it:**  
  - Title line with placeholders: `[insert Title of project...]`, `[insert Principal Investigator's name]`, `[insert Academic Department]`, `[insert IRB protocol number]`.  
  - Standard paragraphs about voluntary participation, purpose, why asked, what they’ll do, time, risks, benefits, payment, confidentiality, rights, contacts, and an agreement checkbox.  
  - Many of these paragraphs contain **placeholders** like `[DESCRIBE RESEARCH PURPOSE]`, `[STATE THE BASIS WHY...]`, `[TIME in minutes/hours]`, etc.
- **What you do:** Open HRP-502b in Word. For **each** placeholder, **replace** it with the exact text from **IRB_fill_in_guide.md** (the “With” blocks). Delete any “INSTRUCTIONS FOR RESEARCHERS” paragraph before submitting. Do **not** change Purdue’s standard black text (e.g. “You do not have to participate…”); only replace the bracketed placeholders and red instructions.

---

### 2.2 HRP-503c – Protocol for Exempt Research (.docx)

- **What it is:** Purdue’s **protocol** template for exempt studies. It’s the formal description of the study that IRB reviews.
- **What’s in it:**  
  - **Table at top:** Study title, Principal Investigator / Faculty Advisor (name, department, phone, email), Student Investigator (name, status, department, phone, email).  
  - **Exempt Justification:** Which exempt category (e.g. Category 2) and how the study fits.  
  - **Numbered sections:** Objectives (2.1), Study Design & Procedures (3.1, 3.2, 3.4, 3.5), Participant Population (4.1–4.8), Incentives (5.1), Informed Consent Process (6.1), Privacy (7), Confidentiality and Management (8), Educational Records (9), Bibliography (10).  
  - Each section has **prompts** (e.g. “Describe the purpose of the study”) and sometimes **red instruction text** you must delete and replace with your own black text.
- **What you do:** Open HRP-503c in Word. For **each** section, **paste or adapt** content from **IRB_Protocol.txt** as indicated in **IRB_fill_in_guide.md**. Fill the **table** with: Study title (from fill-in guide), PI = Adolfo Coronado, Faculty Advisor = Romael Haque, Student Investigator = Priyam More, departments, PFW, emails. Remove or replace all red instruction text; keep Purdue’s standard black wording where it says not to change it.

---

## Part 3: What you will be ADDING (section-by-section)

### HRP-502b (Information Sheet) – Replace in Word

| # | In the Word doc (HRP-502b) | You replace / add |
|---|----------------------------|--------------------|
| 1 | `[insert Title of project - consent form title should match application title]` | **Adoption and Effectiveness of PulseVault for Institutional Knowledge Sharing: A Longitudinal User Study with Employees at Participating Organizations** (from IRB_fill_in_guide.md) |
| 2 | `[insert Principal Investigator's name]` | **Adolfo Coronado** |
| 3 | `[insert Academic Department]` | **Department of Computer Science** (or your department) |
| 4 | `[insert IRB protocol number]` | Leave blank until IRB assigns; then add. |
| 5 | `[DESCRIBE RESEARCH PURPOSE]` | **how employees at participating organizations use PulseVault — a video-based knowledge-sharing platform — and how it compares to text-based documentation. The study team will approach different organizations to implement this study. The purpose is to understand adoption, usability, and whether video documentation is helpful in your workflow.** |
| 6 | `[STATE THE BASIS WHY THE PERSON IS ASKED TO PARTICIPATE...]` | **The study team will approach different organizations to participate. If your organization agrees to participate, you are being asked because you are an employee who may use PulseVault for work-related knowledge sharing. Recruitment within each organization is internal (e.g., in coordination with organizational leadership); participation is voluntary.** |
| 7 | `[take a survey, participate in an interview...] about [insert topic...]` | **participate in naturalistic use of PulseVault (upload, view, share short videos for work), complete up to three short online surveys (baseline, midpoint, end of study) about your role, PulseVault usability and satisfaction, and video vs. text documentation, and optionally participate in a one-on-one interview (about 30–60 minutes) to discuss your experience.** |
| 8 | `[TIME in minutes/hours]` | **Surveys: about 5–15 minutes each (three surveys total). Optional interview: 30–60 minutes. Naturalistic use: at least one month with no minimum usage required.** |
| 9 | `[insert research topic]` (benefits paragraph) | **video-based knowledge sharing and adoption of PulseVault in organizational settings** |
| 10 | Payment paragraph | **You will not be paid for being in this research study.** (or keep template’s “You will not be paid…” if already there) |
| 11 | `[state anticipated time to completion in years or months]` | **approximately one year after the study ends (and for at least three years after we are finished, per Purdue policy)** |
| 12 | `(insert PI name and phone number plus any additional research personnel...)` | **Principal Investigator: Adolfo Coronado — acoronad@pfw.edu. Faculty Advisor: Romael Haque — mdromael.haque@pfw.edu. Faculty Advisor (committee): J. Johns — jdjohns@pfw.edu. First point of contact: PI or Faculty Advisor.** (Add phone numbers if the template or IRB asks for them.) |
| 13 | Checkbox / agreement statement | **By clicking/checking this box, I agree to take part in this research. I am 18 years of age or older and understand the information above about my participation.** |
| 14 | **Delete** before submitting | The paragraph that says “INSTRUCTIONS FOR RESEARCHERS: Please provide...” (and any other “delete before finalizing” text). |

All of the “You replace / add” text above is already in **IRB_fill_in_guide.md** under “Replace … With.” So in practice you: open HRP-502b in Word, open IRB_fill_in_guide.md, and for each “Replace” in the guide, find that placeholder in Word and replace it with the “With” text.

---

### HRP-503c (Protocol) – Paste from IRB_Protocol.txt into Word

| HRP-503c section | What to put there | Source (IRB_Protocol.txt) |
|------------------|-------------------|---------------------------|
| **Table (top)** | Study title (same as 502b). Principal Investigator: **Adolfo Coronado** (name, department, phone, email). Faculty Advisor: **Romael Haque** (mdromael.haque@pfw.edu). Student Investigator: **Priyam More** (Master’s student, department, email). Institution: Purdue University Fort Wayne. | Fill-in guide + your dept/phone. |
| **Exempt Justification** | State that the study fits **Category 2** (survey procedures, observation of public behavior; minimal risk). Describe: surveys, optional interviews, usage data; no sensitive topics; data recorded with optional linkage; limited IRB review if identifiable. | Write short paragraph; can adapt from IRB_Protocol §1, §5, §6. |
| **Objectives (2.1)** | Purpose, research questions, objectives. | **§1** (1.1 Purpose, 1.2 Objectives, 1.3 Research Questions) |
| **Study Design & Procedures (3.1, 3.2, 3.4, 3.5)** | Research design, procedures, data collection, timeline. | **§3** (Study Design), **§5** (Procedures), **§6** (Data Collection, 6.1 table and 6.2/6.3 as needed) |
| **Participant Population (4.1–4.8)** | Who (employees at participating organizations), how many (~5–25), how identified/recruited (study team approaches organizations; within each org, internal recruitment), eligibility, privacy of recruitment. | **§4** (Participants) |
| **Incentives (5.1)** | No payment. Write “N/A” or “No incentives.” | — |
| **Informed Consent Process (6.1)** | When/where consent is obtained; that it’s before any procedures; electronic or paper per IRB. | **§10** (Consent) |
| **Privacy (7)** | How you protect privacy (e.g. recruitment, who has access). | **§8** (Confidentiality and Privacy) |
| **Confidentiality and Management (8)** | How data are stored, who has access, retention, de-identification. | **§6.3** (Analysis Plan – reporting), **§7** (Data Storage, Access, and Retention), **§8** |
| **Educational Records (9)** | **N/A** (no educational records). | — |
| **Bibliography (10)** | Key references if required; otherwise “N/A” or “See thesis bibliography.” | — |

When you paste from IRB_Protocol.txt, you may need to **shorten or adapt** a few sentences so they fit the template’s prompts (e.g. “Describe the purpose…” → paste the purpose paragraph). The **content** should match IRB_Protocol.txt so the protocol and the information sheet (502b) are consistent.

---

## Part 4: Consistency and roles (important)

- **Principal Investigator (PI):** **Adolfo Coronado** (acoronad@pfw.edu) — your professor.  
- **Faculty Advisor:** **Romael Haque** (mdromael.haque@pfw.edu).  
- **Additional faculty advisor (committee):** **J. Johns** (jdjohns@pfw.edu).  
- **Student Investigator:** **Priyam More** — you.

**IRB_Protocol.txt** and **Consent_Form.txt** still say “Principal Investigator: Priyam More” in a couple of places; that was from an earlier version. In the **Word documents** you submit to IRB, use the roles above: PI = Adolfo Coronado, Student Investigator = Priyam More. The **IRB_fill_in_guide.md** and this map already use the correct roles.

---

## Part 5: After IRB approval

- Add the **IRB approval number** (and date if required) to **HRP-502b** where you left the placeholder.
- Use only the **approved** HRP-502b and HRP-503c (and any approved recruitment materials) for the study.
- Keep a copy of the approved protocol and information sheet for your thesis appendix and records.

---

## Quick reference

| You have (content) | You add it to (template) |
|--------------------|---------------------------|
| IRB_Protocol.txt (§1–§12) | HRP-503c (Protocol) – paste into each section as in the table above. |
| Consent_Form.txt + IRB_fill_in_guide.md | HRP-502b (Information Sheet) – replace each placeholder with the “With” text from the guide. |
| fill_irb_from_thesis.py | Edit to change PI/advisor/emails or any “replace with” text; run script to regenerate IRB_fill_in_guide.md. |

If you want, next step can be: open HRP-502b in Word and go through it line by line with IRB_fill_in_guide.md, then do the same for HRP-503c with IRB_Protocol.txt and this map.
