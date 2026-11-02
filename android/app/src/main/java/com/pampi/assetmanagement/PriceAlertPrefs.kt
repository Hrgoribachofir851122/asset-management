package com.pampi.assetmanagement

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/**
 * PriceAlertPrefs.kt — v1.4.0
 *
 * تنظیمات و وضعیت «اعلان رشد/ریزش قیمت» در یک SharedPreferences مستقل —
 * هم ماژول JS (از طریق PriceAlertModule) و هم کارگر پس‌زمینه بدون نیاز به
 * پارس SQLiteِ AsyncStorage مستقیم می‌خوانند/می‌نویسند. سریع، همگام و
 * مقاوم به کرش.
 *
 * کلیدها:
 *   enabled     — سرویس روشن است؟
 *   coinPct     — آستانهٔ رشد/ریزش کوین‌ها (٪ در ۲۴ ساعت)
 *   metalPct    — آستانهٔ رشد/ریزش طلا و دلار (٪ در ۲۴ ساعت)
 *   repeatHours — v1.4.2 — اگر اعلان دیده نشد: تا وقتی دارایی بالای آستانه
 *                 بماند، هر N ساعت دوباره اعلان بده (۰ = فقط بار اول)
 *   watched     — [{key,label,kind,symbol,tgju}] که JS می‌سازد
 *   status      — {lastRun,lastError,okCount,runCount} برای خط وضعیت تنظیمات
 *   fired       — {key:"up"|"down"} — فقط گذر از آستانه اعلان می‌دهد
 *   notifAt     — v1.4.2 — {key:timestamp} آخرین بار که برای هر دارایی اعلان
 *                 رفت؛ مبنای «تکرار هر N ساعت»
 *   base        — {key:{base,at}} خط پایهٔ ۲۴ ساعتهٔ فلزات/دلار (TGJU تغییر
 *                 ٪ ۲۴ساعت نمی‌دهد؛ بایننس برای کوین‌ها خودش می‌دهد)
 */
object PriceAlertPrefs {
    const val FILE = "price_alert"
    const val DEFAULT_COIN_PCT = 10.0
    const val DEFAULT_METAL_PCT = 1.0
    /** v1.4.2 — پیش‌فرض تکرار اعلان: هر ۶ ساعت تا وقتی سیگنال برقرار است */
    const val DEFAULT_REPEAT_HOURS = 6.0
    /** خط پایهٔ فلزات بعد از ۲۴ ساعت کهنه می‌شود و به قیمت فعلی ری‌ست می‌شود */
    const val BASE_TTL_MS = 24 * 60 * 60 * 1000L

    fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun isEnabled(ctx: Context): Boolean = prefs(ctx).getBoolean("enabled", false)
    fun coinPct(ctx: Context): Double =
        Double.fromBits(prefs(ctx).getLong("coinPctBits", DEFAULT_COIN_PCT.toRawBits()))
    fun metalPct(ctx: Context): Double =
        Double.fromBits(prefs(ctx).getLong("metalPctBits", DEFAULT_METAL_PCT.toRawBits()))
    fun repeatHours(ctx: Context): Double =
        Double.fromBits(prefs(ctx).getLong("repeatHoursBits", DEFAULT_REPEAT_HOURS.toRawBits()))

    fun saveConfig(ctx: Context, enabled: Boolean, coinPct: Double, metalPct: Double, repeatHours: Double, watchedJson: String?) {
        prefs(ctx).edit()
            .putBoolean("enabled", enabled)
            .putLong("coinPctBits", coinPct.toRawBits())
            .putLong("metalPctBits", metalPct.toRawBits())
            .putLong("repeatHoursBits", repeatHours.toRawBits())
            .putString("watched", watchedJson ?: "[]")
            .apply()
    }

    fun watched(ctx: Context): JSONArray = JSONArray(prefs(ctx).getString("watched", "[]") ?: "[]")

    fun saveStatus(ctx: Context, lastRun: Long, lastError: String?, okCount: Int, runCount: Int) {
        prefs(ctx).edit().putString(
            "status",
            JSONObject().apply {
                put("lastRun", lastRun)
                put("lastError", lastError ?: JSONObject.NULL)
                put("okCount", okCount)
                put("runCount", runCount)
            }.toString(),
        ).apply()
    }

    fun status(ctx: Context): JSONObject =
        JSONObject(prefs(ctx).getString("status", "{}") ?: "{}")

    fun fired(ctx: Context): JSONObject =
        JSONObject(prefs(ctx).getString("fired", "{}") ?: "{}")

    fun saveFired(ctx: Context, fired: JSONObject) {
        prefs(ctx).edit().putString("fired", fired.toString()).apply()
    }

    /** v1.4.2 — آخرین زمان اعلان برای هر دارایی (مبنای تکرار) */
    fun notifAt(ctx: Context): JSONObject =
        JSONObject(prefs(ctx).getString("notifAt", "{}") ?: "{}")

    fun saveNotifAt(ctx: Context, m: JSONObject) {
        prefs(ctx).edit().putString("notifAt", m.toString()).apply()
    }

    fun bases(ctx: Context): JSONObject =
        JSONObject(prefs(ctx).getString("base", "{}") ?: "{}")

    fun saveBases(ctx: Context, bases: JSONObject) {
        prefs(ctx).edit().putString("base", bases.toString()).apply()
    }
}
