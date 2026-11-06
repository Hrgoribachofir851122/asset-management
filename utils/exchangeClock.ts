/**
 * exchangeClock.ts — v1.4.10 — signed-request clock synchronization.
 *
 * WHY: the phone's clock can drift (or be plain wrong) while every signed
 * exchange request stamps «now» from it. That single root cause produced:
 *   • MEXC   700003 «Timestamp for this request is outside of the recvWindow»
 *   • Binance -1021 (timestamp outside recvWindow) → «موجودی یافت نشد»
 *   • XT     AUTH_105 «outdated message» / signature rejections
 * Instead of trusting Date.now(), every signing helper now asks the exchange's
 * own /time endpoint once, caches the offset (server − local) for 10 minutes,
 * and stamps requests with the SERVER's view of «now».
 *
 * Public time sources (all verified live):
 *   binance → https://api.binance.com/api/v3/time           { serverTime }
 *   mexc    → https://api.mexc.com/api/v3/time              { serverTime }
 *   bitget  → https://api.bitget.com/api/v2/public/time     { data.serverTime }
 *   xt      → https://sapi.xt.com/v4/public/time            { result.serverTime }
 * Fallback when an exchange has no public time endpoint: the HTTP `Date`
 * response header (1-second resolution — plenty for a 5–30s recv window).
 */

export type ClockId = 'binance' | 'mexc' | 'bitget' | 'xt';

interface ClockState {
  offsetMs: number;
  fetchedAt: number;
}

/** Cached offsets per exchange. */
const cache: Partial<Record<ClockId, ClockState>> = {};

/** In-flight /time requests (deduped so parallel section calls share one hit). */
const inflight: Partial<Record<ClockId, Promise<number>>> = {};

const FRESH_MS = 10 * 60_000; // re-sync at most every 10 minutes
const REQ_TIMEOUT_MS = 8_000;

async function timedFetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractServerTime(text: string | null): number | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    const candidates = [
      v?.serverTime,
      v?.data?.serverTime,
      v?.result?.serverTime,
      v?.data,
      v?.result,
    ];
    for (const c of candidates) {
      const n = typeof c === 'string' ? parseInt(c, 10) : typeof c === 'number' ? c : NaN;
      // accept s or ms epochs
      if (Number.isFinite(n) && n > 1_000_000_000) {
        return n > 1e12 ? n : n * 1000;
      }
    }
  } catch {}
  return null;
}

/** One /time hit → offset (server − local). Returns 0 when unreachable. */
async function syncOffset(id: ClockId): Promise<number> {
  const sources: Record<ClockId, string> = {
    binance: 'https://api.binance.com/api/v3/time',
    mexc: 'https://api.mexc.com/api/v3/time',
    bitget: 'https://api.bitget.com/api/v2/public/time',
    xt: 'https://sapi.xt.com/v4/public/time',
  };
  const localAt = Date.now();
  let serverTime = extractServerTime(await timedFetchText(sources[id]));
  if (serverTime === null) {
    // Fallback: the Date response header of the exchange host.
    serverTime = await dateHeaderTimeMs(id);
  }
  if (serverTime === null) return 0;
  // subtract half the round-trip so slow links don't skew the stamp
  const rtt = Date.now() - localAt;
  return serverTime + Math.floor(rtt / 2) - localAt;
}

/** Server time from the HTTP `Date` header (1s resolution). */
async function dateHeaderTimeMs(id: ClockId): Promise<number | null> {
  const hosts: Record<ClockId, string> = {
    binance: 'https://api.binance.com/api/v3/ping',
    mexc: 'https://api.mexc.com/api/v3/ping',
    bitget: 'https://api.bitget.com/api/v2/public/time',
    xt: 'https://sapi.xt.com/v4/public/time',
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(hosts[id], { method: 'HEAD', signal: controller.signal }).catch(() => null);
    const dateHeader = res?.headers?.get?.('date') ?? null;
    if (!dateHeader) return null;
    const t = Date.parse(dateHeader);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * «Now» according to the exchange's server clock.
 * Falls back to the local clock when the sync fails (best effort — a slightly
 * wrong stamp is still better than no request at all).
 */
export async function exchangeNow(id: ClockId): Promise<number> {
  const c = cache[id];
  if (c && Date.now() - c.fetchedAt < FRESH_MS) {
    return Date.now() + c.offsetMs;
  }
  if (!inflight[id]) {
    inflight[id] = syncOffset(id)
      .then((offsetMs) => {
        cache[id] = { offsetMs, fetchedAt: Date.now() };
        return offsetMs;
      })
      .catch(() => 0)
      .finally(() => {
        delete inflight[id];
      });
  }
  try {
    await inflight[id];
  } catch {}
  const c2 = cache[id];
  return Date.now() + (c2?.offsetMs ?? 0);
}

/**
 * Force a re-sync on the NEXT exchangeNow call — called when an exchange
 * answers with a timestamp-type error (MEXC 700003 / Binance -1021 / XT
 * AUTH_105): the cached offset is clearly stale, so refresh it before the
 * automatic retry fires.
 */
export function markClockStale(id: ClockId): void {
  delete cache[id];
}

/** True when a cached offset exists (used for the debug/status line). */
export function hasClockSync(id: ClockId): boolean {
  return Boolean(cache[id]);
}
