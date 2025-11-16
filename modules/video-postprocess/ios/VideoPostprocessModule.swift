import ExpoModulesCore
import AVFoundation
import Accelerate

/// Options for post-processing video clips
struct PostprocessOptions: Record {
    @Field
    var speedFactor: Float = 1.15
    @Field
    var silenceThreshold: Float = -40.0
    @Field
    var minSilenceDuration: Int = 500
}

/// Native module for post-processing video clips with silence removal and pitch-preserving speed adjustment.
public class VideoPostprocessModule: Module {
    
    public func definition() -> ModuleDefinition {
        Name("VideoPostprocess")
        
        Events("onProgress")
        
        AsyncFunction("processClip") { (inputURL: String, outputURL: String, options: PostprocessOptions) -> String in
            guard let input = URL(string: inputURL) else {
                throw NSError(domain: "VideoPostprocess", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid input URL"])
            }
            
            guard let output = URL(string: outputURL) else {
                throw NSError(domain: "VideoPostprocess", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid output URL"])
            }
            
            // Send initial progress
            self.sendEvent("onProgress", [
                "progress": 0.0,
                "phase": "analyzing"
            ])
            
            // Load the asset
            let asset = AVURLAsset(url: input)
            
            // Create composition for processing
            let composition = try await self.createProcessedComposition(
                from: asset,
                speedFactor: options.speedFactor,
                silenceThreshold: options.silenceThreshold,
                minSilenceDuration: options.minSilenceDuration
            )
            
            // Remove existing file if it exists
            if FileManager.default.fileExists(atPath: output.path) {
                try FileManager.default.removeItem(at: output)
            }
            
            // Send finalizing progress
            self.sendEvent("onProgress", [
                "progress": 0.9,
                "phase": "finalizing"
            ])
            
            // Export the processed composition
            guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
                throw NSError(domain: "VideoPostprocess", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to create export session"])
            }
            
            exporter.outputURL = output
            exporter.outputFileType = .mp4
            exporter.shouldOptimizeForNetworkUse = false
            
            try await exporter.export()
            
            guard exporter.status == .completed else {
                throw NSError(domain: "VideoPostprocess", code: 3, userInfo: [NSLocalizedDescriptionKey: "Export failed"])
            }
            
            return output.absoluteString
        }
        
        AsyncFunction("processClips") { (inputURLs: [String], outputDir: String, options: PostprocessOptions) -> [String] in
            var processedURLs: [String] = []
            
            for (index, inputURLString) in inputURLs.enumerated() {
                guard let inputURL = URL(string: inputURLString) else { continue }
                
                // Generate output filename
                let filename = inputURL.deletingPathExtension().lastPathComponent
                let outputURL = URL(fileURLWithPath: outputDir)
                    .appendingPathComponent("\(filename)_processed")
                    .appendingPathExtension("mp4")
                
                // Process the clip
                let processed = try await self.processClip(
                    inputURL: inputURL,
                    outputURL: outputURL,
                    speedFactor: options.speedFactor,
                    silenceThreshold: options.silenceThreshold,
                    minSilenceDuration: options.minSilenceDuration
                )
                
                processedURLs.append(processed)
                
                // Send batch progress
                let batchProgress = Double(index + 1) / Double(inputURLs.count)
                self.sendEvent("onProgress", [
                    "progress": batchProgress,
                    "phase": "processing"
                ])
            }
            
            return processedURLs
        }
    }
    
    /// Process a single clip with silence removal and speed adjustment
    private func processClip(
        inputURL: URL,
        outputURL: URL,
        speedFactor: Float,
        silenceThreshold: Float,
        minSilenceDuration: Int
    ) async throws -> String {
        let asset = AVURLAsset(url: inputURL)
        
        let composition = try await createProcessedComposition(
            from: asset,
            speedFactor: speedFactor,
            silenceThreshold: silenceThreshold,
            minSilenceDuration: minSilenceDuration
        )
        
        // Remove existing file if it exists
        if FileManager.default.fileExists(atPath: outputURL.path) {
            try FileManager.default.removeItem(at: outputURL)
        }
        
        guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
            throw NSError(domain: "VideoPostprocess", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to create export session"])
        }
        
        exporter.outputURL = outputURL
        exporter.outputFileType = .mp4
        exporter.shouldOptimizeForNetworkUse = false
        
        try await exporter.export()
        
        guard exporter.status == .completed else {
            throw NSError(domain: "VideoPostprocess", code: 3, userInfo: [NSLocalizedDescriptionKey: "Export failed"])
        }
        
        return outputURL.absoluteString
    }
    
    /// Create a processed composition with silence removal and speed adjustment
    private func createProcessedComposition(
        from asset: AVAsset,
        speedFactor: Float,
        silenceThreshold: Float,
        minSilenceDuration: Int
    ) async throws -> AVComposition {
        
        self.sendEvent("onProgress", [
            "progress": 0.1,
            "phase": "analyzing"
        ])
        
        // Analyze audio for silence periods
        let silencePeriods = try await analyzeSilence(
            in: asset,
            threshold: silenceThreshold,
            minDuration: minSilenceDuration
        )
        
        self.sendEvent("onProgress", [
            "progress": 0.4,
            "phase": "removing_silence"
        ])
        
        // Create composition with silence removed
        let compositionWithoutSilence = try await createCompositionRemovingSilence(
            from: asset,
            silencePeriods: silencePeriods
        )
        
        self.sendEvent("onProgress", [
            "progress": 0.7,
            "phase": "adjusting_speed"
        ])
        
        // Apply speed adjustment with pitch preservation
        let finalComposition = try await applySpeedAdjustment(
            to: compositionWithoutSilence,
            speedFactor: speedFactor
        )
        
        return finalComposition
    }
    
    /// Analyze audio to detect silence periods
    private func analyzeSilence(
        in asset: AVAsset,
        threshold: Float,
        minDuration: Int
    ) async throws -> [CMTimeRange] {
        
        let audioTracks = try await asset.loadTracks(withMediaType: .audio)
        guard let audioTrack = audioTracks.first else {
            // No audio, return empty array
            return []
        }
        
        let duration = try await asset.load(.duration)
        let reader = try AVAssetReader(asset: asset)
        
        let outputSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false
        ]
        
        let readerOutput = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: outputSettings)
        reader.add(readerOutput)
        
        guard reader.startReading() else {
            throw NSError(domain: "VideoPostprocess", code: 4, userInfo: [NSLocalizedDescriptionKey: "Failed to start reading audio"])
        }
        
        var silencePeriods: [CMTimeRange] = []
        var currentSilenceStart: CMTime?
        let minSilenceCMTime = CMTime(value: Int64(minDuration), timescale: 1000)
        
        // Process audio samples
        while let sampleBuffer = readerOutput.copyNextSampleBuffer() {
            guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { continue }
            
            let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            let sampleDuration = CMSampleBufferGetDuration(sampleBuffer)
            
            var length: Int = 0
            var dataPointer: UnsafeMutablePointer<Int8>?
            CMBlockBufferGetDataPointer(blockBuffer, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &dataPointer)
            
            guard let data = dataPointer else { continue }
            
            // Calculate RMS amplitude
            let samples = data.withMemoryRebound(to: Int16.self, capacity: length / 2) { ptr in
                Array(UnsafeBufferPointer(start: ptr, count: length / 2))
            }
            
            let rms = calculateRMS(samples: samples)
            let dB = 20 * log10(rms + 1e-10) // Add small epsilon to avoid log(0)
            
            // Detect silence with hysteresis
            let isSilent = dB < threshold
            
            if isSilent {
                if currentSilenceStart == nil {
                    currentSilenceStart = presentationTime
                }
            } else {
                if let silenceStart = currentSilenceStart {
                    let silenceDuration = presentationTime - silenceStart
                    if silenceDuration >= minSilenceCMTime {
                        silencePeriods.append(CMTimeRange(start: silenceStart, duration: silenceDuration))
                    }
                    currentSilenceStart = nil
                }
            }
        }
        
        // Handle trailing silence
        if let silenceStart = currentSilenceStart {
            let silenceDuration = duration - silenceStart
            if silenceDuration >= minSilenceCMTime {
                silencePeriods.append(CMTimeRange(start: silenceStart, duration: silenceDuration))
            }
        }
        
        return silencePeriods
    }
    
