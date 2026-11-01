package com.pampi.assetmanagement

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * PriceAlertWorker — v1.3.8 «اعلان رشد قیمت، حتی وقتی برنامه بسته است»
 *
 * یک WorkManager PeriodicWork (حداقل مجاز گوگل: ۱۵ دقیقه) با قید
 * NetworkType.CONNECTED — یعنی وقتی اینترنت گوشی قطع است اجرا نمی‌شود و
 * **به‌محض وصل‌شدن اینترنت** (حتی با برنامهٔ کاملاً بسته) اجرا می‌شود.
 *
 * کاری که می‌کند:
 *  ۱) لیست دارایی‌های تحت نظر را از SharedPreferences می‌خواند (JS هر بار
 *     که موجودی‌ها عوض می‌شود، لیست تازه را با PriceAlertModule.configure
 *     می‌فرستد — شامل «از کدام کیف پول/صرافی است»).
 *  ۲) قیمت ۲۴ ساعته:
 *     • کوین‌ها → Binance /api/v3/ticker/24hr?symbols=[...] (با فیلترشکن)؛
 *       اگر بلاک/خطا شد → Nobitex apiv2 market/stats (بدون فیلترشکن کار می‌کند).
 *     • USDT → Nobitex USDT-IRT (رشد دلار یعنی رشد ارزش تومانی تتر).
 *     • طلای ۱۸ عیار و دلار → call{1,2}.tgju.org/ajax.json فیلد dp (درصد
 *       تغییر روزانهٔ خود TGJU — بدون نیاز به تاریخچه).
 *  ۳) رشد ≥ آستانه (کوین: پیش‌فرض ۲۰٪، طلا/دلار: پیش‌فرض ۱٪) → Notification.
 *     هر دارایی حداکثر روزی یک اعلان (dedupe با SharedPreferences)؛ اگر
 *     بیش از ۵ دارایی همزمان رشد کنند، یک اعلان خلاصه می‌آید.
 */
class PriceAlertWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    companion object {
        const val WORK_NAME = "price_alert_periodic"
        const val WORK_NOW = "price_alert_now"
        const val PREFS = "price_alert_prefs"
        const val KEY_CONFIG = "config_json"
        const val KEY_STATE = "state_json"
        const val CHANNEL_ID = "price_alerts"
        private const val DAY_MS = 24 * 60 * 60 * 1000L
        private const val MAX_SINGLE_NOTIFICATIONS = 5

        private val TGJU_URLS = listOf(
            "https://call1.tgju.org/ajax.json",
            "https://call2.tgju.org/ajax.json",
            "https://call.tgju.org/ajax.json",
        )

        /** این‌ها جفت اسپات معقول می‌سازند؛ بقیه مستقیم به Nobitex می‌روند. */
        private val STABLES = setOf(
            "USDT", "USDC", "DAI", "TUSD", "FDUSD", "BUSD", "USDP", "EUR", "TRY", "BRL",
        )
        private val LEVERAGED_SUFFIX = listOf("UP", "DOWN", "BULL", "BEAR")

        val FA_DIGITS = arrayOf("۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹")

        /**
         * v1.3.9 — باگ گوشی‌های با لوکال فارسی: DecimalFormat بدون Locale.US
         * رقم‌های فارسی تولید می‌کرد و «c - '0'» ایندکس ~۱۷۳۰ از آرایهٔ ۱۰تایی
         * می‌گرفت (خطای «length=10; index=1730» در آخرین خطا) → ساخت متن اعلان
         * می‌شکست و نوتیفیکیشن هرگز فرستاده نمی‌شد. حالا: فرمت همیشه انگلیسی
         * (Locale.US) + نگاشت رقم فقط برای ASCII 0-9؛ هر کاراکتر دیگر سر جایش.
         */
        fun toFaStr(s: String): String {
            val sb = StringBuilder(s.length)
            for (c in s) {
                if (c in '0'..'9') sb.append(FA_DIGITS[c - '0'])
                else if (c == '.') sb.append('٫')
                else sb.append(c)
            }
            return sb.toString()
        }

