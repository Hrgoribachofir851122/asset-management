// utils/foreignExchangeBalances.ts
// v1.4.6 — Balance fetching for EVERY exchange in the app's exchange list.
//
// WHY: until v1.4.5 only Binance/Bybit/OKX/Nobitex/Arzinja/BitPerp could show
// balances; adding any other exchange (MEXC, Huobi, OKX?, KuCoin, Gate, …)
// errored with «صرافی پشتیبانی نمی‌شود». The user asked for ALL exchanges in
// the list to work — this module implements one balance fetcher per exchange.
//
// Signing schemes were validated empirically (dummy-key probes): MEXC, KuCoin,
// Bitget, Gate.io, HTX/Huobi, Toobit, BingX answer with key-level errors →
// format confirmed. Schemes we could not probe from the sandbox (BitMart,
// Bitunix, CoinEx, Phemex, XT, KCEX, LBank) use the documented format FIRST
// and retry with the known alternative variant when the API answers with a
// SIGNATURE-level error — so the correct variant is found at runtime.
//
// Every fetcher throws a precise Persian error (the exchange's own code/msg)
// so the wallet card shows WHY the balance failed instead of a silent zero.

import CryptoJS from 'crypto-js';
import { ExchangeId } from '@/types/crypto';
import { exchangeNow, markClockStale } from './exchangeClock';
import { geoBlockErrorFor, noteResponseStatus } from './geoBlock';
import { isRsaSecret, rsaSignSha256 } from './rsaSign';

export interface ForeignWallet {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
  exchangeName: string;
}

export type ForeignSection = 'spot' | 'earn' | 'funding' | 'futures';

