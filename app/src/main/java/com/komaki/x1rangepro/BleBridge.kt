package com.komaki.x1rangepro

import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.location.LocationManager
import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.ArrayAdapter
import android.widget.ListView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume

/**
 * Native side of the Web Bluetooth shim (assets/ble-polyfill.js).
 * JS calls call(id, method, argsJson); the result comes back through window.__bleResult.
 * Android allows one GATT operation at a time per connection, so each Link serialises them.
 */
@SuppressLint("MissingPermission")
@Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
class BleBridge(private val act: MainActivity, private val web: WebView) {

    private class Err(val kind: String, msg: String) : Exception(msg)
    private data class Found(val addr: String, var name: String?, var rssi: Int)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val adapter: BluetoothAdapter? = act.getSystemService(BluetoothManager::class.java)?.adapter
    private val prefs = act.getSharedPreferences("ble", Context.MODE_PRIVATE)
    private val links = ConcurrentHashMap<String, Link>()
    private val cccd: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    // ---------------------------------------------------------------- JS entry points

    @JavascriptInterface
    fun call(id: Int, method: String, args: String) {
        scope.launch {
            try {
                reply(id, true, handle(method, JSONObject(args)) ?: "")
            } catch (e: TimeoutCancellationException) {
                reply(id, false, "NetworkError:Timed out")
            } catch (e: CancellationException) {
                throw e
            } catch (e: Err) {
                reply(id, false, "${e.kind}:${e.message}")
            } catch (e: Throwable) {
                reply(id, false, "NetworkError:${e.message}")
            }
        }
    }

