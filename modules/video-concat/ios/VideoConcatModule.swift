import ExpoModulesCore
import AVFoundation

/// Represents a video segment with optional trimming points
struct RecordingSegment: Record {
    @Field
    var uri: String
    @Field
    var inMs: Double? = nil
    @Field
    var outMs: Double? = nil
}

/// Native module for concatenating multiple video segments into a single video file.
/// Handles orientation preservation and maintains video/audio quality during concatenation.
public class VideoConcatModule: Module {
    
    public func definition() -> ModuleDefinition {
        Name("VideoConcat")
        
        Events("onProgress")
        
        AsyncFunction("export") { (segments: [RecordingSegment], draftId: String) -> String in
            
            // Create a mutable composition to hold the concatenated video
            let composition = AVMutableComposition()
            
            // Create video and audio tracks for the composition
            guard let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
                  let audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
                throw NSError(domain: "VideoConcat", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to create tracks"])
            }
            
            // Process each video segment and add it to the composition
            var currentTime = CMTime.zero
            
            // Send initial progress
            self.sendEvent("onProgress", [
                "progress": 0.0,
                "currentSegment": 0,
                "phase": "preparing"
            ])
            
            for (index, segment) in segments.enumerated() {
                guard let url = URL(string: segment.uri) else { continue }
                
                // Load the video asset and its tracks
                let asset = AVURLAsset(url: url)
                let videoTracks = try await asset.loadTracks(withMediaType: .video)
                
                guard let sourceVideoTrack = videoTracks.first else {
                    continue
                }
                
                // Load track properties for proper handling
                let naturalSize = try await sourceVideoTrack.load(.naturalSize)
                let preferredTransform = try await sourceVideoTrack.load(.preferredTransform)
                let fullTimeRange = try await sourceVideoTrack.load(.timeRange)
                
                // Calculate the time range based on in/out points
                let timeRange = calculateTimeRange(
                    fullRange: fullTimeRange,
                    inMs: segment.inMs,
                    outMs: segment.outMs
                )
                
                // Insert the video track into the composition at the current time
                try videoTrack.insertTimeRange(timeRange, of: sourceVideoTrack, at: currentTime)
                
                // Insert audio track if available
                // Use the audio track's own timeRange to avoid AAC stream corruption
                let audioTracks = try await asset.loadTracks(withMediaType: .audio)
                if let sourceAudioTrack = audioTracks.first {
                    // Get the audio track's actual time range (may have different timescale than video)
                    let audioFullTimeRange = try await sourceAudioTrack.load(.timeRange)
                    
                    // Calculate the audio trim range using the same in/out points but with audio's timescale
                    let audioTrimRange = calculateTimeRange(
                        fullRange: audioFullTimeRange,
                        inMs: segment.inMs,
                        outMs: segment.outMs
                    )
                    
                    try audioTrack.insertTimeRange(audioTrimRange, of: sourceAudioTrack, at: currentTime)
                }
                
                // Move to the next time position for the next segment
                currentTime = currentTime + timeRange.duration
                
                // Send progress update for this segment
                let segmentProgress = Double(index + 1) / Double(segments.count) * 0.8 // 80% for processing
                self.sendEvent("onProgress", [
                    "progress": segmentProgress,
                    "currentSegment": index + 1,
                    "phase": "processing"
                ])
            }
            
            // Apply the preferred transform from the first video to maintain orientation
            // This ensures the final video has the correct orientation
            if let firstSegment = segments.first,
               let firstURL = URL(string: firstSegment.uri) {
                let firstAsset = AVURLAsset(url: firstURL)
                let firstVideoTracks = try await firstAsset.loadTracks(withMediaType: .video)
                if let firstVideoTrack = firstVideoTracks.first {
                    let firstTransform = try await firstVideoTrack.load(.preferredTransform)
                    videoTrack.preferredTransform = firstTransform
                }
            }
            
            // Create output URL for the merged video using draftId
            let outputURL = FileManager.default.temporaryDirectory.appendingPathComponent(draftId).appendingPathExtension("mp4")
            
            // Remove existing file if it exists to avoid conflicts
            if FileManager.default.fileExists(atPath: outputURL.path) {
                try FileManager.default.removeItem(at: outputURL)
            }
            
            // Create export session with highest quality preset
            guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
                throw NSError(domain: "VideoConcat", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to create export session"])
            }
            
            
            // Configure export settings
            exporter.outputURL = outputURL
            exporter.outputFileType = .mp4
            exporter.shouldOptimizeForNetworkUse = false
            
            // Send finalizing progress
            self.sendEvent("onProgress", [
                "progress": 0.9,
                "currentSegment": segments.count,
                "phase": "finalizing"
            ])
            
            // Export the composition to MP4 file
            try await exporter.export()

            // Verify export was successful
            guard exporter.status == .completed else {
                throw NSError(domain: "VideoConcat", code: 3, userInfo: [NSLocalizedDescriptionKey: "Export failed with status: \(exporter.status.rawValue)"])
            }
            
            // Return the file URL as a string
            return outputURL.absoluteString
        }
    }
    
    /// Calculates the time range for a segment based on in/out points
    /// - Parameters:
    ///   - fullRange: The full time range of the video track
    ///   - inMs: Optional start time in milliseconds (Double for precision)
    ///   - outMs: Optional end time in milliseconds (Double for precision)
    /// - Returns: The calculated time range for trimming
    private func calculateTimeRange(
        fullRange: CMTimeRange,
        inMs: Double?,
        outMs: Double?
    ) -> CMTimeRange {
        let trackTimescale = fullRange.start.timescale
        let fullDuration = fullRange.duration
        
        // Convert milliseconds to CMTime
        let startTime: CMTime
        if let inMs = inMs {
            let startValue = Int64(Double(inMs) * Double(trackTimescale) / 1000.0)
            startTime = CMTime(value: startValue, timescale: trackTimescale)
        } else {
            startTime = fullRange.start
        }
        
        let endTime: CMTime
        if let outMs = outMs {
            let endValue = Int64(Double(outMs) * Double(trackTimescale) / 1000.0)
            endTime = CMTime(value: endValue, timescale: trackTimescale)
        } else {
            endTime = fullRange.start + fullDuration
        }
        
        // Clamp values to valid range
        let clampedStart = max(startTime, fullRange.start)
        let clampedEnd = min(endTime, fullRange.start + fullDuration)
        
        // Ensure start is before end
        let finalStart = min(clampedStart, clampedEnd)
        let finalEnd = max(clampedStart, clampedEnd)
        
        return CMTimeRange(start: finalStart, duration: finalEnd - finalStart)
    }
}
