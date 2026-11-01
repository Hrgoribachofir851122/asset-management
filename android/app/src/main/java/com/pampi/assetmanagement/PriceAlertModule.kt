package com.pampi.assetmanagement

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * PriceAlertModule.kt — v1.4.0
 *
 * پل JS ↔ تنظیمات اعلان (SharedPreferences) و کارگر پس‌زمینه:
 *   configure(enabled, coinPct, metalPct, watchedJson) → ذخیره + زمان‌بندی/لغو
 *   testAlert()  → یک اعلان نمونه فوری
 *   checkNow()   → اجرای فوری کارگر (OneTime)
 *   getStatus()  → {lastRun,lastError,runCount,okCount} برای خط وضعیت تنظیمات
 *   isIgnoringBatteryOptimizations() → آیا سیستم اجازهٔ کار در پس‌زمینه داده؟
 *   requestIgnoreBatteryOptimizations() → دیالوگ رسمی سیستم (نیاز به Activity)
 */

class PriceAlertModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "PriceAlert"

    @ReactMethod
    fun configure(enabled: Boolean, coinPct: Double, metalPct: Double, watchedJson: String, promise: Promise) {
        try {
            PriceAlertPrefs.saveConfig(reactContext, enabled, coinPct, metalPct, watchedJson)
            val wm = androidx.work.WorkManager.getInstance(reactContext)
            if (enabled) {
                PriceAlertWorker.schedulePeriodic(reactContext)
                wm.cancelUniqueWork(PriceAlertWorker.ONESHOT_NAME)
            } else {
                wm.cancelUniqueWork(PriceAlertWorker.PERIODIC_NAME)
                wm.cancelUniqueWork(PriceAlertWorker.ONESHOT_NAME)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("CONFIGURE_FAIL", e.message, e)
        }
    }

    @ReactMethod
    fun testAlert(promise: Promise) {
        try {
            PriceAlertNotification.post(
                reactContext,
                title = "📈 اعلان آزمایشی",
                text = PriceAlertWorker.sampleText(),
                alertId = "test",
                up = true,
            )
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("TEST_FAIL", e.message, e)
        }
    }

    @ReactMethod
    fun checkNow(promise: Promise) {
        try {
            PriceAlertWorker.checkNow(reactContext)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("CHECK_FAIL", e.message, e)
        }
    }

    @ReactMethod
    fun getStatus(promise: Promise) {
        try {
            promise.resolve(PriceAlertPrefs.status(reactContext).toString())
        } catch (e: Exception) {
            promise.reject("STATUS_FAIL", e.message, e)
        }
    }

    @ReactMethod
    fun isIgnoringBatteryOptimizations(promise: Promise) {
        try {
            val pm = reactContext.getSystemService(android.content.Context.POWER_SERVICE) as PowerManager
            promise.resolve(pm.isIgnoringBatteryOptimizations(reactContext.packageName))
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun requestIgnoreBatteryOptimizations(promise: Promise) {
        try {
            val activity: Activity? = reactContext.currentActivity
            if (activity == null) {
                promise.resolve(false)
                return
            }
            if (Build.VERSION.SDK_INT >= 23) {
                val pm = reactContext.getSystemService(android.content.Context.POWER_SERVICE) as PowerManager
                if (!pm.isIgnoringBatteryOptimizations(reactContext.packageName)) {
                    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                        .setData(Uri.parse("package:${reactContext.packageName}"))
                    activity.startActivityForResult(intent, 9412)
                }
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("BATTERY_FAIL", e.message, e)
        }
    }

    @ReactMethod
    fun openBatterySettings(promise: Promise) {
        try {
            val activity: Activity? = reactContext.currentActivity
            if (activity != null) {
                activity.startActivity(
                    Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
                )
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("BATTERY_FAIL", e.message, e)
        }
    }
}
