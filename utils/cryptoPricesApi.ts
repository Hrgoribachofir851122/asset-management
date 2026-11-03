import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * cryptoPricesApi.ts — v1.5.0 «تب قیمت‌ها»
 *
 * قیمت لحظه‌ای بیت‌کوین و اتریوم — هر دو قیمت دلاری و تومانی — مستقیم از
 * گوشی و بدون واسطهٔ سرور (همان الگوی بقیهٔ قیمت‌های لحظه‌ای اپ):
 *
 *   قیمت دلاری  ← Binance spot (BTCUSDT/ETHUSDT، همراه ٪ تغییر ۲۴ ساعته)
 *                 پشتیبان: بازار USDT نوبیتکس (وقتی بایننس در دسترس نیست،
 *                 مثلاً خروجی VPN تحریمی).
 *   قیمت تومانی ← بازار IRT (ریال) نوبیتکس ÷ ۱۰ — تنها منبع بزرگ ایرانی که
 *                 جفت‌ارز ریالی BTC/ETH را لحظه‌ای می‌دهد؛ بدون فیلترشکن
 *                 هم جواب می‌دهد.
 *   ٪ تغییر تومانی ← dayChange همان بازار ریالی نوبیتکس.
 *
 * کش: ۶۰ ثانیه حافظه + ۱۰ دقیقه AsyncStorage + کش کهنه تا ۲۴ ساعت
 * (مثل iranMarketApi — هیچ‌وقت کادر خالی نمی‌ماند).
 */

const CACHE_KEY = '@crypto_prices_v1';
const CACHE_TTL = 10 * 60 * 1000; // 10 min AsyncStorage
const MEMORY_TTL = 60 * 1000; // 60s in-flight result
const STALE_TTL = 24 * 60 * 60 * 1000; // stale fallback ≤ 24h

const NOBITEX_STATS_URL =
  'https://api.nobitex.ir/market/stats?srcCurrency=btc,eth&dstCurrency=rls,usdt';

const BINANCE_TICKER_URL =
  'https://api.binance.com/api/v3/ticker/24hr?symbols=' +
  encodeURIComponent('["BTCUSDT","ETHUSDT"]');

export interface CryptoPrice {
  /** نماد — 'BTC' یا 'ETH' */
  symbol: 'BTC' | 'ETH';
  /** قیمت دلاری (USDT ≈ USD) */
  usd: number;
  /** ٪ تغییر ۲۴ ساعتهٔ قیمت دلاری */
  usdChangePct: number;
  /** قیمت تومانی (بازار ریال نوبیتکس ÷ ۱۰) */
  toman: number;
  /** ٪ تغییر ۲۴ ساعتهٔ بازار تومانی */
  tomanChangePct: number;
  updatedAt: number;
  /** منبع قیمت دلاری — Binance یا Nobitex (پشتیبان) */
  usdSource: string;
}

export interface CryptoPrices {
  btc: CryptoPrice;
  eth: CryptoPrice;
  updatedAt: number;
  usdSource: string;
}

let memoryCache: { at: number; data: CryptoPrices } | null = null;

export function clearCryptoPricesMemoryCache(): void {
  memoryCache = null;
}

