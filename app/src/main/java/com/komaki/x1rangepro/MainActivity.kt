package com.komaki.x1rangepro

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.widget.FrameLayout
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import kotlin.math.roundToInt

class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var ble: BleBridge
    private lateinit var rootView: FrameLayout

    /** Matches status/navigation bar icons and the window background to the app's light or dark theme. */
    fun setBarsLight(light: Boolean) {
        val c = if (light) 0xFFF3F5F8.toInt() else Color.BLACK
        rootView.setBackgroundColor(c); web.setBackgroundColor(c)
        androidx.core.view.WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = light; isAppearanceLightNavigationBars = light
        }
    }

    private var insets = intArrayOf(0, 0, 0, 0) // left, top, right, bottom in CSS px

    /** Gives the page the real safe-area sizes (notch, status bar, gesture bar) as CSS variables. */
    private fun pushInsets() {
        val (l, t, r, b) = insets
        web.evaluateJavascript("(function(){var s=document.documentElement.style;" +
            "s.setProperty('--sal','${l}px');s.setProperty('--sat','${t}px');" +
            "s.setProperty('--sar','${r}px');s.setProperty('--sab','${b}px')})()", null)
    }

    private var locCallback: ((Boolean) -> Unit)? = null
    private val locLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { res ->
            val cb = locCallback; locCallback = null
            cb?.invoke(res.values.any { it })
        }

    /** Location for the in-app map and ride route. Main thread only. */
    fun requestLocationPermission(cb: (Boolean) -> Unit) {
        val ok = listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
            .any { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }
        if (ok) { cb(true); return }
        locCallback = cb
        locLauncher.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
    }

    private var permCallback: ((Boolean) -> Unit)? = null

    private val permLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { res ->
            val cb = permCallback; permCallback = null
            cb?.invoke(hasBlePermissions())
        }

    /** Bluetooth permissions are required; location is requested too (some phones need it for scanning) but optional. */
    fun hasBlePermissions(): Boolean = requiredPerms().all {
        ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
    }

    private fun requiredPerms(): Array<String> =
        if (Build.VERSION.SDK_INT >= 31)
            arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)

    private fun blePerms(): Array<String> =
        (requiredPerms() + Manifest.permission.ACCESS_FINE_LOCATION).distinct().toTypedArray()

    /** Must be called on the main thread. */
    fun requestBlePermissions(cb: (Boolean) -> Unit) {
        val all = blePerms().all { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }
        if (all) { cb(true); return }
        permCallback = cb
        permLauncher.launch(blePerms())
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this).apply { setBackgroundColor(Color.BLACK) }
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        }
        rootView = root
        setContentView(root)
        // Fallback until real insets arrive: status bar height (covers the camera cut-out on most phones)
        val sbId = resources.getIdentifier("status_bar_height", "dimen", "android")
        if (sbId > 0) insets[1] = (resources.getDimensionPixelSize(sbId) / resources.displayMetrics.density).roundToInt()
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, wi ->
            val b = wi.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val d = resources.displayMetrics.density
            insets = intArrayOf((b.left / d).roundToInt(), (b.top / d).roundToInt(), (b.right / d).roundToInt(), (b.bottom / d).roundToInt())
            pushInsets()
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(root)

        val loader = WebViewAssetLoader.Builder()
            .setDomain(HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web.settings.apply {
            javaScriptEnabled = true
            textZoom = 100 // ignore the phone's font-size setting so the layout keeps its proportions
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = true
        }
        web.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) = pushInsets()
            override fun onPageFinished(view: WebView, url: String?) = pushInsets()

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == HOST) return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                return true
            }
        }
        // The page uses alert() and confirm()
        web.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: android.webkit.GeolocationPermissions.Callback) {
                requestLocationPermission { ok -> callback.invoke(origin, ok, false) }
            }

            override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
                AlertDialog.Builder(this@MainActivity).setMessage(message)
                    .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                    .setOnCancelListener { result.cancel() }.show()
                return true
            }

            override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
                AlertDialog.Builder(this@MainActivity).setMessage(message)
                    .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                    .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
                    .setOnCancelListener { result.cancel() }.show()
                return true
            }
        }

        ble = BleBridge(this, web)
        web.addJavascriptInterface(ble, "AndroidBle")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })

        if (savedInstanceState == null) web.loadUrl("https://$HOST/assets/index.html") else web.restoreState(savedInstanceState)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState); web.saveState(outState)
    }

    override fun onDestroy() {
        ble.shutdown()
        web.removeJavascriptInterface("AndroidBle")
        web.destroy()
        super.onDestroy()
    }

    companion object { const val HOST = "appassets.androidplatform.net" }
}