export interface ForeignBalance {
  asset: string;
  free: number;
  locked: number;
  total: number;
  valueUsd: number;
  section?: ForeignSection;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 12_000;

interface RawResponse {
  ok: boolean;
  status: number;
  text: string;
}

async function rawFetch(
  url: string,
  init: RequestInit = {}
): Promise<RawResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
    });
    // v1.4.12 — record geo-block statuses (451/403/418) for sanctioned-IP
    // detection (utils/geoBlock.ts). Cheap no-op for every other status.
    noteResponseStatus(res.status, url);
    return { ok: res.ok, status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function hmacSha256Hex(secret: string, message: string): string {
  return CryptoJS.HmacSHA256(message, secret).toString(CryptoJS.enc.Hex);
}

function hmacSha256B64(secret: string, message: string): string {
  return CryptoJS.enc.Base64.stringify(CryptoJS.HmacSHA256(message, secret));
}

function hmacSha512Hex(secret: string, message: string): string {
  return CryptoJS.HmacSHA512(message, secret).toString(CryptoJS.enc.Hex);
}

function md5Hex(message: string): string {
  return CryptoJS.MD5(message).toString(CryptoJS.enc.Hex);
}

function toNum(v: unknown): number {
  const n = parseFloat(String(v ?? '0'));
  return Number.isFinite(n) ? n : 0;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Stablecoins valued 1:1 in USD. */
function stableValueUsd(asset: string, total: number): number | null {
  if (['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI', 'USDD'].includes(asset)) {
    return total;
  }
  return null;
}

// 60s-cached asset→USDT price map (same source the wallet already uses).
let priceMapCache: { at: number; map: Record<string, number> } | null = null;

async function getUsdPriceMap(): Promise<Record<string, number>> {
  if (priceMapCache && Date.now() - priceMapCache.at < 60_000) {
    return priceMapCache.map;
  }
  const map: Record<string, number> = {};
  try {
    const res = await rawFetch('https://api.binance.com/api/v3/ticker/price');
    if (res.ok) {
      const prices = parseJson(res.text);
      if (Array.isArray(prices)) {
        for (const p of prices as Array<{ symbol?: string; price?: string }>) {
          if (p?.symbol && p?.price) map[p.symbol] = parseFloat(p.price);
        }
      }
    }
  } catch {}
  priceMapCache = { at: Date.now(), map };
  return map;
}

// v1.5.3 — Binance FUTURES price map (fallback for coins that exist on
// futures but not spot — e.g. 1000X-style symbols / delisted-from-spot).
let futuresPriceCache: { at: number; map: Record<string, number> } | null = null;

async function getFuturesPriceMap(): Promise<Record<string, number>> {
  if (futuresPriceCache && Date.now() - futuresPriceCache.at < 60_000) {
    return futuresPriceCache.map;
  }
  const map: Record<string, number> = {};
  try {
    const res = await rawFetch('https://fapi.binance.com/fapi/v1/ticker/price');
    if (res.ok) {
      const prices = parseJson(res.text);
      if (Array.isArray(prices)) {
        for (const p of prices as Array<{ symbol?: string; price?: string }>) {
          if (p?.symbol && p?.price) map[p.symbol] = parseFloat(p.price);
        }
      }
    }
  } catch {}
  futuresPriceCache = { at: Date.now(), map };
  return map;
}

// v1.5.3 — LBank OWN ticker (user: «صرافی البانک در مدیریت دارایی قیمت غلط
// میداد»): LBank coins that are not on Binance were getting 0/«قیمت نامشخص»
// (or a wrong same-name match). The exchange's own public ticker is exact:
//   GET https://api.lbkex.com/v2/supplement/ticker/price.do
//   → {result:true, data:[{symbol:"btc_usdt", price:"81631.36"}]}
let lbankPriceCache: { at: number; map: Record<string, number> } | null = null;

async function getLbankPriceMap(): Promise<Record<string, number>> {
  if (lbankPriceCache && Date.now() - lbankPriceCache.at < 60_000) {
    return lbankPriceCache.map;
  }
  const map: Record<string, number> = {};
  try {
    const res = await rawFetch('https://api.lbkex.com/v2/supplement/ticker/price.do');
    if (res.ok) {
      const body = parseJson(res.text);
      const rows = (body?.data ?? body) as Array<{ symbol?: string; price?: string }>;
      if (Array.isArray(rows)) {
        for (const r of rows) {
          if (!r?.symbol || !r?.price) continue;
          const sym = r.symbol.toUpperCase(); // "BTC_USDT"
          if (!sym.endsWith('_USDT')) continue;
          const coin = sym.slice(0, -'_USDT'.length);
          const px = parseFloat(r.price);
          if (coin && px > 0) map[coin] = px;
        }
      }
    }
  } catch {}
  lbankPriceCache = { at: Date.now(), map };
  return map;
}

/**
 * Fill valueUsd for rows that came back without a USD value.
 * v1.5.3 — order per exchange:
 *   1. stablecoins = $1
 *   2. LBank's OWN ticker (for lbank wallets — exact LBank prices)
 *   3. Binance SPOT ticker
 *   4. Binance FUTURES ticker (futures-only coins)
 */
async function valueInUsd(balances: ForeignBalance[], exchangeId?: string): Promise<void> {
  const priceMap = await getUsdPriceMap();
  const lbankMap = exchangeId === 'lbank' ? await getLbankPriceMap() : null;
  let futuresMap: Record<string, number> | null = null;
  for (const b of balances) {
    if (b.valueUsd > 0) continue;
    const stable = stableValueUsd(b.asset, b.total);
    if (stable !== null) {
      b.valueUsd = stable;
      continue;
    }
    let p = lbankMap ? lbankMap[b.asset] : undefined;
    if (!p) p = priceMap[`${b.asset}USDT`];
    if (!p) {
      // lazy futures fallback (only fetched if some coin misses spot)
      if (!futuresMap) futuresMap = await getFuturesPriceMap();
      p = futuresMap[`${b.asset}USDT`];
    }
    if (p) b.valueUsd = b.total * p;
  }
}

function networkError(name: string, e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  return new Error(
    `اتصال به ${name} برقرار نشد — اینترنت/فیلترشکن را چک کنید (${msg})`
  );
}

/** Push a balance row if it is above the dust threshold. */
function pushBalance(
  out: ForeignBalance[],
  asset: string,
  free: number,
  locked: number,
  section: ForeignSection = 'spot',
  valueUsd = 0
): void {
  const total = free + locked;
  if (!asset || total <= 0.000001) return;
  out.push({
    asset: asset.toUpperCase(),
    free,
    locked,
    total,
    valueUsd,
    section,
  });
}

// ---------------------------------------------------------------------------
// MEXC — Binance-style query signature + X-MEXC-APIKEY header (validated)
// v1.4.10: 700003 = «Timestamp outside recvWindow» (clock drift!) — the stamp
// now comes from MEXC's own /api/v3/time (see exchangeClock.ts), recvWindow
// is widened to 30s, and a 700003 answer re-syncs the clock + retries once.
// ---------------------------------------------------------------------------

async function mexcAccountAttempt(w: ForeignWallet): Promise<RawResponse> {
  const ts = await exchangeNow('mexc');
  const qs = `timestamp=${ts}&recvWindow=30000`;
  const signature = hmacSha256Hex(w.apiSecret, qs);
  return rawFetch(
    `https://api.mexc.com/api/v3/account?${qs}&signature=${signature}`,
    { headers: { 'X-MEXC-APIKEY': w.apiKey } }
  );
}

function mexcCodeOf(text: string): string {
  const body = parseJson(text);
  return String(body?.code ?? '');
}

async function fetchMexc(w: ForeignWallet): Promise<ForeignBalance[]> {
  let res = await mexcAccountAttempt(w);
  // 700003 = timestamp outside recvWindow → clock stale → re-sync + retry.
  if (mexcCodeOf(res.text) === '700003') {
    markClockStale('mexc');
    res = await mexcAccountAttempt(w);
  }
  const body = parseJson(res.text);
  if (!body) throw new Error(`پاسخ نامعتبر از MEXC (HTTP ${res.status})`);
  if (body.balances) {
    const out: ForeignBalance[] = [];
    for (const b of asArray(body.balances) as Array<{
      asset?: string;
      free?: string;
      locked?: string;
    }>) {
      pushBalance(out, String(b.asset ?? ''), toNum(b.free), toNum(b.locked));
    }
    return out;
  }
  const code = String(body.code ?? '');
  if (code === '700003') {
    throw new Error(
      `ساعت گوشی با سرور MEXC اختلاف دارد (کد 700003) — ساعت و تاریخ گوشی را «خودکار» تنظیم کنید و دوباره تلاش کنید`
    );
  }
  if (code === '-2014' || code === '-2015' || res.status === 401 || res.status === 403) {
    throw new Error(
      `کلید API مکسی معتبر نیست (${code}: ${String(body.msg ?? '')}) — کلید و Secret را در MEXC بسازید و دسترسی «خواندن» بدهید`
    );
  }
  if (code === '700006') {
    throw new Error(
      `کلید MEXC فقط از IPهای لیست سفید قبول می‌کند (کد 700006) — در تنظیمات کلید، محدودیت IP را بردارید یا IP فعلی را اضافه کنید`
    );
  }
  throw new Error(`خطای MEXC (کد ${code}): ${String(body.msg ?? res.status)}`);
}

// ---------------------------------------------------------------------------
// KuCoin — KC-* headers v2 (validated). Response: data[] with type trade|main
// ---------------------------------------------------------------------------

async function fetchKucoin(w: ForeignWallet): Promise<ForeignBalance[]> {
  const path = '/api/v1/accounts';
  const ts = Date.now().toString();
  const headers: Record<string, string> = {
    'KC-API-KEY': w.apiKey,
    'KC-API-SIGN': hmacSha256B64(w.apiSecret, `${ts}GET${path}`),
    'KC-API-TIMESTAMP': ts,
    'KC-API-PASSPHRASE': hmacSha256B64(w.apiSecret, w.passphrase ?? ''),
    'KC-API-KEY-VERSION': '2',
  };
  const res = await rawFetch(`https://api.kucoin.com${path}`, { headers });
  const body = parseJson(res.text);
  if (!body) throw new Error(`پاسخ نامعتبر از KuCoin (HTTP ${res.status})`);
  if (String(body.code) === '200000' && Array.isArray(body.data)) {
    const out: ForeignBalance[] = [];
    for (const a of body.data as Array<{
      currency?: string;
      type?: string;
      balance?: string;
      available?: string;
      holds?: string;
    }>) {
      const section: ForeignSection = a.type === 'main' ? 'funding' : 'spot';
      pushBalance(
        out,
        String(a.currency ?? ''),
        toNum(a.available),
        toNum(a.holds),
        section
      );
    }
    return out;
  }
  const code = String(body.code ?? '');
  if (code === '400003' || code === '400005' || code === '400007' || res.status === 401) {
    throw new Error(
      `کلید KuCoin معتبر نیست (${code}: ${String(body.msg ?? '')}) — کلید/Secret/Passphrase را چک کنید (Passphrase همان رمزی است که موقع ساخت کلید وارد کردید)`
    );
  }
  throw new Error(`خطای KuCoin (کد ${code}): ${String(body.msg ?? '')}`);
}

// ---------------------------------------------------------------------------
// Bitget v2/v3 — OKX-style ACCESS-* headers (validated)
// v1.4.10: 40085 = «حساب Unified Account است و API کلاسیک پشتیبانی نمی‌شود» —
// این خطا ربطی به IP/منطقه ندارد؛ کلید کاربر سالم است ولی حسابش از نوع
// «حساب معاملاتی یکپارچه (UTA)» است که endpointهای v2 را قبول نمی‌کند.
// حالا: v2 (کلاسیک) امتحان می‌شود؛ اگر 40085 آمد، همان درخواست با
// endpointهای UTA (v3) تکرار می‌شود:
//   • /api/v3/account/assets         → دارایی‌های یکپارچه (اسپات+فیوچرز)
//     rows: {coin, equity, usdValue, balance, available, locked, debt, bonus}
//   • /api/v3/account/funding-assets → کیف فاندینگ
//     rows: {coin, available, frozen, balance}
// تایم‌استمپ هم با /api/v2/public/time سرورِ بیتگت هماهنگ می‌شود.
// ---------------------------------------------------------------------------

async function bitgetSigned(
  w: ForeignWallet,
  pathWithQuery: string
): Promise<{ body: Record<string, unknown> | null; status: number }> {
  const ts = (await exchangeNow('bitget')).toString();
  const headers: Record<string, string> = {
    'ACCESS-KEY': w.apiKey,
    'ACCESS-SIGN': hmacSha256B64(w.apiSecret, `${ts}GET${pathWithQuery}`),
    'ACCESS-TIMESTAMP': ts,
    'ACCESS-PASSPHRASE': w.passphrase ?? '',
    'Content-Type': 'application/json',
    locale: 'en-US',
  };
  const res = await rawFetch(`https://api.bitget.com${pathWithQuery}`, { headers });
  return { body: parseJson(res.text), status: res.status };
}

/** UTA (Unified Trading Account) rows → ForeignBalance[] */
function pushUtaRows(
  out: ForeignBalance[],
  rows: unknown[],
  section: ForeignSection
): void {
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const asset = String(rec.coin ?? rec.marginCoin ?? '');
    if (!asset) continue;
    const free = toNum(rec.available);
    // «locked» on UTA assets; «frozen» on funding assets
    const frozen = toNum(rec.locked ?? rec.frozen);
    const equity = toNum(rec.equity ?? rec.balance);
    const usd = toNum(rec.usdValue);
    if (free + frozen <= 0 && equity <= 0) continue;
    const useEquity = free + frozen <= 0 && equity > 0;
    const row: ForeignBalance = {
      asset: asset.toUpperCase(),
      free: useEquity ? equity : free,
      locked: useEquity ? 0 : frozen,
      total: useEquity ? equity : free + frozen,
      valueUsd: usd > 0 ? usd : 0,
      section,
    };
    out.push(row);
  }
}

async function fetchBitget(w: ForeignWallet): Promise<ForeignBalance[]> {
  const out: ForeignBalance[] = [];
  let spotAuthError: Error | undefined;
  let spotOtherError: Error | undefined;
  let accountIsUta = false;

  // ---- classic spot (v2) ----
  try {
    const { body } = await bitgetSigned(w, '/api/v2/spot/account/assets');
    if (!body) throw new Error('پاسخ نامعتبر از Bitget (اسپات)');
    const code = String(body.code ?? '');
    if (code === '00000' && Array.isArray(body.data)) {
      for (const d of body.data as Array<{
        coin?: string;
        available?: string;
        frozen?: string;
      }>) {
        pushBalance(out, String(d.coin ?? ''), toNum(d.available), toNum(d.frozen));
      }
    } else if (code === '40085') {
      // Unified Trading Account → classic v2 endpoints rejected; use v3 (UTA).
      accountIsUta = true;
    } else if (code === '40037' || code === '40036' || code === '40038') {
      spotAuthError = new Error(
        `کلید Bitget معتبر نیست (${code}: ${String(body.msg ?? '')}) — کلید/Secret/Passphrase را چک کنید`
      );
    } else {
      spotOtherError = new Error(`خطای Bitget (کد ${code}): ${String(body.msg ?? '')}`);
    }
  } catch (e) {
    spotOtherError = e instanceof Error ? e : new Error(String(e));
  }

  if (accountIsUta) {
    // ---- UTA: unified assets + funding assets (v3) ----
    let utaError: Error | undefined;
    try {
      const { body } = await bitgetSigned(w, '/api/v3/account/assets');
      if (!body) throw new Error('پاسخ نامعتبر از Bitget (UTA)');
      const code = String(body.code ?? '');
      if (code === '00000') {
        const data = (body.data ?? {}) as Record<string, unknown>;
        pushUtaRows(out, asArray(data.assets), 'spot');
      } else if (code === '40037' || code === '40036' || code === '40038') {
        throw new Error(
          `کلید Bitget معتبر نیست (${code}: ${String(body.msg ?? '')}) — کلید/Secret/Passphrase را چک کنید`
        );
      } else {
        throw new Error(`خطای Bitget UTA (کد ${code}): ${String(body.msg ?? '')}`);
      }
    } catch (e) {
      utaError = e instanceof Error ? e : new Error(String(e));
    }
    // funding wallet (best-effort)
    try {
      const { body } = await bitgetSigned(w, '/api/v3/account/funding-assets');
      if (body && String(body.code ?? '') === '00000') {
        pushUtaRows(out, asArray(body.data), 'funding');
      }
    } catch {}
    if (out.length > 0) return out;
    throw utaError ?? spotOtherError ?? new Error('حساب Bitget (UTA) خالی است یا قابل خواندن نیست');
  }

  // ---- classic futures (USDT-M perpetual margin, v2) ----
  try {
    const { body } = await bitgetSigned(
      w,
      '/api/v2/mix/account/accounts?productType=USDT-FUTURES'
    );
    if (body && String(body.code ?? '') === '00000' && Array.isArray(body.data)) {
      for (const d of body.data as Array<{
        marginCoin?: string;
        available?: string;
        locked?: string;
        accountEquity?: string;
        usdtEquity?: string;
      }>) {
        const free = toNum(d.available);
        const frozen = toNum(d.locked);
        // available/locked can be 0 while accountEquity > 0 (all in positions)
        // — fall back to equity so the margin still shows.
        const equity = toNum(d.accountEquity ?? d.usdtEquity);
        if (free + frozen <= 0 && equity > 0) {
          pushBalance(out, String(d.marginCoin ?? ''), equity, 0, 'futures');
        } else {
          pushBalance(out, String(d.marginCoin ?? ''), free, frozen, 'futures');
        }
      }
    }
  } catch {
    // futures is best-effort — spot errors are the ones to surface
  }

  if (out.length > 0) return out;
  if (spotAuthError) throw spotAuthError;
  if (spotOtherError) throw spotOtherError;
  throw new Error('حساب Bitget خالی است یا قابل خواندن نیست');
}

// ---------------------------------------------------------------------------
// Gate.io v4 — HMAC-SHA512 of "METHOD\npath\nquery\nsha512(body)\ntimestamp" (validated)
// ---------------------------------------------------------------------------

async function fetchGateio(w: ForeignWallet): Promise<ForeignBalance[]> {
  const path = '/api/v4/spot/accounts';
  const method = 'GET';
  const query = '';
  const body = '';
  const bodyHash = CryptoJS.SHA512(body).toString();
  const seconds = Math.floor(Date.now() / 1000).toString();
  const sign = hmacSha512Hex(
    w.apiSecret,
    [method, path, query, bodyHash, seconds].join('\n')
  );
  const res = await rawFetch(`https://api.gateio.ws${path}`, {
    headers: { KEY: w.apiKey, SIGN: sign, Timestamp: seconds },
  });
  const bodyJson = parseJson(res.text);
  if (res.status === 200 && Array.isArray(bodyJson)) {
    const out: ForeignBalance[] = [];
    for (const d of (bodyJson as unknown[]) as Array<{
      currency?: string;
      available?: string;
      locked?: string;
    }>) {
      pushBalance(
        out,
        String(d.currency ?? ''),
        toNum(d.available),
        toNum(d.locked)
      );
    }
    return out;
  }
  const err = (bodyJson ?? {}) as Record<string, unknown>;
  const label = String(err.label ?? '');
  const msg = String(err.message ?? '');
  if (label === 'INVALID_KEY' || res.status === 401) {
    throw new Error(
      `کلید Gate.io معتبر نیست (${label}: ${msg}) — کلید و Secret را چک کنید`
    );
  }
  throw new Error(`خطای Gate.io (HTTP ${res.status}): ${msg || res.text.slice(0, 80)}`);
}

// ---------------------------------------------------------------------------
// HTX / Huobi — two-step with HMAC-SHA256 base64 (validated)
// ---------------------------------------------------------------------------

async function htxSignedGet(
  host: string,
  path: string,
  w: ForeignWallet
): Promise<Record<string, unknown> | null> {
  const isoTs = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const params: Record<string, string> = {
    AccessKey: w.apiKey,
    SignatureMethod: 'HmacSHA256',
    SignatureVersion: '2',
    Timestamp: isoTs,
  };
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join('&');
  const preSign = `GET\n${host}\n${path}\n${sorted}`;
  const signature = encodeURIComponent(hmacSha256B64(w.apiSecret, preSign));
  const res = await rawFetch(`https://${host}${path}?${sorted}&Signature=${signature}`);
  if (!res.text) return null;
  return parseJson(res.text);
}

async function fetchHtx(w: ForeignWallet): Promise<ForeignBalance[]> {
  const hosts = ['api.huobi.com', 'api.htx.com'];
  let accountsPayload: unknown[] | null = null;
  let errDetail = '';
  for (const host of hosts) {
    try {
      const data = await htxSignedGet(host, '/v1/account/accounts', w);
      if (data && data.status === 'ok' && Array.isArray(data.data)) {
        accountsPayload = data.data;
        break;
      }
      if (data && data.status === 'error') {
        errDetail = `${String(data['err-code'] ?? '')} ${String(data['err-msg'] ?? '')}`;
        // Access-key errors won't improve on the other host.
        if (String(data['err-code'] ?? '').includes('access')) break;
      }
    } catch (e) {
      errDetail = e instanceof Error ? e.message : String(e);
    }
  }
  if (!accountsPayload) {
    throw new Error(
      `کلید HTX/Huobi معتبر نیست یا دسترسی خواندن ندارد (${errDetail}) — در بخش API صرافی کلید بسازید و مجوز «read» بدهید`
    );
  }

  // Pick the spot account (type === 'spot').
  const spotAccount = (accountsPayload as Array<{
    id?: number;
    type?: string;
    state?: string;
  }>).find((a) => a.type === 'spot' && a.state === 'working');
  if (!spotAccount || !spotAccount.id) {
    throw new Error('حساب اسپات HTX پیدا نشد — حساب شما شاید فقط فیوچرز است');
  }

  const out: ForeignBalance[] = [];
  for (const host of hosts) {
    let balanceData: Record<string, unknown> | null = null;
    try {
      balanceData = await htxSignedGet(
        host,
        `/v1/account/accounts/${spotAccount.id}/balance`,
        w
      );
    } catch {}
    if (balanceData && balanceData.status === 'ok') {
      const list = asArray((balanceData.data as Record<string, unknown>)?.list);
      const freeMap: Record<string, number> = {};
      const lockedMap: Record<string, number> = {};
      for (const row of list as Array<{
        currency?: string;
        type?: string;
        balance?: string;
      }>) {
        const asset = String(row.currency ?? '').toUpperCase();
        if (!asset) continue;
        if (row.type === 'frozen') {
          lockedMap[asset] = (lockedMap[asset] ?? 0) + toNum(row.balance);
        } else {
          freeMap[asset] = (freeMap[asset] ?? 0) + toNum(row.balance);
        }
      }
      for (const asset of Object.keys(freeMap).concat(Object.keys(lockedMap))) {
        pushBalance(
          out,
          asset,
          freeMap[asset] ?? 0,
          lockedMap[asset] ?? 0
        );
      }
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Toobit — X-BB-APIKEY + Binance-style query signature (docs-confirmed)
// GET /api/v1/account → {balances: [{coin,total,free,locked}]}
// ---------------------------------------------------------------------------

async function fetchToobit(w: ForeignWallet): Promise<ForeignBalance[]> {
  const qs = `recvWindow=10000&timestamp=${Date.now()}`;
  const signature = hmacSha256Hex(w.apiSecret, qs);
  const res = await rawFetch(`https://api.toobit.com/api/v1/account?${qs}&signature=${signature}`, {
    headers: { 'X-BB-APIKEY': w.apiKey },
  });
  const body = parseJson(res.text);
  if (!body) throw new Error(`پاسخ نامعتبر از Toobit (HTTP ${res.status})`);
  if (Array.isArray(body.balances)) {
    const out: ForeignBalance[] = [];
    for (const b of body.balances as Array<{
      coin?: string;
      total?: string;
      free?: string;
      locked?: string;
    }>) {
      pushBalance(
        out,
        String(b.coin ?? ''),
        toNum(b.free),
        toNum(b.locked)
      );
    }
    return out;
  }
  const code = String(body.code ?? '');
  if (code === '-2014' || code === '-2015' || res.status === 401 || res.status === 403) {
    throw new Error(
      `کلید Toobit معتبر نیست (${code}: ${String(body.msg ?? '')}) — کلید و Secret را چک کنید`
    );
  }
  throw new Error(`خطای Toobit (کد ${code}): ${String(body.msg ?? res.status)}`);
}

// ---------------------------------------------------------------------------
// BingX spot — X-BX-APIKEY + Binance-style query signature (validated)
// ---------------------------------------------------------------------------

async function fetchBingx(w: ForeignWallet): Promise<ForeignBalance[]> {
  const qs = `recvWindow=10000&timestamp=${Date.now()}`;
  const signature = hmacSha256Hex(w.apiSecret, qs);
  const res = await rawFetch(
    `https://open-api.bingx.com/openApi/spot/v1/account/balance?${qs}&signature=${signature}`,
    { headers: { 'X-BX-APIKEY': w.apiKey } }
  );
  const body = parseJson(res.text);
  if (!body) throw new Error(`پاسخ نامعتبر از BingX (HTTP ${res.status})`);
  const data = (body.data ?? {}) as Record<string, unknown>;
  const balances = asArray(data.balances);
  if (String(body.code) === '0' && balances.length >= 0) {
    const out: ForeignBalance[] = [];
    for (const b of balances as Array<{
      asset?: string;
      free?: string;
      locked?: string;
    }>) {
      pushBalance(out, String(b.asset ?? ''), toNum(b.free), toNum(b.locked));
    }
    if (out.length > 0 || String(body.code) === '0') return out;
  }
  const code = String(body.code ?? '');
  if (code === '100413' || res.status === 401) {
    throw new Error(
      `کلید BingX معتبر نیست (کد ${code}) — کلید را در bingx.com → Account → API بسازید`
    );
  }
  throw new Error(`خطای BingX (کد ${code}): ${String(body.msg ?? '')}`);
}

// ---------------------------------------------------------------------------
// BitMart — X-BM-KEY / X-BM-TIMESTAMP / X-BM-SIGN = HMAC(ts + path + body)
// ---------------------------------------------------------------------------

async function bitmartAttempt(
  w: ForeignWallet,
  signStringKind: 'path' | 'path-query'
): Promise<{ signRejected: boolean; error?: Error; balances?: ForeignBalance[] }> {
  const path = '/account/v1/wallet';
  const ts = Date.now().toString();
  const sign =
    signStringKind === 'path'
      ? hmacSha256Hex(w.apiSecret, `${ts}${path}`)
      : hmacSha256Hex(w.apiSecret, `${ts}${path}?`);
  const res = await rawFetch(`https://api-cloud.bitmart.com${path}`, {
    headers: {
      'X-BM-KEY': w.apiKey,
      'X-BM-TIMESTAMP': ts,
      'X-BM-SIGN': sign,
    },
  });
  const body = parseJson(res.text);
  if (!body) {
    return {
      signRejected: false,
      error: new Error(`پاسخ نامعتبر از BitMart (HTTP ${res.status})`),
    };
  }
  const code = Number(body.code ?? 0);
  const data = (body.data ?? {}) as Record<string, unknown>;
  if (code === 1000 && Array.isArray(data.wallet)) {
    const out: ForeignBalance[] = [];
    for (const d of data.wallet as Array<{
      currency?: string;
      available?: string;
      frozen?: string;
    }>) {
      pushBalance(
        out,
        String(d.currency ?? ''),
        toNum(d.available),
        toNum(d.frozen)
      );
    }
    return { signRejected: false, balances: out };
  }
  const msg = String(body.message ?? body.msg ?? '');
  // 1129 = invalid sign; 1121/1125 = api key problems
  const signRejected = code === 1129 || code === 1107 || /sign/i.test(msg);
  return {
    signRejected,
    error: new Error(
      code === 1121 || code === 1125
        ? `کلید BitMart معتبر نیست (${code}: ${msg})`
        : `خطای BitMart (کد ${code}): ${msg}`
    ),
  };
}

async function fetchBitmart(w: ForeignWallet): Promise<ForeignBalance[]> {
  let last = await bitmartAttempt(w, 'path');
  if (last.balances) return last.balances;
  if (last.signRejected) {
    const alt = await bitmartAttempt(w, 'path-query');
    if (alt.balances) return alt.balances;
    last = alt;
  }
  throw last.error ?? new Error('خطای ناشناخته BitMart');
}

// ---------------------------------------------------------------------------
// SuperEx — Binance-compatible (X-API-KEY + query signature), path candidates
// ---------------------------------------------------------------------------

async function superexAttempt(
  w: ForeignWallet,
  path: string
): Promise<{ notFound: boolean; error?: Error; balances?: ForeignBalance[] }> {
  const qs = `recvWindow=10000&timestamp=${Date.now()}`;
  const signature = hmacSha256Hex(w.apiSecret, qs);
  const res = await rawFetch(`https://api.superex.com${path}?${qs}&signature=${signature}`, {
    headers: { 'X-API-KEY': w.apiKey },
  });
  if (res.status === 404) return { notFound: true };
  const body = parseJson(res.text);
  if (!body) {
    return { notFound: false, error: new Error(`پاسخ نامعتبر از SuperEx (HTTP ${res.status})`) };
  }
  interface GenericBalanceRow {
    asset?: string;
    coin?: string;
    currency?: string;
    free?: string;
    available?: string;
    locked?: string;
    frozen?: string;
  }
  const rows = asArray(body.balances) as GenericBalanceRow[];
  const data = (body.data ?? {}) as Record<string, unknown>;
  const dataRows = asArray(data.balances) as GenericBalanceRow[];
  const list: GenericBalanceRow[] = rows.length > 0 ? rows : dataRows;
  if (list.length > 0 || res.status === 200) {
    const out: ForeignBalance[] = [];
    for (const b of list) {
      pushBalance(
        out,
        String(b.asset ?? b.coin ?? b.currency ?? ''),
        toNum(b.free ?? b.available),
        toNum(b.locked ?? b.frozen)
      );
    }
    return { notFound: false, balances: out };
  }
  return {
    notFound: false,
    error: new Error(`خطای SuperEx (HTTP ${res.status}): ${res.text.slice(0, 80)}`),
  };
}

async function fetchSuperex(w: ForeignWallet): Promise<ForeignBalance[]> {
  const candidates = [
    '/api/v1/account/balance',
    '/api/v3/account',
    '/api/v1/account',
  ];
  let lastError: Error | null = null;
  for (const path of candidates) {
    const r = await superexAttempt(w, path);
    if (r.balances) return r.balances;
    if (r.error) lastError = r.error;
  }
  throw (
    lastError ??
    new Error('مسیر API حساب SuperEx پیدا نشد — صرافی را دوباره اضافه کنید')
  );
}

// ---------------------------------------------------------------------------
// CoinEx v2 — X-COINEX-* headers; two documented sign variants
// ---------------------------------------------------------------------------

async function coinexAttempt(
  w: ForeignWallet,
  variant: 'pipe' | 'concat'
): Promise<{ signRejected: boolean; error?: Error; balances?: ForeignBalance[] }> {
  const method = 'GET';
  const path = '/v2/assets/spot';
  const body = '';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = Math.random().toString(36).slice(2, 12);
  const prepared =
    variant === 'pipe'
      ? `${method}|${path}|${body}|${timestamp}`
      : `${method}${path}${body}${timestamp}`;
  const sign = hmacSha256Hex(w.apiSecret, prepared);
  const res = await rawFetch(`https://api.coinex.com${path}`, {
    headers: {
      'X-COINEX-KEY': w.apiKey,
      'X-COINEX-SIGN': sign,
      'X-COINEX-TIMESTAMP': timestamp,
      'X-COINEX-NONCE': nonce,
      'Content-Type': 'application/json',
    },
  });
  const bodyJson = parseJson(res.text);
  if (!bodyJson) {
    return {
      signRejected: false,
      error: new Error(`پاسخ نامعتبر از CoinEx (HTTP ${res.status})`),
    };
  }
  const code = Number(bodyJson.code ?? 0);
  const data = (bodyJson.data ?? {}) as Record<string, unknown>;
  if (code === 0 && Array.isArray(data)) {
    const out: ForeignBalance[] = [];
    for (const d of data as Array<{ coin?: string; available?: string; frozen?: string }>) {
      pushBalance(out, String(d.coin ?? ''), toNum(d.available), toNum(d.frozen));
    }
    return { signRejected: false, balances: out };
  }
  const msg = String(bodyJson.message ?? bodyJson.msg ?? '');
  const signRejected = /sign/i.test(msg) || code === 40 || code === 41;
  return {
    signRejected,
    error: new Error(
      /key|auth/i.test(msg) || code === 10
        ? `کلید CoinEx معتبر نیست (${code}: ${msg})`
        : `خطای CoinEx (کد ${code}): ${msg}`
    ),
  };
}

async function fetchCoinex(w: ForeignWallet): Promise<ForeignBalance[]> {
  let last = await coinexAttempt(w, 'pipe');
  if (last.balances) return last.balances;
  if (last.signRejected) {
    const alt = await coinexAttempt(w, 'concat');
    if (alt.balances) return alt.balances;
    last = alt;
  }
  throw last.error ?? new Error('خطای ناشناخته CoinEx');
}

// ---------------------------------------------------------------------------
// Phemex — x-phemex-* headers; two sign orderings from doc revisions
// GET /phemex-user/wallets/v3?currency=ALL
// ---------------------------------------------------------------------------

async function phemexAttempt(
  w: ForeignWallet,
  variant: 'path-query-expiry-method' | 'path-query-method-expiry'
): Promise<{ signRejected: boolean; error?: Error; balances?: ForeignBalance[] }> {
  const path = '/phemex-user/wallets/v3';
  const query = 'currency=ALL';
  const expiry = Math.floor(Date.now() / 1000) + 60;
  const sign =
    variant === 'path-query-expiry-method'
      ? hmacSha256Hex(w.apiSecret, `${path}${query}${expiry}GET`)
      : hmacSha256Hex(w.apiSecret, `${path}${query}GET${expiry}`);
  const res = await rawFetch(`https://api.phemex.com${path}?${query}`, {
    headers: {
      'x-phemex-access-token': w.apiKey,
      'x-phemex-request-expiry': String(expiry),
      'x-phemex-signature': sign,
    },
  });
  const body = parseJson(res.text);
  if (!body) {
    return {
      signRejected: false,
      error: new Error(`پاسخ نامعتبر از Phemex (HTTP ${res.status})`),
    };
  }
  const code = Number(body.code ?? 0);
  const data = (body.data ?? {}) as Record<string, unknown>;
  // v3 wallets: data.accounts? currency → {balanceEv, ...} — handle both shapes.
  const accounts = asArray(data.accounts);
  const rows = (
    accounts.length
      ? (accounts as Array<{ currency?: string; balanceEv?: string; availableEv?: string }>)
      : (asArray(data.balances) as Array<{
          currency?: string;
          balanceEv?: string;
          availableEv?: string;
          valueUsd?: string;
        }>)
  );
  if (code === 0 && rows.length >= 0) {
    const out: ForeignBalance[] = [];
    for (const r of rows) {
      // Phemex returns values scaled by 1e8 (Ev units).
      const total = toNum(r.balanceEv) / 1e8;
      const free = toNum(r.availableEv) / 1e8;
      pushBalance(out, String(r.currency ?? ''), free, Math.max(0, total - free));
    }
    if (out.length > 0 || code === 0) return { signRejected: false, balances: out };
  }
  const msg = String(body.msg ?? body.message ?? '');
  const signRejected = /sign/i.test(msg) || code === 1002 || code === 1003;
  return {
    signRejected,
    error: new Error(
      /token|key|auth/i.test(msg)
        ? `کلید Phemex معتبر نیست (${code}: ${msg})`
        : `خطای Phemex (کد ${code}): ${msg}`
    ),
  };
}

async function fetchPhemex(w: ForeignWallet): Promise<ForeignBalance[]> {
  let last = await phemexAttempt(w, 'path-query-expiry-method');
  if (last.balances) return last.balances;
  if (last.signRejected) {
    const alt = await phemexAttempt(w, 'path-query-method-expiry');
    if (alt.balances) return alt.balances;
    last = alt;
  }
  throw last.error ?? new Error('خطای ناشناخته Phemex');
}

// ---------------------------------------------------------------------------
// LBank v2 — v1.5.2 FIX: LBank completed an API upgrade (official notice
// https://www.lbank.com/support/articles/21533217989145):
//   ۱) دامنه قدیمی api.lbank.info غیرفعال شد → دامنه جدید api.lbkex.com
//      (端 قدیمی 404 برمی‌گرداند — «صرافی البانک ارور 404 می‌دهد»).
//   ۲) امضای خصوصی عوض شد: MD5(sort(params)) با حروف بزرگ → سپس
//      HmacSHA256(md5Upper, secret) → پارامتر sign؛ به‌علاوه پارامترهای
//      echostr + signature_method + timestamp هم در فرم و هم در header لازم‌اند.
//   ۳) پاسخ جدید /v2/supplement/user_info.do:
//      {result:"true", data:[{coin, assetAmt, freezeAmt, usableAmt, ...}]}
// v1.5.4 FIX (ارور 10203 — «مدیریت دارایی صرافی البانک هنوز ارور می‌دهد»):
//   کد 10203 در مستند رسمی LBank = «签名方式错误» = روش امضا با نوع کلید
//   هماهنگ نیست. کلیدهای جدید LBank به‌صورت پیش‌فرض RSA هستند (Secret =
//   کلید خصوصی PKCS#8)؛ برنامه قبلاً همیشه signature_method=HmacSHA256
//   می‌فرستاد → سرور 10203 می‌داد. حالا:
//     • Secret کوتاه (HMAC) → HmacSHA256 مثل قبل.
//     • Secret طولانی/PEM (RSA) → signature_method=RSA و امضای
//       Base64(SHA256withRSA(md5Upper)) — دقیقاً مثل مثال رسمی LBank/Java
//       (utils/rsaSign.ts — پیاده‌سازی خالص، تست‌شده در برابر openssl).
// ---------------------------------------------------------------------------

/** v1.5.4 — پیام فارسی دقیق برای کدهای رسمی LBank (از مستند رسمی). */
function lbankErrorMessage(code: string, msg: string): Error {
  switch (code) {
    case '10203':
      return new Error(
        `روش امضا با کلید LBank شما هماهنگ نیست (10203) — Secret کلید را کامل کپی کنید (کلیدهای RSA طولانی هستند و باید تمام متن کپی شود)`
      );
    case '10205':
      return new Error(
        `LBank به دلیل قوانین کشور/منطقه این سرویس را نمی‌دهد (10205) — IP فیلترشکن را به کشور دیگری تغییر دهید و دوباره تلاش کنید`
      );
    case '10022':
      return new Error(
        `کلید LBank مجوز این کار را ندارد یا IP شما مجاز نیست (10022) — در تنظیمات کلید در LBank محدودیت IP را بردارید یا IP فعلی را اضافه کنید`
      );
    case '10600':
      return new Error(
        `ساعت درخواست با سرور LBank نخوانده شد (10600) — تاریخ و ساعت گوشی را روی «خودکار» بگذارید و دوباره تلاش کنید`
      );
    case '10031':
      return new Error(`پارامتر echostr نامعتبر است (10031) — دوباره تلاش کنید`);
    case '10005':
    case '10006':
      return new Error(`کلید LBank پیدا نشد (کد ${code}) — کلید API را دقیق کپی کنید یا یک کلید جدید در LBank بسازید`);
    case '10004':
      return new Error(`درخواست‌ها زیاد شد (10004) — چند ثانیه صبر کنید و دوباره تلاش کنید`);
    default:
      return new Error(`خطای LBank (کد ${code}): ${msg}`);
  }
}

function lbankEchostr(): string {
  // 38-char alnum echo (server expects 30–40 chars)
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 38; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/**
 * v1.5.7 — یک درخواست امضاشده LBank با روش مشخص (HmacSHA256 یا RSA).
 * خروجی: { kind: 'ok', body } | { kind: 'err', code, msg } | { kind: 'net', e }
 * جدا شد تا fetchLbank بتواند در برابر خطای 10203 («روش امضا اشتباه») خودش
 * روش دیگر را امتحان کند و روی خطای شبکه دامنه قدیمی را هم بیازماید.
 */
async function lbankSignedRequest(
  domain: string,
  w: ForeignWallet,
  method: 'HmacSHA256' | 'RSA'
): Promise<
  | { kind: 'ok'; body: Record<string, unknown> }
  | { kind: 'err'; code: string; msg: string }
  | { kind: 'net'; e: unknown }
> {
  try {
    const timestamp = Date.now().toString();
    const echostr = lbankEchostr();
    const params: Record<string, string> = {
      api_key: w.apiKey,
      echostr,
      signature_method: method,
      timestamp,
    };
    // raw string = sorted key=value joined by & (NO url-encoding, per ccxt rawencode)
    const raw = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    const md5Upper = md5Hex(raw).toUpperCase();
    let sign: string;
    if (method === 'RSA') {
      const rsa = rsaSignSha256(md5Upper, w.apiSecret);
      if (!rsa) {
        return { kind: 'err', code: '10203', msg: 'کلید RSA خوانده نشد — Secret را کامل کپی کنید' };
      }
      sign = rsa; // base64 — مثل مثال رسمی LBank (SHA256withRSA)
    } else {
      sign = CryptoJS.HmacSHA256(md5Upper, w.apiSecret).toString(CryptoJS.enc.Hex);
    }
    const all: Record<string, string> = { ...params, sign };
    const formBody = Object.keys(all)
      .sort()
      .map((k) => `${k}=${encodeURIComponent(all[k])}`)
      .join('&');
    const res = await rawFetch(`https://${domain}/v2/supplement/user_info.do`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        timestamp,
        signature_method: method,
        echostr,
      },
      body: formBody,
    });
    const body = parseJson(res.text);
    if (!body) return { kind: 'net', e: new Error(`HTTP ${res.status}`) };
    if (String(body.result) === 'true') return { kind: 'ok', body };
    return { kind: 'err', code: String(body.error_code ?? ''), msg: String(body.msg ?? '') };
  } catch (e) {
    return { kind: 'net', e };
  }
}

/** تبدیل پاسخ موفق user_info به ردیف‌های موجودی (شکل v2 + fallbackهای قدیمی). */
function lbankRowsFromBody(body: Record<string, unknown>): ForeignBalance[] {
  const out: ForeignBalance[] = [];
  const dataArr = Array.isArray(body.data) ? (body.data as Array<Record<string, unknown>>) : [];
  if (dataArr.length > 0) {
    for (const a of dataArr) {
      const total = toNum(a.assetAmt);
      const frozen = toNum(a.freezeAmt ?? a.frozenAmount);
      const usable = toNum(a.usableAmt);
      const avail = usable > 0 ? usable : Math.max(0, total - frozen);
      pushBalance(out, String(a.coin ?? a.assetCode ?? ''), avail, Math.min(frozen, Math.max(0, total - avail)));
    }
    return out;
  }
  // legacy fallback shapes (kept for safety): datas.assetList / datas map
  const datas = (body.datas ?? {}) as Record<string, unknown>;
  const assetList = asArray(datas.assetList);
  if (assetList.length > 0) {
    for (const a of assetList as Array<{
      assetCode?: string;
      availableAmount?: string;
      frozenAmount?: string;
    }>) {
      pushBalance(out, String(a.assetCode ?? ''), toNum(a.availableAmount), toNum(a.frozenAmount));
    }
  } else {
    for (const [coin, v] of Object.entries(datas)) {
      const row = (v ?? {}) as Record<string, unknown>;
      if (row && typeof row === 'object') {
        pushBalance(out, coin, toNum(row.available), toNum(row.freeze ?? row.frozen));
      }
    }
  }
  return out;
}

async function fetchLbank(w: ForeignWallet): Promise<ForeignBalance[]> {
  // v1.5.4/v1.5.7 — کلیدهای LBank دو نوع‌اند: Secret کوتاه (HmacSHA256) و
  // Secret طولانی PEM (RSA). اگر نوع کلید اشتباه تشخیص داده شود، سرور کد
  // 10203 («روش امضا با کلید هماهنگ نیست») می‌دهد → v1.5.7 همان‌جا روش دیگر
  // را خودکار امتحان می‌کند تا «بخش ارز دیجیتال البانک کار نکند» ریشه‌کن شود.
  const primary: 'HmacSHA256' | 'RSA' = isRsaSecret(w.apiSecret) ? 'RSA' : 'HmacSHA256';
  const secondary: 'HmacSHA256' | 'RSA' = primary === 'RSA' ? 'HmacSHA256' : 'RSA';

  let lastErr: { code: string; msg: string } | null = null;
  for (const method of [primary, secondary]) {
    const res = await lbankSignedRequest('api.lbkex.com', w, method);
    if (res.kind === 'ok') {
      const out = lbankRowsFromBody(res.body);
      // v1.5.5/v1.5.7 — فیوچرز LBank (best-effort): اگر LBank مسیرهای فیوچرز را
      // برای کلید API باز کند، ردیف‌های بخش فیوچرز همین‌جا اضافه می‌شوند.
      try {
        const futures = await fetchLbankFuturesBestEffort(w);
        for (const f of futures) out.push(f);
      } catch {}
      return out;
    }
    if (res.kind === 'net') {
      // دامنه رسمی جدید بی‌جواب بود → یک‌بار دامنه قدیمی هم امتحان می‌شود
      // (در بررسی تجربی هنوز جواب می‌دهد؛ دامنه اصلی lbkex.com می‌ماند).
      const legacy = await lbankSignedRequest('api.lbank.info', w, method);
      if (legacy.kind === 'ok') {
        const out = lbankRowsFromBody(legacy.body);
        try {
          const futures = await fetchLbankFuturesBestEffort(w);
          for (const f of futures) out.push(f);
        } catch {}
        return out;
      }
      if (legacy.kind === 'err') lastErr = { code: legacy.code, msg: legacy.msg };
      continue;
    }
    if (res.code !== '10203') {
      throw lbankErrorMessage(res.code, res.msg);
    }
    lastErr = { code: res.code, msg: res.msg };
  }
  // هر دو روش امضا 10203 دادند — پیام راهنما (کلید ناقص/ناهماهنگ)
  throw lbankErrorMessage('10203', lastErr?.msg ?? '');
}

// ---------------------------------------------------------------------------
// v1.5.5 — LBank فیوچرز (بک تستِ مسیر رسمی + best-effort):
//   کاربر: «صرافی البانک موجودی بخش های دیگه مثل فیوچرزو نشون نمیده».
//   بررسی تجربی (پروب با کلید ساختگی + کد ccxt + مستند رسمی):
//   • API «باز» LBank فقط اسپات را می‌دهد (user_info.do کلید را چک می‌کند).
//   • مسیرهای فیوچرز (lbkperp.lbank.com/cfd/user/v1/assetBalance — همان که
//     وب‌اپ خود LBank صدا می‌زند) برای کلید API جواب «not open path» می‌دهند
//     و فقط با نشستِ لاگین کار می‌کنند.
//   بنابراین: هر بار این مسیرها با امضای همان کلید امتحان می‌شوند — اگر
//   LBank روزی آنها را برای API-key باز کند، موجودی فیوچرز خودکار ظاهر
//   می‌شود؛ تا آن موقع ولت کارت یک توضیح صریح فارسی نشان می‌دهد که این
//   محدودیتِ خود صرافی است (نه باگ برنامه) و موجودی فیوچرز فقط داخل
//   اپ/سایت خود LBank دیده می‌شود.
// ---------------------------------------------------------------------------

function lbankSignedQuery(
  w: ForeignWallet,
  extra: Record<string, string>
): { qs: string; headers: Record<string, string> } {
  const timestamp = Date.now().toString();
  const echostr = lbankEchostr();
  const useRsa = isRsaSecret(w.apiSecret);
  const signatureMethod = useRsa ? 'RSA' : 'HmacSHA256';
  const params: Record<string, string> = {
    api_key: w.apiKey,
    signature_method: signatureMethod,
    timestamp,
    echostr,
    ...extra,
  };
  const raw = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  const md5Upper = md5Hex(raw).toUpperCase();
  let sign: string;
  if (useRsa) {
    const rsa = rsaSignSha256(md5Upper, w.apiSecret);
    if (rsa) {
      sign = rsa;
    } else {
      sign = '';
    }
  } else {
    sign = CryptoJS.HmacSHA256(md5Upper, w.apiSecret).toString(CryptoJS.enc.Hex);
  }
  const all: Record<string, string> = { ...params, sign };
  const qs = Object.keys(all)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(all[k])}`)
    .join('&');
  return {
    qs,
    headers: { timestamp, signature_method: signatureMethod, echostr },
  };
}

/** یک مسیر فیوچرز LBank را با کلید API امضا و صدا می‌زند — بی‌صدا best-effort. */
async function lbankFuturesAttempt(
  w: ForeignWallet,
  path: string,
  extra: Record<string, string>
): Promise<ForeignBalance[] | null> {
  try {
    const { qs, headers } = lbankSignedQuery(w, extra);
    const res = await rawFetch(`https://lbkperp.lbank.com${path}?${qs}`, {
      headers,
    });
    if (res.status !== 200) return null;
    const body = parseJson(res.text);
    if (!body || String(body.result) !== 'true') return null;
    const rows = Array.isArray(body.data)
      ? (body.data as Array<Record<string, unknown>>)
      : body.data && typeof body.data === 'object'
        ? [body.data as Record<string, unknown>]
        : [];
    const out: ForeignBalance[] = [];
    for (const r of rows) {
      const coin = String(r.coin ?? r.asset ?? r.assetCode ?? r.currency ?? '');
      if (!coin) continue;
      const total = toNum(r.assetAmt ?? r.total ?? r.equity ?? r.amount);
      const frozen = toNum(r.freezeAmt ?? r.frozen ?? r.freeze ?? r.frozenAmount);
      const usable = toNum(r.usableAmt ?? r.available ?? r.availableAmount ?? r.availableAmt);
      const avail = usable > 0 ? usable : Math.max(0, total - frozen);
      if (total > 0 || avail > 0 || frozen > 0) {
        pushBalance(out, coin.toUpperCase(), avail, Math.min(frozen, Math.max(0, total - avail)), 'futures');
      }
    }
    return out;
  } catch {
    return null;
  }
}

