package com.pampi.assetmanagement

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * PriceAlertWorker.kt — v1.4.0 (بازنویسی کامل)
 *
 * سرویس اعلان «رشد/ریزش قیمت» حتی وقتی برنامه کاملاً بسته است:
 *   • هر ~۱۵ دقیقه (WorkManager دوره‌ای) + بلافاصله بعد از وصل‌شدن اینترنت
 *     (کاربر از «بررسی همین حالا» هم می‌تواند دستور بدهد) + بعد از ری‌استارت
 *     گوشی (BootReceiver).
 *   • کوین‌ها: تغییر ٪ ۲۴ ساعتهٔ واقعی از Binance (ticker/24hr)؛ اگر
 *     فیلترشکن خاموش بود، از Nobitex (dayChange) — بدون خط پایه.
 *   • طلا/سکه/دلار: فید عمومی TGJU (call1/call2/call ajax.json) — چون این فید
 *     تغییر٪ نمی‌دهد، کارگر خط پایهٔ ۲۴ ساعتهٔ خودش را نگه می‌دارد (base + at؛
 *     بعد از ۲۴ ساعت ری‌ست). قیمت‌ها از ریال به تومان ÷۱۰ می‌شوند — همان که
 *     خود اپ نشان می‌دهد. (نسخهٔ قبلی قیمت ریالی خام را تومان می‌نوشت →
 *     «۲۵۵٬۸۰۰٬۰۰۰ تومان» به‌جای ۲۵٬۵۸۰٬۰۰۰!)
 *   • هر دو جهت: رشد ≥ +آستانه → اعلان سبزِ منطقِ رشد؛ ریزش ≤ −آستانه → اعلان
 *     ریزش. فقط گذر از آستانه اعلان می‌دهد (برگشت زیر آستانه دوباره مسلح
 *     می‌شود) تا هر ۱۵ دقیقه اسپم نیاید.
 *   • آیکون نوتیفیکیشن: لوگوی برنامه (largeIcon گرد) + سیلوئت سفید
 *     ic_notification در نوار وضعیت — نه آیکون پیش‌فرض.
 */

class PriceAlertWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {

    companion object {
        const val PERIODIC_NAME = "price_alert_periodic"
        const val ONESHOT_NAME = "price_alert_now"
        /** هر ۱۵ دقیقه — حداقل مجاز WorkManager؛ WorkManager خودش در Doze تعویق می‌کند */
        private val PERIOD_MS = 15L
        private const val HTTP_TIMEOUT = 12_000
        /** حداکثر اعلان در هر اجرا — جلوگیری از باران نوتیفیکیشن */
        private const val MAX_NOTIFY_PER_RUN = 6

        fun schedulePeriodic(context: Context) {
            val req = PeriodicWorkRequestBuilder<PriceAlertWorker>(PERIOD_MS, TimeUnit.MINUTES)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC_NAME, ExistingPeriodicWorkPolicy.KEEP, req,
            )
        }

