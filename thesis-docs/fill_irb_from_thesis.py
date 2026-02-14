#!/usr/bin/env python3
"""
Map thesis-docs content to IRB template placeholders (HRP-502b, HRP-503c).
Run after parse_irb_docs.py. Outputs a fill-in guide for pasting into the Word docs.
"""

import os
from pathlib import Path

THESIS_DIR = Path(__file__).parent
REPO_ROOT = THESIS_DIR.parent

# --- Your thesis content (key phrases for HRP-502b and HRP-503c) ---

STUDY_TITLE = (
    "Adoption and Effectiveness of PulseVault for Institutional Knowledge Sharing: "
    "A Longitudinal User Study with Employees at Participating Organizations"
)
PI_NAME = "Adolfo Coronado"  # Principal Investigator (professor)
STUDENT_INVESTIGATOR_NAME = "Priyam More"
PI_EMAIL = "acoronad@pfw.edu"  # Adolfo Coronado (PI)
FACULTY_ADVISOR_EMAIL = "mdromael.haque@pfw.edu"  # Romael Haque (Faculty Advisor)
SECOND_FACULTY_ADVISOR = "J. Johns"  # Thesis committee – additional faculty advisor
SECOND_FACULTY_ADVISOR_EMAIL = "jdjohns@pfw.edu"
DEPARTMENT = "Department of Computer Science"  # Or your department at PFW
IRB_PROTOCOL_NUMBER = "[Leave blank until IRB assigns]"

PURPOSE_SHORT = (
    "how employees at participating organizations use PulseVault "
    "— a video-based knowledge-sharing platform — and how it compares to text-based documentation. "
    "The study team will approach different organizations to implement this study. "
    "The purpose is to understand adoption, usability, and whether video documentation is helpful in your workflow."
)
WHY_ASKED = (
    "The study team will approach different organizations to participate. "
    "If your organization agrees to participate, you are being asked because you are an employee who may use PulseVault for work-related knowledge sharing. "
    "Recruitment within each organization is internal (e.g., in coordination with organizational leadership); participation is voluntary."
)
WHAT_ASKED = (
    "participate in naturalistic use of PulseVault (upload, view, share short videos for work), "
    "complete up to three short online surveys (baseline, midpoint, end of study) about your role, "
    "PulseVault usability and satisfaction, and video vs. text documentation, and optionally "
    "participate in a one-on-one interview (about 30–60 minutes) to discuss your experience."
)
TIME_TOTAL = "Surveys: about 5–15 minutes each (three surveys total). Optional interview: 30–60 minutes. Naturalistic use: at least one month with no minimum usage required."
BENEFITS_TOPIC = "video-based knowledge sharing and adoption of PulseVault in organizational settings"
PAYMENT = "You will not be paid for being in this research study."
RETENTION = "approximately one year after the study ends (and for at least three years after we are finished, per Purdue policy)"
CONTACT_TEXT = (
    f"Principal Investigator: {PI_NAME} — {PI_EMAIL}. "
    f"Faculty Advisor: Romael Haque — {FACULTY_ADVISOR_EMAIL}. "
    f"Faculty Advisor (committee): {SECOND_FACULTY_ADVISOR} — {SECOND_FACULTY_ADVISOR_EMAIL}. "
    "First point of contact: PI or Faculty Advisor."
)
CONSENT_AGREEMENT = (
    "By clicking/checking this box, I agree to take part in this research. "
    "I am 18 years of age or older and understand the information above about my participation."
)

# --- HRP-502b fill-in guide (Exempt Information Sheet) ---