    /// Calculate RMS (Root Mean Square) of audio samples
    private func calculateRMS(samples: [Int16]) -> Float {
        guard !samples.isEmpty else { return 0.0 }
        
        let sum = samples.reduce(0.0) { result, sample in
            let normalized = Float(sample) / Float(Int16.max)
            return result + normalized * normalized
        }
        
        return sqrt(sum / Float(samples.count))
    }
    
    /// Create composition removing silence periods
    private func createCompositionRemovingSilence(
        from asset: AVAsset,
        silencePeriods: [CMTimeRange]
    ) async throws -> AVMutableComposition {
        
        let composition = AVMutableComposition()
        let duration = try await asset.load(.duration)
        
        // Create tracks
        guard let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
              let audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw NSError(domain: "VideoPostprocess", code: 5, userInfo: [NSLocalizedDescriptionKey: "Failed to create tracks"])
        }
        
        // Get source tracks
        let sourceVideoTracks = try await asset.loadTracks(withMediaType: .video)
        let sourceAudioTracks = try await asset.loadTracks(withMediaType: .audio)
        
        guard let sourceVideoTrack = sourceVideoTracks.first else {
            throw NSError(domain: "VideoPostprocess", code: 6, userInfo: [NSLocalizedDescriptionKey: "No video track found"])
        }
        
