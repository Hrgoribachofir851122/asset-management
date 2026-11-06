/**
 * utils/globalMarketHours.ts — v1.1.0 (درخواست کاربر)
 *
 * «وقتی بازار بسته هست قیمت انس در قیمت لحظه‌ای قرمز بشه» — ساعت‌کار بازار
 * جهانی طلا (XAU/USD — بازار OTC/اسپات که TGJU «انس» را از همان می‌خواند):
 *
 *   • شنبه (UTC): تعطیل کامل
 *   • جمعه (UTC): تا ۲۱:۰۰ باز، بعدش تعطیل
 *   • یکشنبه (UTC): از ۲۲:۰۰ باز می‌شود
 *   • دوشنبه تا پنجشنبه: باز، فقط وقفهٔ روزانهٔ ۲۱:۰۰ تا ۲۲:۰۰ UTC
 *
 * همهٔ محاسبات UTC است (ساعت تهران = UTC+3:30 — قبلاً ساعت تابستانی نمی‌شود
 * چون فقط UTC مبناست). نتیجه در هر رندر ارزان است؛ UI هر دقیقه دوباره ارزیابی
 * می‌کند تا گذر از مرز باز/بسته دیده شود.
 */

/** باز بودن بازار جهانی طلا (XAU/USD) در این لحظه؟ */
export function isGlobalGoldMarketOpen(now: Date = new Date()): boolean {
  const day = now.getUTCDay(); // 0=یکشنبه … 5=جمعه، 6=شنبه
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();

  if (day === 6) return false; // شنبه — تعطیل
  if (day === 5 && mins >= 21 * 60) return false; // جمعه بعدازظهر به بعد — تعطیل
  if (day === 0 && mins < 22 * 60) return false; // یکشنبه تا ۲۲:۰۰ — تعطیل
  // وقفهٔ روزانهٔ ۲۱:۰۰–۲۲:۰۰ UTC (دوشنبه تا پنجشنبه؛ جمعه/یکشنبه بالا هندل شده)
  if (mins >= 21 * 60 && mins < 22 * 60) return false;
  return true;
}

/** برچسب فارسی وضعیت بازار برای نمایش زیر قیمت‌های لحظه‌ای. */
export function globalGoldMarketLabel(now: Date = new Date()): {
  open: boolean;
  text: string;
} {
  const open = isGlobalGoldMarketOpen(now);
  return {
    open,
    text: open ? 'بازار جهانی طلا: باز' : 'بازار جهانی طلا: بسته',
  };
}
