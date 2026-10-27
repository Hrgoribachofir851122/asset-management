import AsyncStorage from '@react-native-async-storage/async-storage';
import { getServerUrl } from './scanServerApi';
import { fetchArzinjaTomanPrice } from './arzinjaV2Api';

const ALANCHAND_URL = 'https://alanchand.com/currencies-price/usd';
const ALANCHAND_API_URL = 'https://api.alanchand.com?type=currency&symbols=usd';
/** v1.4.7 — api.nobitex.ir is DEAD (NXDOMAIN); Nobitex moved to apiv2.nobitex.ir. */
const NOBITEX_ORDERBOOK_API = 'https://apiv2.nobitex.ir/v2/orderbook/USDTIRT';
const NOBITEX_STATS_API = 'https://apiv2.nobitex.ir/market/stats';
const WALLEX_API = 'https://api.wallex.ir/v1/markets';
const TETHERLAND_API = 'https://api.tetherland.com/currencies';
const CURRENCY_API = 'https://latest.currency-api.pages.dev/v1/currencies/usd.json';

/**
 * Arzinja (Iranian exchange) — v1.4.7: real API v2 (api-v2.arzinja.app),
 * NOT Nobitex-compatible. Price data comes from the PUBLIC market endpoint
 * (no auth); wallet balances use the signed endpoints in arzinjaV2Api.ts.
 * Old base api.arzinja.ir no longer resolves (NXDOMAIN).
 */
const ARZINJA_BASE = 'https://api-v2.arzinja.app/api';
const ARZINJA_FALLBACK_BASE = 'https://api-v2.arzinja.ir/api';
const ARZINJA_DEFAULT_KEY = '70c505037afe7c40be8dd6b10ba92d73';
const ARZINJA_DEFAULT_SECRET = '6986dce5b5d4f758da59b85d7102a7d7f05ebf30df320018610b8c9281319419';
const SETTINGS_KEY = '@crypto_scanner_settings';

export interface TomanPrice {
  usdtToToman: number;
  lastUpdated: number;
  source: string;
}

/** Cached Arzinja API keys read from app settings (refreshed at most 60s). */
let arzinjaKeysCache: { at: number; key: string; secret: string } | null = null;

async function getArzinjaKeys(): Promise<{ key: string; secret: string }> {
  if (arzinjaKeysCache && Date.now() - arzinjaKeysCache.at < 60_000) {
    return { key: arzinjaKeysCache.key, secret: arzinjaKeysCache.secret };
  }
  let key = ARZINJA_DEFAULT_KEY;
  let secret = ARZINJA_DEFAULT_SECRET;
  try {
    const stored = await AsyncStorage.getItem(SETTINGS_KEY);
    const settings = stored ? JSON.parse(stored) : {};
    if (typeof settings.arzinjaApiKey === 'string' && settings.arzinjaApiKey.trim()) {
      key = settings.arzinjaApiKey.trim();
    }
    if (typeof settings.arzinjaApiSecret === 'string' && settings.arzinjaApiSecret.trim()) {
      secret = settings.arzinjaApiSecret.trim();
    }
  } catch {}
  arzinjaKeysCache = { at: Date.now(), key, secret };
  return { key, secret };
}

/** Exported for the wallet balance fetcher (v2 signed requests — kept for compatibility). */
export async function arzinjaAuthHeaders(): Promise<Array<Record<string, string>>> {
  const { key, secret } = await getArzinjaKeys();
  return [
    { Authorization: `Token ${key}:${secret}` },
    { Authorization: `ApiKey ${key}:${secret}` },
    {}, // anonymous (public endpoints)
  ];
}

