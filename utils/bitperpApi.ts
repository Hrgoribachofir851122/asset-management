/**
 * bitperpApi.ts — BitPerp (بیت‌پرپ) exchange API client.
 *
 * Discovered from the exchange's own web app (bitperp.com/app,
 * bitperp-api.js — FastAPI V3 backend, "passwordless"):
 *   1. POST /api/auth/request-otp  { email }              → sends an email OTP
 *   2. POST /api/auth/verify-otp   { email, code }        → { access_token, refresh_token }
 *   3. POST /api/auth/refresh      { refresh_token }      → new { access_token, refresh_token }
 *   4. Every request: Authorization: Bearer <access_token>
 *      + the 'ngrok-skip-browser-warning' header the backend expects.
 *
 * Balance endpoints:
 *   GET /api/fund-balance  → { code, data: { balance, perpetual_balance } }  (funding wallet, USDT)
 *   GET /api/balance       → { code, data: [{ asset, balance }] }            (perpetual wallet)
 *   GET /api/perp-balance  → { code, data: { availableMargin, equity } }
 *   GET /api/positions     → open positions
 *   GET /api/position-history-all → closed positions + summary
 *
 * The wallet screen stores: apiKey = email, passphrase = access token,
 * apiSecret = refresh token; fetchBitperpBalance() refreshes automatically
 * on 401 and persists the rotated tokens.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const BASE = 'https://bitperp.com';

/** All requests time out so buttons never hang on a dead network. */
const REQUEST_TIMEOUT_MS = 25_000;

const DEVICE_ID_KEY = '@bitperp_device_id';

/**
 * Stable per-install device id — the REAL BitPerp web app sends a
 * device_id with verify-otp (device management / session binding).
 * Persisted so the server always sees the same device for this install.
 */