        fun checkNow(context: Context) {
            val req = OneTimeWorkRequestBuilder<PriceAlertWorker>().build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                ONESHOT_NAME, ExistingWorkPolicy.REPLACE, req,
            )
        }

        private val FA_DIGITS = arrayOf("۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹")

        /**
         * v1.3.9 — باگ گوشی‌های با لوکال فارسی: DecimalFormat بدون Locale.US
         * رقم‌های فارسی تولید می‌کرد و نگاشت «c - '0'» ایندکس ~۱۷۳۰ از آرایهٔ
         * ۱۰تایی می‌گرفت (خطای «length=10; index=1730») → متن اعلان می‌شکست و
         * اعلان هرگز فرستاده نمی‌شد. حالا: فرمت همیشه انگلیسی (Locale.US) +
         * نگاشت رقم فقط برای ASCII 0-9.
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

        fun toFa(n: Double): String =
            toFaStr(String.format(Locale.US, "%.1f", n))

        fun toFaGrouped(n: Long): String {
            val sym = DecimalFormatSymbols(Locale.US)
            val grouped = DecimalFormat("#,###", sym).format(n)
            return toFaStr(grouped.replace(',', '٬'))
        }

        /** نمونهٔ فارسی برای اعلان آزمایشی */
        fun sampleText(): String =
            "مثال: بیت‌کوین ۴٫۲٪ رشد در ۲۴ ساعت — اکنون: " + toFaGrouped(2_558_000_000L / 10) + " تومان"
    }

    data class Watched(
        val key: String,
        val label: String,
        val kind: String,   // coin | metal | fiat
        val symbol: String, // برای coin: نماد بایننس مثل BTCUSDT
        val tgju: String,   // برای metal/fiat: کلید فید TGJU مثل geram18
    )

    data class Reading(val pct: Double, val priceToman: Double?, val source: String)

    override suspend fun doWork(): Result {
        val ctx = applicationContext
        if (!PriceAlertPrefs.isEnabled(ctx)) return Result.success()
        val started = System.currentTimeMillis()
        var lastError: String? = null
        var notified = 0
        try {
            notified = runCheck(ctx)
        } catch (e: Exception) {
            lastError = "fetch error: ${e.message ?: e.javaClass.simpleName}"
        }
        val runs = try {
            (PriceAlertPrefs.status(ctx).optInt("runCount", 0)) + 1
        } catch (_: Exception) { 1 }
        PriceAlertPrefs.saveStatus(ctx, started, lastError?.take(160), notified, runs)
        return Result.success()
    }

    private fun runCheck(ctx: Context): Int {
        val watched = mutableListOf<Watched>()
        val arr: JSONArray = PriceAlertPrefs.watched(ctx)
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            watched.add(
                Watched(
                    key = o.optString("key"),
                    label = o.optString("label", o.optString("key")),
                    kind = o.optString("kind", "coin"),
                    symbol = o.optString("symbol").uppercase(Locale.US),
                    tgju = o.optString("tgju"),
                ),
            )
        }
        if (watched.isEmpty()) return 0

        val coinPct = PriceAlertPrefs.coinPct(ctx)
        val metalPct = PriceAlertPrefs.metalPct(ctx)

        val coins = watched.filter { it.kind == "coin" && it.symbol.isNotBlank() }
        val metals = watched.filter { it.kind != "coin" && it.tgju.isNotBlank() }

        val coinReadings = fetchCoinReadings(coins)
        val metalReadings = fetchMetalReadings(ctx, metals)

        val fired = PriceAlertPrefs.fired(ctx)
        var notified = 0
        for (w in watched) {
            val r = coinReadings[w.key] ?: metalReadings[w.key] ?: continue
            val thr = if (w.kind == "coin") coinPct else metalPct
            val direction = when {
                r.pct >= thr -> "up"
                r.pct <= -thr -> "down"
                else -> null
            }
            val prev = fired.optString(w.key, "")
            when {
                // گذر تازه از آستانه → اعلان؛ بعدش همان جهت ثبت می‌شود
                direction != null && direction != prev -> {
                    if (notified < MAX_NOTIFY_PER_RUN) {
                        notify(ctx, w, direction, r)
                        notified++
                    }
                    fired.put(w.key, direction)
                }
                // برگشت زیر آستانه → مسلح‌شدن دوباره
                direction == null && prev.isNotEmpty() -> fired.remove(w.key)
            }
        }
        PriceAlertPrefs.saveFired(ctx, fired)
        return notified
    }

    // ─── کوین‌ها: Binance 24h change (fallback: Nobitex dayChange) ─────────

    private fun fetchCoinReadings(coins: List<Watched>): Map<String, Reading> {
        if (coins.isEmpty()) return emptyMap()
        val out = HashMap<String, Reading>()
        val bySymbol = coins.associateBy { it.symbol }

        // لایهٔ ۱ — بایننس: تغییر٪ واقعی ۲۴ ساعته
        try {
            val symbolsJson = JSONArray().apply { coins.forEach { put(it.symbol) } }
            val url = "https://api.binance.com/api/v3/ticker/24hr?symbols=" +
                URLEncoder.encode(symbolsJson.toString(), "UTF-8")
            val body = httpGet(url) ?: throw RuntimeException("no response")
            val arr = JSONArray(body)
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val sym = o.optString("symbol").uppercase(Locale.US)
                val w = bySymbol[sym] ?: continue
                val pct = o.optDouble("priceChangePercent", Double.NaN)
                val last = o.optDouble("lastPrice", Double.NaN)
                if (pct.isFinite()) {
                    out[w.key] = Reading(pct, if (last.isFinite()) last else null, "binance")
                }
            }
        } catch (_: Exception) {
            // فیلترشکن خاموش/بلاک — لایهٔ ۲ نوبیتکس
        }

        // لایهٔ ۲ — نوبیتکس: dayChange ٪ برای هر نماد (قیمت RLS → تومان ÷۱۰)
        val missing = coins.filter { it.symbol !in out.mapValues { it.value }.keys && it.key !in out }
        if (missing.isNotEmpty()) {
            try {
                val srcs = missing.mapNotNull { w ->
                    w.symbol.removeSuffix("USDT").takeIf { it.isNotBlank() }?.lowercase(Locale.US)
                }.distinct().joinToString(",")
                if (srcs.isNotBlank()) {
                    val url = "https://api.nobitex.ir/market/stats?srcCurrency=$srcs&dstCurrency=rls"
                    val body = httpGet(url) ?: throw RuntimeException("no response")
                    val o = JSONObject(body).optJSONObject("stats") ?: return out
                    for (w in missing) {
                        val base = w.symbol.removeSuffix("USDT").lowercase(Locale.US)
                        val s = o.optJSONObject("$base-rls") ?: continue
                        val pctStr = s.optString("dayChange", "").replace("%", "").trim()
                        val pct = pctStr.toDoubleOrNull() ?: continue
                        val latestRls = s.optDouble("latest", Double.NaN)
                        out[w.key] = Reading(
                            pct,
                            if (latestRls.isFinite()) latestRls / 10.0 else null,
                            "nobitex",
                        )
                    }
                }
            } catch (_: Exception) {
                // هر دو منبع نشد — این دور کوین‌ها بی‌اعلان
            }
        }
        return out
    }

    // ─── فلزات/دلار: فید TGJU + خط پایهٔ ۲۴ ساعته ─────────────────────────

    private fun fetchMetalReadings(ctx: Context, metals: List<Watched>): Map<String, Reading> {
        if (metals.isEmpty()) return emptyMap()
        val byTgju = metals.associateBy { it.tgju }
        val prices = HashMap<String, Double>() // tgju → تومان
        var lastErr: String? = null
        for (mirror in listOf(
            "https://call1.tgju.org/ajax.json",
            "https://call2.tgju.org/ajax.json",
            "https://call.tgju.org/ajax.json",
        )) {
            try {
                val body = httpGet(mirror) ?: continue
                val current = JSONObject(body).optJSONObject("current") ?: continue
                for ((tgju, w) in byTgju) {
                    val p = current.optJSONObject(tgju)?.optString("p") ?: continue
                    val clean = p.filter { it.isDigit() }
                    val rial = clean.toLongOrNull() ?: continue
                    if (rial <= 0) continue
                    // v1.4.0 — رفع باگ ×۱۰: TGJU ریال می‌دهد؛ اپ تومان نشان می‌دهد
                    prices[tgju] = rial / 10.0
                }
                if (prices.isNotEmpty()) { lastErr = null; break }
            } catch (e: Exception) {
                lastErr = e.message
            }
        }
        if (prices.isEmpty()) {
            if (lastErr != null) throw RuntimeException("tgju: $lastErr")
            return emptyMap()
        }

        val bases = PriceAlertPrefs.bases(ctx)
        val now = System.currentTimeMillis()
        val out = HashMap<String, Reading>()
        for ((tgju, w) in byTgju) {
            val cur = prices[tgju] ?: continue
            val b = bases.optJSONObject(w.key)
            var base = b?.optDouble("base", Double.NaN) ?: Double.NaN
            val at = b?.optLong("at", 0L) ?: 0L
            if (!base.isFinite() || base <= 0 || now - at > PriceAlertPrefs.BASE_TTL_MS) {
                // خط پایهٔ تازه — هنوز «بازهٔ ۲۴ ساعت» کامل نیست، اعلان نمی‌دهیم
                val obj = JSONObject().put("base", cur).put("at", now)
                bases.put(w.key, obj)
                out[w.key] = Reading(0.0, cur, "tgju-base")
                continue
            }
            val pct = (cur - base) / base * 100.0
            out[w.key] = Reading(pct, cur, "tgju")
        }
        PriceAlertPrefs.saveBases(ctx, bases)
        return out
    }

    // ─── اعلان ─────────────────────────────────────────────────────────────

    private fun notify(ctx: Context, w: Watched, direction: String, r: Reading) {
        val up = direction == "up"
        val title = if (up) "📈 رشد قیمت" else "📉 ریزش قیمت"
        val sb = StringBuilder()
        sb.append(w.label).append(' ')
        sb.append(toFa(Math.abs(r.pct)))
        sb.append('٪').append(if (up) " رشد در ۲۴ ساعت" else " ریزش در ۲۴ ساعت")
        r.priceToman?.let {
            sb.append(" — اکنون: ").append(toFaGrouped(it.toLong())).append(" تومان")
        }
        sb.append('\n').append(if (up) "آستانه: " else "آستانه: ")
            .append(toFa(if (w.kind == "coin") PriceAlertPrefs.coinPct(ctx) else PriceAlertPrefs.metalPct(ctx)))
            .append('٪')
        PriceAlertNotification.post(
            ctx,
            title = title,
            text = sb.toString(),
            alertId = w.key,
            up = up,
        )
    }

    private fun httpGet(url: String): String? {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = HTTP_TIMEOUT
                readTimeout = HTTP_TIMEOUT
                setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36")
                setRequestProperty("Accept", "*/*")
            }
            if (conn.responseCode !in 200..299) null
            else conn.inputStream.bufferedReader().use { it.readText() }
        } catch (_: Exception) {
            null
        } finally {
            try { conn?.disconnect() } catch (_: Exception) {}
        }
    }
}
