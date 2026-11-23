#!/bin/sh
# Adds the Info.plist keys PulseKit needs to the generated iOS app. Run it after `npx cap add ios`
# (the ios/ folder is generated and never committed).
#   - Camera and microphone strings: without them `open` answers host_misconfigured.
#   - Photos add string: without it PulseKit drops the saveToPhotos capability.
#   - View-controller-based status bar: PulseKit's container sets the status bar while it is open.
set -eu
cd "$(dirname "$0")/.."
PLIST=${1:-ios/App/App/Info.plist}
if [ ! -f "$PLIST" ]; then
  echo "No $PLIST: run 'npx cap add ios' first." >&2
  exit 1
fi

set_key() {
  /usr/libexec/PlistBuddy -c "Delete :$1" "$PLIST" >/dev/null 2>&1 || true
  /usr/libexec/PlistBuddy -c "Add :$1 $2 $3" "$PLIST"
}

set_key NSCameraUsageDescription string "'Pulse records video.'"
set_key NSMicrophoneUsageDescription string "'Pulse records sound with the video.'"
set_key NSPhotoLibraryUsageDescription string "'Pulse imports videos from Photos.'"
set_key NSPhotoLibraryAddUsageDescription string "'Pulse saves videos to Photos.'"
set_key UIViewControllerBasedStatusBarAppearance bool true
echo "Updated $PLIST"
