import AsyncStorage from '@react-native-async-storage/async-storage';
import { getServerUrl } from '@/utils/scanServerApi';
import { persianToEnglishDigits } from '@/utils/iranMarketApi';

/**
 * talineApi.ts — v1.3.7
 *
 * «قیمت خرید و فروش هر گرم طلای آب‌شده از سایت طلاین» — the LIVE rate of
 * taline.ir, shown in the دارایی ریالی section under the TGJU price grid.
 *
 * v1.3.7 — «قیمت طلایین در دسترس نیست» fix — بدون نیاز به سرور ریلوی:
 *   the old build fetched the rate ONLY through our Railway backend
 *   (/taline-gold) — when the server itself went down (502، مثل همین هفته)
 *   the whole card went blank. Now the app fetches taline's official live
 *   rate DIRECTLY like every other instant price (TGJU الگو)، with a
 *   5-layer parallel chain — first valid answer wins:
 *
 *     ۱) t.me/s/TalinePrice مستقیم — کانال رسمی طلاین، همان نرخ لحظه‌ای
 *        سایت (گرم ۱۸ عیار خرید/فروش)، هر ۲–۵ دقیقه به‌روز؛ خواندنی از هر
 *        آی‌پی‌ای که تلگرامش باز است (VPN یا خارج از ایران).
 *     ۲) api.allorigins.win/raw — آینهٔ عمومی همان کانال؛ پراکسی با آی‌پی
 *        خودش تلگرام را می‌خواند، پس گوشی نیازی به دسترسی به تلگرام ندارد
 *        (همان لایه‌ای که برای TGJU هم استفاده می‌شود).
 *     ۳) api.codetabs.com/v1/proxy — آینهٔ دوم کانال.
 *     ۴) corsproxy.io — آینهٔ سوم کانال.
 *     ۵) سرور خودمان /taline-gold (اگر بالا بود) + صفحهٔ taline.ir مستقیم
 *        (وقتی بلوک ESI آن زوج خرید/فروش را داشته باشد).
 *
 *   و در نهایت کش: حافظه ۶۰ ثانیه → AsyncStorage ۱۰ دقیقه → آخرین قیمت
 *   معتبر تا ۲۴ ساعت. «در دسترس نیست» فقط وقتی نمایش داده می‌شود که هر
 *   ۵ لایهٔ زنده و هر دو کش همزمان شکست بخورند.
 */

const TALINE_TG_URL = 'https://t.me/s/TalinePrice';
const TALINE_SITE_URL = 'https://taline.ir/';

const CACHE_KEY = '@taline_gold_v1';
const CACHE_TTL = 10 * 60 * 1000; // AsyncStorage fresh window
const MEMORY_TTL = 60 * 1000; // in-flight result
const STALE_MAX = 24 * 60 * 60 * 1000; // last-resort window
const FETCH_TIMEOUT = 10_000; // per layer — layers run in parallel

export interface TalineGold {
  /** قیمت خرید هر گرم طلای آب‌شده — تومان */
  buy: number;
  /** قیمت فروش هر گرم طلای آب‌شده — تومان */
  sell: number;
  /** When the rate itself was captured (post time or fetch time). */
  updatedAt: number;
  /** Where the rate came from (کانال رسمی / آینه / taline.ir / سرور). */
  source: string;
}

let memoryCache: { at: number; data: TalineGold } | null = null;

/** The refresh button clears this so invalidate performs a real network hit. */
export function clearTalineGoldMemoryCache(): void {
  memoryCache = null;
}

function plausible(n: number): boolean {
  return Number.isFinite(n) && n >= 5_000_000 && n <= 200_000_000;
}

/** تومان معقول: خرید/فروش باید در بازهٔ منطقی و با فاصلهٔ کم از هم باشند. */
function plausiblePair(buy: number, sell: number): boolean {
  if (!plausible(buy) || !plausible(sell)) return false;
  return sell / buy >= 0.9 && sell / buy <= 1.1;
}

function parseToman(raw: string): number {
  const clean = persianToEnglishDigits(String(raw)).replace(/[,،\s]/g, '');
  if (!/^\d{5,12}$/.test(clean)) return NaN;
  return parseFloat(clean);
}

/** fetch با تایم‌اوت — هر لایه حداکثر ۱۰ ثانیه؛ لایه‌ها موازی‌اند. */
async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.8',
};

/**
 * کانال تلگرام طلاین: آخرین پیامِ «نرخ لحظه‌ای طلاین» را می‌خواند.
 * قالب پست‌ها:
 *   💰 گرم ۱۸ عیار
 *   🔸 خرید: ۲۵,۹۰۰,۶۹۹
 *   🔹 فروش: ۲۵,۶۹۴,۲۹۵
 * گرمِ ۱۸ عیارِ طلاین = همان «قیمت خرید/فروش هر گرم طلای آب‌شده» سایت است
 * (عددِ مثقالِ «مظنه آب‌شده» ~۱۱۲هزار است و با رنج اعتبارسنجی رد می‌شود).
 */
