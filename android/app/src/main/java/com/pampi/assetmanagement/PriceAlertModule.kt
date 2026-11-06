package com.pampi.assetmanagement

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
    fun configure(enabled: Boolean, coinPct: Double, metalPct: Double, repeatHours: Double, watchedJson: String, promise: Promise) {
        try {
            PriceAlertPrefs.saveConfig(reactContext, enabled, coinPct, metalPct, repeatHours, watchedJson)
            val wm = androidx.work.WorkManager.getInstance(reactContext)
            if (enabled) {
                PriceAlertWorker.schedulePeriodic(reactContext)
                wm.cancelUniqueWork(PriceAlertWorker.ONESHOT_NAME)
            } else {
                wm.cancelUniqueWork(PriceAlertWorker.PERIODIC_NAME)
                wm.cancelUniqueWork(PriceAlertWorker.ONESHOT_NAME)
                wm.cancelUniqueWork(PriceAlertWorker.ON_CONNECT_NAME)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("CONFIGURE_FAIL", e.message, e)
        }
    }

    /**
     * v1.4.2 — درخواست مجوز نوتیفیکیشن برای اندروید ۱۳+ (API 33): بدون این
     * مجوز، سرویس و WorkManager سالم‌اند ولی هیچ نوتیفیکیشنی نشان داده
     * نمی‌شود و کاربر فکر می‌کند «اعلان کار نمی‌کند».
     * جوابِ کاربر از onRequestPermissionsResult در MainActivity به
     * onPermissionResult همین‌جا (companion) برمی‌گردد.
     */
    @ReactMethod
    fun requestNotificationPermission(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT < 33) {
                promise.resolve(true)
                return
            }
            val granted = androidx.core.content.ContextCompat.checkSelfPermission(
                reactContext,
                android.Manifest.permission.POST_NOTIFICATIONS,
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED
            if (granted) {
                promise.resolve(true)
                return
            }
            val activity = reactContext.getCurrentActivity()
            if (activity == null) {
                promise.resolve(false)
                return
            }
            pendingPermissionPromise = promise
            androidx.core.app.ActivityCompat.requestPermissions(
                activity,
                arrayOf(android.Manifest.permission.POST_NOTIFICATIONS),
                4242,
            )
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    companion object {
        /** درخواست مجوز بازِ فعلی — جوابش از MainActivity می‌آید */
        private var pendingPermissionPromise: Promise? = null

        /** MainActivity.onRequestPermissionsResult این را صدا می‌زند */
        @JvmStatic
        fun onPermissionResult(requestCode: Int, grantResults: IntArray) {
            if (requestCode != 4242) return
            val promise = pendingPermissionPromise
            pendingPermissionPromise = null
            val granted = grantResults.isNotEmpty() &&
                grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED
            promise?.resolve(granted)
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

    /**
     * v1.4.2 — نتیجهٔ رشته‌ای برمی‌گردد تا JS بداند واقعاً چه شد:
     *   "already" — از قبل مجاز است (هیچ پنجره‌ای لازم نیست)
     *   "fired"   — پنجرهٔ رسمی سیستم فرستاده شد
     *   "failed"  — روی این گوشی باز نشد (JS خودش لیست تنظیمات را باز می‌کند)
     * JS بعد از ~۲ ثانیه دوباره چک می‌کند؛ اگر پنجره باز نشده بود (شیائومی
     * گاهی قورت می‌دهد) خودش لیست بهینه‌سازی باتری را باز می‌کند.
     */
    @ReactMethod
    fun requestIgnoreBatteryOptimizations(promise: Promise) {
        try {
            val pm = reactContext.getSystemService(android.content.Context.POWER_SERVICE) as PowerManager
            if (pm.isIgnoringBatteryOptimizations(reactContext.packageName)) {
                promise.resolve("already") // از قبل مجاز — هیچ پنجره‌ای لازم نیست
                return
            }
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                .setData(Uri.parse("package:${reactContext.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            reactContext.startActivity(intent)
            promise.resolve("fired")
        } catch (e: Exception) {
            promise.resolve("failed") // JS → لیست بهینه‌سازی باتری را باز می‌کند
        }
    }

    /** v1.4.1 — صفحهٔ اطلاعات برنامه (مسیر مطمئن شیائومی/هوآوی: Battery → No restrictions) */
    @ReactMethod
    fun openAppDetailsSettings(promise: Promise) {
        try {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.parse("package:${reactContext.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("APPDETAILS_FAIL", e.message, e)
        }
    }

    @ReactMethod
    fun openBatterySettings(promise: Promise) {
        try {
            // v1.4.1 — بدون نیاز به Activity (FLAG_ACTIVITY_NEW_TASK از خود context)
            reactContext.startActivity(
                Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("BATTERY_FAIL", e.message, e)
        }
    }
}
