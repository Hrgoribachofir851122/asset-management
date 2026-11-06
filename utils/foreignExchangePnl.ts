/**
 * foreignExchangePnl.ts — v1.4.8 period PnL (30/90/180/360 days) for the
 * foreign exchanges whose APIs expose closed-position / income history.
 *
 *   • MEXC    — GET https://api.mexc.com/api/v1/private/position/list/history_positions
 *               (futures closed positions: `realised` = realized PnL,
 *               `holdFee` = funding fee)
 *               Auth: ApiKey / Request-Time / Signature headers where
 *               Signature = HMAC-SHA256(secret, apiKey + timestamp + sortedParams)
 *               — validated live (fake key → «API Key expired», i.e. the route
 *               and the signature scheme are accepted).
 *   • Bitget  — GET https://api.bitget.com/api/v2/mix/position/history-position
 *               (closed positions with pnl / fee / funding fee / open-close times)
 *               Auth: ACCESS-* headers (same scheme as the balance endpoint —
 *               validated live: fake key → 40037 «Apikey does not exist»).
 *
 * Returns null for any other exchange id — the wallet dispatcher then shows
 * the «این صرافی در API خود سود/زیان دوره‌ای ارائه نمی‌دهد» note as before.
 */

import CryptoJS from 'crypto-js';
import { exchangeNow, markClockStale } from './exchangeClock';
import { noteResponseStatus, geoBlockErrorFor } from './geoBlock';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAGES = 10;

export interface ForeignPeriodPnl {
  realizedPnl: number;
  fundingFees: number;
  commissions: number;
  closedCount: number;
}

interface RawResp {
  ok: boolean;
  status: number;
  text: string;
}

async function rawFetch(url: string, init: RequestInit = {}): Promise<RawResp> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
    });
    // v1.4.12 — geo-block (451/403/418) tracking for sanctioned-IP detection.
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

function toNum(v: unknown): number {
  const n = parseFloat(String(v ?? '0'));
  return Number.isFinite(n) ? n : 0;
}

/** Timestamp normalizer (s / ms / seconds-as-string → epoch ms). */
function toMs(v: unknown): number {
  const n = toNum(v);
  if (n <= 0) return 0;
  return n > 1e12 ? n : n > 1e9 ? n * 1000 : 0;
}

export interface ForeignPnlCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
}

// ---------------------------------------------------------------------------
// MEXC — futures closed-position history (contract API v1).
// v1.4.10: Request-Time now comes from MEXC's own /api/v3/time (see
// exchangeClock.ts) — the old code trusted the phone clock and clock drift
// produced timestamp/signature rejections.
// ---------------------------------------------------------------------------

async function mexcHistoryPage(
  w: ForeignPnlCredentials,
  page: number
): Promise<{ body: Record<string, unknown> | null; status: number }> {
  const params: Record<string, string> = { page: String(page), pageSize: '50' };
  const qsSorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  const ts = await exchangeNow('mexc');
  const signature = CryptoJS.HmacSHA256(
    `${w.apiKey}${ts}${qsSorted}`,
    w.apiSecret
  ).toString(CryptoJS.enc.Hex);

  const res = await rawFetch(
    `https://api.mexc.com/api/v1/private/position/list/history_positions?${qsSorted}`,
    {
      headers: {
        ApiKey: w.apiKey,
        'Request-Time': String(ts),
        Signature: signature,
        'Content-Type': 'application/json',
      },
    }
  );
  return { body: parseJson(res.text), status: res.status };
}

async function mexcPeriodPnl(w: ForeignPnlCredentials, days: number): Promise<ForeignPeriodPnl | null> {
  const windowStart = Date.now() - days * 86_400_000;
  let realizedPnl = 0;
  let fundingFees = 0;
  let commissions = 0;
  let closedCount = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    let { body, status } = await mexcHistoryPage(w, page);
    // Timestamp rejection → re-sync the server clock, retry the page once.
    const firstCode = String(body?.code ?? '');
    if (body && (firstCode === '700003' || /timestamp/i.test(String(body?.message ?? '')))) {
      markClockStale('mexc');
      ({ body, status } = await mexcHistoryPage(w, page));
    }
    if (!body) throw new Error(`پاسخ نامعتبر از MEXC (HTTP ${status})`);

    // auth failures → precise Persian error
    const code = String(body.code ?? '');
    const message = String(body.message ?? body.msg ?? '');
    if (
      status === 401 ||
      code === '401' ||
      code === '402' ||
      /expired|invalid|not\s*exist/i.test(message)
    ) {
      throw new Error(
        `کلید API مکسی معتبر نیست یا دسترسی «View Order Details» ندارد (${message || code}) — در MEXC → API Management کلید را با مجوز خواندن بسازید`
      );
    }
    if (code === '700003') {
      throw new Error(
        `ساعت گوشی با سرور MEXC اختلاف دارد (کد 700003) — ساعت و تاریخ گوشی را «خودکار» تنظیم کنید و دوباره تلاش کنید`
      );
    }
    if (body.success === false && code !== '0' && code !== '200') {
      throw new Error(`خطای MEXC در دریافت سود/زیان (کد ${code}): ${message}`);
    }

    // Response: { success, code, data: { totalPageNum, resultList: [...] } }
    const data = body.data as Record<string, unknown> | undefined;
    const rows = Array.isArray(data?.resultList)
      ? (data?.resultList as Array<Record<string, unknown>>)
      : Array.isArray(body.resultList)
        ? (body.resultList as Array<Record<string, unknown>>)
        : [];
    if (rows.length === 0) break;

    for (const r of rows) {
      const closeMs =
        toMs(r.closeDate) ?? toMs(r.createDate) ?? toMs(r.timestamp) ?? toMs(r.updateTime);
      if (closeMs > 0 && closeMs < windowStart) continue;
      realizedPnl += toNum(r.realised ?? r.realized ?? r.realisedPnl ?? r.pnl);
      fundingFees += toNum(r.holdFee ?? r.fundingFee ?? r.funding);
      commissions += toNum(r.closeTakerFee ?? r.fee ?? r.commission);
      closedCount++;
    }

    const totalPages = toNum(data?.totalPageNum) || 1;
    if (page >= totalPages) break;
  }

  return { realizedPnl, fundingFees, commissions, closedCount };
}

