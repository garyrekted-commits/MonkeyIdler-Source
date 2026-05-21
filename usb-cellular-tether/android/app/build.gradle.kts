plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.example.usbcellulartether"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.example.usbcellulartether"
        minSdk = 26
        targetSdk = 33
        versionCode = 10032
        versionName = "1.0.32"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}