async function fetchWithTimeout(url: string, options?: RequestInit, timeoutMs: number = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function persianToEnglish(str: string): string {
  const persianDigits = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
  let result = str;
  for (let i = 0; i < 10; i++) {
    result = result.replace(new RegExp(persianDigits[i], 'g'), i.toString());
  }
  return result;
}

/**
 * Toman price via the project backend: the server calls Nobitex market stats
 * signed with the project's Nobitex API Key (higher rate limits, more
 * reliable than anonymous requests).
 */
async function tryServerNobitex(): Promise<number | null> {
  const serverUrl = await getServerUrl();
  if (!serverUrl) return null;
  try {
    console.log('[ScanServer] Trying backend Nobitex proxy...');
    const response = await fetchWithTimeout(`${serverUrl}/nobitex/usdt-toman`, {}, 10000);
    if (!response.ok) return null;
    const data = (await response.json()) as { usdtToToman?: number };
    const price = typeof data.usdtToToman === 'number' ? data.usdtToToman : 0;
    if (price > 10000 && price < 500000) {
      console.log('[ScanServer] Nobitex proxy price (Toman):', price);
      return price;
    }
  } catch (e) {
    console.log('[ScanServer] Nobitex proxy error:', e);
  }
  return null;
}

/**
 * Extracts the USD price (Rial or Toman) from an Alan.Chand API response.
 * The exact response shape isn't publicly documented, so well-known price
 * fields are checked first, then a bounded recursive scan.
 */
function extractAlanchandPrice(data: unknown): number | null {
  const pickPrice = (obj: Record<string, unknown>): number | null => {
    for (const key of ['sell_price', 'sellPrice', 'price', 'sell']) {
      const v = obj[key];
      if (typeof v === 'number' && v > 0) return v;
      if (typeof v === 'string') {
        const n = parseFloat(persianToEnglish(v).replace(/[^\d.]/g, ''));
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    return null;
  };
  const findObj = (node: unknown, depth = 0): Record<string, unknown> | null => {
    if (depth > 5 || node === null || typeof node !== 'object') return null;
    const obj = node as Record<string, unknown>;
    if (pickPrice(obj) !== null) return obj;
    for (const v of Object.values(obj)) {
      const found = findObj(v, depth + 1);
      if (found) return found;
    }
    return null;
  };
  const obj = findObj(data);
  const raw = obj ? pickPrice(obj) : null;
  if (!raw) return null;
  // Prices are usually in Rial (e.g. 2040500) — convert to Toman; values that
  // already look like Toman pass through unchanged.
  if (raw > 1000000 && raw < 5000000) return raw / 10;
  if (raw > 100000 && raw < 500000) return raw;
  return null;
}

let alanchandApiCache: { at: number; price: number } | null = null;
let alanchandApiBackoffUntil = 0;

/**
 * Alan.Chand official JSON API with the user's Bearer token — the freshest
 * source. Falls back to other sources on failure (with a 5-minute backoff so
 * a failing key isn't hammered every refresh).
 */
async function tryAlanchandApi(): Promise<number | null> {
  const apiKey = process.env.EXPO_PUBLIC_ALANCHAND_API_KEY ?? '';
  if (!apiKey) return null;
  if (alanchandApiCache && Date.now() - alanchandApiCache.at < 60000) {
    return alanchandApiCache.price;
  }
  if (Date.now() < alanchandApiBackoffUntil) return null;
  try {
    console.log('[AlanchandAPI] Trying alanchand JSON API...');
    const response = await fetchWithTimeout(ALANCHAND_API_URL, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    }, 10000);
    if (response.ok) {
      const data = await response.json();
      const price = extractAlanchandPrice(data);
      if (price) {
        console.log('[AlanchandAPI] Price (Toman):', price);
        alanchandApiCache = { at: Date.now(), price };
        return price;
      }
      console.log('[AlanchandAPI] Unexpected response shape');
    } else {
      console.log('[AlanchandAPI] HTTP', response.status);
    }
  } catch (e) {
    console.log('[AlanchandAPI] Error:', e);
  }
  alanchandApiBackoffUntil = Date.now() + 300000;
  return null;
}

/** Alan.Chand JSON API via the project backend (no CORS/geo restrictions). */
async function tryAlanchandServer(): Promise<number | null> {
  const serverUrl = await getServerUrl();
  if (!serverUrl) return null;
  try {
    const response = await fetchWithTimeout(`${serverUrl}/alanchand/usdt-toman`, {}, 10000);
    if (!response.ok) return null;
    const data = (await response.json()) as { usdtToToman?: number };
    const price = typeof data.usdtToToman === 'number' ? data.usdtToToman : 0;
    if (price > 10000 && price < 500000) {
      console.log('[ScanServer] Alanchand proxy price (Toman):', price);
      return price;
    }
  } catch (e) {
    console.log('[ScanServer] Alanchand proxy error:', e);
  }
  return null;
}

async function tryAlanchandHtml(): Promise<number | null> {
  try {
    console.log('[Alanchand] Fetching USD/Toman from alanchand.com...');
    const response = await fetchWithTimeout(ALANCHAND_URL, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0',
      },
    }, 10000);
    if (response.ok) {
      const html = await response.text();
      console.log('[Alanchand] Got HTML, length:', html.length);
      const priceMatch = html.match(/class="price"[^>]*>([^<]+)</);
      if (priceMatch && priceMatch[1]) {
        const rawPrice = priceMatch[1].trim();
        console.log('[Alanchand] Raw price string:', rawPrice);
        const englishPrice = persianToEnglish(rawPrice).replace(/,/g, '');
        const price = parseFloat(englishPrice);
        console.log('[Alanchand] Parsed price:', price);
        if (price > 10000 && price < 500000) {
          return price;
        }
      }
      const anyPriceMatch = html.match(/(\d{2,3},\d{3})/);
      if (anyPriceMatch) {
        const price = parseFloat(anyPriceMatch[1].replace(/,/g, ''));
        if (price > 10000 && price < 500000) {
          console.log('[Alanchand] Fallback regex price:', price);
          return price;
        }
      }
      const persianPriceMatch = html.match(/([۰-۹]{2,3}[,،][۰-۹]{3})/);
      if (persianPriceMatch) {
        const englishStr = persianToEnglish(persianPriceMatch[1]).replace(/[,،]/g, '');
        const price = parseFloat(englishStr);
        if (price > 10000 && price < 500000) {
          console.log('[Alanchand] Persian regex price:', price);
          return price;
        }
      }
    }
  } catch (e) {
    console.log('[Alanchand] Error:', e);
  }
  return null;
}

