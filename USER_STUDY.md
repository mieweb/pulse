# User Study Plan: PulseVault Adoption and Effectiveness

## Study Overview

**Platform**: PulseVault (https://pulse-vault.opensource.mieweb.org/)  
**Status**: Deployed and operational  
**Study Type**: Longitudinal institutional adoption and effectiveness study  
**Duration**: Minimum 1 month, extended based on user engagement and usage patterns  
**Institutional Partner**: Medical Informatics Engineering, Inc. (MIE)  
**Context**: Internal user study at MIE to evaluate PulseVault for institutional knowledge sharing

## Research Questions

This user study addresses the following research questions from the thesis:

- **RQ1**: How does short-form video documentation compare to traditional text-based documentation in terms of knowledge retention and adoption rates?
- **RQ3**: How do institutional users adopt and interact with video-first knowledge sharing platforms?

## Deployment Status

- ✅ **PulseVault Deployed**: https://pulse-vault.opensource.mieweb.org/
- ✅ **Video Upload**: Functional with resumable uploads (tus protocol)
- ✅ **Video Sharing**: UUID-based sharing links for authenticated users
- ✅ **Access Control**: Only logged-in users can view videos (OAuth authentication)
- ✅ **Transcoding**: Automatic HLS/DASH transcoding with multiple quality renditions
- ✅ **Security**: Basic authentication and access control (sufficient for internal study)

**Note on Security**: For this internal MIE study, basic authentication and access control are sufficient. Full production-grade security (HIPAA compliance, encryption at rest, complex RBAC) is not required for the study period. Security architecture will be documented conceptually in the dissertation for RQ4, with production security considerations discussed as future work.

## Planned Metrics

### Technical Metrics (Already Implemented)

The following metrics are currently tracked via Prometheus:

- `pulsevault_uploads_total` - Total uploads by status
- `pulsevault_upload_size_bytes` - Upload size distribution
- `pulsevault_transcodes_total` - Transcoding jobs by status
- `pulsevault_transcode_duration_seconds` - Transcoding performance
- `pulsevault_queue_length` - Queue depth
- `pulsevault_media_requests_total` - Media access patterns
- `http_request_duration_seconds` - API performance

### User Study Metrics (Based on Research Papers)

**See [METHODOLOGY_AND_METRICS.md](./METHODOLOGY_AND_METRICS.md) for detailed methodology and metric definitions based on 21 research papers.**

#### 1. Adoption Metrics (RQ3 - Papers 3, 10-12, 16-18, 19)
- [x] **Active Users**: Number of users who upload/view videos
- [x] **User Retention**: Users who return after first use
- [x] **Time to First Upload**: Time from signup to first video upload
- [x] **Adoption Rate**: Percentage of eligible users who adopt the platform
- [x] **Churn Rate**: Users who stop using the platform
- [x] **Videos Created per User**: Average number of videos created

#### 2. Engagement Metrics (RQ3 - Papers 10-12, 19)
- [x] **Videos Viewed per User**: Average number of videos viewed
- [x] **Watch Time**: Average duration of video viewing
- [x] **Completion Rate**: Percentage of videos watched to completion
- [x] **Sharing Frequency**: How often users share videos via UUID links
- [x] **Content Discovery**: How users find and access videos
- [x] **Usage Frequency**: How often platform is used in daily workflow

#### 3. Usability Metrics (RQ2, RQ3 - Paper 19: Mobile UX Systematic Review)
- [x] **System Usability Scale (SUS)**: Standardized usability score (0-100)
- [x] **Task Completion Rate**: Percentage of tasks completed successfully
- [x] **Task Completion Time**: Time to complete specific tasks (upload, view, share)
- [x] **Error Frequency**: Number of errors per task
- [x] **Learnability**: Improvement in task completion time over repeated use
- [x] **User Satisfaction**: Satisfaction scores (Likert scale 1-5 or 1-7)
- [x] **Upload Success Rate**: Percentage of successful uploads

#### 4. Knowledge Sharing Effectiveness (RQ1 - Papers 7-9)
- [x] **Documentation Creation Rate**: Videos created vs. text docs created
- [x] **Documentation Usage Rate**: Videos viewed vs. text docs accessed
- [x] **Preference Scores**: User preference for video vs. text (Likert scale)
- [x] **Task Completion Time**: Time to complete tasks using video vs. text docs
- [x] **Error Rate**: Errors made following video vs. text instructions
- [x] **First-Time Success Rate**: Success rate on first attempt
- [x] **Support Ticket Reduction**: Reduction in support requests when using video docs
- [x] **Content Reuse**: How often video vs. text documentation is referenced
- [ ] **Knowledge Retention** (if applicable): Pre-test/post-test scores

#### 5. Security and Compliance (RQ4 - Papers 1, 13-15)
**Note**: For the study, security metrics are simplified. Full production security is not required.

- [x] **Access Control**: Basic OAuth authentication working
- [x] **Authentication Success Rate**: Successful logins vs. failed attempts (if tracked)
- [x] **Audit Log Completeness**: Basic event logging (uploads, views)
- [ ] **Production Security Metrics** (not required for study):
  - Full HIPAA compliance verification
  - Encryption at rest validation
  - Complex RBAC effectiveness
  - Advanced threat detection

**For Dissertation**: Security architecture will be documented conceptually, discussing:
- Current security measures (OAuth, basic access control)
- Security considerations for institutional deployment
- Production security requirements (future work)
- How security architecture addresses RQ4

#### 6. EDL Architecture Impact (RQ5 - Papers 5, 20)
- [x] **Editing Time**: Time to create/edit videos using EDL system
- [x] **Undo/Redo Usage**: Frequency of undo/redo operations
- [x] **Draft Management**: How often drafts are saved/resumed
- [x] **Content Creation Efficiency**: Videos created per hour of editing time
- [x] **Editing Satisfaction**: User satisfaction with editing workflow

## Methodology

### Study Design
- **Type**: **Living Labs Case Study** (based on Paper 3 - CHI 2020) + Mixed Methods
- **Setting**: Internal deployment at Medical Informatics Engineering, Inc. (MIE)
- **Approach**: Mixed methods (quantitative metrics + qualitative feedback)
- **Duration**: Naturalistic observation - study continues as long as users actively engage with the platform
- **Comparison**: Video-based documentation vs. existing text-based documentation methods at MIE
- **Methodology Framework**: Based on systematic review of mobile UX (Paper 19) and CSCW adoption studies (Papers 16-18)
- **Focus Areas**:
  - Adoption patterns and barriers (RQ3)
  - Usability and user satisfaction (RQ2, RQ3)
  - Knowledge sharing effectiveness (RQ1)
  - Impact on organizational workflows (RQ3)
  - Long-term engagement and retention (RQ3)
  - EDL architecture impact (RQ5)
  
**See [METHODOLOGY_AND_METRICS.md](./METHODOLOGY_AND_METRICS.md) for detailed methodology options and analysis methods.**

### Participants
- **Target**: MIE employees (developers, support staff, knowledge workers)
- **Institutional Context**: Internal deployment at Medical Informatics Engineering, Inc.
- **Sample Size**: [To be determined based on MIE team size]
- **Recruitment**: Internal recruitment within MIE organization
- **Use Cases**: 
  - Technical documentation and procedures
  - Knowledge transfer between team members
  - Training materials and onboarding
  - Process documentation

### Data Collection
- **Period**: Minimum 1 month, extended based on user engagement and usage patterns
- **Duration**: Longitudinal study - data collection continues as long as users actively use the platform
- **Location**: MIE internal deployment
- **Approach**: Naturalistic observation - users use PulseVault as part of their regular workflow
- **Tools**: 
  - Prometheus metrics (technical performance)
  - PulseVault audit logs (access patterns, uploads, views)
  - User surveys (satisfaction, usability, adoption barriers) - baseline and periodic check-ins
  - Usage analytics (video creation, sharing, viewing patterns)
  - Optional: Interviews with key users for qualitative insights

### Analysis Plan

**Quantitative Analysis**:
- Descriptive statistics (means, medians, standard deviations)
- Comparative analysis: Video vs. text documentation (t-tests, ANOVA)
- Time series analysis: Adoption trends over time
- Correlation analysis: Relationships between metrics

**Qualitative Analysis**:
- Thematic analysis: Identify themes in interviews and open-ended responses
- Content analysis: Analyze user feedback for patterns
- Case study analysis: Deep dive into specific use cases

**Mixed Methods Integration**:
- Triangulation: Compare quantitative and qualitative findings
- Explanatory sequential: Use qualitative data to explain quantitative results
- Convergent design: Compare findings from both methods

**See [METHODOLOGY_AND_METRICS.md](./METHODOLOGY_AND_METRICS.md) for detailed analysis methods.**

## Implementation Notes

### Current Capabilities
- Videos can be uploaded and shared via UUID links
- Only authenticated users can view videos (OAuth via Google/GitHub)
- Platform is accessible at https://pulse-vault.opensource.mieweb.org/
- Basic security: OAuth authentication, access control, audit logging
- **Study Focus**: Data collection and user adoption metrics
- **Security Note**: Basic authentication sufficient for internal study; production security documented conceptually in dissertation

### Metrics Collection Setup
- Prometheus metrics endpoint: `/metrics`
- Audit logs available for access tracking
- User authentication via OAuth (Google/GitHub) - can track user IDs
- Video metadata includes upload timestamps, user IDs, and access patterns
- [Additional data collection methods to be added as needed]

### MIE-Specific Considerations
- Internal deployment allows for controlled study environment
- Access to real institutional workflows and use cases
- Opportunity to compare video documentation vs. existing text-based documentation at MIE
- Can measure impact on ticket resolution time, knowledge adoption, and collaboration efficiency (as mentioned in research objectives)

## Timeline

- [ ] Study design finalization
- [ ] Metrics implementation
- [ ] Participant recruitment (MIE employees)
- [ ] **Data collection period: Minimum 1 month** (extended based on usage)
  - Continuous monitoring of platform usage
  - Periodic user surveys/check-ins
  - Naturalistic observation of adoption patterns
- [ ] Data analysis (after minimum 1-month period)
- [ ] Results documentation
- [ ] Optional: Extended data collection if users continue active usage

## Expected Outcomes

### For RQ1 (Video vs. Text Documentation)
- Quantitative comparison of knowledge retention between video and text documentation at MIE
- Adoption rates of video-first documentation vs. traditional methods
- Time-to-resolution metrics for tickets/issues using video vs. text documentation

### For RQ3 (User Adoption and Interaction)
- User adoption patterns within MIE organization
- Factors influencing adoption (usability, workflow integration, perceived value)
- Engagement metrics (video creation frequency, viewing patterns, sharing behavior)
- Barriers to adoption and strategies to overcome them

### Institutional Impact
- Assessment of PulseVault's effectiveness for MIE's knowledge management needs
- Identification of best practices for institutional video-based knowledge sharing
- Recommendations for scaling to additional teams or departments

## What the Dissertation Will Contain

### Chapter Structure (7 Chapters, ~100-120 pages)

**Chapter 1: Introduction** (10-12 pages)
- Problem: Institutional knowledge management challenges
- Solution: Pulse platform for video-based knowledge sharing
- Research Questions (all 5 RQs)
- Contributions overview
- Thesis structure

**Chapter 2: Related Work** (18-22 pages)
- Knowledge Management & Video Sharing (Papers 2, 7-9)
- CSCW & Collaboration (Papers 16-18)
- Mobile UX & Adoption (Papers 3, 19, 21)
- Video Processing & Editing (Papers 4-5, 20)
- Security & Compliance (Papers 1, 13-15)
- Short-Form Video Platforms (Papers 10-12)
- Research Gaps & Your Contribution

**Chapter 3: System Design & Implementation** (20-25 pages)
- System Overview
- Cross-Platform Video Processing (RQ2) - iOS/Android implementation
- **EDL-Based Editing Architecture (RQ5)** ⭐ YOUR MAIN CONTRIBUTION
- PulseVault Backend
- Security & Compliance Architecture (RQ4) - Conceptual design and considerations

**Chapter 4: Methodology** (8-10 pages)
- Living Labs Approach at MIE
- Data Collection Methods (quantitative + qualitative)
- Metrics Framework (adoption, engagement, usability, etc.)
- Analysis Plan

**Chapter 5: Results** (20-25 pages)
- Technical Performance (RQ2)
- EDL Architecture Evaluation (RQ5)
- User Adoption & Engagement (RQ3) - From MIE study
- Usability Evaluation (RQ2, RQ3) - SUS scores, task completion
- Knowledge Sharing Effectiveness (RQ1) - If data available
- Security & Compliance Discussion (RQ4) - Architecture and considerations

**Chapter 6: Discussion** (15-18 pages)
- Addressing each research question
- Interpreting findings
- Comparing to related work
- Implications for knowledge management
- Limitations
- Future work

**Chapter 7: Conclusion** (5-8 pages)
- Summary of contributions
- Key findings
- Future work
- Final thoughts

### Key Contributions

1. **EDL-Based Editing Architecture** (RQ5)
   - Non-destructive editing system for mobile
   - Undo/redo with persistent storage
   - Draft management and cross-device transfer
   - **This is your main technical contribution**

2. **Cross-Platform Video Processing** (RQ2)
   - iOS AVFoundation implementation
   - Android Media3 implementation
   - Performance comparison

3. **Living Labs Case Study** (RQ1, RQ3)
   - Real-world deployment at MIE
   - User adoption patterns
   - Engagement metrics
   - Usability evaluation

4. **Security Architecture** (RQ4)
   - Conceptual design for institutional deployment
   - Security considerations and requirements
   - Production deployment guidelines

### Data Sources for Dissertation

**Quantitative Data**:
- User adoption metrics (from admin dashboard)
- Video upload/view metrics
- SUS usability scores (from surveys)
- Technical performance metrics (Prometheus)

**Qualitative Data**:
- User interviews (4-6 interviews, 30-60 min each)
- Survey open-ended responses
- Observational notes

**Technical Documentation**:
- System architecture (existing docs)
- EDL implementation details (your codebase)
- Security architecture (conceptual design)

### What You DON'T Need for Dissertation

- ❌ Full production HIPAA compliance implementation
- ❌ Complex RBAC system
- ❌ Encryption at rest (can discuss conceptually)
- ❌ Advanced threat detection
- ❌ Production-grade security audit

**For RQ4**: You can discuss security architecture, considerations, and requirements conceptually without full production implementation.

---

## References

- See `thesis.md` for full research context
- See `pulse-vault/SYSTEM_ARCHITECTURE.md` for technical implementation details
- See `THESIS_MASTER_PLAN.md` for complete build, test, and write plan
- See `papers.md` for complete list of research papers and their relevance
