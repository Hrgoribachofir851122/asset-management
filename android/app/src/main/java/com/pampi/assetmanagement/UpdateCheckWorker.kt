package com.pampi.assetmanagement

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * UpdateCheckWorker.kt — v1.8.0
 *
 * کارگر پس‌زمینهٔ «اعلان نسخهٔ جدید» — مستقل از اعلان رشد/ریزش قیمت، برای
 * همهٔ کاربرها همیشه فعال است (حتی اگر اعلان قیمت خاموش باشد):
 *   • دوره‌ای هر ۲ ساعت با قید NetworkType.CONNECTED
 *   • هر بازشدن برنامه یک چک فوری (اگر نت قطع باشد، به‌محض وصل‌شدن اجرا
 *     می‌شود — همان الگوی price_alert_on_connect)
 *   • بعد از ری‌استارت گوشی هم PriceAlertBootReceiver دوباره مسلحش می‌کند
 *
 * WorkManager در سندباکس/Doze تعویق می‌کند ولی با مجوز «بهینه‌سازی باتری»
 * (که کاربر برای اعلان قیمت داده) روی شیائومی هم سر وقت اجرا می‌شود.
 */
class UpdateCheckWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {

    companion object {
        /** ریپوی رسمی بروزرسانی (مثل DEFAULT_GITHUB_REPO در constants/appInfo.ts) */
        const val REPO = "Hrgoribachofir851122/asset-management"
        private const val PERIODIC_NAME = "update_check_periodic"
        private const val ON_OPEN_NAME = "update_check_on_open"
        /** هر ۲ ساعت — نسخهٔ جدید لازم نیست دقیقه‌ای چک شود */
        private const val PERIOD_HOURS = 2L

        fun schedulePeriodic(context: Context) {
            val req = PeriodicWorkRequestBuilder<UpdateCheckWorker>(PERIOD_HOURS, TimeUnit.HOURS)
                .setConstraints(
                    androidx.work.Constraints.Builder()
                        .setRequiredNetworkType(androidx.work.NetworkType.CONNECTED)
                        .build(),
                )
                .build()
            // UPDATE (نه KEEP): اگر در نسخهٔ بعدی دوره عوض شد، با اولین
            // بازشدن برنامه زمان‌بندی تازه اعمال می‌شود؛ خودِ چک هم در هر
            // بازشدن با armOnOpen انجام می‌شود پس تأخیری ایجاد نمی‌کند.
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC_NAME, ExistingPeriodicWorkPolicy.UPDATE, req,
            )
        }

        fun armOnOpen(context: Context) {
            try {
                val req = OneTimeWorkRequestBuilder<UpdateCheckWorker>()
                    .setConstraints(
                        androidx.work.Constraints.Builder()
                            .setRequiredNetworkType(androidx.work.NetworkType.CONNECTED)
                            .build(),
                    )
                    .build()
                WorkManager.getInstance(context).enqueueUniqueWork(
                    ON_OPEN_NAME, ExistingWorkPolicy.REPLACE, req,
                )
            } catch (_: Exception) {
            }
        }
    }

    override suspend fun doWork(): Result {
        try {
            UpdateNotify.checkAndNotify(applicationContext)
        } catch (_: Exception) {
            // چک بروزرسانی هرگز نباید کارگر را قرمز کند — دور بعد دوباره
        }
        return Result.success()
    }
}
