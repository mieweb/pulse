# Secure Institutional Knowledge Sharing Through Short-Form Video: A Cross-Platform Mobile Application with Native Video Processing

## Abstract

This thesis presents **Pulse**, a cross-platform mobile application designed for institutional knowledge sharing through short-form video content. Pulse addresses the critical need for modern knowledge management systems by enabling organizations to capture, edit, and share institutional procedures, training materials, and expert knowledge through secure, professionally-edited video content. The platform leverages native video processing capabilities (AVFoundation on iOS, Media3 on Android) for hardware-accelerated video concatenation, implements an Edit Decision List (EDL) architecture for non-destructive editing, and integrates with PulseVault—a secure backend infrastructure for video storage, transcoding, and delivery. This research explores the impact of short-form video on institutional knowledge transfer, evaluates the technical challenges of cross-platform video processing, and assesses user adoption patterns in organizational settings.

## 1. Introduction

### 1.1 The Challenge of Institutional Knowledge Management

Institutional knowledge management represents one of the most critical yet challenging aspects of modern organizational operations. As organizations grow and evolve, they accumulate vast amounts of procedural knowledge, best practices, and domain expertise that are essential for effective operations. However, traditional approaches to capturing, preserving, and sharing this knowledge face significant limitations that hinder organizational effectiveness.

#### 1.1.1 Knowledge Loss and Institutional Memory

One of the most pressing challenges is the loss of critical institutional knowledge when employees transition, retire, or move to different roles. This "brain drain" phenomenon results in the disappearance of tacit knowledge—the unwritten procedures, contextual understanding, and problem-solving approaches that employees develop through experience. Unlike explicit knowledge that can be documented in manuals or databases, tacit knowledge is difficult to capture using traditional text-based documentation methods. When experienced employees leave, organizations often find themselves relearning processes, repeating mistakes, and losing institutional memory that took years to develop.

#### 1.1.2 Limitations of Traditional Documentation

Traditional documentation methods, primarily text-based documents, static images, and written procedures, face fundamental limitations in capturing the nuanced, procedural knowledge that drives organizational success. Text documentation struggles to convey:

- **Temporal sequences**: The precise timing and flow of multi-step procedures
- **Spatial relationships**: How physical objects, interfaces, or environments relate to each other
- **Contextual cues**: Visual and auditory information that guides decision-making
- **Dynamic interactions**: The way systems, tools, or processes respond in real-time
- **Non-verbal communication**: Gestures, demonstrations, and visual explanations that are central to learning

These limitations become particularly acute in technical domains, where procedures often involve complex interactions with software interfaces, hardware systems, or multi-step workflows that are difficult to describe accurately in text alone.

#### 1.1.3 Adoption Barriers in Knowledge Management Systems

Even when organizations invest in knowledge management systems, adoption rates often remain disappointingly low. Complex documentation platforms, cumbersome authoring tools, and disconnected workflows create barriers that prevent employees from contributing to or accessing organizational knowledge. The effort required to create documentation often exceeds the perceived benefit, leading to incomplete knowledge bases, outdated information, and underutilized systems. This creates a vicious cycle where low adoption leads to incomplete knowledge, which further reduces the value of the system and discourages future participation.

#### 1.1.4 Security and Compliance Requirements

Institutional knowledge sharing, particularly in healthcare, finance, and other regulated industries, must operate within strict security and compliance frameworks. Organizations must ensure that sensitive information is protected, access is controlled, and regulatory requirements (such as HIPAA in healthcare) are met. These requirements add complexity to knowledge management systems and often create additional barriers to adoption, as security measures can impede ease of use and accessibility.

### 1.2 The Promise of Video-Based Knowledge Sharing

Video has emerged as a powerful medium for knowledge transfer, offering unique advantages over traditional text-based documentation. Unlike static text, video can capture:

- **Demonstrative procedures**: Step-by-step visual demonstrations of complex processes
- **Contextual information**: The actual environment, tools, and conditions in which procedures are performed
- **Temporal dynamics**: The timing, pacing, and sequence of actions
- **Multi-modal information**: Visual, auditory, and textual information simultaneously
- **Emotional and social cues**: Non-verbal communication that facilitates understanding

Research in educational technology and knowledge management has demonstrated that video-based learning can be more effective than text-based approaches for procedural knowledge transfer, particularly for complex, multi-step processes [Papers 7-9]. The rise of short-form video platforms (TikTok, Instagram Reels, YouTube Shorts) has further demonstrated the power of concise, engaging video content for knowledge sharing and engagement [Papers 10-12].

However, existing video platforms are primarily designed for entertainment or general-purpose content creation, not for institutional knowledge management. They lack the security, workflow integration, and organizational features necessary for enterprise deployment. There is a clear need for a platform specifically designed for institutional knowledge sharing through short-form video content.

