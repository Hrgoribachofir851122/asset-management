import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * iranMarketApi.ts — v1.4.14
 *
 * Live Iranian market prices (gold / silver / coins / mesghal / USD) in TOMAN,
 * from TGJU's public widget API (call1/call2/call mirrors — the same feed that
 * powers tgju.org). No auth, no geo-block for Iranian users.
 *
 * v1.4.14 — «قیمت فلزات با فیلترشکن روشن نمی‌آید» fix:
 *   TGJU sits behind Cloudflare and answers fine from MOST foreign exit IPs
 *   (verified live), but some VPN exits are bot-flagged by Cloudflare and get
 *   an HTML challenge instead of the JSON — both mirrors then fail and the
 *   whole price grid goes blank. Fix = a 3-layer chain:
 *     1. direct mirrors (call1 / call2 / call.tgju) — Iranian IP & clean exits
 *     2. CORS-proxy mirror (api.allorigins.win) — ITS server fetches TGJU, so
 *        the phone's (possibly challenged) exit IP never touches tgju.org
 *     3. stale cache (≤ 24h) with the old timestamp — never a blank grid
 *
 * TGJU returns Iranian prices in RIAL → converted to Toman (/10).
 * Values are cached in memory (60s) + AsyncStorage (10 min) so the wallet's
 * 5-minute refresh never hammers the API, and a failed refresh still shows
 * the last known prices with an «آخرین دریافت» timestamp.
 */

const TGJU_MIRRORS = [
  'https://call1.tgju.org/ajax.json',
  'https://call2.tgju.org/ajax.json',
  'https://call.tgju.org/ajax.json',
];

/**
 * v1.4.14 — proxy mirror for VPN exits that Cloudflare challenges. The proxy
 * service fetches the TGJU file with ITS OWN (clean) IP and streams it back —
 * the response is identical JSON. Only used after every direct mirror fails.
 */
const TGJU_PROXY_MIRRORS = [
  'https://api.allorigins.win/raw?url=' + encodeURIComponent('https://call1.tgju.org/ajax.json'),
  'https://api.allorigins.win/raw?url=' + encodeURIComponent('https://call2.tgju.org/ajax.json'),
];

const CACHE_KEY = '@iran_market_prices_v2'; // v1.5.12 — v2: + goldOunceUsd (انس جهانی)
const CACHE_TTL = 10 * 60 * 1000; // 10 min AsyncStorage
const MEMORY_TTL = 60 * 1000; // 60s in-flight result

export interface IranMarketPrices {
  /** هر گرم طلای ۱۸ عیار — تومان */
  gold18: number;
  /** هر گرم طلای ۲۴ عیار — تومان */
  gold24: number;
  /**
   * v1.5.12 — «قیمت انس جهانی طلا» (XAU/USD) — دلار، نه تومان؛ از همان
   * فید TGJU با نماد «ons» می‌آید (مثل بقیه بدون احراز هویت).
   */
  goldOunceUsd: number;
  /** هر گرم نقره ۹۹۹ — تومان */
  silver999: number;
  /** هر گرم نقره ۹۲۵ — تومان */
  silver925: number;
  /** سکه امامی — تومان */
  coinEmami: number;
  /** سکه بهار آزادی — تومان */
  coinBahar: number;
  /** نیم سکه — تومان */
  coinNim: number;
  /** ربع سکه — تومان */
  coinRob: number;
  /** مثقال طلا — تومان */
  mesghal: number;
  /** دلار بازار آزاد — تومان */
  dollar: number;
  updatedAt: number;
  source: string;
}

/** Persian/Arabic digits → English (user inputs in the asset form). */
export function persianToEnglishDigits(str: string): string {
  const fa = '۰۱۲۳۴۵۶۷۸۹';
  const ar = '٠١٢٣٤٥٦٧٨٩';
  let out = str;
  for (let i = 0; i < 10; i++) {
    out = out.replace(new RegExp(fa[i], 'g'), String(i));
    out = out.replace(new RegExp(ar[i], 'g'), String(i));
  }
  return out;
}

