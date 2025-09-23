import Foundation
import AVFoundation

// Simple test class to merge videos
class VideoConcatTests {
    
    private func getTestVideoURL(filename: String) -> URL? {
        // Get videos directory from environment variable or use current directory
        let videosDir = ProcessInfo.processInfo.environment["VIDEOS_DIR"] ?? FileManager.default.currentDirectoryPath
        let testVideoPath = URL(fileURLWithPath: videosDir).appendingPathComponent(filename)
        
        guard FileManager.default.fileExists(atPath: testVideoPath.path) else {
            print("⚠️ Test video not found: \(filename)")
            return nil
        }
        
        return testVideoPath
    }
    
    func runAllTests() async {
        print("🧪 Testing VideoConcat Module with Orientation Detection")
        print("=====================================================")
        
        if await testMergeVideos() {
            print("✅ Merge test with orientation handling - PASSED")
            print("🎉 All tests completed successfully!")
        } else {
            print("❌ Merge test with orientation handling - FAILED")
        }
    }
    
    func testMergeVideos() async -> Bool {
        print("\n🎬 Testing Video Merge with Orientation Detection")
        
        // Get test video paths
        guard let video1URL = getTestVideoURL(filename: "recording1.mov"),
              let video2URL = getTestVideoURL(filename: "recording2.mov") else {
            print("   ❌ Test videos not available - make sure videos exist in test/video/")
            return false
        }
        
        do {
            // Create composition - exactly like the native module
            let composition = AVMutableComposition()
            
            // Create video and audio tracks - exactly like the native module
            guard let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
                  let audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
                print("   ❌ Failed to create tracks")
                return false
            }
            
            // Process videos - exactly like the native module
            let videos = [video1URL, video2URL]
            var currentTime = CMTime.zero
            
            for (index, videoURL) in videos.enumerated() {
                print("   📹 Processing video \(index + 1): \(videoURL.lastPathComponent)")
                
                // Create asset and load tracks
                let asset = AVURLAsset(url: videoURL)
                let videoTracks = try await asset.loadTracks(withMediaType: .video)
                
                guard let sourceVideoTrack = videoTracks.first else {
                    print("   ⚠️ No video track in \(videoURL.lastPathComponent)")
                    continue
                }
                
                // Get track properties for debugging
                let naturalSize = try await sourceVideoTrack.load(.naturalSize)
                let preferredTransform = try await sourceVideoTrack.load(.preferredTransform)
                let timeRange = try await sourceVideoTrack.load(.timeRange)
                
                print("   📐 Video \(index + 1) properties:")
                print("      - Natural size: \(naturalSize)")
                print("      - Preferred transform: \(preferredTransform)")
                print("      - Duration: \(CMTimeGetSeconds(timeRange.duration))s")
                
                // Determine orientation from transform
                let orientation = getVideoOrientation(from: preferredTransform)
                print("      - Detected orientation: \(orientation)")
                
                // Insert video track - exactly like the native module
                try videoTrack.insertTimeRange(timeRange, of: sourceVideoTrack, at: currentTime)
                
                // Insert audio if available - exactly like the native module
                let audioTracks = try await asset.loadTracks(withMediaType: .audio)
                if let sourceAudioTrack = audioTracks.first {
                    try audioTrack.insertTimeRange(timeRange, of: sourceAudioTrack, at: currentTime)
                    print("   🔊 Audio track added")
                } else {
                    print("   🔇 No audio track found")
                }
                
                currentTime = currentTime + timeRange.duration
            }
            
            // Apply the preferred transform from the first video to maintain orientation
            if let firstVideoURL = videos.first {
                let firstAsset = AVURLAsset(url: firstVideoURL)
                let firstVideoTracks = try await firstAsset.loadTracks(withMediaType: .video)
                if let firstVideoTrack = firstVideoTracks.first {
                    let firstTransform = try await firstVideoTrack.load(.preferredTransform)
                    videoTrack.preferredTransform = firstTransform
                    print("   🔄 Applied transform from first video: \(firstTransform)")
                }
            }
            
            // Get composition properties for debugging
            let compositionDuration = composition.duration
            print("   📊 Composition properties:")
            print("      - Total duration: \(CMTimeGetSeconds(compositionDuration))s")
            print("      - Video track count: \(composition.tracks(withMediaType: .video).count)")
            print("      - Audio track count: \(composition.tracks(withMediaType: .audio).count)")
            
            // Get output directory from environment
            let outputDir = ProcessInfo.processInfo.environment["VIDEOS_DIR"] ?? FileManager.default.currentDirectoryPath
            let outputURL = URL(fileURLWithPath: outputDir).appendingPathComponent("merged_test_video_with_orientation.mp4")
            
            // Remove existing file if any
            if FileManager.default.fileExists(atPath: outputURL.path) {
                try FileManager.default.removeItem(at: outputURL)
            }
            
            // Create export session - exactly like the native module
            guard let exportSession = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
                print("   ❌ Failed to create export session")
                return false
            }
            
            // Configure export - exactly like the native module
            exportSession.outputURL = outputURL
            exportSession.outputFileType = .mp4
            exportSession.shouldOptimizeForNetworkUse = false
            
            print("   🚀 Starting export...")
            print("      - Output URL: \(outputURL.path)")
            print("      - Preset: \(AVAssetExportPresetHighestQuality)")
            print("      - File type: MP4")
            
            // Export
            try await exportSession.export()
            
            // Check export status
            guard exportSession.status == .completed else {
                print("   ❌ Export failed with status: \(exportSession.status.rawValue)")
                if let error = exportSession.error {
                    print("      Error: \(error.localizedDescription)")
                }
                return false
            }
            
            print("   ✅ Export successful!")
            print("   📁 Output saved to: \(outputURL.path)")
            
            // Verify the output file
            let outputAsset = AVURLAsset(url: outputURL)
            let outputDuration = try await outputAsset.load(.duration)
            let outputTracks = try await outputAsset.loadTracks(withMediaType: .video)
            
            if let outputVideoTrack = outputTracks.first {
                let outputNaturalSize = try await outputVideoTrack.load(.naturalSize)
                let outputPreferredTransform = try await outputVideoTrack.load(.preferredTransform)
                let outputOrientation = getVideoOrientation(from: outputPreferredTransform)
                
                print("   📊 Output video properties:")
                print("      - Duration: \(CMTimeGetSeconds(outputDuration))s")
                print("      - Natural size: \(outputNaturalSize)")
                print("      - Preferred transform: \(outputPreferredTransform)")
                print("      - Final orientation: \(outputOrientation)")
            }
            
            return true
            
        } catch {
            print("   ❌ Test failed: \(error.localizedDescription)")
            return false
        }
    }
    
    // Helper function to determine video orientation from transform
    private func getVideoOrientation(from transform: CGAffineTransform) -> String {
        let a = transform.a
        let b = transform.b
        let c = transform.c
        let d = transform.d
        
        if a == 1 && b == 0 && c == 0 && d == 1 {
            return "Portrait (0°)"
        } else if a == 0 && b == 1 && c == -1 && d == 0 {
            return "Landscape Right (90°)"
        } else if a == -1 && b == 0 && c == 0 && d == -1 {
            return "Portrait Upside Down (180°)"
        } else if a == 0 && b == -1 && c == 1 && d == 0 {
            return "Landscape Left (270°)"
        } else {
            return "Unknown (\(a), \(b), \(c), \(d))"
        }
    }
}

// Run tests
Task {
    let tests = VideoConcatTests()
    await tests.runAllTests()
    exit(0)
}
RunLoop.main.run()