HRP_502B_FILLS = [
    ("[insert Title of project - consent form title should match application title]", STUDY_TITLE),
    ("[insert Principal Investigator's name]", PI_NAME),
    ("[insert Academic Department]", DEPARTMENT),
    ("[insert IRB protocol number]", IRB_PROTOCOL_NUMBER),
    ("[DESCRIBE RESEARCH PURPOSE]", PURPOSE_SHORT),
    (
        "[STATE THE BASIS WHY THE PERSON IS ASKED TO PARTICIPATE AND/OR HOW THEY WERE CHOSEN TO RECEIVE THE STUDY.]",
        WHY_ASKED,
    ),
    (
        "[take a survey, participate in an interview, participate in a focus group] about [insert topic of questions, especially if sensitive issues will be asked about, i.e. – alcohol/drug use, mental health, child abuse, etc.]]",
        WHAT_ASKED,
    ),
    ("[TIME in minutes/hours]", TIME_TOTAL),
    ("[insert research topic]", BENEFITS_TOPIC),
    ("You will not be paid for being in this research study.", PAYMENT),
    ("[state anticipated time to completion in years or months]", RETENTION),
    ("(insert PI name and phone number plus any additional research personnel that participants may need to contact and their contact information. If more than one person is listed, please indicate the first point of contact)", CONTACT_TEXT),
    (
        "[Insert checkbox or question to click] By [clicking/checking] this box, I agree to take part in this research. I am 18 years of age or older and understand the information above about my participation. Researcher may also insert other inclusion/exclusion criteria into this statement.",
        CONSENT_AGREEMENT,
    ),
]

# --- HRP-503c section prompts → thesis protocol section references ---

HRP_503C_GUIDE = """
## HRP-503c Protocol – Section mapping (use IRB_Protocol.txt)

- **Exempt Justification / Category:** Your study fits Category 2 (survey procedures, observation of behavior; minimal risk; identifiers optional with limited IRB review). Describe: surveys, optional interviews, usage data; no sensitive topics; data recorded with optional linkage; limited IRB review if identifiable.
- **Objectives (2.1):** Copy from IRB_Protocol.txt §1 (Purpose and Objectives) and §1.3 (Research Questions).
- **Study Design & Procedures (3.1, 3.2, 3.4, 3.5):** Copy from IRB_Protocol.txt §3 (Study Design), §5 (Procedures), §6 (Data Collection).
- **Participant Population (4.1–4.8):** Copy from IRB_Protocol.txt §4 (Participants); check Adults and Employees; number ~5–25; recruitment: study team approaches different organizations; within each participating organization, recruitment is internal.
- **Incentives (5.1):** No payment. N/A or “No incentives.”
- **Informed Consent Process (6.1):** Copy from IRB_Protocol.txt §10 (Consent); before any procedures; electronic or paper per IRB.
- **Privacy (7):** Copy from IRB_Protocol.txt §8 (Confidentiality and Privacy).
- **Confidentiality and Management (8):** Copy from IRB_Protocol.txt §6.3, §7 (Data Storage, Access, and Retention), §8.
- **Educational Records (9):** N/A (no educational records).
- **Bibliography (10):** Add key references if required; otherwise N/A or “See thesis bibliography.”
- **Table (Study Title, PI, etc.):** Title = STUDY_TITLE above; Principal Investigator = Adolfo Coronado; Faculty Advisor = Romael Haque; additional faculty advisor (committee) = J. Johns; Department = DEPARTMENT; Institution = Purdue University Fort Wayne; Student Investigator = Priyam More; Academic Status = Master’s student; Department = DEPARTMENT; Email = PI_EMAIL.
"""


def main():
    out = []
    out.append("# IRB fill-in guide (from thesis-docs)\n")
    out.append("Use this to replace placeholders in HRP-502b and HRP-503c.\n")
    out.append("---\n")

    out.append("## HRP-502b (Exempt Research Information Sheet) – Replace in Word\n")
    for placeholder, replacement in HRP_502B_FILLS:
        out.append(f"### Replace:\n`{placeholder[:80]}{'...' if len(placeholder) > 80 else ''}`\n")
        out.append("**With:**\n")
        out.append(replacement.strip() + "\n\n")

    out.append("---\n")
    out.append(HRP_503C_GUIDE)

    out.append("\n---\n## Placeholders to fix manually\n")
    out.append("- **[IRB protocol number]** – Leave blank until IRB assigns; then add to 502b and protocol.\n")
    out.append("- **PI email / phone** – Insert your Purdue Fort Wayne email and phone in 502b contact section.\n")
    out.append("- **Purdue HRPP address** – Template has 'Seng Liang Wang Hall' / '516 Northwestern Ave' (West Lafayette). If PFW uses a different address, substitute.\n")

    text = "\n".join(out)
    out_path = THESIS_DIR / "IRB_fill_in_guide.md"
    out_path.write_text(text, encoding="utf-8")
    print(f"Wrote {out_path}")
    print(text[:2000])
    print("\n... (see IRB_fill_in_guide.md for full guide)")


if __name__ == "__main__":
    main()