        /** 12.34 → «۱۲٫۳۴» (برای متن نوتیفیکیشن فارسی) */
        fun toFa(n: Double): String {
            val s = if (n == n.toLong().toDouble()) String.format(java.util.Locale.US, "%.0f", n) else String.format(java.util.Locale.US, "%.1f", n)
            return toFaStr(s)
        }

        fun toFaGrouped(n: Long): String {
            val symbols = java.text.DecimalFormatSymbols(java.util.Locale.US)
            val grouped = java.text.DecimalFormat("#,###", symbols).format(n)
            return toFaStr(grouped.replace(',', '٬'))
        }

        /** نوتیفیکیشن با کانال و آیکون و کلیک→بازکردن برنامه؛ هم کارگر هم ماژول تست. */
        fun postNotification(ctx: Context, title: String, text: String, alertId: String) {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= 26) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "هشدار رشد قیمت", NotificationManager.IMPORTANCE_HIGH).apply {
                        description = "اعلان رشد قیمت دارایی‌ها (کیف پول، صرافی، طلا و دلار)"
                    },
                )
            }
            val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
            val pi = PendingIntent.getActivity(
                ctx, alertId.hashCode(), launch,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val builder = if (Build.VERSION.SDK_INT >= 26) {
                NotificationCompat.Builder(ctx, CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                NotificationCompat.Builder(ctx)
            }
            builder.setSmallIcon(ctx.applicationInfo.icon)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
            try {
                nm.notify(alertId.hashCode(), builder.build())
            } catch (e: SecurityException) {
                // اجازهٔ نوتیفیکیشن داده نشده (اندروید ۱۳+) — بی‌صدا رد می‌شود
            }
        }
    }

    data class Asset(val id: String, val kind: String, val symbol: String, val pair: String?, val label: String)
    data class Quote(val pct: Double, val priceText: String?)

    override fun doWork(): Result {
        val ctx = applicationContext
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val configJson = prefs.getString(KEY_CONFIG, null) ?: return Result.success()
        val config = try { JSONObject(configJson) } catch (e: Exception) { return Result.success() }
        if (!config.optBoolean("enabled", false)) return Result.success()

        val assets = mutableListOf<Asset>()
        try {
            val arr = config.optJSONArray("assets") ?: JSONArray()
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                assets.add(
                    Asset(
                        id = o.optString("id"),
                        kind = o.optString("kind", "crypto"),
                        symbol = o.optString("symbol"),
                        pair = o.optString("pair", "").ifEmpty { null },
                        label = o.optString("label"),
                    ),
                )
            }
        } catch (e: Exception) { return Result.success() }
        if (assets.isEmpty()) return Result.success()

        val coinPct = config.optDouble("coinPct", 20.0)
        val metalPct = config.optDouble("metalPct", 1.0)

        val quotes = mutableMapOf<String, Quote>()
        try {
            fetchCryptoQuotes(assets.filter { it.kind == "crypto" || it.kind == "stable" }, quotes)
            fetchTgjuQuotes(assets.filter { it.kind == "metal" || it.kind == "fx" }, quotes)
        } catch (e: Exception) {
            recordState(prefs, quotes, "fetch error: ${e.message}")
            return Result.success()
        }

        val state = try { JSONObject(prefs.getString(KEY_STATE, "{}") ?: "{}") } catch (e: Exception) { JSONObject() }
        val now = System.currentTimeMillis()
        val fired = mutableListOf<Pair<Asset, Quote>>()
        for (a in assets) {
            val q = quotes[a.id] ?: continue
            if (q.pct.isNaN() || q.pct <= 0) continue // فقط «رشد» — افت اعلان نمی‌گیرد
            val threshold = if (a.kind == "metal" || a.kind == "fx") metalPct else coinPct
            if (q.pct < threshold) continue
            val last = state.optJSONObject(a.id)
            if (last != null && now - last.optLong("t", 0) < DAY_MS) continue // روزی یک اعلان
            fired.add(a to q)
        }

        if (fired.isNotEmpty()) {
            if (fired.size <= MAX_SINGLE_NOTIFICATIONS) {
                for ((a, q) in fired) {
                    val title = "🚀 ${a.label}"
                    val body = buildString {
                        append("رشد ")
                        append(toFa(q.pct))
                        append("٪ در ۲۴ ساعت")
                        q.priceText?.let { append(" — الان: ").append(it) }
                    }
                    postNotification(ctx, title, body, a.id)
                }
            } else {
                // پامپ عمومی بازار — یک اعلان خلاصه به‌جای اسپم
                val lines = fired.take(12).joinToString("\n") { (a, q) -> "${a.label}: +${toFa(q.pct)}٪" }
                postNotification(
                    ctx,
                    "🚀 رشد گروهی بازار (${toFaGrouped(fired.size.toLong())} دارایی)",
                    lines,
                    "summary:$now",
                )
            }
            for ((a, _) in fired) {
                state.put(a.id, JSONObject().put("t", now).put("pct", quotes[a.id]?.pct ?: 0.0))
            }
        }

        recordState(prefs, quotes, null)
        return Result.success()
    }

    // ── کوین‌ها: Binance (با VPN) → Nobitex (بدون VPN) ────────────────────
    private fun fetchCryptoQuotes(list: List<Asset>, out: MutableMap<String, Quote>) {
        if (list.isEmpty()) return

        // ۱) بایننس — یک درخواست گروهی برای همهٔ جفت‌های اسپات معتبر
        val binancePairs = list.filter { it.kind == "crypto" && it.pair != null && !STABLES.contains(it.symbol.uppercase()) }
            .mapNotNull { it.pair }.distinct()
        if (binancePairs.isNotEmpty()) {
            val symbolsJson = binancePairs.joinToString(",", "[", "]") { "\"$it\"" }
            val body = httpGet("https://api.binance.com/api/v3/ticker/24hr?symbols=" + URLEncoder.encode(symbolsJson, "UTF-8"))
            var batchOk = false
            if (body != null) {
                try {
                    val byPair = mutableMapOf<String, Pair<Double, String>>()
                    val arr = JSONArray(body)
                    for (i in 0 until arr.length()) {
                        val o = arr.getJSONObject(i)
                        byPair[o.optString("symbol")] = (o.optString("priceChangePercent").toDoubleOrNull() ?: Double.NaN) to o.optString("lastPrice")
                    }
                    for (a in list) {
                        val p = a.pair ?: continue
                        val hit = byPair[p] ?: continue
                        val pct = hit.first
                        if (!pct.isNaN()) out[a.id] = Quote(pct, formatUsd(hit.second.toDoubleOrNull()))
                    }
                    batchOk = true
                } catch (e: Exception) { /* → تکی/نوبیتکس */ }
            }
            if (!batchOk) {
                // درخواست گروهی رد شد (جفت نامعتبر، محدودیت نرخ، بلاک جغرافیایی)
                // → تکی‌تکی می‌پرسیم تا یک نماد خراب بقیه را نبُرد
                for (a in list) {
                    val p = a.pair ?: continue
                    if (out[a.id] != null) continue
                    val one = httpGet("https://api.binance.com/api/v3/ticker/24hr?symbol=" + URLEncoder.encode(p, "UTF-8")) ?: continue
                    try {
                        val o = JSONObject(one)
                        val pct = o.optString("priceChangePercent").toDoubleOrNull() ?: Double.NaN
                        if (!pct.isNaN()) out[a.id] = Quote(pct, formatUsd(o.optString("lastPrice").toDoubleOrNull()))
                    } catch (e: Exception) { continue }
                }
            }
        }

        // ۲) هرچه از بایننس نیامد → نوبیتکس (آی‌پی ایران هم جواب می‌دهد)
        val missingCrypto = list.filter { it.kind == "crypto" && out[it.id] == null }
        if (missingCrypto.isNotEmpty()) nobitexQuotes(missingCrypto, "usdt", out)

        // ۳) استیبل‌کوین‌ها (USDT و…) → ارزش تومانی‌شان یعنی دلار → نوبیتکس IRT
        val stables = list.filter { it.kind == "stable" }
        if (stables.isNotEmpty()) nobitexQuotes(stables, "irt", out)
    }

    private fun nobitexQuotes(list: List<Asset>, dst: String, out: MutableMap<String, Quote>) {
        val srcs = list.map { it.symbol.lowercase() }.filter { it.isNotBlank() && it != "irt" && it != "tmn" }.distinct()
        if (srcs.isEmpty()) return
        val body = httpGet("https://apiv2.nobitex.ir/market/stats?srcCurrency=${srcs.joinToString(",")}&dstCurrency=$dst") ?: return
        try {
            val stats = JSONObject(body).optJSONObject("stats") ?: return
            for (a in list) {
                val key = "${a.symbol.lowercase()}-$dst"
                val s = stats.optJSONObject(key) ?: continue
                val pct = s.optDouble("dayChange", Double.NaN)
                if (pct.isNaN()) continue
                val latest = s.optDouble("latest", Double.NaN)
                val priceText = if (!latest.isNaN()) {
                    if (dst == "irt") formatToman(latest.toLong()) else formatUsd(latest)
                } else null
                out[a.id] = Quote(pct, priceText)
            }
        } catch (e: Exception) { /* نوبیتکس در دسترس نیست — این دوره رد می‌شود */ }
    }

    // ── طلا و دلار: TGJU ajax.json — فیلد dp = درصد تغییر روزانه ──────────
    private fun fetchTgjuQuotes(list: List<Asset>, out: MutableMap<String, Quote>) {
        if (list.isEmpty()) return
        var current: JSONObject? = null
        for (url in TGJU_URLS) {
            val body = httpGet(url) ?: continue
            try {
                current = JSONObject(body).optJSONObject("current")
                if (current != null) break
            } catch (e: Exception) { /* آینهٔ بعدی */ }
        }
        val cur = current ?: return
        for (a in list) {
            val o = cur.optJSONObject(a.symbol) ?: continue
            val pct = o.optString("dp", "").replace(",", "").toDoubleOrNull() ?: Double.NaN
            if (pct.isNaN()) continue
            val price = o.optString("p", "").replace(",", "").toLongOrNull()
            out[a.id] = Quote(pct, price?.let { formatToman(it) })
        }
    }

    // ── helpers ───────────────────────────────────────────────────────────
    private fun httpGet(urlStr: String): String? {
        var conn: HttpURLConnection? = null
        return try {
            conn = URL(urlStr).openConnection() as HttpURLConnection
            conn.connectTimeout = 10_000
            conn.readTimeout = 12_000
            conn.instanceFollowRedirects = true
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36")
            conn.setRequestProperty("Accept", "*/*")
            if (conn.responseCode !in 200..299) null else conn.inputStream.bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            null
        } finally {
            conn?.disconnect()
        }
    }

    private fun formatUsd(v: Double?): String? {
        if (v == null || v.isNaN() || v <= 0) return null
        return if (v >= 1000) "${toFaGrouped(v.toLong())} دلار" else "${toFaStr(String.format(java.util.Locale.US, "%.2f", v))} دلار"
    }

    private fun formatToman(v: Long): String = "${toFaGrouped(v)} تومان"

    private fun recordState(prefs: SharedPreferences, quotes: Map<String, Quote>, error: String?) {
        try {
            val prefsJson = prefs.getString(KEY_STATE, "{}") ?: "{}"
            val state = try { JSONObject(prefsJson) } catch (e: Exception) { JSONObject() }
            state.put("lastRunAt", System.currentTimeMillis())
            state.put("lastAssetCount", quotes.size)
            if (error != null) state.put("lastError", error) else state.remove("lastError")
            prefs.edit().putString(KEY_STATE, state.toString()).apply()
        } catch (e: Exception) { /* state غیرحیاتی است */ }
    }
}
