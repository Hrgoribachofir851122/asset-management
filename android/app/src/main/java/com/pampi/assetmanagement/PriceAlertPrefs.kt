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
 *   watched     — [{key,label,kind,symbol,tgju}] که JS می‌سازد
 *   status      — {lastRun,lastError,okCount,runCount} برای خط وضعیت تنظیمات
 *   fired       — {key:"up"|"down"} — فقط گذر از آستانه اعلان می‌دهد
 *   base        — {key:{base,at}} خط پایهٔ ۲۴ ساعتهٔ فلزات/دلار (TGJU تغییر
 *                 ٪ ۲۴ساعت نمی‌دهد؛ بایننس برای کوین‌ها خودش می‌دهد)
 */
object PriceAlertPrefs {
    const val FILE = "price_alert"
    const val DEFAULT_COIN_PCT = 20.0
    const val DEFAULT_METAL_PCT = 0.5
    /** خط پایهٔ فلزات بعد از ۲۴ ساعت کهنه می‌شود و به قیمت فعلی ری‌ست می‌شود */
    const val BASE_TTL_MS = 24 * 60 * 60 * 1000L

    fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun isEnabled(ctx: Context): Boolean = prefs(ctx).getBoolean("enabled", false)
    fun coinPct(ctx: Context): Double =
        Double.fromBits(prefs(ctx).getLong("coinPctBits", DEFAULT_COIN_PCT.toRawBits()))
    fun metalPct(ctx: Context): Double =
        Double.fromBits(prefs(ctx).getLong("metalPctBits", DEFAULT_METAL_PCT.toRawBits()))

    fun saveConfig(ctx: Context, enabled: Boolean, coinPct: Double, metalPct: Double, watchedJson: String?) {
        prefs(ctx).edit()
            .putBoolean("enabled", enabled)
            .putLong("coinPctBits", coinPct.toRawBits())
            .putLong("metalPctBits", metalPct.toRawBits())
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

    fun bases(ctx: Context): JSONObject =
        JSONObject(prefs(ctx).getString("base", "{}") ?: "{}")

    fun saveBases(ctx: Context, bases: JSONObject) {
        prefs(ctx).edit().putString("base", bases.toString()).apply()
    }
}