async function fetchLbankFuturesBestEffort(w: ForeignWallet): Promise<ForeignBalance[]> {
  // ۱) همان مسیری که وب‌اپ رسمی LBank برای موجودی فیوچرز صدا می‌زند
  let out = await lbankFuturesAttempt(w, '/cfd/user/v1/assetBalance', {
    asset: 'USDT',
    productGroup: 'SwapU',
  });
  if (out && out.length > 0) return out;
  // ۲) مسیر مثالِ مستند امضای قراردادها (prv/account)
  out = await lbankFuturesAttempt(w, '/cfd/prv/account', {
    asset: 'USDT',
    productGroup: 'SwapU',
  });
  return out ?? [];
}

// ---------------------------------------------------------------------------
// XT.com — v4 «xt-validate-*» header signing (matches ccxt + live probes).
//   • SPOT    : GET https://sapi.xt.com/v4/balance
//               sign payload = xt-validate-algorithms=HmacSHA256&xt-validate-appkey=KEY
//                               &xt-validate-recvwindow=RW&xt-validate-timestamp=TS#GET#/v4/balance
//   • FUTURES : GET https://fapi.xt.com/future/user/v1/balance/list
//               sign payload = xt-validate-appkey=KEY&xt-validate-timestamp=TS#GET#<path>
// v1.4.10:
//   1) تایم‌استمپ از /v4/public/time خود XT خوانده می‌شود (ساعت گوشی دیگر
//      خطای «outdated message» / خطای امضا نمی‌سازد).
//   2) پیام خطا دقیق شد — XT برای هر مشکل کد جدا می‌دهد:
//      AUTH_101 کلید پیدا نشد / AUTH_103 خطای امضا (Secret اشتباه) /
//      AUTH_104 کلید فقط با IP مجاز / AUTH_105 تایم‌استمپ کهنه /
//      AUTH_106 کلید دسترسی این کار را ندارد.
// ---------------------------------------------------------------------------