### 1.3 Pulse: A Video-First Knowledge Sharing Platform

This thesis presents **Pulse**, a cross-platform mobile application designed specifically for institutional knowledge sharing through short-form video content. Pulse addresses the limitations of traditional documentation methods by providing a mobile-first platform that enables organizations to capture, edit, and share institutional knowledge through professionally-edited video content.

#### 1.3.1 Core Capabilities

Pulse provides several key capabilities that distinguish it from general-purpose video platforms:

**Segmented Video Recording**: Pulse enables users to record multiple video clips that combine seamlessly into a single, cohesive video. This segmented approach allows for natural pauses, retakes, and iterative refinement during the recording process, making it easier to create high-quality documentation without requiring extensive post-production editing.

**Professional Editing with EDL Architecture**: At the heart of Pulse is an Edit Decision List (EDL) architecture that enables non-destructive video editing on mobile devices. This system allows users to:
- Reorder video segments through intuitive drag-and-drop interfaces
- Trim segments with precise in/out markers
- Undo and redo editing operations with full history
- Save and resume editing sessions across app launches
- Transfer drafts between devices for collaborative editing

The EDL architecture represents a significant technical contribution, as it brings professional video editing capabilities to mobile devices while maintaining performance and usability.

**Cross-Platform Native Video Processing**: Pulse leverages platform-specific video processing capabilities to ensure optimal performance and quality:
- **iOS**: Custom native module using AVFoundation for hardware-accelerated video concatenation
- **Android**: Native module using Media3 (formerly ExoPlayer) for video processing

This cross-platform approach ensures consistent quality and performance across different devices while taking advantage of platform-specific optimizations.

**Secure Backend Integration**: Pulse integrates with **PulseVault**, a secure backend infrastructure designed for institutional video storage, transcoding, and delivery. PulseVault provides:
- Resumable video uploads using the tus protocol for reliable large-file transfers
- Automatic transcoding to adaptive HLS/DASH streams with multiple quality renditions
- Secure access control with HMAC-signed URLs and time-limited access
- Audit logging and monitoring capabilities for compliance and analytics

**Institutional Workflows**: Pulse is designed with institutional use cases in mind, supporting:
- Draft management and auto-save functionality
- Deep linking for integration with organizational workflows
- Local-first storage with optional cloud synchronization
- Cross-device transfer for collaborative editing

#### 1.3.2 Design Philosophy

Pulse is built on several key design principles:

**Mobile-First**: Recognizing that knowledge capture often happens in the moment and in context, Pulse is designed primarily for mobile devices. This enables users to document procedures, training, and knowledge directly where and when they occur, rather than requiring them to return to a desktop computer.

**Short-Form Content**: Pulse emphasizes short-form video content (typically 15 seconds to 3 minutes), recognizing that focused, concise videos are more effective for knowledge transfer and more likely to be consumed than longer-form content.

**Ease of Use**: The platform prioritizes simplicity and ease of use, recognizing that adoption barriers are a primary challenge in knowledge management systems. The editing interface is designed to be intuitive, requiring minimal training.

**Security and Privacy**: While designed for ease of use, Pulse maintains security as a core consideration, with architecture that supports institutional security and compliance requirements.

### 1.4 Research Questions

This research addresses five fundamental questions about video-based knowledge sharing in institutional settings:

**RQ1: Effectiveness of Video vs. Text Documentation**
How does short-form video documentation compare to traditional text-based documentation in terms of knowledge retention and adoption rates? This question explores whether video-based documentation offers measurable advantages over text-based approaches for institutional knowledge management.

**RQ2: Technical Challenges of Cross-Platform Video Processing**
What are the technical challenges and solutions for implementing cross-platform native video processing in mobile applications? This question addresses the engineering challenges of providing consistent, high-quality video processing across iOS and Android platforms.

**RQ3: User Adoption and Interaction Patterns**
How do institutional users adopt and interact with video-first knowledge sharing platforms? This question examines the factors that influence adoption, usage patterns, and barriers to engagement in organizational contexts.

**RQ4: Security and Compliance Considerations**
What security and compliance considerations are necessary for institutional video content management? This question explores the security architecture, access control mechanisms, and compliance requirements for deploying video-based knowledge sharing systems in institutional settings.

**RQ5: Impact of EDL Architecture on Workflow**
How does the EDL-based editing architecture impact user workflow and content creation efficiency? This question evaluates the effectiveness of the EDL approach for mobile video editing and its impact on the content creation process.

### 1.5 Contributions

This research makes several key contributions to the fields of knowledge management, mobile computing, and human-computer interaction:

#### 1.5.1 Technical Contributions

