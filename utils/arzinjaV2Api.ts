/**
 * arzinjaV2Api.ts — Arzinja (ارزینجا) API v2 client.
 *
 * v1.4.7 — COMPLETE REWRITE. The previous integration assumed Arzinja was a
 * "Nobitex-compatible" platform (api.arzinja.ir + Token key:secret auth +
 * /users/wallets/list). That was WRONG on every axis:
 *   1. api.arzinja.ir does NOT resolve anymore (NXDOMAIN) — the old base URL
 *      was simply dead, so every balance/price request failed at DNS level.
 *   2. Arzinja runs its own Laravel API v2 (docs: arzinja.ir/api-docs):
 *        Base:        https://api-v2.arzinja.app/api   (fallback: .ir)
 *        Wallet:      GET /v1/services/wallet/balances  (PRIVATE, signed)
 *        Markets:     GET /v1/market/all-market         (PUBLIC, no auth)
 *   3. Private-endpoint auth is an HMAC-SHA256 signature scheme with the
 *      headers X-ARZ-API-KEY / X-ARZ-SIGN / X-ARZ-TIMESTAMP / X-ARZ-RECV-WINDOW
 *      (exact scheme from the official docs' JavaScript sample):
 *        signString (GET)  = `${timestamp}${apiKey}${recvWindow}${queryString}`
 *        signString (POST) = `${timestamp}${apiKey}${recvWindow}${bodyJson}`
 *        X-ARZ-SIGN        = HMAC-SHA256(signString, apiSecret) → hex
 *
 * Both live-verified against the real API (route + auth machinery validated:
 * a fake key answers 401 «Invalid API Key», the public market endpoint
 * returns the live USDTIRT pair).
 *
 * Response envelope: { code, success, message, result, pagination? } — note
 * that the API may answer HTTP 200 with code !== 200 inside the body; the
 * balance parser surfaces that message instead of showing an empty wallet.
 */

import CryptoJS from 'crypto-js';

/** Primary base works from Iran AND through a VPN; .ir is the fallback. */
const ARZINJA_V2_BASES = ['https://api-v2.arzinja.app/api', 'https://api-v2.arzinja.ir/api'];

const REQUEST_TIMEOUT_MS = 12_000;
const RECV_WINDOW_MS = 60_000 * 10; // 10 minutes — safe for slow phone clocks

// ---------------------------------------------------------------------------
// Signing (official docs scheme)
// ---------------------------------------------------------------------------

export function arzinjaSign(
  timestamp: number,
  apiKey: string,
  recvWindow: number,
  payload: string,
  apiSecret: string
): string {
  const prepared = `${timestamp}${apiKey}${recvWindow}${payload}`;
  return CryptoJS.HmacSHA256(prepared, apiSecret).toString(CryptoJS.enc.Hex);
}

interface ArzHeaders {
  timestamp: number;
  headers: Record<string, string>;
}

/** Build the 4 auth headers for a GET request with the given query string. */
function arzinjaAuthGet(apiKey: string, apiSecret: string, queryString: string): ArzHeaders {
  const timestamp = Date.now();
  const sign = arzinjaSign(timestamp, apiKey, RECV_WINDOW_MS, queryString, apiSecret);
  return {
    timestamp,
    headers: {
      'X-ARZ-API-KEY': apiKey,
      'X-ARZ-SIGN': sign,
      'X-ARZ-TIMESTAMP': String(timestamp),
      'X-ARZ-RECV-WINDOW': String(RECV_WINDOW_MS),
    },
  };
}

// ---------------------------------------------------------------------------
// Generic signed GET with base-URL fallback
// ---------------------------------------------------------------------------

interface ArzResponse<T> {
  ok: boolean;
  status: number;
  data: T | null;
  /** Persian, user-actionable message on failure. */
  error?: string;
  baseUsed: string;
}

