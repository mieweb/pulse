# Secure Institutional Knowledge Sharing Through Short-Form Video: A Cross-Platform Mobile Application with Native Video Processing

## Abstract

This thesis presents **Pulse**, a cross-platform mobile application designed for institutional knowledge sharing through short-form video content. Pulse addresses the critical need for modern knowledge management systems by enabling organizations to capture, edit, and share institutional procedures, training materials, and expert knowledge through secure, professionally-edited video content. The platform leverages native video processing capabilities (AVFoundation on iOS, Media3 on Android) for hardware-accelerated video concatenation, implements an Edit Decision List (EDL) architecture for non-destructive editing, and integrates with PulseVault—a secure backend infrastructure for video storage, transcoding, and delivery. This research explores the impact of short-form video on institutional knowledge transfer, evaluates the technical challenges of cross-platform video processing, and assesses user adoption patterns in organizational settings.

## 1. Introduction

### 1.1 Research Context

Institutional knowledge management faces significant challenges in the modern workplace:
- **Knowledge Loss**: Critical institutional knowledge is lost when employees transition or retire
- **Training Inefficiency**: Traditional documentation methods (text, static images) fail to capture procedural nuances
- **Adoption Barriers**: Complex documentation systems often see low adoption rates
- **Security Concerns**: Institutional knowledge sharing requires enterprise-grade security and compliance

### 1.2 Pulse: A Video-First Knowledge Sharing Platform

Pulse is a React Native application that enables:
- **Segmented Video Recording**: Capture multiple clips that combine seamlessly
- **Professional Editing**: Native hardware-accelerated video processing with EDL-based editing
- **Cross-Platform Deployment**: iOS and Android support for organization-wide accessibility
- **Secure Integration**: Local-first storage with optional integration to PulseVault backend
- **Institutional Workflows**: Draft management, deep linking, and enterprise-grade security

### 1.3 Technical Architecture

**Frontend (Pulse App)**:
- React Native with Expo for cross-platform development
- Native video processing modules (AVFoundation/Media3)
- EDL-based editing system for non-destructive video composition
- Local-first storage with draft management

**Backend (PulseVault)**:
- Fastify + TypeScript server
- tus-node-server for resumable video uploads
- FFmpeg + Shaka Packager for adaptive streaming (HLS/DASH)
- Redis queue for transcoding jobs
- HIPAA-compliant architecture with encryption at rest and in transit

## 2. Research Objectives

1. **Evaluate Business Value**: Assess the impact of video-first documentation on ticket resolution time, knowledge adoption, and collaboration efficiency
2. **Design & Develop Platform**: Implement secure cross-platform mobile app with scalable backend pipeline
3. **Assess Adoption & Usability**: Conduct user studies to analyze usability, knowledge retention, and satisfaction
4. **Technical Scalability**: Investigate challenges in scaling secure video capture, editing, and delivery for organizational use

## 3. Related Work: Research Papers

This section reviews relevant research across multiple domains that inform Pulse's design, implementation, and evaluation. Papers are organized by research theme and their relationship to Pulse's research questions.

### 3.1 Knowledge Management and Institutional Video Sharing

Research on institutional knowledge management and video-based knowledge sharing provides the theoretical foundation for Pulse's approach. Studies demonstrate the effectiveness of video for knowledge transfer in organizational contexts [Papers 7-9], with mobile technology reshaping knowledge management practices in educational and institutional settings [Paper 7]. Cloud-based video platforms have been shown to integrate knowledge sharing into training workflows [Paper 8], while video-based learning demonstrates effectiveness in promoting knowledge and readiness for specific practices [Paper 9]. The foundational work on video issues in knowledge management [Paper 2] establishes the theoretical basis for video-first knowledge sharing approaches.

**Key Papers:**
- **Herschel & Yermish** (Book Chapter): "Video Issues for Knowledge Management" - Establishes the role of video in knowledge management systems (RQ1)
- **Eka et al.** (2025): "Impact of Mobile Technology Use on Knowledge Management in the Education Sector" - Examines mobile technology reshaping knowledge management in institutions (RQ1, RQ3)
- **Cloud-Based Video Platform** (2024): "Integrating online training and knowledge sharing among teachers through a cloud-based video platform" - Demonstrates video platforms for knowledge sharing in training (RQ1)
- **Syafa** (2025): "Video-based Learning for Knowledge and Readiness" - Provides empirical evidence of video-based learning effectiveness (RQ1)

### 3.2 Computer-Supported Cooperative Work (CSCW)

