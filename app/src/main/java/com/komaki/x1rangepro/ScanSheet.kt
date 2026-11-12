package com.komaki.x1rangepro

import android.app.Activity
import android.app.Dialog
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView

data class Found(val addr: String, var name: String?, var rssi: Int, var likely: Boolean = false)

/** Dark bottom sheet that lists nearby BLE devices while a scan runs. Main thread only. */
class ScanSheet(
    private val act: Activity,
    private val onPick: (Found) -> Unit,
    private val onCancel: () -> Unit
) {
    private val accent = Color.parseColor("#3AA0FF")
    private val muted = Color.parseColor("#8A94A0")
    private val dlg = Dialog(act, R.style.SheetDialog)
    private val list = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL }
    private val empty = TextView(act)
    private val ui = Handler(Looper.getMainLooper())
    private var items: List<Found> = emptyList()
    private var queued = false
    private var picked = false

    private fun dp(v: Int) = (v * act.resources.displayMetrics.density).toInt()
    private fun text(t: String, sp: Float, color: Int, weight: String = "sans-serif") = TextView(act).apply {
        this.text = t; setTextSize(TypedValue.COMPLEX_UNIT_SP, sp); setTextColor(color)
        typeface = Typeface.create(weight, Typeface.NORMAL)
    }

    private fun round(color: Int, r: Float, stroke: Int = 0) = GradientDrawable().apply {
        setColor(color); cornerRadius = r
        if (stroke != 0) setStroke(dp(1), stroke)
    }

    fun show() {
        val sheet = LinearLayout(act).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(10), dp(20), dp(26))
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#0F1114"))
                val r = dp(28).toFloat(); cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
                setStroke(dp(1), Color.parseColor("#1FFFFFFF"))
            }
        }
        // grab handle
        sheet.addView(View(act).apply { background = round(Color.parseColor("#33FFFFFF"), dp(2).toFloat()) },
            LinearLayout.LayoutParams(dp(38), dp(4)).apply { gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = dp(18) })
        sheet.addView(text("Find your scooter", 24f, Color.WHITE, "sans-serif-medium"))
        sheet.addView(text("Switch the scooter on, close PackDial and stay close to it.", 13.5f, muted).apply {
            setPadding(0, dp(4), 0, dp(14))
        })
        sheet.addView(ProgressBar(act, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = true
            indeterminateTintList = ColorStateList.valueOf(accent)
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)).apply { bottomMargin = dp(14) })

        empty.apply {
            text = "Searching for Bluetooth devices…\nNothing showing? Turn Location on."
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f); setTextColor(muted)
            gravity = Gravity.CENTER; setPadding(0, dp(28), 0, dp(28)); setLineSpacing(0f, 1.25f)
        }
        list.addView(empty)
        val maxH = (act.resources.displayMetrics.heightPixels * 0.42f).toInt()
        sheet.addView(ScrollView(act).apply { addView(list); overScrollMode = View.OVER_SCROLL_NEVER },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, maxH))

        sheet.addView(text("Cancel", 15f, Color.WHITE, "sans-serif-medium").apply {
            gravity = Gravity.CENTER
            background = RippleDrawable(ColorStateList.valueOf(Color.parseColor("#22FFFFFF")),
                round(Color.parseColor("#1A1D22"), dp(16).toFloat()), null)
            setOnClickListener { dlg.cancel() }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(50)).apply { topMargin = dp(16) })

        dlg.requestWindowFeature(Window.FEATURE_NO_TITLE)
        dlg.setContentView(sheet)
        dlg.setOnCancelListener { if (!picked) onCancel() }
        dlg.window?.apply {
            setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            setGravity(Gravity.BOTTOM)
            setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
            addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND); setDimAmount(0.6f)
        }
        dlg.show()
        sheet.translationY = dp(420).toFloat()
        sheet.animate().translationY(0f).setDuration(260).start()
    }

    fun dismiss() { runCatching { dlg.dismiss() } }

    /** Called from scan callbacks; redraws at most twice a second. */
    fun submit(found: Collection<Found>) {
        items = found.toList()
        if (queued) return
        queued = true
        ui.postDelayed({ queued = false; redraw() }, 450)
    }

    private fun redraw() {
        list.removeAllViews()
        if (items.isEmpty()) { list.addView(empty); return }
        val sorted = items.sortedWith(compareByDescending<Found> { it.likely }
            .thenByDescending { it.name != null }.thenByDescending { it.rssi })
        sorted.forEach { list.addView(row(it)) }
    }

    private fun row(f: Found): View {
        val line = LinearLayout(act).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(13), dp(16), dp(13))
            val base = round(Color.parseColor(if (f.likely) "#10223A" else "#15181C"), dp(18).toFloat(),
                if (f.likely) accent else Color.parseColor("#14FFFFFF"))
            background = RippleDrawable(ColorStateList.valueOf(Color.parseColor("#22FFFFFF")), base, null)
            setOnClickListener { picked = true; dlg.dismiss(); onPick(f) }
        }
        val col = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL }
        col.addView(text(f.name ?: "Unnamed device", 16f, if (f.name == null) muted else Color.WHITE, "sans-serif-medium"))
        col.addView(text(if (f.likely) "Likely your scooter" else f.addr, 12.5f, if (f.likely) accent else muted))
        line.addView(col, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        line.addView(Signal(f.rssi, if (f.likely) accent else Color.parseColor("#C9D1D9")),
            LinearLayout.LayoutParams(dp(26), dp(20)))
        val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        lp.bottomMargin = dp(8)
        line.layoutParams = lp
        return line
    }

    /** Four-bar signal strength glyph. */
    private inner class Signal(rssi: Int, private val on: Int) : View(act) {
        private val level = when { rssi >= -60 -> 4; rssi >= -72 -> 3; rssi >= -84 -> 2; else -> 1 }
        private val p = Paint(Paint.ANTI_ALIAS_FLAG)
        override fun onDraw(c: Canvas) {
            val w = width / 7f
            for (i in 0 until 4) {
                p.color = if (i < level) on else Color.parseColor("#33FFFFFF")
                val h = height * (0.35f + 0.65f * (i + 1) / 4f)
                c.drawRoundRect(RectF(i * 2 * w, height - h, i * 2 * w + w * 1.4f, height.toFloat()), w / 2, w / 2, p)
            }
        }
    }
}
