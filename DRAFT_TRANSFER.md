# Draft Transfer Guide

This guide explains how to transfer your Pulse drafts between devices or back them up for safekeeping.

## Overview

Pulse drafts are stored locally on your device for privacy and security. However, you can manually transfer drafts between devices or create backups using the built-in export/import features.

## Methods for Transferring Drafts

### 1. iOS Device Transfer (Automatic)

When you transfer data from an old iPhone to a new iPhone using Apple's built-in transfer process:

**What gets transferred:**
- ✅ App settings and preferences
- ✅ Draft video files (stored in app's Documents directory)
- ✅ Draft metadata (stored in AsyncStorage)

**Requirements:**
- Pulse version with file sharing enabled (UIFileSharingEnabled)
- iOS device transfer via:
  - Quick Start (direct device-to-device transfer)
  - iCloud Backup
  - iTunes/Finder Backup

**Note:** For the automatic transfer to work properly, ensure you're using the latest version of Pulse that includes the iOS file sharing configuration.

### 2. Manual Export/Import (Recommended for Collaboration)

Use the built-in export/import features in Pulse to manually transfer drafts between devices or share with collaborators.

#### Exporting a Single Draft

1. Open Pulse and navigate to the **Drafts** screen
2. Tap the **share icon** (📤) next to the draft you want to export
3. Choose how you want to share:
   - **AirDrop**: Send to a nearby iOS/macOS device
   - **Files**: Save to iCloud Drive or local Files
   - **Messages/Email**: Send via messaging apps

The draft will be exported as a `.pulse` file containing:
- Draft metadata (segments, duration, name, timestamps)
- All video segments
- Thumbnail image

#### Exporting All Drafts (Backup)

1. Open Pulse and navigate to the **Drafts** screen
2. Tap the **Export All** button at the top
3. Confirm you want to export all drafts
4. Choose your destination (AirDrop, Files, etc.)

This creates a single backup file containing all your drafts.

#### Importing Drafts

1. Open Pulse and navigate to the **Drafts** screen
2. Tap the **Import** button at the top
3. Select the `.pulse` file (either single draft or backup)
4. The draft(s) will be imported and appear in your drafts list

**Note:** Imported drafts are assigned new IDs to avoid conflicts with existing drafts.

### 3. WiFi/Local Network Transfer (Planned)

Future versions will support direct WiFi transfer between devices on the same network:
- Automatic device discovery
- Peer-to-peer transfer without cloud
- Collaborative editing across multiple devices

## Use Cases

### Transferring to a New iPhone

**Option A: Use Apple's Device Transfer**
1. During iPhone setup, choose "Transfer from iPhone"
2. Follow Apple's setup process
3. After transfer completes, open Pulse
4. Your drafts should appear automatically

**Option B: Manual Export/Import**
1. On old iPhone: Export all drafts to Files/iCloud Drive
2. On new iPhone: Install Pulse
3. Open Pulse, go to Drafts screen
4. Tap Import and select your backup file

### Sharing Drafts with Collaborators

1. Export the draft you want to share
2. Send via AirDrop to a nearby colleague
3. They import it into their Pulse app
4. Both can work on the draft independently

### Creating Regular Backups

1. Periodically tap "Export All" in the Drafts screen
2. Save to iCloud Drive or another cloud storage
3. Keep multiple backup versions if needed

### Working Across iPad and iPhone

1. Export draft from iPhone
2. AirDrop to iPad
3. Import on iPad
4. Work on the draft
5. Export and send back to iPhone when done

## File Format

Pulse draft files (`.pulse`) are JSON files containing:

```json
{
  "version": "1.0",
  "draft": {
    "id": "...",
    "mode": "camera",
    "segments": [...],
    "totalDuration": 60,
    "createdAt": "...",
    "lastModified": "...",
    "thumbnail": "...",
    "name": "..."
  },
  "files": {
    "pulse/drafts/{id}/segments/{segment}.mp4": "base64...",
    "pulse/drafts/{id}/thumbs/thumb.jpg": "base64..."
  }
}
```

Backup files contain multiple draft packages keyed by draft ID.

## Technical Details

### Storage Locations

**iOS:**
- Draft metadata: `AsyncStorage` (stored in app's Library/Preferences)
- Video files: `FileSystem.documentDirectory/pulse/drafts/{draftId}/`
- Temporary exports: `FileSystem.cacheDirectory/exports/`

**What's Backed Up by iOS:**
- When `UIFileSharingEnabled` is set to `true`, the app's Documents directory is included in device backups
- AsyncStorage data is included in app backups by default

### Privacy & Security

- All drafts remain local until you explicitly export them
- Exported files are not encrypted (they contain your video content)
- Consider the security of your sharing method (AirDrop, email, etc.)
- No data is sent to cloud servers without your action

### File Sizes

Draft export files can be large:
- Single segment (15s): ~5-15 MB
- Full draft (60s): ~20-80 MB
- Backup of multiple drafts: Cumulative size

Ensure you have sufficient storage and bandwidth when sharing.

## Troubleshooting

### Drafts didn't transfer to new iPhone

1. Verify you're using latest Pulse version on both devices
2. Try manual export/import method instead
3. Check if device transfer completed successfully
4. Ensure sufficient storage on new device

### Import fails with error

1. Verify the file is a valid `.pulse` file
2. Ensure you have sufficient storage space
3. Try importing one draft at a time
4. Check that video segments aren't corrupted

### Exported file is too large to share

1. Export individual drafts instead of all at once
2. Use WiFi transfer methods (iCloud Drive) instead of cellular
3. Compress before sending via email
4. Delete unused segments from drafts before exporting

## Best Practices

1. **Regular Backups**: Export all drafts weekly to iCloud Drive
2. **Before Device Transfer**: Create a manual backup just in case
3. **Name Your Drafts**: Makes it easier to find specific drafts later
4. **Clean Up Old Drafts**: Delete unused drafts to reduce backup size
5. **Test Imports**: After importing, verify videos play correctly

## Future Enhancements

Planned improvements for draft transfer:
- [ ] WiFi direct transfer between devices
- [ ] Bonjour/mDNS device discovery
- [ ] Incremental sync for changed drafts
- [ ] QR code pairing for quick transfer
- [ ] Selective export (choose specific drafts)
- [ ] Compressed export format option
- [ ] Cloud sync option (optional)

## Support

If you encounter issues with draft transfer:
1. Check this guide for troubleshooting steps
2. Verify both devices have the latest Pulse version
3. Try the manual export/import method
4. Contact support with error details

---

**Remember:** Pulse is designed for local-first privacy. Your drafts never leave your device unless you explicitly export and share them.