function fetchJsonTimeout(url: string, ms: number): Promise<any> {
  return Promise.race([
    fetch(url, { headers: { Accept: 'application/json' } }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};

/** ——— لایهٔ ۱: نوبیتکس (هر دو قیمت تومانی + پشتیبان دلاری) ——— */
async function tryNobitex(): Promise<Omit<CryptoPrices, 'updatedAt'> | null> {
  try {
    const data = await fetchJsonTimeout(NOBITEX_STATS_URL, 6000);
    const stats = data?.stats;
    if (!stats?.btc?.rls || !stats?.eth?.rls) return null;

    const build = (symbol: 'BTC' | 'ETH'): CryptoPrice | null => {
      const s = stats[symbol.toLowerCase()];
      const rlsLatest = num(s?.rls?.latest);
      const toman = rlsLatest / 10;
      // sanity: BTC ~ میلیارد تومان، ETH ~ صدها میلیون تومان
      const tomanOk =
        symbol === 'BTC' ? toman > 1e9 && toman < 1e12 : toman > 1e7 && toman < 1e11;
      if (!tomanOk) return null;
      const usdtLatest = num(s?.usdt?.latest);
      // sanity دلاری
      const usdOk =
        symbol === 'BTC'
          ? usdtLatest > 1000 && usdtLatest < 1e7
          : usdtLatest > 10 && usdtLatest < 1e6;
      return {
        symbol,
        usd: usdOk ? usdtLatest : 0,
        usdChangePct: usdOk ? num(s?.usdt?.dayChange) : 0,
        toman,
        tomanChangePct: num(s?.rls?.dayChange),
        updatedAt: Date.now(),
        usdSource: usdOk ? 'Nobitex' : '',
      };
    };

    const btc = build('BTC');
    const eth = build('ETH');
    if (!btc || !eth) return null;
    return { btc, eth, usdSource: btc.usdSource || eth.usdSource ? 'Nobitex' : '' };
  } catch (e) {
    console.log('[CryptoPrices] nobitex failed:', e);
    return null;
  }
}

/** ——— لایهٔ ۲: بایننس spot — قیمت دلاری رسمی + ٪ تغییر ۲۴ ساعته ——— */
async function tryBinanceUsd(): Promise<Record<string, { price: number; pct: number }> | null> {
  try {
    const arr = await fetchJsonTimeout(BINANCE_TICKER_URL, 5000);
    if (!Array.isArray(arr)) return null;
    const out: Record<string, { price: number; pct: number }> = {};
    for (const t of arr) {
      const price = num(t?.lastPrice);
      const pct = num(t?.priceChangePercent);
      if (t?.symbol === 'BTCUSDT' && price > 1000 && price < 1e7)
        out.BTC = { price, pct };
      if (t?.symbol === 'ETHUSDT' && price > 10 && price < 1e6) out.ETH = { price, pct };
    }
    return out.BTC && out.ETH ? out : null;
  } catch (e) {
    console.log('[CryptoPrices] binance failed:', e);
    return null;
  }
}

export async function fetchCryptoPrices(): Promise<CryptoPrices> {
  // ۰) کش ۶۰ ثانیه‌ای حافظه — مثل بقیهٔ قیمت‌ها هر رفرش یک درخواست تازه
  if (memoryCache && Date.now() - memoryCache.at < MEMORY_TTL) {
    return memoryCache.data;
  }

  // ۱) تومان از نوبیتکس (منبع هر دو قیمت تومانی + پشتیبان دلاری)
  let result = await tryNobitex();

  // ۲) دلاری رسمی از بایننس (روی نوبیتکس می‌نشیَند اگر موفق شد)
  let binance = await tryBinanceUsd();
  if (result && binance) {
    const patch = (c: CryptoPrice): CryptoPrice => ({
      ...c,
      usd: binance![c.symbol].price,
      usdChangePct: binance![c.symbol].pct,
      usdSource: 'Binance',
    });
    result = { ...result, btc: patch(result.btc), eth: patch(result.eth), usdSource: 'Binance' };
  }

  // ۲-ب) نوبیتکس کاملFail شد ولی بایننس هست → حداقل قیمت دلاری بیاید
  if (!result && binance) {
    const only = (symbol: 'BTC' | 'ETH'): CryptoPrice => ({
      symbol,
      usd: binance![symbol].price,
      usdChangePct: binance![symbol].pct,
      toman: 0,
      tomanChangePct: 0,
      updatedAt: Date.now(),
      usdSource: 'Binance',
    });
    result = { btc: only('BTC'), eth: only('ETH'), usdSource: 'Binance' };
  }

  // ۳) هیچ منبعی جواب نداد → کش کهنه تا ۲۴ ساعت (هرگز کادر خالی)
  if (!result) {
    try {
      const stored = await AsyncStorage.getItem(CACHE_KEY);
      if (stored) {
        const old = JSON.parse(stored) as CryptoPrices;
        if (Date.now() - old.updatedAt < STALE_TTL) {
          memoryCache = { at: Date.now(), data: old };
          return old;
        }
      }
    } catch {}
    // آخرین پناه: دادهٔ صفر (UI به‌صورت «…» نشان می‌دهد)
    const empty = (symbol: 'BTC' | 'ETH'): CryptoPrice => ({
      symbol,
      usd: 0,
      usdChangePct: 0,
      toman: 0,
      tomanChangePct: 0,
      updatedAt: Date.now(),
      usdSource: '',
    });
    const fallback: CryptoPrices = {
      btc: empty('BTC'),
      eth: empty('ETH'),
      updatedAt: Date.now(),
      usdSource: '',
    };
    memoryCache = { at: Date.now(), data: fallback };
    return fallback;
  }

  const data: CryptoPrices = { ...result, updatedAt: Date.now() };
  memoryCache = { at: Date.now(), data };
  AsyncStorage.setItem(CACHE_KEY, JSON.stringify(data)).catch(() => {});
  return data;
}
