package com.pampi.assetmanagement

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.os.Build
import android.view.View
import androidx.core.app.NotificationCompat

/**
 * PriceAlertNotification.kt — v1.4.2
 *
 * نوتیفیکیشن با هویت برنامه:
 *   • smallIcon = ic_notification (سیلوئت سفیدِ لوگو — استاندارد نوار وضعیت).
 *     نکتهٔ اندروید: آیکون نوار وضعیت از API 24 به بعد را سیستم اجباراً
 *     تک‌رنگ می‌کند (هیچ اپی نمی‌تواند رنگی‌اش کند) — برای همین سیلوئتِ
 *     شفافِ سفید گذاشته‌ایم تا به‌جای مربع تیره، لوگوی تمیز و روشن دیده شود.
 *   • largeIcon = ic_logo_mirror — v1.4.2: لوگوی رنگیِ برنامه، آینه‌شده
 *     (خلاف جهت قبلی) به درخواست کاربر، کنار سرتیتر اعلان.
 *   • رنگ accent زرد برنامه؛ سبز برای رشد، قرمز برای ریزش.
 */

object PriceAlertNotification {
    const val CHANNEL_RISE = "price_alert_rise"
    const val CHANNEL_FALL = "price_alert_fall"
    /** v1.8.0 — کانال مستقل «اعلان بروزرسانی برنامه» (کاربر می‌تواند جدا خاموشش کند) */
    const val CHANNEL_UPDATE = "app_updates"
    private const val GROUP_KEY = "com.pampi.assetmanagement.PRICE_ALERT"

    fun ensureChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT >= 26) {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_RISE, "اعلان رشد قیمت", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "رشد قیمت دارایی‌های کیف پول، صرافی، طلا و دلار"
                },
            )
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_FALL, "اعلان ریزش قیمت", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "ریزش قیمت دارایی‌های کیف پول، صرافی، طلا و دلار"
                },
            )
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_UPDATE, "اعلان بروزرسانی برنامه", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "وقتی نسخهٔ جدیدی از برنامه منتشر شود خبر می‌دهد (هر نسخه فقط یک‌بار)"
                },
            )
        }
    }

    fun post(ctx: Context, title: String, text: String, alertId: String, up: Boolean) {
        ensureChannels(ctx)
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
        val pi = PendingIntent.getActivity(
            ctx, alertId.hashCode(), launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // v1.4.2 — لوگوی رنگی آینه‌ای؛ اگر نبود لوگوی گرد ساده
        val largeIcon = try {
            BitmapFactory.decodeResource(ctx.resources, R.drawable.ic_logo_mirror)
                ?: BitmapFactory.decodeResource(ctx.resources, R.drawable.ic_logo_round)
        } catch (_: Exception) {
            try {
                BitmapFactory.decodeResource(ctx.resources, R.drawable.ic_logo_round)
            } catch (_: Exception) { null }
        }

        val builder = if (Build.VERSION.SDK_INT >= 26) {
            NotificationCompat.Builder(ctx, if (up) CHANNEL_RISE else CHANNEL_FALL)
        } else {
            @Suppress("DEPRECATION")
            NotificationCompat.Builder(ctx)
        }
        builder.setSmallIcon(R.drawable.ic_notification)
            .setColor(if (up) 0xFF0ECB81.toInt() else 0xFFF6465D.toInt())
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setGroup(GROUP_KEY)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
        largeIcon?.let { builder.setLargeIcon(it) }
        try {
            nm.notify(alertId.hashCode(), buildRtl(ctx, builder))
        } catch (_: SecurityException) {
            // اجازهٔ نوتیفیکیشن داده نشده (اندروید ۱۳+) — بی‌صدا رد می‌شود
        }
    }

    /**
     * v1.9.0 — اعلان همیشه راست‌به‌چپ رندر می‌شود: آیکون برنامه سمت راست و
     * متن (مثل «ریزش قیمت») بعد از آن — مستقل از زبان گوشی (درخواست کاربر).
     *
     * Notification.Builder و RemoteViews متد setLayoutDirection مستقیم ندارند؛
     * از این‌رو روی RemoteViews محتوای اعلان (API 24+) از طریق setInt و
     * reflection روی view ریشه، setLayoutDirection(RTL) را فراخوانی می‌کنیم —
     * این روش از API 3 در دسترس است و مطمئن‌ترین راه قفل‌کردن RTL اعلان است.
     */
    private fun buildRtl(ctx: Context, builder: NotificationCompat.Builder): Notification {
        val base = builder.build()
        return if (Build.VERSION.SDK_INT >= 24) {
            try {
                val nBuilder = Notification.Builder.recoverBuilder(ctx, base)
                nBuilder.createContentView()?.let { rv ->
                    // setInt با reflection متد setLayoutDirection را روی آیکون
                    // (نمای شروع قالب اعلان) صدا می‌زند → چیدمان راست‌به‌چپ.
                    rv.setInt(android.R.id.icon, "setLayoutDirection", View.LAYOUT_DIRECTION_RTL)
                    nBuilder.setCustomContentView(rv)
                }
                nBuilder.build()
            } catch (_: Exception) {
                base
            }
        } else {
            base
        }
    }

    /**
     * v1.8.0 — اعلان «نسخهٔ جدید منتشر شد». IMPORTANCE_DEFAULT (بالای
     * صفحه نمی‌پرد؛ در شید و نوار وضعیت می‌نشیند) + زرد accent برنامه.
     * برمی‌گرداند: اعلان واقعاً پست شد؟ (مبنای ثبت «notified» در UpdateNotify)
     */
    fun postUpdate(ctx: Context, versionFa: String, note: String?): Boolean {
        ensureChannels(ctx)
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
        val pi = PendingIntent.getActivity(
            ctx, "app_update".hashCode(), launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val largeIcon = try {
            BitmapFactory.decodeResource(ctx.resources, R.drawable.ic_logo_mirror)
                ?: BitmapFactory.decodeResource(ctx.resources, R.drawable.ic_logo_round)
        } catch (_: Exception) {
            try {
                BitmapFactory.decodeResource(ctx.resources, R.drawable.ic_logo_round)
            } catch (_: Exception) { null }
        }
        val text = "نسخهٔ $versionFa منتشر شد" +
            (note?.let { " — $it" } ?: " — برنامه را باز کنید تا تازه‌ها و دکمهٔ دانلود را ببینید")
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            NotificationCompat.Builder(ctx, CHANNEL_UPDATE)
        } else {
            @Suppress("DEPRECATION")
            NotificationCompat.Builder(ctx)
        }
        builder.setSmallIcon(R.drawable.ic_notification)
            .setColor(0xFFFCD535.toInt())
            .setContentTitle("🔔 نسخهٔ جدید مدیریت دارایی")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
        largeIcon?.let { builder.setLargeIcon(it) }
        return try {
            nm.notify("app_update".hashCode(), buildRtl(ctx, builder))
            true
        } catch (_: SecurityException) {
            false
        }
    }
}
