plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.komaki.x1rangepro"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.komaki.x1rangepro"
        minSdk = 29
        targetSdk = 35
        // Every GitHub build gets a higher number, so each APK installs over the previous one.
        val run = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 0
        versionCode = 100 + run
        versionName = "1.$run"
    }
    // One fixed signing key for every build. Without it each GitHub build is signed with a new random key,
    // Android refuses to update over the old app, and the only way forward is to uninstall (which deletes your data).
    signingConfigs {
        create("fixed") {
            storeFile = file("komaki-debug.keystore")
            storePassword = "android"
            keyAlias = "komaki"
            keyPassword = "android"
        }
    }
    buildTypes {
        getByName("debug") { signingConfig = signingConfigs.getByName("fixed") }
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("fixed")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