let arzinjaPriceCache: { at: number; price: number } | null = null;
let arzinjaBackoffUntil = 0;

/**
 * Live USDT/Toman from Arzinja — v1.4.7: the PUBLIC v2 market endpoint
 * (api-v2.arzinja.app/v1/market/all-market → USDTIRT.stats.lastPrice, already
 * in Toman; no auth needed). The old api.arzinja.ir endpoints are dead
 * (NXDOMAIN), which silently killed this whole source. Cached for 4 minutes
 * so the 5-minute refresh cycle hits the API at most once per cycle.
 */
async function tryArzinja(): Promise<number | null> {
  if (arzinjaPriceCache && Date.now() - arzinjaPriceCache.at < 240_000) {
    return arzinjaPriceCache.price;
  }
  if (Date.now() < arzinjaBackoffUntil) return null;

  try {
    const price = await fetchArzinjaTomanPrice();
    if (price !== null && price > 10_000 && price < 2_000_000) {
      console.log('[ArzinjaAPI] Market price (Toman):', price);
      arzinjaPriceCache = { at: Date.now(), price };
      return price;
    }
  } catch {
    // network/DNS failure — fall through to the backoff below
  }

  // All Arzinja attempts failed — back off 5 minutes so the fallback chain
  // below can take over without hammering a (temporarily) unreachable API.
  arzinjaBackoffUntil = Date.now() + 300_000;
  return null;
}

async function tryNobitexStats(): Promise<number | null> {
  try {
    console.log('[NobitexAPI] Trying market/stats endpoint...');
    const response = await fetchWithTimeout(NOBITEX_STATS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ srcCurrency: 'usdt', dstCurrency: 'rls' }),
    });
    if (response.ok) {
      const data = await response.json();
      console.log('[NobitexAPI] Stats response:', JSON.stringify(data).slice(0, 200));
      const stats = data?.stats?.['usdt-rls'];
      if (stats?.latest) {
        const price = parseFloat(stats.latest) / 10;
        if (price > 10000 && price < 500000) {
          console.log('[NobitexAPI] Stats price (Toman):', price);
          return price;
        }
      }
      if (stats?.lastTradePrice) {
        const price = parseFloat(stats.lastTradePrice) / 10;
        if (price > 10000 && price < 500000) {
          console.log('[NobitexAPI] Stats lastTradePrice (Toman):', price);
          return price;
        }
      }
    }
  } catch (e) {
    console.log('[NobitexAPI] Stats error:', e);
  }
  return null;
}

async function tryNobitexOrderbook(): Promise<number | null> {
  try {
    console.log('[NobitexAPI] Trying orderbook endpoint...');
    const response = await fetchWithTimeout(NOBITEX_ORDERBOOK_API);
    if (response.ok) {
      const data = await response.json();
      console.log('[NobitexAPI] Orderbook response keys:', Object.keys(data));
      if (data?.lastTradePrice) {
        const raw = parseFloat(data.lastTradePrice);
        const price = raw / 10;
        if (price > 10000 && price < 500000) {
          console.log('[NobitexAPI] Orderbook price (Toman):', price);
          return price;
        }
        if (raw > 10000 && raw < 500000) {
          console.log('[NobitexAPI] Orderbook price already Toman:', raw);
          return raw;
        }
      }
    }
  } catch (e) {
    console.log('[NobitexAPI] Orderbook error:', e);
  }
  return null;
}

async function tryWallex(): Promise<number | null> {
  try {
    console.log('[WallexAPI] Trying Wallex...');
    const response = await fetchWithTimeout(WALLEX_API);
    if (response.ok) {
      const data = await response.json();
      const usdtMarket = data?.result?.symbols?.USDTTMN;
      if (usdtMarket?.stats?.lastPrice) {
        const price = parseFloat(usdtMarket.stats.lastPrice);
        if (price > 10000 && price < 500000) {
          console.log('[WallexAPI] USDT/Toman price:', price);
          return price;
        }
      }
      const usdtAlt = data?.result?.symbols?.USDTIRT;
      if (usdtAlt?.stats?.lastPrice) {
        const price = parseFloat(usdtAlt.stats.lastPrice) / 10;
        if (price > 10000 && price < 500000) {
          console.log('[WallexAPI] USDT/IRT price (Toman):', price);
          return price;
        }
      }
    }
  } catch (e) {
    console.log('[WallexAPI] Wallex error:', e);
  }
  return null;
}