// ---------------------------------------------------------------------------
// Bitget
// v1.4.10: 40085 = «حساب Unified Account» — classic v2 history-position is
// rejected, so the SAME PnL is read from the UTA endpoint:
//   GET /api/v3/position/history-position?category=USDT-FUTURES&limit=100
//   rows: {cumRealisedPnl, netProfit, totalFunding, openFeeTotal, closeFeeTotal, updatedTime}
//   pagination: data.cursor → next request idLessThan=cursor
// The classic (v2) route stays first — classic accounts keep working as before.
// ---------------------------------------------------------------------------

async function bitgetSignedGet(
  w: ForeignPnlCredentials,
  pathWithQuery: string
): Promise<{ body: Record<string, unknown> | null; status: number }> {
  const ts = (await exchangeNow('bitget')).toString();
  const signature = CryptoJS.enc.Base64.stringify(
    CryptoJS.HmacSHA256(`${ts}GET${pathWithQuery}`, w.apiSecret)
  );
  const res = await rawFetch(`https://api.bitget.com${pathWithQuery}`, {
    headers: {
      'ACCESS-KEY': w.apiKey,
      'ACCESS-SIGN': signature,
      'ACCESS-TIMESTAMP': ts,
      'ACCESS-PASSPHRASE': w.passphrase ?? '',
      'Content-Type': 'application/json',
      locale: 'en-US',
    },
  });
  return { body: parseJson(res.text), status: res.status };
}

function bitgetAuthError(code: string, msg: string): Error | null {
  if (code === '40037' || code === '40036' || code === '40038') {
    return new Error(
      `کلید Bitget معتبر نیست (${msg}) — کلید/Secret/Passphrase را چک کنید`
    );
  }
  return null;
}

async function bitgetPeriodPnl(w: ForeignPnlCredentials, days: number): Promise<ForeignPeriodPnl | null> {
  const windowStart = Date.now() - days * 86_400_000;

  // ---- classic (v2) first ----
  const classic = await bitgetClassicPnl(w, windowStart);
  if (classic.uta) {
    // ---- UTA (v3): cursor-paginated position history ----
    return bitgetUtaPnl(w, windowStart);
  }
  // v1.4.12 — Unified accounts sometimes answer the v2 route with code 00000
  // and an EMPTY list (instead of 40085), which made PnL read as 0/خالی on
  // EVERY timeframe. Empty classic result → probe the v3 UTA route as well;
  // if it returns rows, those numbers win.
  if (classic.result && classic.result.closedCount === 0) {
    try {
      const uta = await bitgetUtaPnl(w, windowStart);
      if (uta && uta.closedCount > 0) return uta;
    } catch {
      // keep the classic zeros — auth errors for the classic route already
      // threw above, so any failure here leaves the old behavior intact.
    }
  }
  return classic.result;
}

