import ExpoModulesCore
import AVFoundation

struct RecordingSegment: Record {
    @Field
    var uri: String
}

public class VideoConcatModule: Module {
    
    public func definition() -> ModuleDefinition {
        Name("VideoConcat")
        
        AsyncFunction("export") { (segments: [RecordingSegment]) -> String in
            let composition = AVMutableComposition()
            
            guard let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
                  let audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
                throw NSError(domain: "VideoConcat", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to create tracks"])
            }
            
            var currentTime = CMTime.zero
            
            for segment in segments {
                guard let url = URL(string: segment.uri) else { continue }
                let asset = AVAsset(url: url)
                let timeRange = CMTimeRange(start: .zero, duration: asset.duration)
                
                if let assetVideoTrack = asset.tracks(withMediaType: .video).first {
                    try? videoTrack.insertTimeRange(timeRange, of: assetVideoTrack, at: currentTime)
                }
                if let assetAudioTrack = asset.tracks(withMediaType: .audio).first {
                    try? audioTrack.insertTimeRange(timeRange, of: assetAudioTrack, at: currentTime)
                }
                
                currentTime = currentTime + asset.duration
            }
            
            let outputURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension("mp4")
            
            guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
                throw NSError(domain: "VideoConcat", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to create export session"])
            }
            
            exporter.outputURL = outputURL
            exporter.outputFileType = .mp4
            
            try await withCheckedThrowingContinuation { continuation in
                exporter.exportAsynchronously {
                    if exporter.status == .completed {
                        continuation.resume()
                    } else {
                        continuation.resume(throwing: NSError(domain: "VideoConcat", code: 3, userInfo: [NSLocalizedDescriptionKey: "Export failed"]))
                    }
                }
            }
            
            return outputURL.absoluteString
        }
    }
}