/** Persian, actionable message per XT auth code. */
function xtAuthErrorMessage(mc: string, isFutures: boolean): Error | null {
  const where = isFutures ? ' (فیوچرز)' : '';
  switch (mc) {
    case 'AUTH_101':
      return new Error(
        `XT این کلید را پیدا نکرد (AUTH_101)${where} — مطمئن شوید «AccessKey» را کپی کرده‌اید (نه SecretKey یا User ID). اگر تازه کلید ساختید چند دقیقه صبر کنید یا یک کلید جدید در XT.com → API Management بسازید و دوباره وارد کنید`
      );
    case 'AUTH_102':
      return new Error(`کلید XT فعال نشده است (AUTH_102)${where} — در XT.com کلید را تأیید/فعال کنید`);
    case 'AUTH_103':
      return new Error(
        `امضای XT نامعتبر است (AUTH_103)${where} — «SecretKey» را دقیقاً همان‌طور که موقع ساخت کلید نمایش داده شد کپی کنید (بدون فاصله اضافه)`
      );
    case 'AUTH_104':
      return new Error(
        `کلید XT فقط از IPهای مجاز قبول می‌کند (AUTH_104)${where} — در تنظیمات کلید در XT.com محدودیت IP را بردارید یا IP فعلی (IP فیلترشکن) را به لیست اضافه کنید`
      );
    case 'AUTH_105':
      return new Error(
        `ساعت درخواست با سرور XT نخوانده شد (AUTH_105)${where} — ساعت و تاریخ گوشی را روی «خودکار» بگذارید و دوباره تلاش کنید`
      );
    case 'AUTH_106':
      return new Error(
        `کلید XT مجوز این کار را ندارد (AUTH_106)${where} — در XT.com کلید را با مجوز خواندن موجودی بسازید`
      );
    default:
      if (/AUTH/i.test(mc)) {
        return new Error(`کلید API XT معتبر نیست (${mc})${where}`);
      }
      return null;
  }
}

