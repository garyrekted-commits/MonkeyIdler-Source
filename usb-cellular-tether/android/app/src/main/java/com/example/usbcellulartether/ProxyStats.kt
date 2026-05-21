package com.example.usbcellulartether

data class ProxyStats(
    val state: String = "Stopped",
    val listenPort: Int = 28080,
    val activeConnections: Int = 0,
    val totalConnections: Long = 0,
    val bytesFromComputer: Long = 0,
    val bytesToComputer: Long = 0,
    val lastError: String? = null,
) {
    val bytesTransferred: Long
        get() = bytesFromComputer + bytesToComputer
}