CSCW research provides frameworks for understanding collaborative knowledge sharing and group interaction. Foundational work [Paper 17] establishes how computing technologies enable effective collaboration, while mobile CSCW research [Paper 16] examines the evolution from desktop to mobile collaborative systems. These works inform Pulse's collaborative knowledge sharing architecture and mobile-first approach.

**Key Papers:**
- **Wilson** (1990): "Computer supported cooperative work: an overview" - Foundational overview of CSCW and collaboration theory (RQ1, RQ3)
- **Johnson** (2013): "Mobile Support in CSCW Applications and Groupware Development Frameworks" - Examines mobile support in CSCW applications (RQ2, RQ3)
- **Zhang & Chung** (1970): "A NEW MODEL FOR COMPUTER SUPPORTED COOPERATIVE WORK" - Early CSCW collaboration models (RQ3)

### 3.3 Computer-Human Interaction (CHI) and Mobile UX

CHI research on mobile video editing and user experience directly informs Pulse's interface design and usability considerations. Studies examine cross-platform development challenges [Paper 4], mobile content creation practices [Paper 4], and user adoption patterns in organizational contexts [Paper 3]. Recent systematic reviews of mobile application UX [Paper 19] provide comprehensive frameworks for evaluating and designing mobile interfaces, while research on short video editing theory [Paper 20] addresses the specific challenges of mobile video editing workflows.

**Key Papers:**
- **Ahmadi et al.** (CHI 2020): "Feminist Living Labs as Research Infrastructures for HCI" - Explores user adoption in organizational technology contexts (RQ3)
- **Ashtari et al.** (CHI 2020): "Creating Augmented and Virtual Reality Applications" - Cross-platform development and mobile content creation challenges (RQ2, RQ3)
- **Lu et al.** (2025): "Understanding user experience for mobile applications: a systematic literature review" - Comprehensive mobile UX framework (RQ2, RQ3)
- **Li** (2024): "Spatio-Temporal Processing of Editing Points-Research on Short Video Editing Theory and Paradigm" - Short video editing theory and paradigms (RQ5)
- **Darus & Zou** (2024): "Research on User Experience Optimization of Mobile Application Based on Animation Technology" - Mobile UX optimization strategies (RQ3)

### 3.4 Short-Form Video and Mobile Content Creation

Research on short-form video platforms and mobile content creation examines the dynamics of platforms like TikTok, Instagram Reels, and YouTube Shorts [Papers 10-12]. These studies explore engagement strategies, platform comparisons, and the relationship between short-form and long-form content, providing context for Pulse's short-form video approach to knowledge sharing.

**Key Papers:**
- **Rajendran et al.** (2024): "Shorts on the Rise: Assessing the Effects of YouTube Shorts on Long-Form Video Content" - Analyzes short-form vs. long-form video dynamics (RQ1, RQ2)
- **Fatimah & Nasir** (2025): "Utilization of Short-Form Videos (TikTok, Reels, Shorts) to Increase Brand Engagement and Visibility" - Examines engagement strategies (RQ3)
- **Lim et al.** (2025): "PERBANDINGAN KESERUAN MENONTON VIDEO PENDEK DARI TIKTOK, INSTAGRAM REELS, DAN YOUTUBE SHORTS" - Compares user experience across platforms (RQ3)

### 3.5 Video Editing and Processing Technologies

Research on video editing architectures and processing techniques informs Pulse's EDL-based editing system and video processing pipeline. Studies explore non-linear editing systems [Paper 5], video summarization techniques [Paper 6], and advanced video processing methods that could enhance future Pulse features.

**Key Papers:**
- **Sandoval-Castaneda et al.** (arXiv 2025): "EditDuet: A Multi-Agent System for Video Non-Linear Editing" - Advanced video editing architectures and EDL systems (RQ5)
- **Xie et al.** (2024): "Video summarization via knowledge-aware multimodal deep networks" - Video processing and knowledge extraction techniques (RQ1, RQ5)

### 3.6 Security and Compliance

HIPAA compliance and secure video storage research directly informs PulseVault's security architecture. Studies provide frameworks for HIPAA-compliant video systems [Papers 13-15], privacy and governance frameworks [Paper 14], and methods for securing visual PHI [Paper 15]. Security knowledge sharing research [Paper 1] offers frameworks for organizational security contexts.

**Key Papers:**
- **Alahmari & Renaud** (ICITST 2020): "Implement a Model for Describing and Maximising Security Knowledge Sharing" - Security frameworks for institutional knowledge sharing (RQ4)
- **Miles & Quinlan** (Nursing): "HIPAA and video recordings in the clinical setting" - HIPAA compliance for video recordings (RQ4)
- **Nadella** (2024): "Frameworks for Privacy and Governance: Safeguarding Health Data in Compliance with HIPAA Regulations" - Privacy and governance frameworks (RQ4)
- **US Patent 11,923,053** (2024): "HIPPA-compliant computer security method and system for recording visual personal health information" - HIPAA-compliant visual PHI recording (RQ4)

