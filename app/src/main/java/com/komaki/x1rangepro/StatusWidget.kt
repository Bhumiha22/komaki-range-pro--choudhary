package com.komaki.x1rangepro

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

/** Home-screen widget: battery level, range left and when the scooter was last seen. */
class StatusWidget : AppWidgetProvider() {

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        manager.updateAppWidget(ids, build(context))
    }

    companion object {
        private const val PREFS = "status"

        fun save(ctx: Context, soc: Int, range: Int, charging: Boolean, eta: Int) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putInt("soc", soc).putInt("range", range).putBoolean("chg", charging)
                .putInt("eta", eta).putLong("t", System.currentTimeMillis()).apply()
            refresh(ctx)
        }

        fun refresh(ctx: Context) {
            val m = AppWidgetManager.getInstance(ctx)
            val ids = m.getAppWidgetIds(ComponentName(ctx, StatusWidget::class.java))
            if (ids.isNotEmpty()) m.updateAppWidget(ids, build(ctx))
        }

        private fun ago(t: Long): String {
            val min = (System.currentTimeMillis() - t) / 60000
            return when {
                min < 1 -> "Updated just now"
                min < 60 -> "Updated $min min ago"
                min < 1440 -> "Last seen ${min / 60} h ago"
                else -> "Last seen ${min / 1440} d ago"
            }
        }

        private fun build(ctx: Context): RemoteViews {
            val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val soc = p.getInt("soc", -1)
            val range = p.getInt("range", -1)
            val chg = p.getBoolean("chg", false)
            val eta = p.getInt("eta", -1)
            val t = p.getLong("t", 0L)
            val v = RemoteViews(ctx.packageName, R.layout.widget_status)

            v.setTextViewText(R.id.w_soc, if (soc >= 0) "$soc%" else "--%")
            v.setTextViewText(R.id.w_chg, if (chg) "Charging" else "")
            val bars = intArrayOf(R.id.w_bar_blue, R.id.w_bar_green, R.id.w_bar_amber, R.id.w_bar_red)
            val on = when {
                soc in 0..15 -> R.id.w_bar_red
                soc in 16..30 -> R.id.w_bar_amber
                chg -> R.id.w_bar_green
                else -> R.id.w_bar_blue
            }
            bars.forEach {
                v.setViewVisibility(it, if (it == on) android.view.View.VISIBLE else android.view.View.GONE)
                v.setProgressBar(it, 100, soc.coerceAtLeast(0), false)
            }
            v.setTextViewText(R.id.w_rng, if (range >= 0) "$range km" else "-- km")
            v.setTextViewText(
                R.id.w_sub,
                when {
                    soc < 0 -> "Open the app to connect"
                    chg && eta > 0 -> "full in " + (if (eta >= 60) "${eta / 60} h ${eta % 60} min" else "$eta min")
                    else -> "range left"
                }
            )
            v.setTextViewText(R.id.w_upd, if (t > 0) ago(t) else "")

            val open = PendingIntent.getActivity(
                ctx, 0, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
            v.setOnClickPendingIntent(R.id.w_root, open)
            return v
        }
    }
}
