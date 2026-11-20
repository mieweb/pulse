// Mirrors embed/native/ios/PulseKitInfo.swift: `info()` (native-bridge.md §3) and what `open` needs
// from the host app. The build stamps come from BuildConfig, which embed/plugins/
// with-pulsekit-android.js writes on prebuild from the same sources as the iOS Info.plist stamps.
// Where iOS reads the host's Info.plist purpose strings, Android reads the host's merged manifest.

package com.mieweb.pulse.kit

import android.Manifest
import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import com.mieweb.pulse.kit.core.PulseContract
import com.mieweb.pulse.kit.core.PulseJson
import com.mieweb.pulse.kit.core.PulseNamespace

/**
 * `info()` and the host's requirements. Every function reads only the application context, so
 * the facade calls them from any state.
 */
internal object PulseKitInfo {
  /**
   * Android 7.0 (API 24) is Pulse's floor (S1-b: every module is at 24 or below after #303 and
   * pulse-editor #20). The AAR's manifest says the same, so a host below it needs
   * `tools:overrideLibrary`, and then `info()` says `os`.
   */
  const val MIN_API = 24

  /**
   * Whether host writes run Pulse JS with no screen (the `headless` capability, AD5). iOS builds it
   * from the `PULSEKIT_HEADLESS` compile condition (spike S3 passed there). On Android it stays
   * off in PR4: running Pulse JS with no Activity needs its own spike (S3-A). React Native's timers
   * stop while no React host is resumed (JavaTimerManager pauses on onHostPause unless a headless
   * JS task runs), so a root with no Activity would hang on its first timer. Until S3-A, a write
   * that finds the runtime cold shows "Preparing…" (PulseKitRuntime.kt), or answers
   * `runtime.paused` with no Activity in front. Flip it only together with that path.
   */
  const val HEADLESS = false

  /**
   * The smallest width, in dp, from which a screen is a tablet's (Android's own sw600dp line).
   * Tablets report `supported: false` until X7, like iPad on iOS (owner, 2026-11-20). The
   * contract has no `tablet` reason, so they say `device`.
   */
  const val TABLET_MIN_WIDTH_DP = 600

  /** Whether Pulse runs here, and why not when it doesn't. */
  data class Support(val supported: Boolean, val reason: String?)

  /**
   * `os` below [MIN_API]; `device` without any camera, or on a tablet-sized screen. A foldable
   * that opens to tablet width reports `device` while open (its configuration at the time of the
   * call).
   */
  fun support(context: Context): Support {
    if (Build.VERSION.SDK_INT < MIN_API) return Support(false, "os")
    if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
      return Support(false, "device")
    }
    if (context.resources.configuration.smallestScreenWidthDp >= TABLET_MIN_WIDTH_DP) {
      return Support(false, "device")
    }
    return Support(true, null)
  }

  /**
   * `info()`: the stamps, the contract (the stamped minor or the facade's own, whichever is
   * higher, as PulseKit.swift reports it), the entries, the methods this facade answers, its
   * capabilities and whether Pulse runs here.
   */
  fun json(context: Context, namespace: String?): PulseJson {
    val support = support(context)
    val o = LinkedHashMap<String, PulseJson>()
    o["sdkVersion"] = PulseJson.Str(BuildConfig.PULSEKIT_VERSION)
    o["build"] = PulseJson.Str(BuildConfig.PULSEKIT_BUILD)
    o["gitSha"] = PulseJson.Str(BuildConfig.PULSEKIT_GIT_SHA)
    o["contract"] = PulseJson.obj(
      "major" to PulseJson.Integer(PulseContract.MAJOR.toLong()),
      "minor" to PulseJson.Integer(
        maxOf(BuildConfig.PULSEKIT_CONTRACT_MINOR, PulseContract.MINOR.toLong()),
      ),
    )
    o["formatVersion"] = PulseJson.Integer(BuildConfig.PULSEKIT_FORMAT_VERSION)
    o["dbSchema"] = PulseJson.Integer(BuildConfig.PULSEKIT_DB_SCHEMA)
    o["entries"] = PulseJson.Arr(PulseContract.entries.map { PulseJson.Str(it) })
    o["methods"] = PulseJson.Arr(PulseContract.methods.map { PulseJson.Str(it) })
    o["capabilities"] = PulseJson.Arr(capabilities(context).map { PulseJson.Str(it) })
    o["platform"] = PulseJson.Str("android")
    o["osVersion"] = PulseJson.Str(Build.VERSION.RELEASE ?: "")
    o["supported"] = PulseJson.Bool(support.supported)
    o["namespace"] = PulseJson.of(namespace)
    support.reason?.let { o["unsupportedReason"] = PulseJson.Str(it) }
    return PulseJson.Obj(o)
  }

  /**
   * What this build can do, as iOS lists it: Export sends through Pulse's outbox (`upload.pulse`)
   * or hands the video back (`upload.file`); Pulse's uploads go on after Pulse closes in
   * PulseUploadService (`upload.background`); `share`. `saveToPhotos` on Android 10 and later
   * (MediaStore needs no permission), and on 7–9 only when the merged manifest keeps
   * WRITE_EXTERNAL_STORAGE (the AAR asks for it up to API 28). Never `headless` ([HEADLESS]).
   */
  fun capabilities(context: Context): List<String> {
    val list = mutableListOf("upload.pulse", "upload.background", "upload.file", "share")
    if (canSaveToPhotos(context)) list.add("saveToPhotos")
    if (HEADLESS) list.add("headless")
    return list
  }

  /** Save to Photos can work here (see [capabilities]). */
  fun canSaveToPhotos(context: Context): Boolean =
    Build.VERSION.SDK_INT >= 29 ||
      Manifest.permission.WRITE_EXTERNAL_STORAGE in requestedPermissions(context)

  /**
   * The permissions `open` can't do without. A host whose manifest merge removed one would have
   * the camera or microphone request fail on the first take, so `open` refuses with
   * `host_misconfigured` instead (iOS: the purpose strings).
   */
  fun missingRequiredPermissions(context: Context): List<String> {
    val requested = requestedPermissions(context)
    return listOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
      .filter { it !in requested }
  }

  @Volatile private var requestedCache: Set<String>? = null

  /** The host's merged manifest's `uses-permission` names (fixed for the process). */
  fun requestedPermissions(context: Context): Set<String> {
    requestedCache?.let { return it }
    val names = try {
      packageInfo(context).requestedPermissions?.toSet() ?: emptySet()
    } catch (e: PackageManager.NameNotFoundException) {
      emptySet()
    }
    requestedCache = names
    return names
  }

  private fun packageInfo(context: Context): PackageInfo {
    val pm = context.packageManager
    return if (Build.VERSION.SDK_INT >= 33) {
      pm.getPackageInfo(
        context.packageName,
        PackageManager.PackageInfoFlags.of(PackageManager.GET_PERMISSIONS.toLong()),
      )
    } else {
      @Suppress("DEPRECATION")
      pm.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
    }
  }

  /** The default hostId: the host's package name, sanitised (AD12; iOS: the bundle id). */
  fun defaultHostId(context: Context): String = PulseNamespace.sanitise(context.packageName)
}
