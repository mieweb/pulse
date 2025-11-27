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
        
        /// Gets the exact duration of a video from AVFoundation
        /// Returns full duration if no trim points, or trimmed duration if trim points are provided
        AsyncFunction("getVideoDuration") { (uri: String, inMs: Double?, outMs: Double?) -> Double in
            guard let url = URL(string: uri) else {
                throw NSError(domain: "VideoDuration", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid URL"])
            }
            
            let asset = AVURLAsset(url: url)
            let videoTracks = try await asset.loadTracks(withMediaType: .video)
            
            guard let videoTrack = videoTracks.first else {
                throw NSError(domain: "VideoDuration", code: 2, userInfo: [NSLocalizedDescriptionKey: "No video track found"])
            }
            
            let fullTimeRange = try await videoTrack.load(.timeRange)
            let assetDuration = try await asset.load(.duration)
            
            // If trim points exist, calculate trimmed duration using calculateTimeRange
            if inMs != nil || outMs != nil {
                let timeRange = self.calculateTimeRange(
                    fullRange: fullTimeRange,
                    assetDuration: assetDuration,
                    inMs: inMs,
                    outMs: outMs
                )
                return CMTimeGetSeconds(timeRange.duration)
            } else {
                // Return full duration from AVFoundation
                return CMTimeGetSeconds(fullTimeRange.duration)
            }
        }
        
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
                
                // Also load asset duration to ensure we have the correct reference
                let assetDuration = try await asset.load(.duration)
                
                // Calculate the time range based on in/out points
                let timeRange = calculateTimeRange(
                    fullRange: fullTimeRange,
                    assetDuration: assetDuration,
                    inMs: segment.inMs,
                    outMs: segment.outMs
                )
                
                // Insert the video track into the composition at the current time
                try videoTrack.insertTimeRange(timeRange, of: sourceVideoTrack, at: currentTime)
                
                // Insert audio track if available
                let audioTracks = try await asset.loadTracks(withMediaType: .audio)
                if let sourceAudioTrack = audioTracks.first {
                    try audioTrack.insertTimeRange(timeRange, of: sourceAudioTrack, at: currentTime)
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
    ///   - assetDuration: The duration of the asset (for reference)
    ///   - inMs: Optional start time in milliseconds (Double for precision) - relative to video start (0ms)
    ///   - outMs: Optional end time in milliseconds (Double for precision) - relative to video start (0ms)
    /// - Returns: The calculated time range for trimming (relative to track's own timeline)
    private func calculateTimeRange(
        fullRange: CMTimeRange,
        assetDuration: CMTime,
        inMs: Double?,
        outMs: Double?
    ) -> CMTimeRange {
        // The track's timeRange tells us where the track is in the asset
        // fullRange.start = where track starts in asset timeline (usually 0)
        // fullRange.duration = length of track (usually equals asset duration)
        // For insertTimeRange, we need offsets relative to the track's own timeline
        
        let trackStartInAsset = fullRange.start
        let trackDuration = fullRange.duration
        let trackTimescale = trackStartInAsset.timescale
        
        // Use high precision timescale (1000 = millisecond precision) for conversion
        // Then convert to track's timescale to avoid precision loss
        let precisionTimescale: Int32 = 1000
        
        // Convert milliseconds to CMTime with high precision, then convert to track's timescale
        // inMs/outMs are relative to video start (0ms)
        // For insertTimeRange, we need offsets relative to the track's own timeline (starts at 0)
        // The track's timeRange.start tells us where the track starts in the asset timeline
        // If track starts at T in asset, and we want content at time X (relative to video start),
        // the offset in the track's timeline is X - T (but typically T = 0, so offset = X)
        
        let trimStart: CMTime
        if let inMs = inMs {
            // Convert milliseconds to CMTime with high precision
            // First use millisecond precision timescale
            let preciseValue = Int64(inMs * Double(precisionTimescale) / 1000.0)
            let preciseTime = CMTime(value: preciseValue, timescale: precisionTimescale)
            // Convert to track's timescale for accurate insertion
            let timeInTrackTimescale = CMTimeConvertScale(preciseTime, timescale: trackTimescale, method: .roundHalfAwayFromZero)
            
            // Calculate offset from track start
            // If trackStartInAsset is 0 (typical), offset is just timeInTrackTimescale
            // Otherwise, we need to subtract the track start
            if trackStartInAsset.value == 0 {
                trimStart = timeInTrackTimescale
            } else {
                // Ensure both are in same timescale before subtracting
                let trackStartScaled = CMTimeConvertScale(trackStartInAsset, timescale: trackTimescale, method: .roundHalfAwayFromZero)
                trimStart = timeInTrackTimescale - trackStartScaled
            }
        } else {
            trimStart = CMTime.zero
        }
        
        let trimEnd: CMTime
        if let outMs = outMs {
            // Same logic as trimStart
            let preciseValue = Int64(outMs * Double(precisionTimescale) / 1000.0)
            let preciseTime = CMTime(value: preciseValue, timescale: precisionTimescale)
            let timeInTrackTimescale = CMTimeConvertScale(preciseTime, timescale: trackTimescale, method: .roundHalfAwayFromZero)
            
            if trackStartInAsset.value == 0 {
                trimEnd = timeInTrackTimescale
            } else {
                let trackStartScaled = CMTimeConvertScale(trackStartInAsset, timescale: trackTimescale, method: .roundHalfAwayFromZero)
                trimEnd = timeInTrackTimescale - trackStartScaled
            }
        } else {
            // Use track duration (not asset duration) as it's what we're actually working with
            trimEnd = trackDuration
        }
        
        // Clamp to valid range (0 to trackDuration)
        // These offsets are relative to the track's start (which is 0 in the track's own timeline)
        let clampedStart = max(trimStart, CMTime.zero)
        let clampedEnd = min(trimEnd, trackDuration)
        
        // Ensure start is before end
        let finalStart = min(clampedStart, clampedEnd)
        let finalEnd = max(clampedStart, clampedEnd)
        
        // Calculate duration
        let duration = finalEnd - finalStart
        
        // Return time range relative to track's own timeline
        // insertTimeRange expects: start = offset from track start, duration = length to insert
        return CMTimeRange(start: finalStart, duration: duration)
    }
}
