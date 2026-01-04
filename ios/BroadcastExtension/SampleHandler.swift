import ReplayKit
import AVFoundation

/// Broadcast Upload Extension handler for audio-gated screen recording
/// Only writes video frames when audio level is above a configurable threshold
class SampleHandler: RPBroadcastSampleHandler {
    
    // MARK: - Configuration
    
    /// Audio threshold for considering audio as "active" (RMS value)
    /// Typical speech is around 0.02-0.1, adjust as needed
    private let audioThreshold: Float = 0.02
    
    /// Minimum duration audio must be above threshold to enter active state (in seconds)
    private let minActiveTransitionDuration: TimeInterval = 0.3
    
    /// Minimum duration audio must be below threshold to enter silent state (in seconds)
    private let minSilentTransitionDuration: TimeInterval = 0.7
    
    // MARK: - State
    
    private enum RecordingState {
        case silent
        case active
    }
    
    private var currentState: RecordingState = .silent
    private var stateTransitionStartTime: Date?
    
    private var assetWriter: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    
    private var isRecording = false
    private var videoOutputURL: URL?
    
    // Shared container for communication with main app
    private let appGroupIdentifier = "group.com.mieweb.pulse.screenrecorder"
    
    // MARK: - Sample Buffer Processing
    
    override func broadcastStarted(withSetupInfo setupInfo: [String : NSObject]?) {
        NSLog("[BroadcastExtension] Broadcast started")
        
        // Set up the output file
        setupOutputFile()
        
        // Mark recording as active in shared preferences
        if let sharedDefaults = UserDefaults(suiteName: appGroupIdentifier) {
            sharedDefaults.set(true, forKey: "isRecording")
        }
        
        isRecording = true
        currentState = .silent
        stateTransitionStartTime = Date()
    }
    
    override func broadcastPaused() {
        NSLog("[BroadcastExtension] Broadcast paused")
    }
    
    override func broadcastResumed() {
        NSLog("[BroadcastExtension] Broadcast resumed")
    }
    
    override func broadcastFinished() {
        NSLog("[BroadcastExtension] Broadcast finished")
        
        isRecording = false
        
        // Mark recording as inactive
        if let sharedDefaults = UserDefaults(suiteName: appGroupIdentifier) {
            sharedDefaults.set(false, forKey: "isRecording")
        }
        
        // Finalize the asset writer
        finalizeRecording()
    }
    
    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard isRecording else { return }
        
