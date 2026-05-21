package com.example.usbcellulartether

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.IBinder

class TetherForegroundService : Service() {
    private val binder = LocalBinder()
    private val listeners = mutableSetOf<(ProxyStats) -> Unit>()
    private var proxyServer: ProxyServer? = null
    private var fullTunnelRelayServer: FullTunnelRelayServer? = null
    private var lastStats = ProxyStats()
    private var lastNotificationUpdateMs = 0L

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> stopProxy()
            else -> startProxy()
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        stopProxy()
        super.onDestroy()
    }

    fun startProxy() {
        if (proxyServer != null) return
        startForeground(NOTIFICATION_ID, buildNotification(lastStats.copy(state = "Starting")))
        proxyServer = ProxyServer(this) { stats ->
            lastStats = stats
            notifyListeners(stats)
            updateNotificationThrottled(stats)
        }.also { it.start() }
        fullTunnelRelayServer = FullTunnelRelayServer(this).also { it.start() }
    }

    fun stopProxy() {
        proxyServer?.stop()
        proxyServer = null
        fullTunnelRelayServer?.stop()
        fullTunnelRelayServer = null
        lastStats = lastStats.copy(state = "Stopped", activeConnections = 0)
        notifyListeners(lastStats)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    fun addListener(listener: (ProxyStats) -> Unit) {
        listeners.add(listener)
        listener(lastStats)
    }

    fun removeListener(listener: (ProxyStats) -> Unit) {
        listeners.remove(listener)
    }

    private fun notifyListeners(stats: ProxyStats) {
        listeners.toList().forEach { listener -> listener(stats) }
    }

    private fun updateNotificationThrottled(stats: ProxyStats) {
        val now = System.currentTimeMillis()
        if (stats.state != "Stopped" && now - lastNotificationUpdateMs < NOTIFICATION_UPDATE_INTERVAL_MS) {
            return
        }

        lastNotificationUpdateMs = now
        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildNotification(stats))
    }

    private fun buildNotification(stats: ProxyStats): Notification {
        val text = "State: ${stats.state} | ${formatBytes(stats.bytesTransferred)} transferred"
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("USB Cellular Tether")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setOngoing(stats.state != "Stopped")
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val channel = NotificationChannel(
            CHANNEL_ID,
            "USB Cellular Tether",
            NotificationManager.IMPORTANCE_LOW,
        )
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    inner class LocalBinder : Binder() {
        fun getService(): TetherForegroundService = this@TetherForegroundService
    }

    companion object {
        const val ACTION_STOP = "com.example.usbcellulartether.STOP"
        private const val CHANNEL_ID = "usb_cellular_tether"
        private const val NOTIFICATION_ID = 1001
        private const val NOTIFICATION_UPDATE_INTERVAL_MS = 1_000L

        fun formatBytes(bytes: Long): String {
            if (bytes < 1024) return "$bytes B"
            val kib = bytes / 1024.0
            if (kib < 1024) return "%.1f KiB".format(kib)
            val mib = kib / 1024.0
            if (mib < 1024) return "%.1f MiB".format(mib)
            return "%.1f GiB".format(mib / 1024.0)
        }
    }
}