**EDL-Based Editing Architecture for Mobile Devices**: The primary technical contribution is the design and implementation of an Edit Decision List (EDL) architecture for non-destructive video editing on mobile devices. This system enables professional-grade editing capabilities (undo/redo, segment reordering, trimming) while maintaining performance and usability on resource-constrained mobile platforms. The EDL architecture represents a novel approach to mobile video editing that balances functionality with performance.

**Cross-Platform Native Video Processing**: The research demonstrates practical approaches to implementing hardware-accelerated video processing across iOS and Android platforms, addressing challenges of platform-specific APIs, performance optimization, and quality consistency.

**Integration Architecture**: The research presents an integrated architecture connecting mobile video capture and editing with secure backend storage and delivery, demonstrating how to build end-to-end video knowledge sharing systems.

#### 1.5.2 Empirical Contributions

**Living Labs Case Study**: Through deployment at Medical Informatics Engineering, Inc. (MIE), this research provides empirical insights into how institutional users adopt and interact with video-first knowledge sharing platforms. The study examines adoption patterns, engagement metrics, usability factors, and barriers to adoption in a real-world organizational context.

**Evaluation Framework**: The research establishes a comprehensive metrics framework for evaluating video-based knowledge sharing systems, drawing from research in knowledge management, CSCW, and mobile UX to provide a multi-dimensional evaluation approach.

#### 1.5.3 Design Contributions

**Mobile-First Knowledge Sharing Design**: The research contributes design patterns and principles for building mobile-first knowledge sharing systems, addressing the unique challenges of mobile content creation and consumption in institutional contexts.

**Short-Form Video for Knowledge Management**: The research explores how short-form video content can be effectively applied to institutional knowledge management, providing insights into optimal content length, structure, and presentation for knowledge transfer.

### 1.6 Thesis Structure

This thesis is organized into seven chapters:

**Chapter 2: Related Work** reviews relevant research across knowledge management, CSCW, mobile UX, video processing, and security domains. The chapter synthesizes findings from 21 research papers and identifies gaps that Pulse addresses.

**Chapter 3: System Design & Implementation** presents the technical architecture of Pulse and PulseVault, with detailed discussion of the EDL architecture, cross-platform video processing, and backend infrastructure.

**Chapter 4: Methodology** describes the Living Labs case study approach, data collection methods, metrics framework, and analysis plan for evaluating Pulse in an institutional setting.

**Chapter 5: Results** presents findings from the MIE case study, including technical performance metrics, user adoption patterns, usability evaluation, and knowledge sharing effectiveness.

**Chapter 6: Discussion** interprets the findings, addresses each research question, compares results to related work, and discusses implications for knowledge management and mobile computing.

**Chapter 7: Conclusion** summarizes contributions, key findings, limitations, and directions for future work.

### 1.7 Scope and Limitations

This research focuses on institutional knowledge sharing through short-form video content, with particular emphasis on:
- Mobile-first content creation and consumption
- Cross-platform deployment (iOS and Android)
- Non-destructive editing workflows
- Institutional deployment contexts

The research does not address:
- Long-form video content (beyond 3 minutes)
- Desktop-based video editing workflows
- Consumer-facing video platforms
- Real-time collaborative editing (though drafts can be transferred)

The user study is conducted within a single organization (MIE), which provides valuable insights but limits generalizability. Future work should explore deployment across multiple organizations and contexts.

### 1.8 Organization of This Thesis

The remainder of this thesis proceeds as follows. Chapter 2 reviews related work and establishes the theoretical and empirical foundation for this research. Chapter 3 presents the system design and implementation, with particular focus on the EDL architecture and cross-platform video processing. Chapter 4 describes the methodology for the institutional case study. Chapter 5 presents results from the study, and Chapter 6 discusses implications and contributions. Chapter 7 concludes with a summary and future directions.

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
- **Platform Deployment**: PulseVault deployed at https://pulse-vault.opensource.mieweb.org/ with video upload, sharing, and transcoding capabilities
- **Usability Testing**: Task-based evaluation of video recording and editing workflows
- **Adoption Studies**: Longitudinal analysis of user engagement and content creation patterns
- **Knowledge Retention Studies**: Comparison of video vs. text-based documentation effectiveness
- **Institutional Deployment**: Case studies with partner organizations
- **Metrics Collection**: Technical metrics via Prometheus; user study metrics being defined (see [USER_STUDY.md](./USER_STUDY.md))

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
- ✅ PulseVault backend infrastructure deployed and operational (https://pulse-vault.opensource.mieweb.org/)
- ✅ Video upload and sharing via UUID links (authenticated users only)
- ✅ Automatic transcoding to HLS/DASH with multiple quality renditions
- ✅ Integration between Pulse app and PulseVault
- 🔄 User studies and evaluation (in progress - metrics planned)
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

