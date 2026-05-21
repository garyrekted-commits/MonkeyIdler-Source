package com.example.usbcellulartether

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : Activity() {
    private val backgroundColor = Color.rgb(21, 25, 38)
    private val surfaceColor = Color.rgb(31, 37, 55)
    private val primaryTextColor = Color.rgb(238, 243, 255)
    private val secondaryTextColor = Color.rgb(150, 160, 185)
    private val cyanColor = Color.rgb(45, 211, 232)
    private val redColor = Color.rgb(245, 82, 101)
    private val purpleColor = Color.rgb(129, 119, 255)

    private lateinit var statusView: TextView
    private lateinit var detailView: TextView
    private lateinit var nextStepView: TextView
    private lateinit var transferCard: TextView
    private lateinit var connectionsCard: TextView
    private lateinit var startButton: Button
    private lateinit var stopButton: Button
    private lateinit var updateButton: Button
    private var service: TetherForegroundService? = null

    private val statsListener: (ProxyStats) -> Unit = { stats ->
        runOnUiThread { renderStats(stats) }
    }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            service = (binder as TetherForegroundService.LocalBinder).getService()
            service?.addListener(statsListener)
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            service?.removeListener(statsListener)
            service = null
            renderStats(ProxyStats())
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestNotificationPermission()
        buildUi()
    }

    override fun onStart() {
        super.onStart()
        bindService(Intent(this, TetherForegroundService::class.java), connection, Context.BIND_AUTO_CREATE)
    }

    override fun onStop() {
        service?.removeListener(statsListener)
        unbindService(connection)
        service = null
        super.onStop()
    }

    private fun buildUi() {
        val scrollView = ScrollView(this).apply {
            setBackgroundColor(backgroundColor)
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(48, 64, 48, 48)
            setBackgroundColor(backgroundColor)
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
        }

        val title = TextView(this).apply {
            text = "USB Cellular Tether v1.0.32"
            textSize = 26f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(primaryTextColor)
        }

        statusView = TextView(this).apply {
            textSize = 22f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(primaryTextColor)
            setPadding(0, 0, 0, 8)
        }

        detailView = TextView(this).apply {
            textSize = 15f
            setLineSpacing(4f, 1f)
            setTextColor(secondaryTextColor)
        }

        nextStepView = TextView(this).apply {
            textSize = 16f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(cyanColor)
            setPadding(0, 10, 0, 0)
        }

        val heroCard = dashboardCard().apply {
            orientation = LinearLayout.VERTICAL
            setPadding(28, 24, 28, 24)
            addView(statusView)
            addView(detailView)
            addView(nextStepView)
        }

        transferCard = TextView(this)
        connectionsCard = TextView(this)
        val cards = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, 18, 0, 18)
            addView(statCard("TRANSFERRED", transferCard, redColor), LinearLayout.LayoutParams(0, 160, 1f).apply {
                marginEnd = 12
            })
            addView(statCard("CONNECTIONS", connectionsCard, purpleColor), LinearLayout.LayoutParams(0, 160, 1f).apply {
                marginStart = 12
            })
        }

        startButton = Button(this).apply {
            styleDashboardButton("Start Tether", cyanColor)
            setOnClickListener {
                startProxyService()
            }
        }

        stopButton = Button(this).apply {
            styleDashboardButton("Stop Tether", redColor)
            setOnClickListener {
                startService(Intent(this@MainActivity, TetherForegroundService::class.java).apply {
                    action = TetherForegroundService.ACTION_STOP
                })
            }
        }

        updateButton = Button(this).apply {
            styleDashboardButton("Install / Update App", purpleColor)
            setOnClickListener {
                openLatestAndroidUpdate()
            }
        }

        val instructions = TextView(this).apply {
            text = buildString {
                appendLine("Setup")
                appendLine("1. Turn off Wi-Fi if you want to force cellular data.")
                appendLine("2. Enable Developer Options and USB debugging.")
                appendLine("3. Connect USB and accept the debugging prompt.")
                appendLine("4. Tap Start Tether here, then click Start in the Windows companion.")
                appendLine()
                appendLine("The phone proxy listens only on 127.0.0.1:28080. The Windows companion reaches it through an ADB USB tunnel.")
                appendLine("Network Adapter Mode creates the network adapter on Windows and forwards it through this phone proxy.")
            }
            textSize = 14f
            setTextColor(secondaryTextColor)
            setPadding(0, 22, 0, 0)
        }

        root.addView(title, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        root.addView(heroCard, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        root.addView(cards, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        root.addView(startButton, buttonLayoutParams())
        root.addView(stopButton, buttonLayoutParams())
        root.addView(updateButton, buttonLayoutParams())
        root.addView(instructions)
        scrollView.addView(root)
        setContentView(scrollView)
        renderStats(ProxyStats())
    }

    private fun renderStats(stats: ProxyStats) {
        statusView.text = stats.state
        nextStepView.text = when (stats.state) {
            "Stopped" -> "Next: tap Start Tether."
            "Starting" -> "Starting local proxy..."
            "Waiting for PC" -> "Next: connect USB and start the Windows companion."
            "Connected" -> "Connected. Keep this app running while you use the PC."
            "Error" -> "Fix the error below, then restart tethering."
            else -> "Follow the setup steps below."
        }
        startButton.isEnabled = stats.state == "Stopped"
        stopButton.isEnabled = stats.state != "Stopped"
        detailView.text = buildString {
            appendLine("Phone proxy: 127.0.0.1:${stats.listenPort}")
            appendLine("Active connections: ${stats.activeConnections}")
            appendLine("Total connections: ${stats.totalConnections}")
            stats.lastError?.let { appendLine("Last error: $it") }
        }
        transferCard.text = TetherForegroundService.formatBytes(stats.bytesTransferred)
        connectionsCard.text = stats.totalConnections.toString()
    }

    private fun dashboardCard(): LinearLayout =
        LinearLayout(this).apply {
            background = GradientDrawable().apply {
                setColor(surfaceColor)
                cornerRadius = 26f
            }
        }

    private fun statCard(title: String, value: TextView, color: Int): LinearLayout =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(14, 14, 14, 14)
            background = GradientDrawable().apply {
                setColor(color)
                cornerRadius = 24f
            }
            addView(TextView(this@MainActivity).apply {
                text = title
                textSize = 12f
                setTextColor(Color.argb(220, 255, 255, 255))
                gravity = Gravity.CENTER
            })
            addView(value.apply {
                textSize = 23f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(Color.WHITE)
                gravity = Gravity.CENTER
            })
        }

    private fun Button.styleDashboardButton(textValue: String, color: Int) {
        text = textValue
        setTextColor(Color.WHITE)
        textSize = 14f
        background = GradientDrawable().apply {
            setColor(color)
            cornerRadius = 22f
        }
    }

    private fun buttonLayoutParams(): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 112).apply {
            topMargin = 10
        }

    private fun startProxyService() {
        val proxyIntent = Intent(this@MainActivity, TetherForegroundService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(proxyIntent)
        } else {
            startService(proxyIntent)
        }
    }

    private fun openLatestAndroidUpdate() {
        updateButton.isEnabled = false
        updateButton.text = "Checking..."

        Thread {
            val url = runCatching { findLatestAndroidApkUrl() }
                .getOrElse { LATEST_RELEASE_URL }

            runOnUiThread {
                updateButton.isEnabled = true
                updateButton.text = "Install / Update App"
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            }
        }.start()
    }

    private fun findLatestAndroidApkUrl(): String {
        val connection = (URL(LATEST_RELEASE_API_URL).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            setRequestProperty("Accept", "application/vnd.github+json")
            setRequestProperty("User-Agent", "UsbCellularTether.Android")
            connectTimeout = 10_000
            readTimeout = 10_000
        }

        return connection.inputStream.bufferedReader().use { it.readText() }
            .let { json ->
                DOWNLOAD_URL_REGEX.findAll(json)
                    .map { it.groupValues[1].replace("\\/", "/") }
                    .firstOrNull { it.contains("Android", ignoreCase = true) && it.endsWith(".apk", ignoreCase = true) }
            }
            ?: error("No Android APK was found on the latest release.")
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 100)
        }
    }

    companion object {
        private const val LATEST_RELEASE_URL = "https://github.com/garyrekted-commits/UsbCellularTether/releases/latest"
        private const val LATEST_RELEASE_API_URL = "https://api.github.com/repos/garyrekted-commits/UsbCellularTether/releases/latest"
        private val DOWNLOAD_URL_REGEX = """"browser_download_url"\s*:\s*"([^"]+)"""".toRegex()
    }

}
