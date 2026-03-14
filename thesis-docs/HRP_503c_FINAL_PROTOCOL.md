# HRP-503c EXEMPT STUDY PROTOCOL — Final (paste into Word)

**Instructions:** Copy each section below into the corresponding place in your HRP-503c Word template. Keep all Purdue standard language (black font and gold instruction boxes) unchanged. Delete any red instruction text and replace with the black text below. Do not convert to PDF for submission.

---

## Study Title

**Adoption and Effectiveness of Pulse Vault for Institutional Knowledge Sharing: A Longitudinal User Study with Employees at Participating Organizations**

---

## Principal Investigator / Faculty Advisor

| Field | Content |
|-------|---------|
| Name | Adolfo Coronado |
| Department | Department of Computer Science |
| Telephone Number | 260-481-6181 |
| Institutional Email Address | acoronad@pfw.edu |

---

## Student Investigator (if applicable)

| Field | Content |
|-------|---------|
| Name | Priyam More |
| Current Academic Status | Master's student |
| Department | Department of Computer Science |
| Telephone Number | 260-449-1394 |
| Institutional Email Address | morepr01@pfw.edu |

*All other Study Personnel will be added in the PERA SmartForm.*

---

## Exempt Categories (check in template)

**Select only:** **(2)** — Research that only includes interactions involving educational tests, survey procedures, interview procedures, or observation of public behavior (including visual or auditory recording), with the criteria met as described in 1.1 below.

**Participant population (Section 4.1):** Check **Adults** and **Employees**.

**Educational Records (Section 9.1):** Check **No**.

---

## 1. Exempt Justification (1.1)

Describe how the proposed research meets the criteria for exemption. Reference the exempt research table and address the category you selected.

**Text to insert:**

This study fits Category 2. It involves survey procedures (baseline, midpoint, and end-of-study surveys), optional interview procedures, and observation of public behavior (naturalistic use of Pulse Vault and usage data). The information obtained is recorded with optional linkage to identifiers; disclosure would not reasonably place subjects at risk of criminal or civil liability or be damaging to subjects' financial standing, employability, educational advancement, or reputation. The study is minimal risk. If identifiers are retained, limited IRB review applies per §46.111(a)(7).

---

## 2. Objectives (2.1)

Describe the purpose of the study.

**Text to insert:**

This study evaluates the adoption and effectiveness of Pulse Vault—a video-based knowledge-sharing platform—when used by employees at participating organizations in their normal work context. The study team will approach different organizations to implement the study; organizations that agree to participate will have their employees invited. The work is conducted as part of a Master's thesis at Purdue University Fort Wayne and is designed to generate ecologically valid evidence on how institutional users adopt video-first knowledge-sharing tools and how short-form video documentation compares to traditional text-based documentation in an organizational setting.

**Objectives:** (1) Adoption and engagement—measure adoption (active users, time to first upload, retention, churn) and engagement (videos per user, views, watch time, sharing frequency) using server-side usage data and survey responses. (2) Usability—assess perceived usability via the System Usability Scale (SUS) and user satisfaction via Likert-scale and open-ended survey items. (3) Video vs. text documentation—where feasible, compare creation rates, usage rates, and user preference for video vs. existing text-based documentation at participating organizations. (4) Barriers and enablers—identify factors that support or hinder adoption and sustained use through periodic surveys and optional semi-structured interviews.

**Research questions:** RQ1—How does short-form video documentation compare to traditional text-based documentation in terms of knowledge retention and adoption rates? RQ3—How do institutional users adopt and interact with video-first knowledge-sharing platforms? These questions are central to the thesis; the present study provides the primary empirical basis for RQ1 and RQ3.

---

## 3. Study Design & Procedures

### 3.1 Research interactions, interventions, and activities

Provide information about all research interactions, interventions, and activities. If the research is taking place during a Purdue course, provide the course number(s).

**Text to insert:**

(1) **Recruitment:** Prospective participants receive a brief, IRB-approved study description and are directed to the informed consent process (electronic or paper, per IRB approval). (2) **Informed consent:** Consent is obtained before any study procedures, including creation of accounts used for research data. (3) **Account creation and onboarding:** After consent, participants create or use an existing Pulse Vault account (OAuth, e.g., Google/GitHub) and receive brief instructions on uploading, viewing, and sharing videos. No additional software beyond the Pulse app and/or Pulse Vault web interface is required. Participants may access Pulse Vault at https://pulse-vault.opensource.mieweb.org/ and the Pulse app via the App Store (https://apps.apple.com/app/pulse-video-recorder/id6748621024) and Google Play (https://play.google.com/store/apps/details?id=com.mieweb.pulse); the consent form and recruitment materials also provide these links. Pulse and Pulse Vault are available on GitHub (https://github.com/mieweb/pulse and https://github.com/mieweb/pulsevault). (4) **Naturalistic use:** Participants use Pulse Vault in their normal workflow (upload, view, share work-related short-form video). There are no prescribed tasks or minimum usage requirements. (5) **Surveys:** Baseline (short survey after consent: demographics/role, prior use of video for documentation); midpoint (~2 weeks): SUS and satisfaction items, optional open-ended feedback; end of study (~1 month or later): SUS, satisfaction, adoption barriers, and preference for video vs. text. Surveys are administered via web or in-app form; total time per survey is estimated at 5–15 minutes. (6) **Interviews (optional):** A subset of participants may be invited to semi-structured interviews (approximately 30–60 minutes) on adoption, barriers, workflow fit, and suggestions. Separate consent for audio recording will be obtained when applicable. (7) **Usage data:** Collected automatically via the Pulse Vault backend (logins, uploads, views, sharing events, watch time when available). No additional tracking software is installed on participants' devices beyond normal use of the platform. The research is not taking place during a Purdue course; N/A for course number(s).