let deviceIdCache: string | null = null;
async function getDeviceId(): Promise<string> {
  if (deviceIdCache) return deviceIdCache;
  try {
    const stored = await AsyncStorage.getItem(DEVICE_ID_KEY);
    if (stored) {
      deviceIdCache = stored;
      return stored;
    }
    const id = `pampay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
    deviceIdCache = id;
    return id;
  } catch {
    return 'pampay-unknown-device';
  }
}

/**
 * v1.4.5 — extract a human-readable message from ANY FastAPI error body.
 * FastAPI validation errors look like:
 *   {"detail":[{"loc":["body","otp"],"msg":"Field required","type":"missing"}]}
 * `String(detail)` on that array produced the infamous «[object Object]».
 */
function extractApiErrorMessage(data: unknown, fallbackStatus: number): string {
  if (data === null || data === undefined) return `HTTP ${fallbackStatus}`;
  if (typeof data === 'string') return data.slice(0, 200);
  if (typeof data === 'object') {
    const rec = data as Record<string, unknown>;
    const detail = rec.detail ?? rec.msg ?? rec.message ?? rec.error;
    if (typeof detail === 'string') return detail.slice(0, 200);
    // FastAPI validation array: pick each item's msg
    if (Array.isArray(detail)) {
      const msgs = detail
        .map((d) => {
          if (typeof d === 'string') return d;
          if (d && typeof d === 'object') {
            const r = d as Record<string, unknown>;
            const m = r.msg ?? r.message ?? '';
            const loc = Array.isArray(r.loc) ? r.loc.map(String).join('.') : '';
            if (m) return loc ? `${m} (${loc})` : String(m);
          }
          return '';
        })
        .filter(Boolean);
      if (msgs.length > 0) return msgs.join('؛ ').slice(0, 250);
    }
    if (detail && typeof detail === 'object') {
      const r = detail as Record<string, unknown>;
      const m = r.msg ?? r.message ?? r.reason;
      if (typeof m === 'string') return m.slice(0, 200);
    }
    return `HTTP ${fallbackStatus}`;
  }
  return `HTTP ${fallbackStatus}`;
}

/** Endpoint variants tried in order (FastAPI routers sometimes get renamed). */
const OTP_REQUEST_PATHS = [
  '/api/auth/request-otp',
  '/api/auth/send-otp',
  '/api/auth/otp-request',
  '/api/auth/request-code',
];
const OTP_VERIFY_PATHS = [
  '/api/auth/verify-otp',
  '/api/auth/check-otp',
  '/api/auth/submit-otp',
  '/api/auth/verify-code',
];
const REFRESH_PATHS = ['/api/auth/refresh', '/api/auth/token-refresh'];

const BASE_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'ngrok-skip-browser-warning': 'true',
};

function authHeaders(accessToken: string): Record<string, string> {
  return { ...BASE_HEADERS, Authorization: `Bearer ${accessToken}` };
}

async function postJson<T>(
  path: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; status: number; data: T | null; errorDetail?: string }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: BASE_HEADERS,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!res.ok) {
      return { ok: false, status: res.status, data: null, errorDetail: extractApiErrorMessage(data, res.status) };
    }
    return { ok: true, status: res.status, data: data as T };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const aborted = /abort/i.test(msg);
    return {
      ok: false,
      status: 0,
      data: null,
      errorDetail: aborted ? 'پاسخ بیت‌پرپ دیرتر از ۲۵ ثانیه رسید' : msg.slice(0, 200),
    };
  }
}

async function getJson<T>(
  path: string,
  accessToken: string
): Promise<{ ok: boolean; status: number; data: T | null; errorDetail?: string }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, { headers: authHeaders(accessToken), signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!res.ok) {
      return { ok: false, status: res.status, data: null, errorDetail: extractApiErrorMessage(data, res.status) };
    }
    return { ok: true, status: res.status, data: data as T };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, data: null, errorDetail: msg.slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Auth flow (used from the Add-Exchange form)
// ---------------------------------------------------------------------------

/** Step 1 — ask BitPerp to email a one-time code to the user. */
export async function bitperpRequestOtp(email: string): Promise<{ ok: boolean; error?: string }> {
  const e = email.trim().toLowerCase(); // the real web app lowercases the email too
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    return { ok: false, error: 'یک ایمیل معتبر وارد کنید' };
  }
  const attempts: string[] = [];
  let networkFailed = false;
  for (const path of OTP_REQUEST_PATHS) {
    const r = await postJson(path, { email: e });
    if (r.ok) return { ok: true };
    if (r.status === 0) {
      networkFailed = true; // fetch itself failed — keep trying other paths
      attempts.push(`${path}: اتصال برقرار نشد`);
    } else {
      attempts.push(`${path}: ${r.errorDetail}`);
      if (r.status === 404) continue; // wrong path — try the next variant
      if (r.status === 400 || r.status === 422) {
        // A validation answer means the ENDPOINT exists — surface its detail.
        return {
          ok: false,
          error: `صرافی پاسخ داد: ${r.errorDetail}`,
        };
      }
    }
  }
  if (networkFailed) {
    return {
      ok: false,
      error: 'اتصال به بیت‌پرپ برقرار نشد — فیلترشکن را روشن کنید و دوباره بزنید (bitperp.com از ایران مستقیم در دسترس نیست)',
    };
  }
  return { ok: false, error: `ارسال کد ناموفق بود (${attempts[attempts.length - 1] ?? 'خطای نامشخص'})` };
}

export interface BitperpTokens {
  accessToken: string;
  refreshToken: string;
}

/** Step 2 — verify the emailed code → JWT tokens. */
export async function bitperpVerifyOtp(
  email: string,
  code: string
): Promise<{ ok: boolean; tokens?: BitperpTokens; error?: string }> {
  const e = email.trim().toLowerCase();
  let networkFailed = false;
  let lastDetail = '';
  let lastStatus = 0;
  const deviceId = await getDeviceId();
  for (const path of OTP_VERIFY_PATHS) {
    // v1.4.5 fix — the REAL BitPerp API (confirmed from the exchange's own web
    // app) expects { email, otp, device_id }. We previously sent `code`, which
    // the FastAPI backend rejected with 422 + an ARRAY detail → rendered as
    // «[object Object]». Field name and shape now match the web app exactly.
    const r = await postJson<{
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
      expires_in?: number;
      data?: { access_token?: string; refresh_token?: string };
    }>(path, { email: e, otp: code.trim(), device_id: deviceId });
    if (r.status === 0) {
      networkFailed = true;
      continue;
    }
    if (r.status === 404) continue; // wrong path — try the next variant
    lastDetail = r.errorDetail ?? '';
    lastStatus = r.status;
    if (r.ok && r.data) {
      const accessToken = r.data.access_token ?? r.data.data?.access_token;
      const refreshToken = r.data.refresh_token ?? r.data.data?.refresh_token;
      if (accessToken && refreshToken) {
        return { ok: true, tokens: { accessToken, refreshToken } };
      }
    }
    // 400/401/422 → the endpoint exists, the code (or email) is wrong.
    if (r.status === 400 || r.status === 401 || r.status === 422) break;
  }
  if (networkFailed) {
    return {
      ok: false,
      error: 'اتصال به بیت‌پرپ برقرار نشد — فیلترشکن را روشن کنید و دوباره امتحان کنید',
    };
  }
  if (lastStatus === 401) {
    return { ok: false, error: lastDetail || 'کد تأیید اشتباه است یا منقضی شده — دوباره «دریافت کد» را بزنید' };
  }
  return { ok: false, error: lastDetail || 'کد تأیید اشتباه است یا منقضی شده — دوباره «دریافت کد» را بزنید' };
}

/** Silent token rotation (called when the access token expired). */
export interface BitperpRefreshResult {
  ok: boolean;
  tokens?: BitperpTokens;
  error?: string;
  /** 'invalid' — the server explicitly REJECTED the refresh token (401/403) → the user must re-login.
   *  'transient' — network/timeout/5xx → the session is probably still good,
   *  retry later (v1.4.7: previously ANY failure was reported as «نشست منقضی شده»
   *  which mislabeled plain network hiccups as expired sessions). */
  kind?: 'invalid' | 'transient';
}

export async function bitperpRefresh(
  refreshToken: string
): Promise<BitperpRefreshResult> {
  for (const path of REFRESH_PATHS) {
    const r = await postJson<{ access_token?: string; refresh_token?: string }>(
      path,
      { refresh_token: refreshToken }
    );
    if (r.status === 404) continue;
    if (r.ok && r.data && r.data.access_token && r.data.refresh_token) {
      return { ok: true, tokens: { accessToken: r.data.access_token, refreshToken: r.data.refresh_token } };
    }
    if (r.status === 0) {
      // Network/timeout — the session may still be alive; do NOT claim expiry.
      return { ok: false, kind: 'transient', error: r.errorDetail ?? 'خطای شبکه هنگام تمدید نشست' };
    }
    if (r.status === 401 || r.status === 403) {
      return { ok: false, kind: 'invalid', error: r.errorDetail ?? 'نشست منقضی شده است' };
    }
    // Other HTTP statuses (400/422/5xx…): likely a body-level rejection — treat
    // FastAPI validation answers (422) as invalid (wrong payload shape), and
    // everything else as transient to avoid false «session expired» reports.
    if (r.status === 400 || r.status === 422) {
      return { ok: false, kind: 'invalid', error: r.errorDetail ?? 'نشست منقضی شده است' };
    }
    return { ok: false, kind: 'transient', error: r.errorDetail ?? 'خطای گذرا در تمدید نشست' };
  }
  return { ok: false, kind: 'transient', error: 'مسیر تمدید نشست پیدا نشد' };
}

// ---------------------------------------------------------------------------
// Account data (balances + positions)
// ---------------------------------------------------------------------------

export interface BitperpPosition {
  symbol: string;
  positionSide: string;
  leverage: number;
  entryPrice: number;
  markPrice: number;
  notionalUsd: number;
  unrealizedPnl: number;
  roePercent: number;
}

export interface BitperpWalletItem {
  asset: string;
  free: number;
  locked: number;
  total: number;
  /** USDT value when the API provides it (spot/fund items carry `value`). */
  valueUsd: number;
}

export interface BitperpAccount {
  /** Funding (main) wallet USDT balance — LEGACY /api/fund-balance shape. */
  fundingUsdt: number;
  /** v1.4.9 — perpetual USDT from /api/fund-balance (perpetual_balance),
   *  used as a fallback when /api/balance gave no USDT row. */
  fundPerpUsdt?: number;
  /** Perpetual wallet balances: [{asset, amount}] — LEGACY /api/balance shape. */
  perpBalances: Array<{ asset: string; amount: number }>;
  /** Perp account equity / available margin (when returned). */
  equity?: number;
  availableMargin?: number;
  /** v1.4.14 — NEW wallet structure (discovered from the live web-app bundle,
   *  Oct 2026). BitPerp split the account into Funding / Spot / Perpetual /
   *  Copy-Trading sub-accounts with new endpoints:
   *    GET /api/spot/fund-balance → {code:0, data:[{asset,free,locked,total,value}]}
   *    GET /api/spot/balance      → {code:0, data:[{asset,free,locked,total,value}]}
   *    GET /api/v2/perp-balances  → {code:0, data:[{asset,available,equity,…}]}
   *    GET /api/wallet/overview   → {balance:{equity,available,…}, running:[…], …}
   *  The user's «new assets don't show» bug: the app kept reading the OLD
   *  /api/balance + /api/fund-balance which now return stale/partial data. */
  newWallet: boolean;
  fundingBalances: BitperpWalletItem[];
  spotBalances: BitperpWalletItem[];
  perpBalancesV2: Array<{ asset: string; available: number; equity: number }>;
  /** Copy-trading account equity (USDT) from /api/wallet/overview. */
  copyEquity?: number;
  /** Open positions (best-effort parse). */
  positions: BitperpPosition[];
  /** True when the access token was rejected (401) → refresh needed. */
  authFailed: boolean;
  /** v1.4.7 — HTTP 200 with {code!=0,msg} business error (previously silently
   *  ignored → user saw an EMPTY wallet instead of the exchange's message). */
  errorMsg?: string;
  /** Raw response payloads for debugging. */
  raw: { fundBalance?: unknown; balance?: unknown; perpBalance?: unknown; positions?: unknown };
}

/** Extract a business-level error ({code, msg}) from an HTTP-200 body. */
function businessError(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const rec = data as { code?: unknown; msg?: unknown; message?: unknown; status?: unknown };
  const code = rec.code ?? rec.status;
  // v1.4.9 — code:-1 is the server's CACHED-TIMEOUT answer and STILL CARRIES
  // the last valid balance (bitperp's own web app relies on this: «سرور موقع
  // timeout آخرین مقدار معتبر را cache می‌کند و code:-1 می‌دهد»). Throwing on
  // it blanked the whole wallet — e.g. the «۵ سنت» row — for a full refresh
  // cycle. Treat it as data, not as an error.
  if (code === -1) return undefined;
  if (typeof code === 'number' && code !== 0) {
    const msg = typeof rec.msg === 'string' ? rec.msg : typeof rec.message === 'string' ? rec.message : '';
    return msg ? `${msg} (کد ${code})` : `کد خطای ${code}`;
  }
  return undefined;
}

function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// v1.4.14 — NEW wallet endpoints (live web-app bundle, Oct 2026)
// ---------------------------------------------------------------------------

/** {code:0, data:[{asset, free, locked, total, value}]} — spot & fund items. */
function parseWalletItemRows(data: unknown): BitperpWalletItem[] {
  const root = extractDataArray(data);
  const out: BitperpWalletItem[] = [];
  if (!Array.isArray(root)) return out;
  for (const item of root) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const asset = String(rec.asset ?? rec.coin ?? rec.currency ?? rec.symbol ?? '').toUpperCase();
    if (!asset) continue;
    const free = toNum(rec.free ?? rec.available ?? rec.balance ?? 0);
    const locked = toNum(rec.locked ?? rec.frozen ?? rec.in_orders ?? 0);
    const total = toNum(rec.total ?? rec.equity ?? 0) || free + locked;
    if (total <= 0.000001 && free <= 0.000001 && locked <= 0.000001) continue;
    out.push({ asset, free, locked, total, valueUsd: toNum(rec.value ?? rec.usdValue ?? 0) });
  }
  return out;
}

/** {code:0, data:[{asset, available, equity}]} — v2 perp items. */
function parsePerpV2Rows(data: unknown): Array<{ asset: string; available: number; equity: number }> {
  const root = extractDataArray(data);
  const out: Array<{ asset: string; available: number; equity: number }> = [];
  if (!Array.isArray(root)) return out;
  for (const item of root) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const asset = String(rec.asset ?? rec.coin ?? rec.currency ?? rec.symbol ?? '').toUpperCase();
    if (!asset) continue;
    const available = toNum(rec.available ?? rec.free ?? rec.balance ?? 0);
    const equity = toNum(rec.equity ?? rec.total ?? available);
    if (available <= 0.000001 && equity <= 0.000001) continue;
    out.push({ asset, available, equity });
  }
  return out;
}

/** FastAPI {code:0, data:[…]} → the array itself (tolerant). */
function extractDataArray(data: unknown): unknown {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const rec = data as Record<string, unknown>;
    if (rec.code !== undefined && Number(rec.code) !== 0) return null; // business error
    if (Array.isArray(rec.data)) return rec.data;
    for (const key of ['balances', 'coins', 'assets', 'list', 'rows']) {
      if (Array.isArray(rec[key])) return rec[key];
    }
  }
  return null;
}

export async function fetchBitperpAccount(accessToken: string): Promise<BitperpAccount> {
  // v1.4.14 — probe the NEW endpoints first (in parallel, cheap): if ANY of
  // them answers, the account uses the new Funding/Spot/Perp/Copy structure
  // and the legacy /api/balance data is stale (the «new assets missing» bug).
  const [spotFundRes, spotRes, perpV2Res, overviewRes] = await Promise.all([
    getJson<unknown>('/api/spot/fund-balance', accessToken),
    getJson<unknown>('/api/spot/balance', accessToken),
    getJson<unknown>('/api/v2/perp-balances', accessToken),
    getJson<unknown>('/api/wallet/overview', accessToken),
  ]);

  const newEndpointsAlive =
    spotFundRes.ok || spotRes.ok || perpV2Res.ok || overviewRes.ok;
  const newAuthRejected =
    (spotFundRes.status === 401 && !spotFundRes.ok) ||
    (spotRes.status === 401 && !spotRes.ok) ||
    (perpV2Res.status === 401 && !perpV2Res.ok) ||
    (overviewRes.status === 401 && !overviewRes.ok);

  const fundingBalances = parseWalletItemRows(spotFundRes.data);
  const spotBalances = parseWalletItemRows(spotRes.data);
  const perpBalancesV2 = parsePerpV2Rows(perpV2Res.data);
  let copyEquity: number | undefined;
  try {
    const ov = overviewRes.data as
      | { balance?: { equity?: unknown; available?: unknown } }
      | null
      | undefined;
    const eq = toNum(ov?.balance?.equity);
    if (eq > 0) copyEquity = eq;
  } catch {}

  // Legacy endpoints — still fetched (fallback + funding/perp-equity data).
  const [fundRes, balanceRes, perpRes, positionsRes] = await Promise.all([
    getJson<{ code?: number; data?: { balance?: unknown; perpetual_balance?: unknown } | number | string }>(
      '/api/fund-balance',
      accessToken
    ),
    getJson<{ code?: number; data?: unknown }>('/api/balance', accessToken),
    getJson<{ code?: number; data?: { availableMargin?: unknown; equity?: unknown } }>(
      '/api/perp-balance',
      accessToken
    ),
    getJson<{ code?: number; data?: unknown }>('/api/positions', accessToken),
  ]);

  const authFailed =
    newAuthRejected ||
    fundRes.status === 401 || balanceRes.status === 401 || perpRes.status === 401;

  // v1.4.7 — business errors inside HTTP-200 bodies (FastAPI {code, msg}).
  // v1.4.14: only when the NEW endpoints gave nothing (otherwise the legacy
  // stale answers must not raise a false error on a perfectly good account).
  const newWalletDataReady =
    fundingBalances.length > 0 || spotBalances.length > 0 || perpBalancesV2.length > 0 || copyEquity !== undefined;
  const businessMsgs = [fundRes.data, balanceRes.data, perpRes.data]
    .map((d) => businessError(d))
    .filter(Boolean) as string[];
  const errorMsg = authFailed || newWalletDataReady ? undefined : businessMsgs[0];

  // ---- funding wallet ----
  // v1.4.9 — CONFIRMED shape (from bitperp's own web app):
  //   { code: 0, data: { balance: "12.3", perpetual_balance: "45.6" } }
  // balance/perpetual_balance may be strings, numbers, or the whole data may
  // be a bare string/number — all are accepted now. Even when code:-1
  // (cached timeout), the numbers are still the last VALID values → use them.
  let fundingUsdt = 0;
  let fundPerpUsdt = 0;
  try {
    const d = fundRes.data?.data;
    if (typeof d === 'number') fundingUsdt = d;
    else if (typeof d === 'string') fundingUsdt = toNum(d);
    else if (d && typeof d === 'object') {
      const rec = d as Record<string, unknown>;
      fundingUsdt = toNum(rec.balance ?? rec.funding ?? rec.amount ?? rec.usdt ?? 0);
      fundPerpUsdt = toNum(rec.perpetual_balance ?? rec.perp ?? rec.perpetual ?? 0);
    }
  } catch {}

  // ---- perpetual wallet assets ----
  const perpBalances: Array<{ asset: string; amount: number }> = [];
  try {
    let root: unknown = balanceRes.data?.data;
    if (root && typeof root === 'object' && !Array.isArray(root)) {
      const rec = root as Record<string, unknown>;
      for (const key of ['balances', 'coins', 'assets', 'list', 'rows', 'wallet']) {
        if (Array.isArray(rec[key])) {
          root = rec[key];
          break;
        }
      }
    }
    if (!Array.isArray(root) && root && typeof root === 'object') {
      // A plain map { USDT: 12.3, ... } is also accepted.
      for (const [asset, amount] of Object.entries(root as Record<string, unknown>)) {
        const n = toNum(amount);
        if (n > 0.000001) perpBalances.push({ asset: asset.toUpperCase(), amount: n });
      }
    } else if (Array.isArray(root)) {
      for (const item of root) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        const asset = String(
          rec.asset ?? rec.coin ?? rec.currency ?? rec.symbol ?? ''
        ).toUpperCase();
        const amount = toNum(
          rec.balance ?? rec.total ?? rec.amount ?? rec.equity ?? rec.walletBalance ?? 0
        );
        if (asset && amount > 0.000001) perpBalances.push({ asset, amount });
      }
    }
  } catch {}

  // ---- perp account equity ----
  let equity: number | undefined;
  let availableMargin: number | undefined;
  try {
    const d = perpRes.data?.data;
    if (d && typeof d === 'object') {
      const eq = toNum((d as Record<string, unknown>).equity);
      const am = toNum((d as Record<string, unknown>).availableMargin);
      if (eq > 0) equity = eq;
      if (am > 0) availableMargin = am;
    }
  } catch {}

  // ---- open positions ----
  const positions: BitperpPosition[] = [];
  try {
    let root: unknown = positionsRes.data?.data;
    if (root && typeof root === 'object' && !Array.isArray(root)) {
      const rec = root as Record<string, unknown>;
      for (const key of ['positions', 'list', 'rows', 'data']) {
        if (Array.isArray(rec[key])) {
          root = rec[key];
          break;
        }
      }
    }
    if (Array.isArray(root)) {
      for (const item of root) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        const symbol = String(rec.symbol ?? rec.contract ?? rec.instId ?? '');
        const qty = toNum(
          rec.quantity ?? rec.positionAmt ?? rec.qty ?? rec.size ?? rec.amount ?? 0
        );
        if (!symbol || Math.abs(qty) <= 0) continue;
        const unrealizedPnl = toNum(
          rec.unrealizedPnl ?? rec.unRealizedProfit ?? rec.pnl ?? rec.upnl ?? rec.uPnl ?? 0
        );
        const entryPrice = toNum(rec.entryPrice ?? rec.avgPrice ?? rec.openPrice ?? rec.price ?? 0);
        const markPrice = toNum(rec.markPrice ?? rec.lastPrice ?? rec.curPrice ?? entryPrice);
        const notionalUsd = toNum(rec.notional ?? rec.notionalUsd ?? rec.value ?? Math.abs(qty) * markPrice);
        const roeRaw = toNum(rec.roePercent ?? rec.roe ?? rec.percentage ?? 0);
        positions.push({
          symbol,
          positionSide: String(rec.positionSide ?? rec.side ?? (qty < 0 ? 'SHORT' : 'LONG')),
          leverage: toNum(rec.leverage ?? rec.lever ?? 1) || 1,
          entryPrice,
          markPrice,
          notionalUsd,
          unrealizedPnl,
          roePercent: roeRaw,
        });
      }
    }
  } catch {}

  return {
    fundingUsdt,
    fundPerpUsdt,
    perpBalances,
    equity,
    availableMargin,
    newWallet: newEndpointsAlive,
    fundingBalances,
    spotBalances,
    perpBalancesV2,
    copyEquity,
    positions,
    authFailed,
    errorMsg,
    raw: {
      fundBalance: fundRes.data,
      balance: balanceRes.data,
      perpBalance: perpRes.data,
      positions: positionsRes.data,
    },
  };
}

// ---------------------------------------------------------------------------
// Closed-position history (for PnL over 30/90/180/360 days)
// ---------------------------------------------------------------------------

export interface BitperpClosedPosition {
  symbol: string;
  pnl: number;
  closedAt: number | null;
}

/** Timestamps may arrive in seconds, ms or ISO — normalize to epoch ms. */
function parseTime(v: unknown): number | null {
  if (typeof v === 'number') {
    return v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
  }
  const s = String(v ?? '');
  if (!s) return null;
  const n = Number(s);
  if (Number.isFinite(n) && n !== 0) {
    return n > 1e12 ? n : n > 1e9 ? n * 1000 : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export interface BitperpPositionHistoryResult {
  positions: BitperpClosedPosition[];
  /** True when the access token was rejected (401) → refresh needed. */
  authFailed: boolean;
}

/**
 * Closed positions (all symbols). The endpoint has no period parameter, so
 * the wallet screen filters by close time client-side.
 */
export async function fetchBitperpPositionHistory(
  accessToken: string
): Promise<BitperpPositionHistoryResult> {
  const res = await getJson<{ code?: number; data?: unknown; summary?: unknown }>(
    '/api/position-history-all',
    accessToken
  );
  if (res.status === 401) {
    return { positions: [], authFailed: true };
  }
  if (!res.ok || !res.data) return { positions: [], authFailed: false };
  let root: unknown = res.data.data;
  if (!Array.isArray(root)) {
    const rec = res.data as Record<string, unknown>;
    for (const key of ['data', 'positions', 'list', 'rows', 'history']) {
      if (Array.isArray(rec[key])) {
        root = rec[key];
        break;
      }
    }
  }
  if (!Array.isArray(root)) return { positions: [], authFailed: false };
  const out: BitperpClosedPosition[] = [];
  for (const item of root) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const symbol = String(rec.symbol ?? rec.contract ?? rec.instId ?? '?');
    const pnl = toNum(
      rec.pnl ?? rec.realizedPnl ?? rec.realized_pnl ?? rec.profit ?? rec.netPnl ?? rec.closePnl ?? 0
    );
    const closedAt =
      parseTime(rec.closed_at) ??
      parseTime(rec.close_time) ??
      parseTime(rec.closeTime) ??
      parseTime(rec.closedAt) ??
      parseTime(rec.time) ??
      parseTime(rec.updated_at) ??
      null;
    out.push({ symbol, pnl, closedAt });
  }
  return { positions: out, authFailed: false };
}
