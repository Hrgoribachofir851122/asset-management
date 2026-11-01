package com.pampi.assetmanagement

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.Configuration
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * PriceAlertModule — v1.3.8 پل JS ↔ سرویس اعلان رشد قیمت
 *
 * از JS:
 *   NativeModules.PriceAlert.configure(configJson)  — ذخیرهٔ تنظیمات + لیست
 *     دارایی‌ها و زمان‌بندی/لغو WorkManager دوره‌ای (۱۵ دقیقه، قید اینترنت)
 *   .requestPermission()  — اجازهٔ نوتیفیکیشن اندروید ۱۳+ (جواب: boolean)
 *   .testNotification()   — یک اعلان آزمایشی همین حالا
 *   .runNow()             — اجرای فوری یک دورهٔ چک
 *   .getStatus()          — {enabled, hasPermission, assetCount, lastRunAt, lastError}
 *   .openBatterySettings() — صفحهٔ «بدون بهینه‌سازی باتری» برای گوشی‌های
 *                            شیائومی/سامسونگ/هوآوی که اپ‌های پس‌زمینه را می‌کشند
 */
class PriceAlertModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "PriceAlert"
        const val PERM_CODE = 4711

        /** جواب درخواست اجازه از MainActivity.onRequestPermissionsResult می‌آید */
        @Volatile
        var permissionCallback: ((Boolean) -> Unit)? = null

        fun onPermissionResult(requestCode: Int, grantResults: IntArray) {
            if (requestCode != PERM_CODE) return
            val cb = permissionCallback
            permissionCallback = null
            cb?.invoke(grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED)
        }
    }

    override fun getName(): String = NAME

    private fun prefs() = reactApplicationContext.getSharedPreferences(PriceAlertWorker.PREFS, Context.MODE_PRIVATE)

    private fun isGranted(): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(reactApplicationContext, android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun workManager(): WorkManager = try {
        WorkManager.getInstance(reactApplicationContext)
    } catch (e: IllegalStateException) {
        // اگر androidx.startup زودتر مقداردهی نکرده باشد — مقداردهی امن
        WorkManager.initialize(reactApplicationContext, Configuration.Builder().build())
        WorkManager.getInstance(reactApplicationContext)
    }

    @ReactMethod
    fun hasPermission(promise: Promise) {
        promise.resolve(isGranted())
    }

    @ReactMethod
    fun requestPermission(promise: Promise) {
        if (isGranted()) {
            promise.resolve(true)
            return
        }
        val activity: Activity? = reactApplicationContext.currentActivity
        if (Build.VERSION.SDK_INT >= 33 && activity != null) {
            permissionCallback = { granted -> promise.resolve(granted) }
            try {
                activity.requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), PERM_CODE)
            } catch (e: Exception) {
                permissionCallback = null
                promise.resolve(false)
            }
        } else {
            // زیر اندروید ۱۳ نوتیفیکیشن بدون اجازهٔ ران‌تایم است
            promise.resolve(true)
        }
    }

    /** ذخیرهٔ تنظیمات + لیست دارایی‌ها؛ enabled=true → زمان‌بندی، false → لغو */
    @ReactMethod
    fun configure(configJson: String, promise: Promise) {
        try {
            val config = JSONObject(configJson) // فقط اعتبار JSON چک می‌شود
            prefs().edit().putString(PriceAlertWorker.KEY_CONFIG, config.toString()).apply()
            val wm = workManager()
            if (config.optBoolean("enabled", false)) {
                val request = PeriodicWorkRequestBuilder<PriceAlertWorker>(15, TimeUnit.MINUTES)
                    .setConstraints(
                        Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
                    )
                    .build()
                wm.enqueueUniquePeriodicWork(PriceAlertWorker.WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, request)
            } else {
                wm.cancelUniqueWork(PriceAlertWorker.WORK_NAME)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("CONFIGURE_FAILED", e.message, e)
        }
    }

    /** اجرای فوری یک دورهٔ چک (بدون قید اینترنت — چکِ دستی) */
    @ReactMethod
    fun runNow(promise: Promise) {
        try {
            val request = OneTimeWorkRequestBuilder<PriceAlertWorker>().build()
            workManager().enqueueUniqueWork(PriceAlertWorker.WORK_NOW, ExistingWorkPolicy.REPLACE, request)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("RUN_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun testNotification(promise: Promise) {
        try {
            if (!isGranted()) {
                promise.resolve(false)
                return
            }
            PriceAlertWorker.postNotification(
                reactApplicationContext,
                "🔔 اعلان آزمایشی — فعال است",
                "اعلان رشد قیمت کار می‌کند؛ حتی وقتی برنامه بسته است و اینترنت تازه وصل شده باشد.",
                "test_notification",
            )
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("TEST_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun openBatterySettings(promise: Promise) {
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + reactApplicationContext.packageName))
        try {
            val activity = reactApplicationContext.currentActivity
            if (activity != null) {
                activity.startActivity(direct)
            } else {
                val fallback = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                reactApplicationContext.startActivity(fallback)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            try {
                val fallback = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                reactApplicationContext.startActivity(fallback)
                promise.resolve(true)
            } catch (e2: Exception) {
                promise.resolve(false)
            }
        }
    }

    @ReactMethod
    fun getStatus(promise: Promise) {
        try {
            val state = JSONObject(prefs().getString(PriceAlertWorker.KEY_STATE, "{}") ?: "{}")
            val config = JSONObject(prefs().getString(PriceAlertWorker.KEY_CONFIG, "{}") ?: "{}")
            val map = Arguments.createMap()
            map.putBoolean("enabled", config.optBoolean("enabled", false))
            map.putBoolean("hasPermission", isGranted())
            map.putInt("assetCount", config.optJSONArray("assets")?.length() ?: 0)
            map.putDouble("lastRunAt", state.optDouble("lastRunAt", 0.0))
            map.putString("lastError", if (state.has("lastError") && !state.isNull("lastError")) state.optString("lastError") else null)
            map.putInt("lastAssetCount", state.optInt("lastAssetCount", 0))
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("STATUS_FAILED", e.message, e)
        }
    }
}
