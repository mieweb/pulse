import ExpoModulesCore
import ReplayKit
import AVFoundation

/// Native module for iOS screen recording with audio-gated video capture.
/// Uses ReplayKit to record the screen and only includes video segments when audio is above a threshold.
public class ScreenRecorderModule: Module {
    
    // Shared container identifier for communication between app and broadcast extension
    private let appGroupIdentifier = "group.com.mieweb.pulse.screenrecorder"
    
    public func definition() -> ModuleDefinition {
        Name("ScreenRecorder")
        
        /// Starts the system screen recording picker
        /// This presents the iOS system UI to select and start a broadcast
        AsyncFunction("startScreenRecording") { (promise: Promise) in
            DispatchQueue.main.async {
                self.showBroadcastPicker(promise: promise)
            }
        }
        
        /// Gets the path to the last recorded video file
        /// Returns nil if no recording exists
        AsyncFunction("getLastRecordingPath") { () -> String? in
            return self.getLastRecordingFilePath()
        }
        
        /// Checks if a recording is currently in progress
        Function("isRecording") { () -> Bool in
            return self.checkIfRecording()
        }
    }
    
    /// Shows the ReplayKit broadcast picker UI
    private func showBroadcastPicker(promise: Promise) {
        guard let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
              let window = windowScene.windows.first,
              let rootViewController = window.rootViewController else {
            promise.reject("PICKER_ERROR", "Unable to get root view controller")
            return
        }
        
        // Create the broadcast picker view
        let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 50, height: 50))
        
        // Set the preferred extension bundle identifier
        // This will be updated once we create the broadcast extension
        picker.preferredExtension = "com.mieweb.pulse.BroadcastExtension"
        
        // Show the picker
        picker.showsMicrophoneButton = false
        
        // Add picker to view hierarchy temporarily to trigger it
        rootViewController.view.addSubview(picker)
        
        // Programmatically trigger the button
        for view in picker.subviews {
            if let button = view as? UIButton {
                button.sendActions(for: .allTouchEvents)
                break
            }
        }
        
        // Remove picker after a short delay
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            picker.removeFromSuperview()
        }
        
        promise.resolve(true)
    }
    
    /// Gets the file path of the last recording from the shared container
    private func getLastRecordingFilePath() -> String? {
        guard let containerURL = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupIdentifier
        ) else {
            print("[ScreenRecorder] Unable to access app group container")
            return nil
        }
        
        let recordingsPath = containerURL.appendingPathComponent("Recordings")
        
        // Get the most recent recording
        do {
            let files = try FileManager.default.contentsOfDirectory(
                at: recordingsPath,
                includingPropertiesForKeys: [.creationDateKey],
                options: [.skipsHiddenFiles]
            )
            
            let sortedFiles = files.sorted { url1, url2 in
                let date1 = try? url1.resourceValues(forKeys: [.creationDateKey]).creationDate
                let date2 = try? url2.resourceValues(forKeys: [.creationDateKey]).creationDate
                return (date1 ?? Date.distantPast) > (date2 ?? Date.distantPast)
            }
            
            return sortedFiles.first?.path
        } catch {
            print("[ScreenRecorder] Error reading recordings directory: \(error)")
            return nil
        }
    }
    
    /// Checks if a recording is currently in progress by checking shared UserDefaults
    private func checkIfRecording() -> Bool {
        guard let sharedDefaults = UserDefaults(suiteName: appGroupIdentifier) else {
            return false
        }
        return sharedDefaults.bool(forKey: "isRecording")
    }
}