async function arzinjaGet<T>(
  path: string,
  apiKey: string,
  apiSecret: string,
  queryString = ''
): Promise<ArzResponse<T>> {
  let lastError = 'خطای نامشخص';
  for (const base of ARZINJA_V2_BASES) {
    const { headers } = arzinjaAuthGet(apiKey, apiSecret, queryString);
    const url = `${base}${path}${queryString ? `?${queryString}` : ''}`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'GET',
          headers: { Accept: 'application/json', ...headers },
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const bodyText = await res.text();
      let data: unknown = null;
      try {
        data = JSON.parse(bodyText);
      } catch {
        data = null;
      }
      const rec = (data ?? {}) as {
        code?: number;
        success?: boolean;
        message?: string;
      };
      // HTTP 200 but business error inside the body (Laravel envelope).
      if (res.ok && rec.code !== undefined && rec.code !== 200 && !rec.success) {
        const msg = rec.message ?? `کد ${rec.code}`;
        // 401-ish codes mean the key/signature was rejected → stop trying bases.
        if (rec.code === 401 || /کلید|api key|signature|امضا/i.test(msg)) {
          return { ok: false, status: res.status, data: null, error: arzinjaPersianError(rec.code, msg), baseUsed: base };
        }
        lastError = arzinjaPersianError(rec.code, msg);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          status: res.status,
          data: null,
          error: arzinjaPersianError(res.status, rec.message ?? ''),
          baseUsed: base,
        };
      }
      if (!res.ok) {
        lastError = arzinjaPersianError(res.status, rec.message ?? '');
        continue;
      }
      return { ok: true, status: res.status, data: data as T, baseUsed: base };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const aborted = /abort/i.test(msg);
      lastError = aborted
        ? 'پاسخ ارزینجا دیرتر از ۱۲ ثانیه رسید'
        : 'اتصال به ارزینجا برقرار نشد — اینترنت گوشی را چک کنید';
    }
  }
  return { ok: false, status: 0, data: null, error: lastError, baseUsed: '' };
}

/** Map numeric codes / API messages to precise Persian guidance. */
function arzinjaPersianError(code: number, raw: string): string {
  const rawMsg = (raw ?? '').slice(0, 120);
  if (code === 401) {
    if (/signature|امضا|sign/i.test(rawMsg)) {
      return `امضای درخواست ارزینجا معتبر شناخته نشد (${rawMsg}) — کلید و Secret را دقیقاً همان‌طور که در «مدیریت API» ارزینجا نمایش داده می‌شود کپی کنید`;
    }
    return `کلید API ارزینجا نامعتبر است (${rawMsg || '401'}) — در پنل ارزینجا → بخش مدیریت API، کلید با دسترسی «خواندن» بسازید و همان کلید و Secret را وارد کنید`;
  }
  if (code === 403) {
    return `دسترسی این کلید ارزینجا محدود است (${rawMsg}) — کلید باید دسترسی خواندن (read) داشته باشد`;
  }
  if (code === 429) {
    return 'تعداد درخواست‌ها به ارزینجا زیاد بوده — چند دقیقه صبر کنید و دوباره تازه‌سازی بزنید';
  }
  if (rawMsg) {
    return `صرافی ارزینجا پاسخ خطا داد (کد ${code}): ${rawMsg}`;
  }
  return `صرافی ارزینجا پاسخ خطا داد (کد ${code})`;
}

// ---------------------------------------------------------------------------
// Wallet balances
// ---------------------------------------------------------------------------

export interface ArzinjaBalanceRow {
  asset: string;
  free: number;
  locked: number;
  total: number;
  valueUsd: number;
  isFiat: boolean;
}

interface ArzWalletItem {
  currency_id?: number;
  symbol?: string;
  title?: string;
  is_fiat?: number | boolean;
  balance?: string;
  balance_freeze?: string;
  balance_available?: string;
  estimated_usdt?: string;
}

interface ArzWalletEnvelope {
  code?: number;
  success?: boolean;
  message?: string;
  result?: ArzWalletItem[];
  pagination?: { current_page?: number; total_pages?: number; total?: number };
}

/**
 * Fetches EVERY non-empty wallet balance (walks all pages, 100 per page) and
 * values each row in USD using the API's own `estimated_usdt` field.
 * Toman (IRT) rows are returned as is_fiat with valueUsd computed later by
 * the caller at the live tether rate.
 */