### 3.2 Research Design

Identify and describe the research design appropriate to answer the question(s) under study.

**Text to insert:**

Longitudinal living-labs case study with mixed methods (quantitative usage and survey data; optional qualitative interviews). The approach is informed by living-labs and naturalistic evaluation methods used in HCI and CSCW. The study team will approach different organizations to participate; at each participating organization, Pulse Vault is deployed for internal use; participants use it as part of their normal workflow for technical documentation, knowledge transfer, training, and process documentation. Duration: minimum one month of naturalistic use; extension based on engagement and organizational need. Where data allow, video-based documentation behavior and attitudes will be contrasted with participants' use of and attitudes toward existing text-based documentation at their organization. No deception or experimental manipulation; participants use Pulse Vault as they would for work; no placebo conditions or undisclosed procedures.

### 3.4 Data collection procedures

Describe procedures for data collection. Specify the source records that will be used to collect data about participants. Upload all surveys, scripts, and data collection forms/spreadsheets to the Other Attachments section of the SmartForm.

**Text to insert:**

Data collection: (1) **Usage/behavior**—server logs, database, Prometheus metrics; identifiers: user/account ID (email or internal id). (2) **Surveys**—web or in-app forms (e.g., Google Forms, in-app); optional user ID to link to usage per consent. (3) **Interviews**—audio recording (with consent), transcription; pseudonym or study ID per consent. (4) **Technical metrics**—Prometheus (upload/transcode success, latency); no direct participant identifiers. Surveys, scripts, and data collection forms will be uploaded to the Other Attachments section of the SmartForm.

### 3.5 Timeline

Describe the timeline for participant evaluations and the duration of project participation.

**Text to insert:**

Minimum one month of naturalistic use of Pulse Vault; surveys at baseline (after consent), midpoint (~2 weeks), and end of study (~1 month or later); optional interview 30–60 minutes. Total study participation: at least one month plus time for surveys (5–15 minutes each) and, if applicable, one optional interview.

---

## 4. Participant Population

### 4.2 Sample population

Describe the sample population from which the study team plans to either recruit or access private, identifiable information.

**Text to insert:**

Employees at participating organizations, including developers, support staff, and other knowledge workers who may create or consume procedural documentation. The study team will approach different organizations to implement the study; each organization may agree to participate and have its employees invited. No student pools.

### 4.3 Number of participants

- **Number of participants to be enrolled locally by Purdue researchers:** 5–25  
- **Total number of participants to be enrolled across all sites (for studies at other sites):** 5–25  

### 4.4 How this number was derived

**Text to insert:**

Determined by the number of participating organizations and willingness of employees to participate. The study is designed to support descriptive and time-series analysis of adoption and engagement; a target of approximately 5–25 active users across participating organizations is anticipated, with 4–6 optional interviewees for qualitative depth. No minimum sample size is required for thesis feasibility; findings will be reported with appropriate caveats if the sample is small.

### 4.5 Participant identification

Describe how potential participants will be identified. Explain how the investigator(s) will gain access to this population.

**Text to insert:**

Potential participants will be identified through participating organizations. The study team approaches organizations to participate; within each organization, employees who may use Pulse Vault for work-related knowledge sharing are the target population. Access is gained through organizational leadership agreement to participate and internal recruitment (e.g., email, team announcements).

### 4.6 Screening and eligibility

Describe how potential participants will be screened or otherwise determined to be eligible.

**Text to insert:**

Eligibility: employees at a participating organization who are permitted by their employer to use Pulse Vault for work-related knowledge sharing and who can read and understand the consent form (English). Screening is by self-selection (voluntary response to recruitment) and confirmation of eligibility (employed at participating organization, permitted to use Pulse Vault for work).

### 4.7 Recruitment process

Describe the recruitment process, including the setting, how, when, and who will recruit. Identify general strategies for recruitment and retention.

**Text to insert:**

The study team approaches organizations to participate. Within each participating organization, recruitment is internal (e.g., email, team announcements) by or in coordination with organizational leadership. Recruitment setting: within each participating organization (workplace). How: study team or organizational leadership distributes IRB-approved study description and link to consent/information sheet. When: after IRB approval and after each organization agrees to participate. Who: Principal Investigator, Student Investigator, or designee in coordination with organizational leadership. Strategy: internal recruitment within participating organizations is appropriate for reaching employees who use or may use Pulse Vault for work-related knowledge sharing. Recruitment materials will be uploaded to the documents page of the PERA SmartForm and will not be used until IRB approval is received.