## 4. Technical Contributions

### 4.1 Cross-Platform Native Video Processing

**Challenge**: Implementing hardware-accelerated video processing across iOS and Android platforms while maintaining consistent quality and performance.

**Solution**: 
- **iOS**: Custom native module using AVFoundation for hardware-accelerated video concatenation
- **Android**: Native module using Media3 (formerly ExoPlayer) for video processing
- **EDL Architecture**: Edit Decision List system for non-destructive editing, enabling undo/redo and draft persistence

**Key Technical Details**:
- Segmented recording with configurable durations (15s, 30s, 1m, 3m)
- Real-time video concatenation without quality loss
- Trim points (in/out markers) for precise editing
- Drag-and-drop reordering with visual feedback

### 4.2 EDL-Based Editing System

The Edit Decision List (EDL) architecture enables:
- **Non-destructive Editing**: Original video segments remain unchanged
- **Undo/Redo**: Full editing history with persistent storage
- **Draft Management**: Auto-save and resume editing across sessions
- **Cross-Device Transfer**: Export/import drafts via AirDrop, Files app, or device transfer

### 4.3 Integration with PulseVault

**Upload Pipeline**:
- Resumable uploads using tus protocol for reliable large-file transfers
- Encrypted uploads with TLS in transit
- Metadata sidecar files (meta.json) as source of truth

**Transcoding Pipeline**:
- FFmpeg-based transcoding to adaptive HLS/DASH streams
- Multiple quality renditions (240p–1080p)
- Optional HEVC/AV1 encoding for efficiency
- Redis queue for asynchronous job processing

**Delivery Pipeline**:
- Signed HMAC URLs with time-limited access (≤300s expiry)
- Nginx reverse proxy for efficient streaming
- Observability stack (Prometheus, Grafana, Loki) for monitoring

## 5. Research Questions

1. **RQ1**: How does short-form video documentation compare to traditional text-based documentation in terms of knowledge retention and adoption rates?

2. **RQ2**: What are the technical challenges and solutions for implementing cross-platform native video processing in mobile applications?

3. **RQ3**: How do institutional users adopt and interact with video-first knowledge sharing platforms?

4. **RQ4**: What security and compliance considerations are necessary for institutional video content management?

5. **RQ5**: How does the EDL-based editing architecture impact user workflow and content creation efficiency?

## 6. Methodology

### 6.1 System Development
- Agile development methodology with iterative design and testing
- Cross-platform development using React Native and Expo
- Native module development for platform-specific video processing
- Backend infrastructure development with focus on scalability and security

### 6.2 User Studies (Planned)
- **Usability Testing**: Task-based evaluation of video recording and editing workflows
- **Adoption Studies**: Longitudinal analysis of user engagement and content creation patterns
- **Knowledge Retention Studies**: Comparison of video vs. text-based documentation effectiveness
- **Institutional Deployment**: Case studies with partner organizations

## 7. Expected Contributions

1. **Technical**: Cross-platform native video processing architecture for mobile knowledge sharing applications
2. **Design**: EDL-based editing system for non-destructive video composition on mobile devices
3. **Empirical**: Evaluation of short-form video's impact on institutional knowledge management
4. **Practical**: Open-source platform for institutional knowledge sharing with enterprise-grade security

## 8. Current Status

- ✅ Core mobile application (iOS/Android) with segmented recording
- ✅ Native video processing modules (AVFoundation/Media3)
- ✅ EDL-based editing with undo/redo
- ✅ Draft management and cross-device transfer
- ✅ PulseVault backend infrastructure
- ✅ Integration between Pulse app and PulseVault
- 🔄 User studies and evaluation (in progress)
- ✅ Research paper identification and review (21 papers identified and documented)

## 9. Future Work

- Complete user studies and evaluation
- Publish findings in relevant conferences (CSCW, CHI, etc.)
- Extend platform with advanced features (AI-assisted editing, content recommendations)
- Scale deployment to additional institutional partners
- Investigate long-term impact on organizational knowledge management

## 10. References

### Conference Papers

1. Ahmadi, M., Eilert, R., et al. (2020). "Feminist Living Labs as Research Infrastructures for HCI: The Case of a Video Game Company." *Proceedings of the 2020 CHI Conference on Human Factors in Computing Systems*.

