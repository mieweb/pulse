# PulseKit's consumer R8 rules (G2). They ship in the AAR (proguard.txt) and apply when a host
# builds with minify on; PulseKit's own build doesn't minify. expo-brownfield's consumer-rules.pro
# (Expo modules, services, records, views) ships beside these. package-android.mjs refuses an AAR
# without these rules.

# The public API (PulseKit.kt, PulseKitApi.kt). Hosts and the Capacitor and Cordova plugins call
# it by name; Java callers use PulseKit.shared(context) and the fun interfaces.
-keep class com.mieweb.pulse.kit.PulseKit { public *; }
-keep class com.mieweb.pulse.kit.PulseKit$Companion { public *; }
-keep interface com.mieweb.pulse.kit.PulseReply { *; }
-keep interface com.mieweb.pulse.kit.PulseEventListener { *; }
-keep interface com.mieweb.pulse.kit.PulseOpenLauncher { *; }

# The components the library manifest declares (PR4-D, PR4-E), and their Intent extras' names.
-keep class com.mieweb.pulse.kit.PulseActivity { *; }
-keep class com.mieweb.pulse.kit.PulseUploadService { *; }

# BuildConfig: the stamps info() reports (with-pulsekit-android.js writes them on prebuild).
-keep class com.mieweb.pulse.kit.BuildConfig { *; }

# expo-brownfield's messaging: Pulse JS looks BrownfieldMessaging up by its JS module name.
-keep class expo.modules.brownfield.** { *; }

# whisper.rn: its JNI callbacks resolve these classes by name (the rule app.json's
# expo-build-properties `extraProguardRules` gives the standalone app).
-keep class com.rnwhisper.** { *; }