### 4.8 Privacy of recruitment

Explain how the recruitment process respects potential participants' privacy.

**Text to insert:**

Recruitment is internal within participating organizations; there is no direct access to identifiable information prior to voluntary expression of interest. Only study team members and, as needed, organizational leadership (for internal announcements) are involved in recruitment. The number of study team members who access identifiable information is limited to the study team (PI, Faculty Advisor, Student Investigator). Recruitment respects potential participants' privacy by not accessing educational records or identifiable information before individuals voluntarily respond.

---

## 5. Incentives to Participate (5.1)

Describe any compensation or other incentives.

**Text to insert:**

No compensation or other incentives. N/A.

---

## 6. Informed Consent Process

### 6.1 Consent process

Describe when and where consent will be obtained and how participants will have sufficient opportunity to consider participation.

**Text to insert:**

Consent is obtained before any study procedures, including creation of accounts used for research data. Consent will be obtained electronically or on paper, as approved by the IRB. Participants are provided with the information sheet (HRP-502b), which covers purpose, procedures, risks, benefits, confidentiality, voluntary participation, withdrawal, and contact information for the PI and IRB. Participants indicate agreement by checking a box (electronic) or signing (paper). Consent is obtained in a setting that allows sufficient time to read and consider participation (e.g., via link to information sheet before account creation, or in person/by video if preferred). A copy of the consent form will be provided to the participant.

### 6.2 Deception

If deception is being used, describe debriefing. Otherwise state N/A.

**Text to insert:**

N/A. No deception is used in this study.

---

## 7. Privacy of Participants (7.1)

Describe the steps that will be taken to protect participants' privacy and make them feel at ease.

**Text to insert:**

Participation is not disclosed to other employees except as needed for recruitment (e.g., awareness by organizational leadership that the study is being conducted). Survey and interview responses are treated as confidential. Only the study team (PI, Faculty Advisor, Student Investigator) will have access to identifiable information. Interviews, if conducted, will be in a private setting (e.g., closed room or private video call) where others cannot hear. The number of study personnel who access private information is limited to the study team. Participants are informed in the information sheet that they may skip questions or withdraw at any time.

---

## 8. Confidentiality and Management of Study Materials

### 8.1 Steps to secure study data

Describe the steps that will be taken to secure study data.

**Text to insert:**

Data are stored on PFW and/or systems used for the study (e.g., hosted by participating organizations or PFW). Access is restricted to the study team (PI, Faculty Advisor, Student Investigator). Survey data may be collected via institutional or third-party tools (e.g., Google Forms) in compliance with IRB and institutional data policies. Pulse Vault uses OAuth, access control, and audit logging. Methods for handling and storing data comply with university policies. Authorization of access: only study team. Password protection and access control are used for Pulse Vault and any survey/data storage. No clinical or HIPAA-covered data are collected; authentication and access control are appropriate for internal organizational use. Identifiers and data may be separated during analysis where feasible; consent form discloses any linkage of survey to usage data.

### 8.2 Identifiable data at end of study

If identifiable data will be collected, indicate what will happen at the end of the study. If deidentified, describe the process.

**Text to insert:**

Identifiable data will be deidentified at the end of the study unless a compelling reason to maintain linked identifiers exists (e.g., follow-up per IRB approval). Process: remove or code identifiers; retain only aggregated or de-identified data for thesis and publications. Transcripts of audio recordings will be de-identified (e.g., remove names, identifying details); transcripts will be made by the study team or a transcription service under confidentiality agreement; recordings will be deleted or de-identified per IRB policy after analysis. Research-related records will be retained for at least three years after the research has been discontinued, per university policy.

### 8.3 Data shared broadly / Open Science

If data or biospecimens will be shared broadly with outside groups or Open Science, describe those procedures.

**Text to insert:**

N/A. Data will not be shared broadly with outside groups or Open Science.

---

## 9. Educational Records

### 9.1

**No.** We are not accessing or collecting information that is part of students' educational records.

### 9.2

**Text to insert:**

N/A. No educational records are accessed or collected.

---

## 10. Bibliography

**Text to insert:**

Brooke, J. (1996). SUS: A quick and dirty usability scale. *Usability Evaluation in Industry*, *189*(194), 4–7.

Følstad, A. (2008). Living labs for innovation and development of information and communication technology: A literature review. *The Electronic Journal for Virtual Organizations and Networks*, *10*, 99–131.

---

## Final checklist before submission

- [ ] Table at top: Study title, PI (Adolfo Coronado), Faculty Advisor, Student Investigator (Priyam More), departments, phone numbers, emails.
- [ ] Category (2) checked; Adults and Employees checked in 4.1; 9.1 No checked.
- [ ] All red instruction text deleted and replaced with black text above (or N/A where indicated).
- [ ] Save as Word document; do not convert to PDF if template instructs otherwise.
- [ ] Upload this document and the Information Sheet (HRP-502b) to the PERA SmartForm as Word documents.