2. Alahmari, S., & Renaud, K. (2020). "Implement a Model for Describing and Maximising Security Knowledge Sharing." *15th International Conference for Internet Technology and Secured Transactions (ICITST)*.

3. Ashtari, N., Bunt, A., et al. (2020). "Creating Augmented and Virtual Reality Applications: Current Practices, Challenges, and Opportunities." *Proceedings of the 2020 CHI Conference on Human Factors in Computing Systems*.

4. Nadella, D. (2024). "Frameworks for Privacy and Governance: Safeguarding Health Data in Compliance with HIPAA Regulations." *Journées Bases de Données Avancées*.

### Journal Articles

5. Eka, M., Lubis, Y. F. A., et al. (2025). "Impact of Mobile Technology Use on Knowledge Management in the Education Sector." *Journal of Computer Science Artificial Intelligence and Communications*.

6. [Anonymous] (2024). "Integrating online training and knowledge sharing among teachers through a cloud-based video platform." *Knowledge Management & E-Learning An International Journal* (Impact Factor: 2.8).

7. Syafa, B. S. N. (2025). "Video-based Learning for Knowledge and Readiness on Waste Separation at Source (WSAS) Practice among Engineering Students." *Journal of Education and Teacher Training Innovation*.

8. Xie, J., Chen, X., et al. (2024). "Video summarization via knowledge-aware multimodal deep networks." *Knowledge-Based Systems* (Impact Factor: 7.6).

9. Rajendran, P. T., Creusy, K., et al. (2024). "Shorts on the Rise: Assessing the Effects of YouTube Shorts on Long-Form Video Content." *arXiv - Social and Information Networks*.

10. Fatimah, A. F., & Nasir, M. (2025). "Utilization of Short-Form Videos (TikTok, Reels, Shorts) to Increase Brand Engagement and Visibility." *Journal of Digital Marketing and Search Engine Optimization*.

11. Lim, V., Jackson, J., et al. (2025). "PERBANDINGAN KESERUAN MENONTON VIDEO PENDEK DARI TIKTOK, INSTAGRAM REELS, DAN YOUTUBE SHORTS." *Simtek : jurnal sistem informasi dan teknik komputer*.

12. Miles, G., & Quinlan, A. "HIPAA and video recordings in the clinical setting." *Nursing*.

13. Johnson, D. (2013). "Mobile Support in CSCW Applications and Groupware Development Frameworks." *International Journal of Interactive Mobile Technologies (iJIM)*.

14. Wilson, P. (1990). "Computer supported cooperative work: an overview." *Intelligent Tutoring Media*.

15. Lu, G., Qu, S., et al. (2025). "Understanding user experience for mobile applications: a systematic literature review." *Discover Applied Sciences*.

16. Li, P. (2024). "Spatio-Temporal Processing of Editing Points-Research on Short Video Editing Theory and Paradigm." *Transactions on Social Science, Education and Humanities Research*.

17. Darus, M., & Zou, D. (2024). "Research on User Experience Optimization of Mobile Application Based on Animation Technology." *Journal of Global Humanities and Social Sciences*.

### Book Chapters

18. Herschel, R. T., & Yermish, I. "Video Issues for Knowledge Management." *Ubiquitous Developments in Knowledge Management*.

### Preprints

19. Sandoval-Castaneda, M., Russell, B., et al. (2025). "EditDuet: A Multi-Agent System for Video Non-Linear Editing." *arXiv - Computer Vision and Pattern Recognition*.

### Patents

20. [Anonymous] (2024). "HIPPA-compliant computer security method and system for recording visual personal health information in an electronic format relating to at least two individuals, at least one..." *US Patent 11,923,053*.

### Technical Reports

21. Zhang, J., & Chung, J.-Y. (1970). "A NEW MODEL FOR COMPUTER SUPPORTED COOPERATIVE WORK." *IBM infiNET Solutions*.

---

*For a detailed analysis of each paper's relevance to Pulse research, including research question alignment and application notes, see [papers.md](./papers.md).*

---

## Notes

This thesis builds upon 21 identified research papers spanning knowledge management, CSCW, CHI, video processing, security, and mobile UX. Papers were identified through systematic searches of academic databases (Bohrium) using targeted queries across five key domains:

1. Institutional knowledge sharing video
2. Short-form video mobile content creation
3. HIPAA compliant video storage systems
4. CSCW video collaboration knowledge sharing
5. CHI mobile video editing user experience

All papers have been documented with relevance analysis, research question alignment, and application notes in [papers.md](./papers.md). The literature review demonstrates Pulse's contribution to addressing gaps in mobile-first, secure, institutional knowledge sharing through short-form video.