async function xtSpotBalance(w: ForeignWallet): Promise<ForeignBalance[]> {
  const path = '/v4/balance';
  const ts = String(await exchangeNow('xt'));
  const recvWindow = '5000';
  const payload =
    `xt-validate-algorithms=HmacSHA256&xt-validate-appkey=${w.apiKey}` +
    `&xt-validate-recvwindow=${recvWindow}&xt-validate-timestamp=${ts}#GET#${path}`;
  const signature = hmacSha256Hex(w.apiSecret, payload);
  const res = await rawFetch(`https://sapi.xt.com${path}`, {
    headers: {
      'xt-validate-algorithms': 'HmacSHA256',
      'xt-validate-appkey': w.apiKey,
      'xt-validate-recvwindow': recvWindow,
      'xt-validate-timestamp': ts,
      'xt-validate-signature': signature,
    },
  });
  const body = parseJson(res.text);
  if (!body) throw new Error(`پاسخ نامعتبر از XT (HTTP ${res.status})`);
  const rc = Number(body.rc ?? -1);
  if (rc === 0) {
    const out: ForeignBalance[] = [];
    const result: unknown = body.result;
    // v4: result is an array of {currency, available, frozen, ...} — tolerate
    // map/list wrappers too.
    let rows: unknown[] = asArray(result);
    if (rows.length === 0 && result && typeof result === 'object') {
      const rec = result as Record<string, unknown>;
      rows = asArray(rec.list ?? rec.balances ?? rec.data);
    }
    for (const item of rows) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const asset = String(rec.currency ?? rec.coin ?? rec.asset ?? '');
      pushBalance(
        out,
        asset,
        toNum(rec.available ?? rec.free ?? rec.amount),
        toNum(rec.frozen ?? rec.freeze ?? rec.locked ?? 0)
      );
    }
    return out;
  }
  const mc = String(body.mc ?? '');
  // timestamp rejected → force clock re-sync, then one retry.
  if (mc === 'AUTH_105' || mc === 'AUTH_103') {
    markClockStale('xt');
    const ts2 = String(await exchangeNow('xt'));
    const payload2 =
      `xt-validate-algorithms=HmacSHA256&xt-validate-appkey=${w.apiKey}` +
      `&xt-validate-recvwindow=${recvWindow}&xt-validate-timestamp=${ts2}#GET#${path}`;
    const sig2 = hmacSha256Hex(w.apiSecret, payload2);
    const res2 = await rawFetch(`https://sapi.xt.com${path}`, {
      headers: {
        'xt-validate-algorithms': 'HmacSHA256',
        'xt-validate-appkey': w.apiKey,
        'xt-validate-recvwindow': recvWindow,
        'xt-validate-timestamp': ts2,
        'xt-validate-signature': sig2,
      },
    });
    const body2 = parseJson(res2.text);
    if (body2 && Number(body2.rc ?? -1) === 0) {
      const out: ForeignBalance[] = [];
      let rows: unknown[] = asArray(body2.result);
      if (rows.length === 0 && body2.result && typeof body2.result === 'object') {
        const rec = body2.result as Record<string, unknown>;
        rows = asArray(rec.list ?? rec.balances ?? rec.data);
      }
      for (const item of rows) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        pushBalance(
          out,
          String(rec.currency ?? rec.coin ?? rec.asset ?? ''),
          toNum(rec.available ?? rec.free ?? rec.amount),
          toNum(rec.frozen ?? rec.freeze ?? rec.locked ?? 0)
        );
      }
      return out;
    }
    if (body2) {
      const mc2 = String(body2.mc ?? '');
      const err2 = xtAuthErrorMessage(mc2, false);
      if (err2) throw err2;
      throw new Error(`خطای XT (${mc2 || body2.rc})`);
    }
  }
  const err = xtAuthErrorMessage(mc, false);
  if (err) throw err;
  throw new Error(`خطای XT (${mc || rc})`);
}

