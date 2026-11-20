#!/bin/sh
# Prepares the generated Android project for the Pulse checks. Run it after `npx cap add android`
# (the android/ folder is generated and never committed); running it again changes nothing.
#   - PULSEKIT_ANDROID_LOCAL (a local Maven repository with the PulseKit AAR), when set: added to
#     allprojects.repositories in android/build.gradle. The plugin lists it too, but a library's
#     repositories don't resolve the app's dependencies.
#   - minSdkVersion 24 in android/variables.gradle: PulseKit's floor.
#   - android:usesCleartextTraffic="true" on the application, so the app reaches the http test server
#     (scripts/pv-test-server.mjs) through adb reverse or the LAN. Test host only.
#   - A caphost:// intent filter on MainActivity, for the deep-link checks
#     (`adb shell am start -a android.intent.action.VIEW -d "caphost://nav?to=x"`).
set -eu
cd "$(dirname "$0")/.."
ANDROID=${1:-android}
BUILD_GRADLE="$ANDROID/build.gradle"
VARIABLES="$ANDROID/variables.gradle"
MANIFEST="$ANDROID/app/src/main/AndroidManifest.xml"
for f in "$BUILD_GRADLE" "$VARIABLES" "$MANIFEST"; do
  if [ ! -f "$f" ]; then
    echo "No $f: run 'npx cap add android' first." >&2
    exit 1
  fi
done

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

# Moves $TMP over $1 when they differ, and says which it was.
apply() {
  if cmp -s "$TMP" "$1"; then
    echo "unchanged: $2"
  else
    cat "$TMP" >"$1"
    echo "changed:   $2"
  fi
}

# 1. The PulseKit Maven repository. The line carries a marker, so a new path replaces the old one.
if [ -n "${PULSEKIT_ANDROID_LOCAL:-}" ]; then
  if [ ! -d "$PULSEKIT_ANDROID_LOCAL" ]; then
    echo "PULSEKIT_ANDROID_LOCAL is not a folder: $PULSEKIT_ANDROID_LOCAL" >&2
    exit 1
  fi
  REPO=$(cd "$PULSEKIT_ANDROID_LOCAL" && pwd)
  case "$REPO" in
  *\'* | *\\*)
    echo "PULSEKIT_ANDROID_LOCAL can't contain ' or \\: $REPO" >&2
    exit 1
    ;;
  esac
  MAVEN_LINE="        maven { url = uri('$REPO') } // pulsekit-local (scripts/android-setup.sh)" \
    awk '
      /\/\/ pulsekit-local/ { next }
      { print }
      /^[[:space:]]*allprojects[[:space:]]*\{/ { inAll = 1 }
      inAll && /^[[:space:]]*repositories[[:space:]]*\{/ {
        print ENVIRON["MAVEN_LINE"]; inAll = 0; done = 1
      }
      END { if (!done) exit 3 }
    ' "$BUILD_GRADLE" >"$TMP" || {
    echo "No allprojects { repositories { in $BUILD_GRADLE" >&2
    exit 1
  }
  apply "$BUILD_GRADLE" "$BUILD_GRADLE: maven { url = uri('$REPO') } in allprojects.repositories"
else
  echo "skipped:   $BUILD_GRADLE: PULSEKIT_ANDROID_LOCAL is not set"
fi

# 2. minSdkVersion 24.
if ! grep -q '^[[:space:]]*minSdkVersion[[:space:]]*=' "$VARIABLES"; then
  echo "No minSdkVersion in $VARIABLES" >&2
  exit 1
fi
sed 's/^\([[:space:]]*minSdkVersion[[:space:]]*=[[:space:]]*\)[0-9][0-9]*/\124/' "$VARIABLES" >"$TMP"
apply "$VARIABLES" "$VARIABLES: minSdkVersion = 24"

# 3. Cleartext traffic on the application.
if grep -q 'android:usesCleartextTraffic=' "$MANIFEST"; then
  sed 's/android:usesCleartextTraffic="[a-z]*"/android:usesCleartextTraffic="true"/' "$MANIFEST" >"$TMP"
else
  awk '
    !done && /<application([[:space:]]|>|$)/ {
      sub(/<application/, "<application android:usesCleartextTraffic=\"true\""); done = 1
    }
    { print }
    END { if (!done) exit 3 }
  ' "$MANIFEST" >"$TMP" || {
    echo "No <application in $MANIFEST" >&2
    exit 1
  }
fi
apply "$MANIFEST" "$MANIFEST: android:usesCleartextTraffic=\"true\""

# 4. The caphost:// intent filter, before MainActivity's closing tag.
if grep -q 'android:scheme="caphost"' "$MANIFEST"; then
  cat "$MANIFEST" >"$TMP"
else
  awk '
    /android:name="\.MainActivity"/ { inMain = 1 }
    inMain && /<\/activity>/ {
      print "            <intent-filter>"
      print "                <action android:name=\"android.intent.action.VIEW\" />"
      print "                <category android:name=\"android.intent.category.DEFAULT\" />"
      print "                <category android:name=\"android.intent.category.BROWSABLE\" />"
      print "                <data android:scheme=\"caphost\" />"
      print "            </intent-filter>"
      print ""
      inMain = 0; done = 1
    }
    { print }
    END { if (!done) exit 3 }
  ' "$MANIFEST" >"$TMP" || {
    echo "No MainActivity <activity> in $MANIFEST" >&2
    exit 1
  }
fi
apply "$MANIFEST" "$MANIFEST: caphost:// intent filter on MainActivity"