    @JavascriptInterface
    fun keepAwake(on: Boolean) {
        act.runOnUiThread {
            if (on) act.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else act.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    @JavascriptInterface
    fun saveFile(name: String, mime: String, b64: String) {
        scope.launch {
            try {
                val bytes = Base64.decode(b64, Base64.DEFAULT)
                val cv = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, name)
                    put(MediaStore.Downloads.MIME_TYPE, mime)
                    put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                }
                val uri = act.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv)!!
                act.contentResolver.openOutputStream(uri)!!.use { it.write(bytes) }
                toast("Saved to Downloads: $name")
            } catch (e: Throwable) {
                toast("Save failed: ${e.message}")
            }
        }
    }

    fun shutdown() {
        scope.cancel()
        links.values.forEach { it.gatt?.close() }
        links.clear()
    }

    // ---------------------------------------------------------------- dispatch

    private suspend fun handle(method: String, a: JSONObject): String? = when (method) {
        "requestDevice" -> {
            ensureReady()
            val d = pick()
            prefs.edit().putString("addr", d.addr).putString("name", d.name ?: "").apply()
            JSONObject().put("id", d.addr).put("name", d.name ?: JSONObject.NULL).toString()
        }
        "getDevices" -> {
            val addr = prefs.getString("addr", null)
            val arr = JSONArray()
            if (addr != null && act.hasBlePermissions())
                arr.put(JSONObject().put("id", addr).put("name", prefs.getString("name", "")))
            arr.toString()
        }
        "connect" -> { ensureReady(); connect(a.getString("id")); null }
        "disconnect" -> { links[a.getString("id")]?.gatt?.disconnect(); null }
        "getService" -> {
            val l = link(a)
            if (l.gatt?.getService(UUID.fromString(a.getString("svc"))) == null) throw Err("NotFoundError", "Service not found")
            null
        }
        "getCharacteristic" -> {
            val p = chr(a).second.properties
            JSONObject()
                .put("read", p and BluetoothGattCharacteristic.PROPERTY_READ != 0)
                .put("write", p and BluetoothGattCharacteristic.PROPERTY_WRITE != 0)
                .put("writeWithoutResponse", p and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0)
                .put("notify", p and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0)
                .put("indicate", p and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0)
                .toString()
        }
        "startNotifications" -> { setNotify(a, true); null }
        "stopNotifications" -> { setNotify(a, false); null }
        "read" -> {
            val (l, c) = chr(a)
            l.exec { l.gatt!!.readCharacteristic(c) }
            JSONObject().put("v", Base64.encodeToString(l.readVal ?: ByteArray(0), Base64.NO_WRAP)).toString()
        }
        "write" -> {
            val (l, c) = chr(a)
            val bytes = Base64.decode(a.getString("v"), Base64.DEFAULT)
            val type = if (a.optBoolean("resp", true) && c.properties and BluetoothGattCharacteristic.PROPERTY_WRITE != 0)
                BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT else BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            l.exec {
                val g = l.gatt!!
                if (Build.VERSION.SDK_INT >= 33) g.writeCharacteristic(c, bytes, type) == BluetoothStatusCodes.SUCCESS
                else { c.writeType = type; c.value = bytes; g.writeCharacteristic(c) }
            }
            null
        }
        else -> throw Err("NotSupportedError", "Unknown method $method")
    }

    private fun reply(id: Int, ok: Boolean, payload: String) {
        act.runOnUiThread {
            web.evaluateJavascript("__bleResult($id,$ok,${JSONObject.quote(payload)})", null)
        }
    }

    private fun emit(js: String) = act.runOnUiThread { web.evaluateJavascript(js, null) }
    private fun toast(m: String) = act.runOnUiThread { Toast.makeText(act, m, Toast.LENGTH_LONG).show() }

    // ---------------------------------------------------------------- permissions, scanning

    private suspend fun ensureReady() {
        val ok = suspendCancellableCoroutine<Boolean> { c ->
            act.runOnUiThread { act.requestBlePermissions { if (c.isActive) c.resume(it) } }
        }
        if (!ok) throw Err("SecurityError", "Bluetooth permission denied")
        if (adapter == null || !adapter.isEnabled) throw Err("NetworkError", "Bluetooth is off. Turn it on and try again.")
    }

    /** Shows a native device chooser fed by a live BLE scan. */
    private suspend fun pick(): Found {
        val scanner = adapter?.bluetoothLeScanner ?: throw Err("NetworkError", "BLE scanner unavailable")
        val result = CompletableDeferred<Found?>()
        val found = LinkedHashMap<String, Found>()
        var order: List<Found> = emptyList()
        val labels = ArrayList<String>()
        var dialog: AlertDialog? = null
        var ui: ArrayAdapter<String>? = null
        val cb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, r: ScanResult) {
                val addr = r.device.address
                val name = r.scanRecord?.deviceName ?: r.device.name
                val f = found.getOrPut(addr) { Found(addr, name, r.rssi) }
                f.rssi = r.rssi
                if (name != null) f.name = name
                order = found.values.sortedWith(compareByDescending<Found> { it.name != null }.thenByDescending { it.rssi })
                labels.clear()
                labels.addAll(order.map { "${it.name ?: "Unknown device"}\n${it.addr}   ${it.rssi} dBm" })
                ui?.notifyDataSetChanged()
            }

            override fun onScanFailed(errorCode: Int) {
                result.completeExceptionally(Err("NetworkError", "Scan failed ($errorCode)"))
            }
        }
        act.runOnUiThread {
            val lv = ListView(act)
            val listAdapter = ArrayAdapter(act, android.R.layout.simple_list_item_1, labels)
            ui = listAdapter
            lv.adapter = listAdapter
            val d = AlertDialog.Builder(act)
                .setTitle("Select your scooter")
                .setMessage("Scanning… Keep the scooter on and close PackDial. If nothing appears, turn Location ON.")
                .setView(lv)
                .setNegativeButton(android.R.string.cancel) { _, _ -> result.complete(null) }
                .setOnCancelListener { result.complete(null) }
                .create()
            lv.setOnItemClickListener { _, _, pos, _ -> result.complete(order.getOrNull(pos)); d.dismiss() }
            dialog = d
            d.show()
            scanner.startScan(null, ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), cb)
            val lm = act.getSystemService(LocationManager::class.java)
            if (lm != null && !lm.isLocationEnabled) toast("Location is OFF. Turn it on, or the scan may find nothing.")
        }
        try {
            return result.await() ?: throw Err("NotFoundError", "No device selected")
        } finally {
            act.runOnUiThread { runCatching { scanner.stopScan(cb) }; dialog?.dismiss() }
        }
    }

    // ---------------------------------------------------------------- GATT

    private fun link(a: JSONObject): Link =
        links[a.getString("id")]?.takeIf { it.up } ?: throw Err("NetworkError", "GATT server not connected")

    private fun chr(a: JSONObject): Pair<Link, BluetoothGattCharacteristic> {
        val l = link(a)
        val s = l.gatt?.getService(UUID.fromString(a.getString("svc"))) ?: throw Err("NotFoundError", "Service not found")
        val c = s.getCharacteristic(UUID.fromString(a.getString("ch"))) ?: throw Err("NotFoundError", "Characteristic not found")
        return l to c
    }

    private suspend fun connect(addr: String) {
        links[addr]?.let {
            if (it.up) return
            it.gatt?.close(); links.remove(addr, it)
        }
        val link = Link(addr)
        links[addr] = link
        val dev = adapter!!.getRemoteDevice(addr)
        link.gatt = dev.connectGatt(act, false, link, BluetoothDevice.TRANSPORT_LE)
        try {
            withTimeout(15_000) { link.ready.await() }
        } catch (e: Throwable) {
            link.gatt?.close(); link.gatt = null; links.remove(addr, link)
            throw if (e is TimeoutCancellationException) Err("NetworkError", "Connection timed out") else e
        }
    }

    private suspend fun setNotify(a: JSONObject, on: Boolean) {
        val (l, c) = chr(a)
        val g = l.gatt!!
        val desc = c.getDescriptor(cccd) ?: throw Err("NotSupportedError", "Characteristic has no CCCD")
        val value = when {
            !on -> BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
            c.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0 -> BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            else -> BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
        }
        g.setCharacteristicNotification(c, on)
        l.exec {
            if (Build.VERSION.SDK_INT >= 33) g.writeDescriptor(desc, value) == BluetoothStatusCodes.SUCCESS
            else { desc.value = value; g.writeDescriptor(desc) }
        }
    }

    private inner class Link(val addr: String) : BluetoothGattCallback() {
        @Volatile var gatt: BluetoothGatt? = null
        @Volatile var up = false
        @Volatile var op: CompletableDeferred<Int>? = null
        @Volatile var readVal: ByteArray? = null
        val ready = CompletableDeferred<Unit>()
        private val lock = Mutex()

        suspend fun exec(start: () -> Boolean) {
            lock.withLock {
                val d = CompletableDeferred<Int>()
                op = d
                try {
                    if (!start()) throw Err("NetworkError", "GATT operation rejected")
                    val s = withTimeout(8_000) { d.await() }
                    if (s == -1) throw Err("NetworkError", "Disconnected")
                    if (s != BluetoothGatt.GATT_SUCCESS) throw Err("NetworkError", "GATT error $s")
                } finally {
                    op = null
                }
            }
        }

        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            gatt = g
            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                g.discoverServices()
            } else {
                val wasUp = up
                up = false
                ready.completeExceptionally(Err("NetworkError", "Disconnected (status $status)"))
                op?.complete(-1)
                g.close()
                gatt = null
                if (links.remove(addr, this) && wasUp) emit("__bleDisc(${JSONObject.quote(addr)})")
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                up = true
                ready.complete(Unit)
            } else {
                ready.completeExceptionally(Err("NetworkError", "Service discovery failed ($status)"))
                g.disconnect()
            }
        }

        override fun onCharacteristicRead(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            if (Build.VERSION.SDK_INT < 33) { readVal = c.value; op?.complete(status) }
        }

        override fun onCharacteristicRead(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
            readVal = value; op?.complete(status)
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            op?.complete(status)
        }

        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
            op?.complete(status)
        }

        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
            if (Build.VERSION.SDK_INT < 33) notifyJs(c, c.value)
        }

        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) {
            notifyJs(c, value)
        }

        private fun notifyJs(c: BluetoothGattCharacteristic, v: ByteArray) {
            val b64 = Base64.encodeToString(v, Base64.NO_WRAP)
            emit("__bleNotify(${JSONObject.quote(addr)},${JSONObject.quote(c.service.uuid.toString())}," +
                "${JSONObject.quote(c.uuid.toString())},${JSONObject.quote(b64)})")
        }
    }
}