async function xtFuturesBalance(w: ForeignWallet): Promise<ForeignBalance[]> {
  const path = '/future/user/v1/balance/list';
  const ts = String(await exchangeNow('xt'));
  const payload = `xt-validate-appkey=${w.apiKey}&xt-validate-timestamp=${ts}#GET#${path}`;
  const signature = hmacSha256Hex(w.apiSecret, payload);
  const res = await rawFetch(`https://fapi.xt.com${path}`, {
    headers: {
      'xt-validate-appkey': w.apiKey,
      'xt-validate-timestamp': ts,
      'xt-validate-signature': signature,
    },
  });
  const body = parseJson(res.text);
  if (!body) throw new Error(`پاسخ نامعتبر از XT فیوچرز (HTTP ${res.status})`);
  const rc = Number(body.returnCode ?? -1);
  if (rc === 0) {
    const out: ForeignBalance[] = [];
    const result: unknown = body.result;
    let rows: unknown[] = asArray(result);
    if (rows.length === 0 && result && typeof result === 'object') {
      const rec = result as Record<string, unknown>;
      rows = asArray(rec.list ?? rec.balances ?? rec.data);
    }
    for (const item of rows) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const asset = String(rec.marginCoin ?? rec.currency ?? rec.coin ?? rec.asset ?? '');
      pushBalance(
        out,
        asset,
        toNum(rec.available ?? rec.free ?? rec.amount),
        toNum(rec.frozen ?? rec.freeze ?? rec.locked ?? 0),
        'futures'
      );
    }
    return out;
  }
  const msg = String(body.msgInfo ?? '');
  const errCode = String((body.error as Record<string, unknown> | undefined)?.code ?? '');
  const authErr = xtAuthErrorMessage(errCode, true);
  if (authErr) throw authErr;
  if (/sign|auth|token|key/i.test(msg + ' ' + errCode)) {
    throw new Error(
      `کلید API XT (فیوچرز) معتبر نیست (${errCode || msg}) — دسترسی خواندن را در XT.com چک کنید`
    );
  }
  throw new Error(`خطای XT فیوچرز (${errCode || msg || rc})`);
}

