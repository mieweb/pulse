// Android only: iOS needs no service (a background URLSession runs in nsurlsessiond;
// PulseKitBackground.swift). This is the foreground service PulseKitUploads.kt runs its PATCHes
// under (O16, PR4-E); the library manifest declares it (PR4-B): foregroundServiceType="dataSync",
// stopWithTask="false", not exported.

package com.mieweb.pulse.kit

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Keeps PulseKit's uploads going when nothing else would: after Pulse closes, with the host in
 * the background, the screen locked or the task swiped away (`stopWithTask="false"`). It runs while
 * at least one PATCH does ([PulseKitUploads] starts it for the first and ends it after the last);
 * the PATCHes themselves are OkHttp calls in [PulseKitUploads], not work of this class.
 *
 * - Foreground type dataSync: the 3-argument `startForeground(id, notification,
 *   FOREGROUND_SERVICE_TYPE_DATA_SYNC)` on API 29+, the 2-argument one below. The library manifest
 *   asks for FOREGROUND_SERVICE and FOREGROUND_SERVICE_DATA_SYNC (API 34+).
 * - The notification: channel `pulsekit.uploads` (low importance: no sound, no vibration, no
 *   heads-up), ongoing, "Sending N videos" (`R.plurals.pulsekit_upload_title`) with a determinate
 *   progress bar of the bytes sent, and the host's launch intent as its content intent.
 * - **POST_NOTIFICATIONS: PulseKit never asks for it** (owner's answer, Q-A6); a host that wants
 *   the notification asks itself. On Android 13+ without it the service still runs, uploads still
 *   finish, and the notification shows only in the task manager (the "Active apps" list in quick
 *   settings). Progress updates are posted only with the permission.
 * - While it runs: a PARTIAL_WAKE_LOCK (the CPU stays up with the screen off) and a WifiLock in
 *   WIFI_MODE_FULL_HIGH_PERF (Wi-Fi stays up; the mode is deprecated and has no effect from API 34,
 *   where the system manages Wi-Fi power for foreground services itself).
 * - Android 15's dataSync limit (6 hours in 24): [onTimeout] stops every PATCH, which ends not-ok
 *   (not as a cancel), so Pulse JS resumes the uploads from the server's offset later, and the
 *   service stops at once as the system requires.
 * - START_NOT_STICKY: the system never restarts it after a kill. Nothing could continue: the
 *   PATCHes died with the process, and Pulse JS resumes them from HEAD on its next run.
 */
class PulseUploadService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null
  private var lastNotified = 0L

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
    createChannel(this)
    acquireLocks()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    requested = false
    instance = this
    // startForegroundService needs startForeground soon, even when the calls ended meanwhile.
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          NOTIFICATION_ID,
          notification(),
          ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        )
      } else {
        startForeground(NOTIFICATION_ID, notification())
      }
    } catch (e: RuntimeException) {
      // ForegroundServiceStartNotAllowedException (12+) or a missing type permission (14+): the
      // PATCHes go on without the service, as when it couldn't be started at all.
      PulseKitUploads.log("the service couldn't go to the foreground: ${e.message}")
      stopNow()
      return START_NOT_STICKY
    }
    if (PulseKitUploads.snapshot.calls == 0) stopNow()
    return START_NOT_STICKY
  }

  /** Android 15+: the dataSync time limit ran out. Stop the PATCHes, then stop at once. */
  override fun onTimeout(startId: Int, fgsType: Int) {
    PulseKitUploads.log("the dataSync time limit ran out; stopping the uploads")
    PulseKitUploads.stopAll("Android's time limit for background uploads ran out.")
    stopNow()
  }

  override fun onDestroy() {
    releaseLocks()
    if (instance === this) instance = null
    super.onDestroy()
  }

  /** Leaves the foreground and stops. A start that comes meanwhile brings it back (begin). */
  private fun stopNow() {
    if (instance === this) instance = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  /** Posts the current progress (at most once a second; the system drops faster updates). */
  private fun refresh() {
    val now = SystemClock.elapsedRealtime()
    if (now - lastNotified < NOTIFY_INTERVAL_MS) return
    lastNotified = now
    if (
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
        ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
          PackageManager.PERMISSION_GRANTED
    ) {
      return
    }
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    try {
      manager.notify(NOTIFICATION_ID, notification())
    } catch (e: SecurityException) {
      PulseKitUploads.log("couldn't update the notification: ${e.message}")
    }
  }

  private fun notification(): Notification {
    val snap = PulseKitUploads.snapshot
    val count = maxOf(1, snap.calls)
    val percent =
      if (snap.total > 0) ((snap.sent.coerceIn(0, snap.total) * 100) / snap.total).toInt() else 0
    val builder =
      NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(R.drawable.pulsekit_ic_upload)
        .setContentTitle(resources.getQuantityString(R.plurals.pulsekit_upload_title, count, count))
        .setProgress(100, percent, snap.total <= 0)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setSilent(true)
        .setCategory(NotificationCompat.CATEGORY_PROGRESS)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
    launchIntent()?.let(builder::setContentIntent)
    return builder.build()
  }

  /** The host's launcher Activity, so a tap brings the host back. */
  private fun launchIntent(): PendingIntent? {
    val intent = packageManager.getLaunchIntentForPackage(packageName) ?: return null
    return PendingIntent.getActivity(
      this,
      0,
      intent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }

  // Both locks are held for the service's life, which is the uploads' life. The wake lock's timeout
  // is a backstop matching Android 15's dataSync limit; a WifiLock takes none.
  @SuppressLint("WakelockTimeout")
  private fun acquireLocks() {
    val power = getSystemService(Context.POWER_SERVICE) as? PowerManager
    wakeLock =
      power?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PulseKit:upload")?.apply {
        setReferenceCounted(false)
        acquire(LOCK_TIMEOUT_MS)
      }
    val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    @Suppress("DEPRECATION")
    wifiLock =
      wifi?.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "PulseKit:upload")?.apply {
        setReferenceCounted(false)
        acquire()
      }
  }

  private fun releaseLocks() {
    wakeLock?.takeIf { it.isHeld }?.release()
    wakeLock = null
    wifiLock?.takeIf { it.isHeld }?.release()
    wifiLock = null
  }

  /** Starting, updating and ending the service; every function runs on the main thread. */
  internal companion object {
    /** The notification channel PR4-B's strings name (PR4-SPEC "Frozen names"). */
    const val CHANNEL_ID = "pulsekit.uploads"
    private const val NOTIFICATION_ID = 0x5055_4C53
    private const val NOTIFY_INTERVAL_MS = 1_000L
    private const val LOCK_TIMEOUT_MS = 6 * 60 * 60 * 1_000L

    private var instance: PulseUploadService? = null
    private var requested = false

    /**
     * Starts the service for the first PATCH. False when Android refused it
     * (`ForegroundServiceStartNotAllowedException` on 12+ from the background): the caller runs
     * the PATCH without it.
     */
    fun begin(context: Context): Boolean {
      if (instance != null || requested) {
        update()
        return true
      }
      return try {
        val intent = Intent(context, PulseUploadService::class.java)
        ContextCompat.startForegroundService(context, intent)
        requested = true
        true
      } catch (e: IllegalStateException) {
        // ForegroundServiceStartNotAllowedException extends IllegalStateException.
        PulseKitUploads.log("couldn't start the upload service: ${e.message}")
        false
      } catch (e: SecurityException) {
        PulseKitUploads.log("couldn't start the upload service: ${e.message}")
        false
      }
    }

    /** The PATCHes moved on: refresh the notification. */
    fun update() {
      instance?.refresh()
    }

    /** No PATCH is left: leave the foreground and stop. */
    fun end() {
      instance?.stopNow()
    }

    /** The low-importance, silent channel (API 26+; created again is a no-op). */
    private fun createChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager =
        context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
      val channel =
        NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.pulsekit_upload_channel_name),
            NotificationManager.IMPORTANCE_LOW,
          )
          .apply {
            description = context.getString(R.string.pulsekit_upload_channel_description)
            setSound(null, null)
            enableVibration(false)
            setShowBadge(false)
          }
      manager.createNotificationChannel(channel)
    }
  }
}
