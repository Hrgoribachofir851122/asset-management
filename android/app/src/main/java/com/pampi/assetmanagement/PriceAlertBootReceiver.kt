package com.pampi.assetmanagement

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * PriceAlertBootReceiver.kt — v1.4.0
 * بعد از ری‌استارت گوشی، کارگر دوره‌ای اعلان دوباره زمان‌بندی می‌شود
 * (WorkManager خودش boot-persistence دارد؛ این گیرهٔ مطمئنِ اضافه است —
 * فقط وقتی کاربر اعلان را روشن کرده اجرا می‌شود).
 * v1.8.0 — کارگر «اعلان نسخهٔ جدید» مستقل از اعلان قیمت، همیشه مسلح می‌شود.
 */
class PriceAlertBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (Build.VERSION.SDK_INT >= 31 && intent.getBooleanExtra(Intent.EXTRA_REPLACING, false)) return
        try { UpdateCheckWorker.schedulePeriodic(context) } catch (_: Exception) {}
        if (PriceAlertPrefs.isEnabled(context)) {
            PriceAlertWorker.schedulePeriodic(context)
        }
    }
}