async function fetchXt(w: ForeignWallet): Promise<ForeignBalance[]> {
  const out: ForeignBalance[] = [];
  let spotError: Error | undefined;
  let futuresError: Error | undefined;
  try {
    out.push(...(await xtSpotBalance(w)));
  } catch (e) {
    spotError = e instanceof Error ? e : new Error(String(e));
  }
  try {
    out.push(...(await xtFuturesBalance(w)));
  } catch (e) {
    futuresError = e instanceof Error ? e : new Error(String(e));
  }
  if (out.length > 0) return out;
  // Nothing readable anywhere — surface the SPOT error (primary account).
  throw spotError ?? futuresError ?? new Error('خطای ناشناخته XT');
}

// ---------------------------------------------------------------------------
// Bitunix — futures account balance, header-sign scheme + fallback
// ---------------------------------------------------------------------------

async function bitunixAttempt(
  w: ForeignWallet,
  variant: 'ts-key' | 'ts-key-body'
): Promise<{ signRejected: boolean; error?: Error; balances?: ForeignBalance[] }> {
  const path = '/api/v1/futures/account/balance';
  const ts = Date.now().toString();
  const sign =
    variant === 'ts-key'
      ? hmacSha256Hex(w.apiSecret, `${ts}${w.apiKey}`)
      : hmacSha256Hex(w.apiSecret, `${ts}${w.apiKey}{}`);
  const res = await rawFetch(`https://api.bitunix.com${path}`, {
    headers: {
      apikey: w.apiKey,
      timestamp: ts,
      sign: sign,
      'Content-Type': 'application/json',
    },
  });
  const body = parseJson(res.text);
  if (!body) {
    return {
      signRejected: false,
      error: new Error(`پاسخ نامعتبر از Bitunix (HTTP ${res.status})`),
    };
  }
  const code = Number(body.code ?? -1);
  const data = (body.data ?? {}) as Record<string, unknown>;
  if (code === 0 && data) {
    const out: ForeignBalance[] = [];
    // Bitunix: data.list → [{coinId, frozen? available? total?}]
    const list = asArray(data.list);
    if (list.length > 0) {
      for (const r of list as Array<{
        coinId?: string;
        frozen?: string;
        available?: string;
        total?: string;
      }>) {
        pushBalance(
          out,
          String(r.coinId ?? ''),
          toNum(r.available),
          toNum(r.frozen)
        );
      }
    } else {
      for (const [coin, v] of Object.entries(data)) {
        if (v && typeof v === 'object') {
          const row = v as Record<string, unknown>;
          pushBalance(out, coin, toNum(row.available), toNum(row.frozen));
        }
      }
    }
    return { signRejected: false, balances: out };
  }
  const msg = String(body.msg ?? body.message ?? '');
  const signRejected = /sign/i.test(msg) || code === 10021 || code === 10022;
  return {
    signRejected,
    error: new Error(
      /key|auth/i.test(msg)
        ? `کلید Bitunix معتبر نیست (${code}: ${msg})`
        : `خطای Bitunix (کد ${code}): ${msg}`
    ),
  };
}