export async function fetchArzinjaBalances(
  apiKey: string,
  apiSecret: string
): Promise<ArzinjaBalanceRow[]> {
  const key = apiKey.trim();
  const secret = apiSecret.trim();
  if (!key || !secret) {
    throw new Error('کلید و Secret ارزینجا هر دو لازم هستند — در پنل ارزینجا → مدیریت API هر دو را کپی کنید');
  }

  const items: ArzWalletItem[] = [];
  let totalPages = 1;
  for (let page = 1; page <= totalPages && page <= 10; page++) {
    const qs = `per_page=100&page=${page}`;
    const res = await arzinjaGet<ArzWalletEnvelope>('/v1/services/wallet/balances', key, secret, qs);
    if (!res.ok || !res.data) {
      // First page failing → hard error with the precise reason.
      throw new Error(res.error ?? 'دریافت موجودی ارزینجا ناموفق بود');
    }
    const env = res.data;
    if (Array.isArray(env.result)) items.push(...env.result);
    totalPages = Math.max(1, Number(env.pagination?.total_pages ?? 1));
    if (!Array.isArray(env.result) || env.result.length === 0) break;
  }

  const rows: ArzinjaBalanceRow[] = [];
  for (const w of items) {
    const symbol = String(w.symbol ?? '').toUpperCase();
    const free = parseFloat(w.balance_available ?? '0') || 0;
    const locked = parseFloat(w.balance_freeze ?? '0') || 0;
    const total = parseFloat(w.balance ?? String(free + locked)) || free + locked;
    if (!symbol || total <= 0) continue;
    const isFiat = !!w.is_fiat && Number(w.is_fiat) !== 0;
    const valueUsd = parseFloat(w.estimated_usdt ?? '0') || 0;
    rows.push({
      asset: symbol,
      free,
      locked,
      total,
      valueUsd: isFiat ? 0 : valueUsd, // IRT priced by the caller in Toman
      isFiat,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Public market data (no auth) — tether price + USD pricing for IRT rows
// ---------------------------------------------------------------------------

let marketCache: { at: number; map: Record<string, { lastToman: number; lastUsd: number }> } | null = null;

/**
 * Public pairs snapshot: { SYMBOLIRT: { lastToman, lastUsd } }.
 * GET /v1/market/all-market — the path the exchange's own web app uses.
 */
export async function fetchArzinjaMarkets(force = false): Promise<Record<string, { lastToman: number; lastUsd: number }>> {
  if (!force && marketCache && Date.now() - marketCache.at < 60_000) {
    return marketCache.map;
  }
  const map: Record<string, { lastToman: number; lastUsd: number }> = {};
  for (const base of ARZINJA_V2_BASES) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(`${base}/v1/market/all-market`, {
          headers: { Accept: 'application/json' },
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) continue;
      const data = (await res.json()) as {
        result?: Array<Record<string, {
          pair?: string;
          stats?: { lastPrice?: string; lastPriceUsd?: string };
        }>>;
      };
      const first = Array.isArray(data.result) ? data.result[0] : null;
      if (!first || typeof first !== 'object') continue;
      for (const [pairName, pair] of Object.entries(first)) {
        const stats = (pair as { stats?: { lastPrice?: string; lastPriceUsd?: string } })?.stats;
        if (!stats) continue;
        const lastToman = parseFloat(stats.lastPrice ?? '0') || 0;
        const lastUsd = parseFloat(stats.lastPriceUsd ?? '0') || 0;
        if (lastToman > 0) map[pairName.toUpperCase()] = { lastToman, lastUsd };
      }
      if (Object.keys(map).length > 0) {
        marketCache = { at: Date.now(), map };
        return map;
      }
    } catch {
      // try the next base
    }
  }
  return marketCache?.map ?? map;
}

/** Live USDT/Toman from the public market endpoint (Toman units already). */
export async function fetchArzinjaTomanPrice(): Promise<number | null> {
  try {
    const markets = await fetchArzinjaMarkets(true);
    const usdt = markets['USDTIRT'];
    if (usdt && usdt.lastToman > 10_000 && usdt.lastToman < 2_000_000) {
      return usdt.lastToman;
    }
  } catch {}
  return null;
}