        switch sampleBufferType {
        case .video:
            processVideoSample(sampleBuffer)
        case .audioApp, .audioMic:
            processAudioSample(sampleBuffer)
        @unknown default:
            break
        }
    }
    
    // MARK: - Audio Processing
    
    private func processAudioSample(_ sampleBuffer: CMSampleBuffer) {
        // Calculate audio level (RMS)
        let audioLevel = calculateAudioLevel(from: sampleBuffer)
        
        NSLog("[BroadcastExtension] Audio level: %.4f, threshold: %.4f, state: \(currentState)", audioLevel, audioThreshold)
        
        // Update state based on audio level with hysteresis
        updateState(audioLevel: audioLevel)
        
        // Only write audio if in active state
        if currentState == .active {
            writeAudioSample(sampleBuffer)
        }
    }
    
    private func calculateAudioLevel(from sampleBuffer: CMSampleBuffer) -> Float {
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else {
            return 0.0
        }
        
        var length: Int = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        
        let status = CMBlockBufferGetDataPointer(
            blockBuffer,
            atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &length,
            dataPointerOut: &dataPointer
        )
        
        guard status == kCMBlockBufferNoErr,
              let pointer = dataPointer else {
            return 0.0
        }
        
        // Calculate RMS of audio samples
        let samples = UnsafeBufferPointer(start: UnsafePointer<Int16>(OpaquePointer(pointer)), count: length / 2)
        
        var sum: Float = 0
        for sample in samples {
            let normalized = Float(sample) / Float(Int16.max)
            sum += normalized * normalized
        }
        
        let rms = sqrtf(sum / Float(samples.count))
        return rms
    }
    
    private func updateState(audioLevel: Float) {
        let now = Date()
        let isAboveThreshold = audioLevel > audioThreshold
        
        switch currentState {
        case .silent:
            if isAboveThreshold {
                // Check if we should transition to active
                if let transitionStart = stateTransitionStartTime {
                    let duration = now.timeIntervalSince(transitionStart)
                    if duration >= minActiveTransitionDuration {
                        NSLog("[BroadcastExtension] State transition: silent -> active")
                        currentState = .active
                        stateTransitionStartTime = nil
                        
                        // Initialize asset writer when entering active state for the first time
                        if assetWriter == nil {
                            initializeAssetWriter()
                        }
                    }
                } else {
                    stateTransitionStartTime = now
                }
            } else {
                // Reset transition timer if we go back below threshold
                stateTransitionStartTime = nil
            }
            
        case .active:
            if !isAboveThreshold {
                // Check if we should transition to silent
                if let transitionStart = stateTransitionStartTime {
                    let duration = now.timeIntervalSince(transitionStart)
                    if duration >= minSilentTransitionDuration {
                        NSLog("[BroadcastExtension] State transition: active -> silent")
                        currentState = .silent
                        stateTransitionStartTime = nil
                    }
                } else {
                    stateTransitionStartTime = now
                }
            } else {
                // Reset transition timer if we go back above threshold
                stateTransitionStartTime = nil
            }
        }
    }
    
    // MARK: - Video Processing
    
    private func processVideoSample(_ sampleBuffer: CMSampleBuffer) {
        // Only write video if in active state
        if currentState == .active {
            writeVideoSample(sampleBuffer)
        }
    }
    
    // MARK: - Asset Writer Setup
    
    private func setupOutputFile() {
        guard let containerURL = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupIdentifier
        ) else {
            NSLog("[BroadcastExtension] Unable to access app group container")
            return
        }
        
        let recordingsPath = containerURL.appendingPathComponent("Recordings")
        
        // Create recordings directory if it doesn't exist
        try? FileManager.default.createDirectory(at: recordingsPath, withIntermediateDirectories: true)
        
        // Create output file URL with timestamp
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let fileName = "recording-\(timestamp).mp4"
        videoOutputURL = recordingsPath.appendingPathComponent(fileName)
        
        NSLog("[BroadcastExtension] Output file will be: \(videoOutputURL?.path ?? "unknown")")
    }
    
    private func initializeAssetWriter() {
        guard let outputURL = videoOutputURL else {
            NSLog("[BroadcastExtension] No output URL set")
            return
        }
        
        // Remove existing file if it exists
        try? FileManager.default.removeItem(at: outputURL)
        
        do {
            assetWriter = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
            
            // Configure video input
            let videoSettings: [String: Any] = [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: 1080,
                AVVideoHeightKey: 1920,
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: 6000000,
                    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
                ]
            ]
            
            videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
            videoInput?.expectsMediaDataInRealTime = true
            
            if let videoInput = videoInput, assetWriter?.canAdd(videoInput) == true {
                assetWriter?.add(videoInput)
            }
            
            // Configure audio input
            let audioSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 44100,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 64000
            ]
            
            audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            audioInput?.expectsMediaDataInRealTime = true
            
            if let audioInput = audioInput, assetWriter?.canAdd(audioInput) == true {
                assetWriter?.add(audioInput)
            }
            
            // Start writing
            assetWriter?.startWriting()
            assetWriter?.startSession(atSourceTime: .zero)
            
            NSLog("[BroadcastExtension] Asset writer initialized and started")
        } catch {
            NSLog("[BroadcastExtension] Error initializing asset writer: \(error)")
        }
    }
    
    private func writeVideoSample(_ sampleBuffer: CMSampleBuffer) {
        guard let videoInput = videoInput,
              let assetWriter = assetWriter,
              assetWriter.status == .writing,
              videoInput.isReadyForMoreMediaData else {
            return
        }
        
        videoInput.append(sampleBuffer)
    }
    
    private func writeAudioSample(_ sampleBuffer: CMSampleBuffer) {
        guard let audioInput = audioInput,
              let assetWriter = assetWriter,
              assetWriter.status == .writing,
              audioInput.isReadyForMoreMediaData else {
            return
        }
        
        audioInput.append(sampleBuffer)
    }
    
    private func finalizeRecording() {
        guard let assetWriter = assetWriter else {
            NSLog("[BroadcastExtension] No asset writer to finalize")
            return
        }
        
        videoInput?.markAsFinished()
        audioInput?.markAsFinished()
        
        assetWriter.finishWriting { [weak self] in
            guard let self = self else { return }
            
            if assetWriter.status == .completed {
                NSLog("[BroadcastExtension] Recording finalized successfully at: \(self.videoOutputURL?.path ?? "unknown")")
                
                // Store the last recording path in shared preferences
                if let sharedDefaults = UserDefaults(suiteName: self.appGroupIdentifier),
                   let path = self.videoOutputURL?.path {
                    sharedDefaults.set(path, forKey: "lastRecordingPath")
                }
            } else {
                NSLog("[BroadcastExtension] Recording finalization failed with status: \(assetWriter.status.rawValue)")
                if let error = assetWriter.error {
                    NSLog("[BroadcastExtension] Error: \(error)")
                }
            }
            
            self.assetWriter = nil
            self.videoInput = nil
            self.audioInput = nil
        }
    }
}
