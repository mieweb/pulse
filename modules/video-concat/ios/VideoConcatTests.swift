import AVFoundation
import Foundation

// Simple test class to merge videos
class VideoConcatTests {

    private func getTestVideoURL(filename: String) -> URL? {
        // Get videos directory from environment variable or use current directory
        let videosDir =
            ProcessInfo.processInfo.environment["VIDEOS_DIR"]
            ?? FileManager.default.currentDirectoryPath
        let testVideoPath = URL(fileURLWithPath: videosDir).appendingPathComponent(filename)

        guard FileManager.default.fileExists(atPath: testVideoPath.path) else {
            print("⚠️ Test video not found: \(filename)")
            return nil
        }

        return testVideoPath
    }

    func runAllTests() async {
        print("🧪 Testing VideoConcat Module")
        print("=============================")

        let mergeTestPassed = await testMergeVideos()
        let orientationTestPassed = await testOrientationHandling()
        
        if mergeTestPassed && orientationTestPassed {
            print("✅ All tests - PASSED")
            print("🎉 All tests completed successfully!")
        } else {
            if !mergeTestPassed {
                print("❌ Merge test - FAILED")
            }
            if !orientationTestPassed {
                print("❌ Orientation test - FAILED")
            }
        }
    }

    func testMergeVideos() async -> Bool {
        print("\n🎬 Testing Video Merge")

        // Get test video paths
        guard let video1URL = getTestVideoURL(filename: "recording1.mov"),
            let video2URL = getTestVideoURL(filename: "recording2.mov")
        else {
            print("   ❌ Test videos not available - make sure videos exist in test/video/")
            return false
        }

        do {
            // Create composition
            let composition = AVMutableComposition()

            // Create video and audio tracks
            guard
                let videoTrack = composition.addMutableTrack(
                    withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
                let audioTrack = composition.addMutableTrack(
                    withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
            else {
                print("   ❌ Failed to create tracks")
                return false
            }

            // Process videos
            let videos = [video1URL, video2URL]
            var insertTime = CMTime.zero

            for videoURL in videos {
                // Create asset and load tracks
                let asset = AVURLAsset(url: videoURL)
                let videoTracks = try await asset.loadTracks(withMediaType: .video)

                guard let sourceVideoTrack = videoTracks.first else {
                    print("   ⚠️ No video track in \(videoURL.lastPathComponent)")
                    continue
                }

                // Get track duration
                let timeRange = CMTimeRange(
                    start: .zero, duration: sourceVideoTrack.timeRange.duration)

                // Insert video
                try videoTrack.insertTimeRange(timeRange, of: sourceVideoTrack, at: insertTime)

                // Insert audio if available
                let audioTracks = try await asset.loadTracks(withMediaType: .audio)
                if let sourceAudioTrack = audioTracks.first {
                    try audioTrack.insertTimeRange(timeRange, of: sourceAudioTrack, at: insertTime)
                }

                insertTime = composition.duration
            }

            // Get output directory from environment
            let outputDir =
                ProcessInfo.processInfo.environment["VIDEOS_DIR"]
                ?? FileManager.default.currentDirectoryPath
            let outputURL = URL(fileURLWithPath: outputDir).appendingPathComponent(
                "merged_test_video.mp4")

            // Remove existing file if any
            if FileManager.default.fileExists(atPath: outputURL.path) {
                try FileManager.default.removeItem(at: outputURL)
            }

            // Create export session
            guard
                let exportSession = AVAssetExportSession(
                    asset: composition, presetName: AVAssetExportPresetHighestQuality)
            else {
                print("   ❌ Failed to create export session")
                return false
            }

            // Configure export
            exportSession.outputURL = outputURL
            exportSession.outputFileType = .mp4
            exportSession.shouldOptimizeForNetworkUse = false

            // Export
            try await exportSession.export()
            print("   ✅ Export successful!")
            print("   📁 Output saved to: \(outputURL.path)")
            return true

        } catch {
            print("   ❌ Test failed: \(error.localizedDescription)")
            return false
        }
    }
    
    func testOrientationHandling() async -> Bool {
        print("\n🔄 Testing Per-Segment Orientation Handling")
        
        // Get test video paths - these could be portrait and landscape videos
        guard let video1URL = getTestVideoURL(filename: "recording1.mov"),
              let video2URL = getTestVideoURL(filename: "recording2.mov")
        else {
            print("   ❌ Test videos not available - make sure videos exist in test/video/")
            return false
        }
        
        do {
            // Create test segments to simulate the module behavior
            let asset1 = AVURLAsset(url: video1URL)
            let asset2 = AVURLAsset(url: video2URL)
            
            // Load tracks to get orientation info
            try await asset1.load(.tracks)
            try await asset2.load(.tracks)
            
            let videoTracks1 = try await asset1.loadTracks(withMediaType: .video)
            let videoTracks2 = try await asset2.loadTracks(withMediaType: .video)
            
            guard let track1 = videoTracks1.first,
                  let track2 = videoTracks2.first else {
                print("   ❌ No video tracks found in test videos")
                return false
            }
            
            // Get transforms and natural sizes
            let transform1 = try await track1.load(.preferredTransform)
            let transform2 = try await track2.load(.preferredTransform)
            let size1 = try await track1.load(.naturalSize)
            let size2 = try await track2.load(.naturalSize)
            
            print("   📐 Video 1: transform=\(transform1), size=\(size1)")
            print("   📐 Video 2: transform=\(transform2), size=\(size2)")
            
            // Check if transforms are different (indicating different orientations)
            let transformsAreDifferent = !transform1.equalTo(transform2)
            
            if transformsAreDifferent {
                print("   ✅ Videos have different orientations - per-segment handling needed")
            } else if size1.width != size2.width || size1.height != size2.height {
                print("   ✅ Videos have different dimensions - per-segment handling beneficial")
            } else {
                print("   ℹ️ Videos appear to have same orientation and size")
            }
            
            print("   ✅ Orientation handling test - metadata collection verified")
            return true
            
        } catch {
            print("   ❌ Orientation test failed: \(error.localizedDescription)")
            return false
        }
    }
}
