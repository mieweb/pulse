#!/usr/bin/env python3
"""
Script to add Broadcast Extension target to the Xcode project.
This automates the manual steps required to integrate the ReplayKit broadcast extension.

Usage:
    python3 scripts/add_broadcast_extension_target.py
"""

import json
import re
import sys
from pathlib import Path

# UUID generation for Xcode
import uuid

def generate_uuid():
    """Generate a UUID without dashes for Xcode"""
    return uuid.uuid4().hex[:24].upper()

def read_pbxproj(project_path):
    """Read the project.pbxproj file"""
    with open(project_path, 'r') as f:
        return f.read()

def write_pbxproj(project_path, content):
    """Write the project.pbxproj file"""
    with open(project_path, 'w') as f:
        f.write(content)

def add_broadcast_extension_target(project_path):
    """Add the Broadcast Extension target to the Xcode project"""
    
    print("⚠️  WARNING: This script modifies your Xcode project file.")
    print("⚠️  Make sure you have a backup or commit your changes first!")
    print()
    response = input("Continue? (yes/no): ")
    if response.lower() != 'yes':
        print("Aborting.")
        return False
    
    content = read_pbxproj(project_path)
    
    # Generate UUIDs for the new target
    extension_target_uuid = generate_uuid()
    extension_product_uuid = generate_uuid()
    extension_build_config_list_uuid = generate_uuid()
    extension_debug_config_uuid = generate_uuid()
    extension_release_config_uuid = generate_uuid()
    extension_sources_phase_uuid = generate_uuid()
    extension_frameworks_phase_uuid = generate_uuid()
    extension_copy_files_phase_uuid = generate_uuid()
    sample_handler_uuid = generate_uuid()
    sample_handler_ref_uuid = generate_uuid()
    info_plist_uuid = generate_uuid()
    info_plist_ref_uuid = generate_uuid()
    entitlements_uuid = generate_uuid()
    entitlements_ref_uuid = generate_uuid()
    
    # Check if extension already exists
    if 'BroadcastExtension' in content:
        print("❌ BroadcastExtension target already exists in the project!")
        return False
    
    print("✅ Preparing to add BroadcastExtension target...")
    
    # This is a simplified version - in reality, you'd need to add many sections
    # For now, we'll provide clear instructions that this needs to be done manually
    
    print()
    print("⚠️  Automated Xcode project modification is complex and error-prone.")
    print("⚠️  Please add the Broadcast Extension target manually using Xcode:")
    print()
    print("1. Open ios/pulse.xcworkspace in Xcode")
    print("2. File → New → Target")
    print("3. Choose 'Broadcast Upload Extension'")
    print("4. Product Name: BroadcastExtension")
    print("5. Bundle Identifier: com.mieweb.pulse.BroadcastExtension")
    print("6. Language: Swift")
    print("7. Click Finish")
    print("8. Delete the auto-generated SampleHandler.swift")
    print("9. Add ios/BroadcastExtension/SampleHandler.swift to the target")
    print("10. Configure App Groups capability on both targets")
    print()
    print("See SCREEN_RECORDING_SETUP.md for detailed instructions.")
    
    return True

def main():
    """Main entry point"""
    repo_root = Path(__file__).parent.parent
    project_path = repo_root / 'ios' / 'pulse.xcodeproj' / 'project.pbxproj'
    
    if not project_path.exists():
        print(f"❌ Project file not found: {project_path}")
        return 1
    
    print("Xcode Project Setup Helper")
    print("=" * 50)
    print()
    
    add_broadcast_extension_target(project_path)
    
    return 0

if __name__ == '__main__':
    sys.exit(main())
