package com.pampi.assetmanagement

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * UpdateNotify.kt — v1.8.0
 *
 * «اعلان نسخهٔ جدید حتی وقتی برنامه باز نیست» (درخواست کاربر):
 *   • UpdateCheckWorker هر ۲ ساعت + هر بازشدن برنامه + بعد از ری‌استارت گوشی
 *     اجرا می‌شود (قید «اینترنت وصل» — به‌محض وصل‌شدن نت هم می‌دود).
 *   • آخرین Release گیتهاب را می‌خواند و با نسخهٔ نصب‌شده (BuildConfig
 *     .VERSION_NAME — همیشه دقیقاً همان چیزی که روی گوشی نصب است) مقایسه
 *     می‌کند. جدیدتر بود → یک اعلان؛ لمس اعلان برنامه را باز می‌کند و بنر
 *     بالای صفحه تازه‌ها + دکمهٔ دانلود را نشان می‌دهد.
 *   • هر نسخه فقط یک‌بار اعلان می‌دهد («notified» در SharedPreferences) تا
 *     مزاحم تکراری نشود؛ نسخهٔ بعدی که منتشر شود دوباره اعلان می‌آید.
 *
 * زنجیرهٔ دریافت (همان الگوی قیمت طلاین v1.3.7 — از ایران هم جواب می‌دهد):
 *   api.github.com مستقیم → allorigins → codetabs → corsproxy
 * (پروکسی سرور خودمان هم می‌توانست لایهٔ اول باشد ولی سرور Railway گاهی
 * قطع می‌شود؛ زنجیرهٔ مستقل اپ هیچ وابستگی به سرور ندارد.)
 */
object UpdateNotify {
    private const val PREFS = "update_check"
    private const val KEY_NOTIFIED = "notified"
    private const val HTTP_TIMEOUT = 10_000

    /** "v1.8.0" / "1.8.0" → [1,8,0]؛ ناشناخته = null */
    private fun parseSemver(v: String?): IntArray? {
        val m = Regex("^v?(\\d+)\\.(\\d+)\\.(\\d+)").find((v ?: "").trim()) ?: return null
        return intArrayOf(
            m.groupValues[1].toInt(),
            m.groupValues[2].toInt(),
            m.groupValues[3].toInt(),
        )
    }

    /** latest > installed؟ (ناشناخته‌ها هرگز «جدیدتر» حساب نمی‌شوند) */
    fun isNewer(latest: String, installed: String): Boolean {
        val a = parseSemver(latest) ?: return false
        val b = parseSemver(installed) ?: return false
        for (i in 0..2) {
            if (a[i] != b[i]) return a[i] > b[i]
        }
        return false
    }

    private fun httpGet(url: String): String? {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = HTTP_TIMEOUT
                readTimeout = HTTP_TIMEOUT
                setRequestProperty("Accept", "application/vnd.github+json")
                setRequestProperty("User-Agent", "asset-management-app")
            }
            if (conn.responseCode !in 200..299) null
            else conn.inputStream.bufferedReader().use { it.readText() }
        } catch (_: Exception) {
            null
        } finally {
            try { conn?.disconnect() } catch (_: Exception) {}
        }
    }

    /** اولین خط مفیدِ changelog برای متن اعلان (بدون هدینگ/جدول مارک‌داون) */
    private fun firstNoteLine(body: String?): String? {
        if (body.isNullOrBlank()) return null
        for (raw in body.lines()) {
            var l = raw.trim()
            if (l.isEmpty()) continue
            if (l.startsWith("#") || l.startsWith("|") || l.startsWith("---")) continue
            if (l.startsWith("-") || l.startsWith("*")) l = l.substring(1).trim()
            l = l.replace("**", "").replace("`", "")
            if (l.isEmpty()) continue
            return if (l.length > 90) l.take(87).trimEnd() + "…" else l
        }
        return null
    }

    /** زنجیرهٔ آینه — اولین پاسخ سالمِ دارای نسخهٔ معتبر برنده است */
    private fun fetchLatestRelease(): Pair<String, String>? {
        val target = "https://api.github.com/repos/${UpdateCheckWorker.REPO}/releases/latest"
        val encoded = URLEncoder.encode(target, "UTF-8")
        val layers = listOf(
            target,
            "https://api.allorigins.win/raw?url=$encoded",
            "https://api.codetabs.com/v1/proxy?quest=$encoded",
            "https://corsproxy.io/?url=$encoded",
        )
        for (layer in layers) {
            try {
                val body = httpGet(layer) ?: continue
                val o = JSONObject(body)
                val tag = o.optString("tag_name", "").ifBlank { o.optString("name", "") }
                if (parseSemver(tag) == null) continue
                return Pair(tag, o.optString("body", ""))
            } catch (_: Exception) {
                // لایهٔ بعدی
            }
        }
        return null
    }

    fun checkAndNotify(ctx: Context) {
        val installed = BuildConfig.VERSION_NAME
        val (tag, body) = fetchLatestRelease() ?: return
        if (!isNewer(tag, installed)) return
        val ver = parseSemver(tag)!!.joinToString(".")
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getString(KEY_NOTIFIED, null) == ver) return
        val note = firstNoteLine(body)
        val sent = PriceAlertNotification.postUpdate(
            ctx,
            versionFa = PriceAlertWorker.toFaStr(ver),
            note = note,
        )
        // فقط اگر اعلان واقعاً فرستاده شد ثبت شود؛ اگر مجوز نبود دفعهٔ بعد دوباره تلاش می‌شود
        if (sent) prefs.edit().putString(KEY_NOTIFIED, ver).apply()
    }
}
