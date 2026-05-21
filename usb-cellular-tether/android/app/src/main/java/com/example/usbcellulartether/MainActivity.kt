package com.example.usbcellulartether

import android.app.Activity
import android.os.Bundle

/** Scaffold shell; full proxy UI lands in android-proxy PR. */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = "USB Cellular Tether"
    }
}