function parseTelegramPage(html: string): TalineGold | null {
  try {
    const texts = [...html.matchAll(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g)];
    for (let i = texts.length - 1; i >= 0; i--) {
      const norm = persianToEnglishDigits(texts[i][1].replace(/<[^>]+>/g, ' '));
      if (!/گرم\s*18\s*عیار/.test(norm)) continue;
      const buyMatch = /خرید\s*[:؛]\s*([\d][\d,،.]{5,15})/.exec(norm);
      const sellMatch = /فروش\s*[:؛]\s*([\d][\d,،.]{5,15})/.exec(norm);
      if (!buyMatch || !sellMatch) continue;
      const buy = parseToman(buyMatch[1]);
      const sell = parseToman(sellMatch[1]);
      if (!plausiblePair(buy, sell)) continue;
      // زمان پست: تگ <time datetime="..."> بعد از همان پیام
      const tail = html.slice(texts[i].index ?? 0, (texts[i].index ?? 0) + 4000);
      const t = /datetime="([^"]+)"/.exec(tail);
      const parsed = t ? Date.parse(t[1]) : NaN;
      return {
        buy,
        sell,
        updatedAt: Number.isFinite(parsed) ? parsed : Date.now(),
        source: 'طلاین (کانال رسمی)',
      };
    }
  } catch {}
  return null;
}

/**
 * سایت taline.ir: عدد بعد از «قیمت خرید هر گرم» / «قیمت فروش هر گرم».
 * وقتی بلوک ESI عدد واقعی داشته باشد کار می‌کند؛ با «—» null برمی‌گردد.
 */
function parseSitePage(html: string): TalineGold | null {
  const grab = (label: string): number => {
    const idx = html.indexOf(label);
    if (idx < 0) return NaN;
    const seg = persianToEnglishDigits(html.slice(idx, idx + 800).replace(/<[^>]+>/g, ' '));
    const num = /([0-9]{1,3}(?:[,،][0-9]{3})+|[0-9]{7,12})/.exec(seg);
    return num ? parseToman(num[1]) : NaN;
  };
  const buy = grab('قیمت خرید هر گرم');
  const sell = grab('قیمت فروش هر گرم');
  if (!plausiblePair(buy, sell)) return null;
  return { buy, sell, updatedAt: Date.now(), source: 'taline.ir' };
}

/** لایه‌های زنده — همهٔ آینه‌های تلگرام + سایت + سرور، به‌صورت موازی. */
async function fetchLiveParallel(): Promise<TalineGold | null> {
  const tgEncoded = encodeURIComponent(TALINE_TG_URL);

  const layerDirectTg = (async () => {
    const html = await fetchWithTimeout(TALINE_TG_URL, BROWSER_HEADERS);
    return html ? parseTelegramPage(html) : null;
  })();

  const layerAllorigins = (async () => {
    const html = await fetchWithTimeout(`https://api.allorigins.win/raw?url=${tgEncoded}`, BROWSER_HEADERS);
    return html ? parseTelegramPage(html) : null;
  })();

  const layerCodetabs = (async () => {
    const html = await fetchWithTimeout(`https://api.codetabs.com/v1/proxy?quest=${tgEncoded}`, BROWSER_HEADERS);
    return html ? parseTelegramPage(html) : null;
  })();

  const layerCorsproxy = (async () => {
    const html = await fetchWithTimeout(`https://corsproxy.io/?url=${tgEncoded}`, BROWSER_HEADERS);
    return html ? parseTelegramPage(html) : null;
  })();

  const layerServer = (async () => {
    try {
      const base = await getServerUrl();
      const body = await fetchWithTimeout(`${base}/taline-gold`, { Accept: 'application/json' });
      if (!body) return null;
      const data = JSON.parse(body) as { ok?: boolean; buy?: number; sell?: number; postTimeIso?: string | null; ts?: number };
      if (!data?.ok || !plausiblePair(data.buy ?? NaN, data.sell ?? NaN)) return null;
      const parsed = data.postTimeIso ? Date.parse(data.postTimeIso) : NaN;
      return {
        buy: data.buy!,
        sell: data.sell!,
        updatedAt: Number.isFinite(parsed) ? parsed : (data.ts ?? Date.now()),
        source: 'طلاین (سرور)',
      };
    } catch {
      return null;
    }
  })();

  const layerSite = (async () => {
    const html = await fetchWithTimeout(TALINE_SITE_URL, BROWSER_HEADERS);
    return html ? parseSitePage(html) : null;
  })();

  const results = await Promise.allSettled([layerDirectTg, layerAllorigins, layerCodetabs, layerCorsproxy, layerServer, layerSite]);
  // اولویت: کانال مستقیم → آینه‌ها → سرور → سایت
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) return r.value;
  }
  return null;
}

async function readCache(maxAgeMs: number): Promise<TalineGold | null> {
  try {
    const stored = await AsyncStorage.getItem(CACHE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as TalineGold;
    if (!parsed?.buy || !plausible(parsed.buy) || Date.now() - parsed.updatedAt > maxAgeMs) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(data: TalineGold): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {}
}

/**
 * Fetches taline's live per-gram buy/sell rate — بدون نیاز به سرور.
 * Chain: memory (60s) → ۵ لایهٔ زندهٔ موازی → AsyncStorage fresh → stale.
 * Returns null only when we have never seen a valid rate anywhere.
 */
export async function fetchTalineGold(): Promise<TalineGold | null> {
  if (memoryCache && Date.now() - memoryCache.at < MEMORY_TTL) {
    return memoryCache.data;
  }

  const live = await fetchLiveParallel();
  if (live) {
    memoryCache = { at: Date.now(), data: live };
    await writeCache(live);
    console.log('[TalineGold] fetched —', live.source, 'buy:', live.buy, 'sell:', live.sell);
    return live;
  }

  // همهٔ لایه‌ها شکست خوردند → کش تازه، بعد آخرین نسخهٔ معتبر (≤۲۴ ساعت).
  const cached = await readCache(CACHE_TTL);
  if (cached) return cached;
  const stale = await readCache(STALE_MAX);
  if (stale) {
    console.log('[TalineGold] serving STALE cache from', new Date(stale.updatedAt).toISOString());
    return stale;
  }
  return null;
}