        // Calculate non-silent periods
        let nonSilentPeriods = calculateNonSilentPeriods(duration: duration, silencePeriods: silencePeriods)
        
        // Insert non-silent periods into composition
        var currentTime = CMTime.zero
        
        for period in nonSilentPeriods {
            try videoTrack.insertTimeRange(period, of: sourceVideoTrack, at: currentTime)
            
            if let sourceAudioTrack = sourceAudioTracks.first {
                try audioTrack.insertTimeRange(period, of: sourceAudioTrack, at: currentTime)
            }
            
            currentTime = currentTime + period.duration
        }
        
        // Preserve video track properties
        let preferredTransform = try await sourceVideoTrack.load(.preferredTransform)
        videoTrack.preferredTransform = preferredTransform
        
        return composition
    }
    
    /// Calculate non-silent periods from silence periods
    private func calculateNonSilentPeriods(duration: CMTime, silencePeriods: [CMTimeRange]) -> [CMTimeRange] {
        var nonSilentPeriods: [CMTimeRange] = []
        var currentStart = CMTime.zero
        
        for silentRange in silencePeriods.sorted(by: { $0.start < $1.start }) {
            if currentStart < silentRange.start {
                let periodDuration = silentRange.start - currentStart
                nonSilentPeriods.append(CMTimeRange(start: currentStart, duration: periodDuration))
            }
            currentStart = silentRange.end
        }
        
        // Add final non-silent period if any
        if currentStart < duration {
            nonSilentPeriods.append(CMTimeRange(start: currentStart, duration: duration - currentStart))
        }
        
        return nonSilentPeriods
    }
    
    /// Apply speed adjustment with pitch preservation
    private func applySpeedAdjustment(
        to composition: AVMutableComposition,
        speedFactor: Float
    ) async throws -> AVMutableComposition {
        
        // If speed factor is 1.0, no adjustment needed
        guard speedFactor != 1.0 else {
            return composition
        }
        
        // Create new composition for speed-adjusted version
        let speedComposition = AVMutableComposition()
        
        // Add video track with time scaling
        if let sourceVideoTrack = composition.tracks(withMediaType: .video).first {
            guard let videoTrack = speedComposition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
                throw NSError(domain: "VideoPostprocess", code: 7, userInfo: [NSLocalizedDescriptionKey: "Failed to create speed-adjusted video track"])
            }
            
            let timeRange = sourceVideoTrack.timeRange
            try videoTrack.insertTimeRange(timeRange, of: sourceVideoTrack, at: CMTime.zero)
            videoTrack.preferredTransform = sourceVideoTrack.preferredTransform
            
            // Scale video time
            let scaledDuration = CMTime(
                value: Int64(Double(timeRange.duration.value) / Double(speedFactor)),
                timescale: timeRange.duration.timescale
            )
            videoTrack.scaleTimeRange(
                CMTimeRange(start: CMTime.zero, duration: timeRange.duration),
                toDuration: scaledDuration
            )
        }
        
        // Add audio track with pitch preservation
        if let sourceAudioTrack = composition.tracks(withMediaType: .audio).first {
            guard let audioTrack = speedComposition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
                throw NSError(domain: "VideoPostprocess", code: 8, userInfo: [NSLocalizedDescriptionKey: "Failed to create speed-adjusted audio track"])
            }
            
            let timeRange = sourceAudioTrack.timeRange
            try audioTrack.insertTimeRange(timeRange, of: sourceAudioTrack, at: CMTime.zero)
            
            // Scale audio time
            let scaledDuration = CMTime(
                value: Int64(Double(timeRange.duration.value) / Double(speedFactor)),
                timescale: timeRange.duration.timescale
            )
            audioTrack.scaleTimeRange(
                CMTimeRange(start: CMTime.zero, duration: timeRange.duration),
                toDuration: scaledDuration
            )
        }
        
        return speedComposition
    }
}