/** Parses a user-typed number (Persian digits, commas, spaces) → number. */
export function parseTomanInput(str: string): number {
  const clean = persianToEnglishDigits(str).replace(/[,،\s]/g, '');
  if (!clean || !/^\d*\.?\d*$/.test(clean)) return NaN;
  return parseFloat(clean);
}

function toToman(raw: string | number | undefined | null): number {
  if (raw === null || raw === undefined) return 0;
  // TGJU prints numbers with commas (e.g. "264,959,000") — strip them.
  const clean = typeof raw === 'number' ? String(raw) : persianToEnglishDigits(raw).replace(/[,،\s]/g, '');
  const n = parseFloat(clean);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // v1.4.14 — UNIT FIX: TGJU quotes this market in RIAL (verified against the
  // cross-symbol ratios: gold24/USD ≈ world gold per oz, gold/silver ratio ≈ 69,
  // coin ≈ 10.8 g of 18k). The old `> 10B` heuristic never divided at today's
  // price levels → gold18 (264.9M RIAL) failed the 100M sanity bound → the
  // whole price grid showed «قیمت‌ها در دسترس نیست» and, when it did render,
  // values were 10× too high. RIAL → TOMAN is a plain ÷10.
  return n / 10;
}

interface TgjuEntry {
  p?: string;
  h?: string;
  l?: string;
  t?: string;
  dt?: string;
}

function extractPrices(data: {
  current?: Record<string, TgjuEntry>;
}): Partial<IranMarketPrices> {
  const cur = data?.current ?? {};
  const pick = (key: string): number => toToman(cur[key]?.p);

  const gold18 = pick('geram18');
  const gold24 = pick('geram24');
  const silver999 = pick('silver_999');
  const silver925 = pick('silver_925');
  const coinEmami = pick('sekee');
  const coinBahar = pick('sekeb');
  const coinNim = pick('nim');
  const coinRob = pick('rob');
  const mesghal = pick('mesghal');
  const dollar = pick('price_dollar_rl');

  // v1.5.12 — انس جهانی طلا (XAU) — TGJU آن را «دلاری» منتشر می‌کند (ریال
  // نیست!) پس ÷10 نمی‌شود؛ فقط کاما حذف و عدد اعتبار‌سنجی می‌شود (رنج امن).
  const onsRaw = cur['ons']?.p;
  const goldOunceUsd = (() => {
    const n = parseFloat(String(onsRaw ?? '').replace(/,/g, ''));
    return Number.isFinite(n) && n > 100 && n < 100_000 ? n : 0;
  })();

  // Sanity: گرم ۱۸ عیار باید بین ۵ تا ۱۰۰ میلیون تومان باشد (رنج امن ۱۰ ساله).
  if (gold18 < 5_000_000 || gold18 > 100_000_000) return {};

  return {
    gold18,
    gold24: gold24 > 5_000_000 ? gold24 : Math.round((gold18 / 0.75) * 1000) / 1000,
    goldOunceUsd,
    silver999: silver999 > 10_000 ? silver999 : 0,
    silver925: silver925 > 10_000 ? silver925 : silver999 > 10_000 ? Math.round(silver999 * 0.925) : 0,
    coinEmami: coinEmami > 10_000_000 ? coinEmami : 0,
    coinBahar: coinBahar > 10_000_000 ? coinBahar : 0,
    coinNim: coinNim > 5_000_000 ? coinNim : 0,
    coinRob: coinRob > 2_000_000 ? coinRob : 0,
    mesghal: mesghal > 10_000_000 ? mesghal : 0,
    dollar: dollar > 10_000 ? dollar : 0,
  };
}

let memoryCache: { at: number; prices: IranMarketPrices } | null = null;