/** Tetherland USDT/Toman rate — an independent extra fallback source. */
async function tryTetherland(): Promise<number | null> {
  try {
    console.log('[TetherlandAPI] Trying Tetherland...');
    const response = await fetchWithTimeout(TETHERLAND_API);
    if (response.ok) {
      const data = await response.json();
      const raw = data?.data?.currencies?.USDT?.price;
      if (typeof raw === 'number' && raw > 0) {
        const price = raw > 1000000 && raw < 5000000 ? raw / 10 : raw;
        if (price > 10000 && price < 500000) {
          console.log('[TetherlandAPI] USDT/Toman price:', price);
          return price;
        }
      }
    }
  } catch (e) {
    console.log('[TetherlandAPI] Error:', e);
  }
  return null;
}

async function tryCurrencyApi(): Promise<number | null> {
  try {
    console.log('[CurrencyAPI] Trying fawazahmed0 currency API...');
    const response = await fetchWithTimeout(CURRENCY_API);
    if (response.ok) {
      const data = await response.json();
      const irrRate = data?.usd?.irr;
      if (irrRate && typeof irrRate === 'number') {
        const tomanRate = irrRate / 10;
        console.log('[CurrencyAPI] USD/IRR:', irrRate, '=> Toman:', tomanRate);
        if (tomanRate > 10000 && tomanRate < 500000) {
          return tomanRate;
        }
      }
    }
  } catch (e) {
    console.log('[CurrencyAPI] Error:', e);
  }
  return null;
}

export async function fetchUsdtTomanPrice(): Promise<TomanPrice> {
  console.log('[TomanPrice] Fetching USDT/Toman price from multiple sources...');

  // 0) Arzinja (the user's Iranian exchange) — live price with the personal
  //    API keys; tried FIRST per the user's request.
  const arzinja = await tryArzinja();
  if (arzinja) {
    return { usdtToToman: arzinja, lastUpdated: Date.now(), source: 'Arzinja' };
  }

  // 1) Alan.Chand official API with the user's key (freshest).
  const alanchandApi = await tryAlanchandApi();
  if (alanchandApi) {
    return { usdtToToman: alanchandApi, lastUpdated: Date.now(), source: 'Alan.Chand' };
  }

  // 2) Same API via the backend proxy (no CORS/geo restrictions).
  const alanchandServer = await tryAlanchandServer();
  if (alanchandServer) {
    return { usdtToToman: alanchandServer, lastUpdated: Date.now(), source: 'Alan.Chand' };
  }

  const nobitexStats = await tryNobitexStats();
  if (nobitexStats) {
    return { usdtToToman: nobitexStats, lastUpdated: Date.now(), source: 'Nobitex' };
  }

  const nobitexOB = await tryNobitexOrderbook();
  if (nobitexOB) {
    return { usdtToToman: nobitexOB, lastUpdated: Date.now(), source: 'Nobitex' };
  }

  const wallex = await tryWallex();
  if (wallex) {
    return { usdtToToman: wallex, lastUpdated: Date.now(), source: 'Wallex' };
  }

  const tetherland = await tryTetherland();
  if (tetherland) {
    return { usdtToToman: tetherland, lastUpdated: Date.now(), source: 'Tetherland' };
  }

  // 6) HTML scrape of alanchand.com — its regex often picks up stale/wrong
  // numbers, so it only runs when everything above failed.
  const alanchandHtml = await tryAlanchandHtml();
  if (alanchandHtml) {
    return { usdtToToman: alanchandHtml, lastUpdated: Date.now(), source: 'Alanchand' };
  }

  // 7) Backend proxy (Nobitex with API-key signature) — can fail due to
  // Nobitex geo-restrictions on server IPs.
  const serverNobitex = await tryServerNobitex();
  if (serverNobitex) {
    return { usdtToToman: serverNobitex, lastUpdated: Date.now(), source: 'Nobitex' };
  }

  const currencyApi = await tryCurrencyApi();
  if (currencyApi) {
    return { usdtToToman: currencyApi, lastUpdated: Date.now(), source: 'CurrencyAPI' };
  }

  console.log('[TomanPrice] All sources failed, using fallback');
  return { usdtToToman: 0, lastUpdated: Date.now(), source: 'unavailable' };
}

export function formatToman(amount: number): string {
  if (amount >= 1000000000) return `${(amount / 1000000000).toFixed(1)} میلیارد`;
  if (amount >= 1000000) return `${(amount / 1000000).toFixed(1)} میلیون`;
  if (amount >= 1000) return `${(amount / 1000).toFixed(1)} هزار`;
  return amount.toFixed(0);
}