async function bitgetClassicPnl(
  w: ForeignPnlCredentials,
  windowStart: number
): Promise<{ uta: boolean; result: ForeignPeriodPnl | null }> {
  let realizedPnl = 0;
  let fundingFees = 0;
  let commissions = 0;
  let closedCount = 0;

  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
    const path = '/api/v2/mix/position/history-position';
    const qs = `productType=USDT-FUTURES&pageSize=50&pageNo=${pageNo}`;
    const { body, status } = await bitgetSignedGet(w, `${path}?${qs}`);
    if (!body) throw new Error(`پاسخ نامعتبر از Bitget (HTTP ${status})`);

    const code = String(body.code ?? '');
    if (code === '40085') {
      // Unified Trading Account → retry via the v3 UTA endpoint instead.
      return { uta: true, result: null };
    }
    const authErr = bitgetAuthError(code, String(body.msg ?? ''));
    if (authErr || status === 401) {
      throw authErr ?? new Error('کلید Bitget معتبر نیست (401) — کلید/Secret/Passphrase را چک کنید');
    }
    if (code !== '00000') {
      throw new Error(`خطای Bitget در دریافت سود/زیان (کد ${code}): ${String(body.msg ?? '')}`);
    }

    const data = body.data as Record<string, unknown> | undefined;
    const rows = Array.isArray(data?.entrustedList)
      ? (data?.entrustedList as Array<Record<string, unknown>>)
      : Array.isArray(data?.list)
        ? (data?.list as Array<Record<string, unknown>>)
        : [];
    if (rows.length === 0) break;

    for (const r of rows) {
      const closeMs = toMs(r.closeTime ?? r.cTime ?? r.uTime);
      if (closeMs > 0 && closeMs < windowStart) continue;
      realizedPnl += toNum(r.pnl ?? r.profit ?? r.realisedPnl);
      fundingFees += toNum(r.fundingFee ?? r.fundingFees);
      commissions += toNum(r.fee ?? r.fees ?? r.tradeFee);
      closedCount++;
    }

    // Pagination: stop when fewer than pageSize rows came back.
    if (rows.length < 50) break;
  }

  return { uta: false, result: { realizedPnl, fundingFees, commissions, closedCount } };
}

async function bitgetUtaPnl(
  w: ForeignPnlCredentials,
  windowStart: number
): Promise<ForeignPeriodPnl | null> {
  let realizedPnl = 0;
  let fundingFees = 0;
  let commissions = 0;
  let closedCount = 0;
  let lastError: Error | null = null;

  // v1.4.12 — try both category spellings; keep whichever answers with rows.
  for (const category of ['USDT-FUTURES', 'linear'] as const) {
    let cursor: string | undefined;
    let categoryCount = 0;
    try {
      for (let round = 0; round < MAX_PAGES * 2; round++) {
        const path = '/api/v3/position/history-position';
        let qs = `category=${category}&limit=100`;
        if (cursor) qs += `&idLessThan=${cursor}`;
        const { body, status } = await bitgetSignedGet(w, `${path}?${qs}`);
        if (!body) throw new Error(`پاسخ نامعتبر از Bitget UTA (HTTP ${status})`);

        const code = String(body.code ?? '');
        const authErr = bitgetAuthError(code, String(body.msg ?? ''));
        if (authErr) throw authErr;
        if (code !== '00000') {
          throw new Error(`خطای Bitget UTA در دریافت سود/زیان (کد ${code}): ${String(body.msg ?? '')}`);
        }

        const data = (body.data ?? {}) as Record<string, unknown>;
        // v1.4.12 — tolerate every observed row-shape for the v3 route.
        const rows = Array.isArray(data.list)
          ? (data.list as Array<Record<string, unknown>>)
          : Array.isArray(data.rows)
            ? (data.rows as Array<Record<string, unknown>>)
            : Array.isArray(data.positionList)
              ? (data.positionList as Array<Record<string, unknown>>)
              : [];
        if (rows.length === 0) break;

        for (const r of rows) {
          const closeMs = toMs(r.updatedTime ?? r.uTime ?? r.closeTime ?? r.createdTime);
          if (closeMs > 0 && closeMs < windowStart) continue;
          realizedPnl += toNum(r.cumRealisedPnl ?? r.netProfit ?? r.pnl ?? r.realisedPnl);
          fundingFees += toNum(r.totalFunding ?? r.fundingFee ?? 0);
          commissions += toNum(r.openFeeTotal ?? 0) + toNum(r.closeFeeTotal ?? 0);
          closedCount++;
          categoryCount++;
        }

        const next = String(data.cursor ?? data.endId ?? '');
        if (!next || rows.length < 100) break;
        cursor = next;
      }
    } catch (e) {
      // Remember the first failure; if the other category also fails, throw.
      if (lastError === null) lastError = e instanceof Error ? e : new Error(String(e));
    }
    if (categoryCount > 0) {
      // This category returned data — use it.
      return { realizedPnl, fundingFees, commissions, closedCount };
    }
  }
  if (closedCount === 0 && lastError) throw lastError;
  return { realizedPnl, fundingFees, commissions, closedCount };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Period PnL for the supported foreign exchanges. Returns null when this
 * exchange has no period-PnL API (the caller shows its own note then).
 * Network/auth problems THROW precise Persian errors.
 *
 * v1.4.12 — a recent geo-block (451/403/418) from THIS exchange is converted
 * into SanctionedIpError so the PnL card shows the «تحریم» explanation too.
 */
export async function fetchForeignPeriodPnl(
  exchangeId: string,
  w: ForeignPnlCredentials,
  days: number
): Promise<ForeignPeriodPnl | null> {
  try {
    switch (exchangeId) {
      case 'mexc':
        return await mexcPeriodPnl(w, days);
      case 'bitget':
        return await bitgetPeriodPnl(w, days);
      default:
        return null;
    }
  } catch (e) {
    const geo = geoBlockErrorFor(exchangeId, exchangeId);
    if (geo) throw geo;
    throw e;
  }
}