async function fetchBitunix(w: ForeignWallet): Promise<ForeignBalance[]> {
  let last = await bitunixAttempt(w, 'ts-key');
  if (last.balances) return last.balances;
  if (last.signRejected) {
    const alt = await bitunixAttempt(w, 'ts-key-body');
    if (alt.balances) return alt.balances;
    last = alt;
  }
  throw last.error ?? new Error('خطای ناشناخته Bitunix');
}

// ---------------------------------------------------------------------------
// KCEX — Binance-compatible, X-API-KEY + query signature, path candidates
// ---------------------------------------------------------------------------

async function fetchKcex(w: ForeignWallet): Promise<ForeignBalance[]> {
  const candidates = ['/api/v1/account/balance', '/api/v3/account', '/api/v1/account'];
  let lastError: Error | null = null;
  for (const path of candidates) {
    const qs = `recvWindow=10000&timestamp=${Date.now()}`;
    const signature = hmacSha256Hex(w.apiSecret, qs);
    const res = await rawFetch(`https://api.kcex.com${path}?${qs}&signature=${signature}`, {
      headers: { 'X-API-KEY': w.apiKey },
    });
    if (res.status === 404) continue;
    const body = parseJson(res.text);
    if (!body) {
      lastError = new Error(`پاسخ نامعتبر از KCEX (HTTP ${res.status})`);
      continue;
    }
    const balances = asArray(body.balances);
    if (balances.length > 0 || String(body.code ?? '') === '0') {
      const out: ForeignBalance[] = [];
      for (const b of balances as Array<{
        asset?: string;
        free?: string;
        locked?: string;
      }>) {
        pushBalance(out, String(b.asset ?? ''), toNum(b.free), toNum(b.locked));
      }
      return out;
    }
    lastError = new Error(
      `خطای KCEX (کد ${String(body.code ?? res.status)}): ${String(body.msg ?? '')}`
    );
  }
  throw (
    lastError ??
    new Error('اتصال به KCEX برقرار نشد — اینترنت/فیلترشکن را چک کنید')
  );
}

// ---------------------------------------------------------------------------
// Iranicart — Nobitex-compatible platform attempt (Token auth)
// ---------------------------------------------------------------------------

async function fetchIranicart(w: ForeignWallet): Promise<ForeignBalance[]> {
  const bases = ['https://api.iranicart.ir'];
  let lastError = 'اتصال برقرار نشد';
  for (const base of bases) {
    try {
      const res = await rawFetch(`${base}/users/wallets/list`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Token ${w.apiKey.trim()}:${w.apiSecret.trim()}`,
        },
        body: JSON.stringify({ tokens: 'all' }),
      });
      const body = parseJson(res.text);
      if (res.ok && body && Array.isArray(body.wallets)) {
        const out: ForeignBalance[] = [];
        for (const row of body.wallets as Array<{
          currency?: string;
          balance?: string;
          blockedBalance?: string;
        }>) {
          const currency = String(row.currency ?? '').toLowerCase();
          const free = toNum(row.balance);
          const locked = toNum(row.blockedBalance);
          if (!currency || free + locked <= 0) continue;
          if (currency === 'rls' || currency === 'irt') {
            pushBalance(out, 'IRT', currency === 'rls' ? free / 10 : free, 0, 'spot', 0);
          } else {
            pushBalance(out, currency, free, locked);
          }
        }
        return out;
      }
      lastError = res.text.slice(0, 120);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(
    `دریافت موجودی ایرانیکارت ناموفق بود (${lastError}) — اگر صرافی API ارائه می‌دهد و خطا ادامه داشت اطلاع دهید`
  );
}

// ---------------------------------------------------------------------------
// Orbiter — not an exchange (Layer-2 bridge): no wallet API exists
// ---------------------------------------------------------------------------

function orbiterError(name: string): Error {
  return new Error(
    `${name} یک صرافی نیست — پل انتقال ارز بین شبکه‌های L2 است و API کیف پول/موجودی ندارد؛ برای مدیریت دارایی یک صرافی دیگر اضافه کنید`
  );
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const FOREIGN_FETCHERS: Partial<
  Record<ExchangeId, (w: ForeignWallet) => Promise<ForeignBalance[]>>
> = {
  mexc: fetchMexc,
  kucoin: fetchKucoin,
  bitget: fetchBitget,
  gateio: fetchGateio,
  htx: fetchHtx,
  huobi: fetchHtx, // Huobi = HTX (rebrand) — same platform/API
  toobit: fetchToobit,
  bingx: fetchBingx,
  bitmart: fetchBitmart,
  superex: fetchSuperex,
  coinex: fetchCoinex,
  phemex: fetchPhemex,
  lbank: fetchLbank,
  xt: fetchXt,
  bitunix: fetchBitunix,
  kcex: fetchKcex,
  iranicart: fetchIranicart,
};

export async function fetchForeignExchangeBalance(
  exchangeId: ExchangeId,
  wallet: ForeignWallet
): Promise<ForeignBalance[]> {
  if (exchangeId === 'orbiter') throw orbiterError(wallet.exchangeName);
  const fetcher = FOREIGN_FETCHERS[exchangeId];
  if (!fetcher) {
    throw new Error(
      `صرافی ${wallet.exchangeName} هنوز پشتیبانی نمی‌شود — به‌زودی اضافه می‌شود`
    );
  }
  if (!wallet.apiKey?.trim() || !wallet.apiSecret?.trim()) {
    throw new Error(
      `کلید API و Secret برای ${wallet.exchangeName} ثبت نشده — صرافی را حذف و دوباره با کلید معتبر اضافه کنید`
    );
  }
  let balances: ForeignBalance[];
  try {
    balances = await fetcher(wallet);
  } catch (e) {
    // v1.4.12 — sanctioned-IP detection: if this exchange just answered with
    // a geo-block status (451/403/418), replace the (often vague) error with
    // the dedicated SanctionedIpError → wallet shows the «تحریم» dialog and
    // can disconnect THIS exchange only (the others stay connected).
    const geo = geoBlockErrorFor(exchangeId, wallet.exchangeName);
    if (geo) throw geo;
    if (e instanceof Error) throw e;
    throw networkError(wallet.exchangeName, e);
  }
  await valueInUsd(balances, exchangeId);
  return balances;
}