async function fetchWithTimeout(url: string, timeoutMs = 12000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36',
        Referer: 'https://www.tgju.org/',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readCached(): Promise<IranMarketPrices | null> {
  try {
    const stored = await AsyncStorage.getItem(CACHE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as IranMarketPrices;
    if (!parsed?.gold18 || Date.now() - parsed.updatedAt > CACHE_TTL) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** v1.4.14 — the VPN-on fallback may serve a stale-but-valid copy (≤24h). */
async function readStaleCached(maxAgeMs: number): Promise<IranMarketPrices | null> {
  try {
    const stored = await AsyncStorage.getItem(CACHE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as IranMarketPrices;
    if (!parsed?.gold18 || Date.now() - parsed.updatedAt > maxAgeMs) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(prices: IranMarketPrices): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(prices));
  } catch {}
}

/** Parse one TGJU response body → prices, or null when unusable (HTML challenge). */
function parseTgjuBody(text: string): Partial<IranMarketPrices> | null {
  try {
    const data = JSON.parse(text) as { current?: Record<string, TgjuEntry> };
    const partial = extractPrices(data);
    if (partial.gold18) return partial;
    return null;
  } catch {
    // v1.4.14 — Cloudflare challenge / HTML error page → treat as failure
    // so the NEXT mirror (or the proxy layer) gets a chance.
    return null;
  }
}

/**
 * Fetches live Iranian metal/coin prices (Toman). Chain (v1.4.14):
 *   direct mirrors → proxy mirrors → fresh cache → stale cache (≤24h) → null.
 */
export async function fetchIranMarketPrices(): Promise<IranMarketPrices | null> {
  if (memoryCache && Date.now() - memoryCache.at < MEMORY_TTL) {
    return memoryCache.prices;
  }

  const buildPrices = (partial: Partial<IranMarketPrices>, source: string): IranMarketPrices => ({
    gold18: partial.gold18!,
    gold24: partial.gold24!,
    goldOunceUsd: partial.goldOunceUsd ?? 0,
    silver999: partial.silver999 ?? 0,
    silver925: partial.silver925 ?? 0,
    coinEmami: partial.coinEmami ?? 0,
    coinBahar: partial.coinBahar ?? 0,
    coinNim: partial.coinNim ?? 0,
    coinRob: partial.coinRob ?? 0,
    mesghal: partial.mesghal ?? 0,
    dollar: partial.dollar ?? 0,
    updatedAt: Date.now(),
    source,
  });

  // ── layer 1: direct TGJU mirrors (Iranian IP & clean VPN exits) ──
  for (const url of TGJU_MIRRORS) {
    try {
      const res = await fetchWithTimeout(url, 12000);
      if (!res.ok) continue;
      const partial = parseTgjuBody(await res.text());
      if (partial) {
        const prices = buildPrices(partial, 'TGJU');
        memoryCache = { at: Date.now(), prices };
        await writeCache(prices);
        console.log('[IranMarket] TGJU prices fetched — gold18:', prices.gold18);
        return prices;
      }
    } catch (e) {
      console.log(`[IranMarket] ${url} failed:`, e instanceof Error ? e.message : e);
    }
  }

  // ── layer 2: proxy mirrors — the proxy's own IP fetches TGJU, so a
  // Cloudflare-challenged VPN exit can no longer blank the price grid ──
  for (const url of TGJU_PROXY_MIRRORS) {
    try {
      const res = await fetchWithTimeout(url, 20000);
      if (!res.ok) continue;
      const partial = parseTgjuBody(await res.text());
      if (partial) {
        const prices = buildPrices(partial, 'TGJU (پروکسی)');
        memoryCache = { at: Date.now(), prices };
        await writeCache(prices);
        console.log('[IranMarket] proxied TGJU prices fetched — gold18:', prices.gold18);
        return prices;
      }
    } catch (e) {
      console.log(`[IranMarket] proxy failed:`, e instanceof Error ? e.message : e);
    }
  }

  // Mirrors failed → serve the fresh cache (if any) with the old timestamp.
  const cached = await readCached();
  if (cached) {
    console.log('[IranMarket] serving cached prices from', new Date(cached.updatedAt).toISOString());
    return cached;
  }

  // v1.4.14 — last resort: a stale-but-valid copy (≤24h) beats a blank grid.
  const stale = await readStaleCached(24 * 60 * 60 * 1000);
  if (stale) {
    console.log('[IranMarket] serving STALE prices from', new Date(stale.updatedAt).toISOString());
    return stale;
  }
  return null;
}

/** Full Toman formatting with Persian thousand separators. */
export function formatFullToman(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('fa-IR', { maximumFractionDigits: 0 });
}
