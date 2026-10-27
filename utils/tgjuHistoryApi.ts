/**
 * tgjuHistoryApi.ts — v1.4.14
 *
 * Historical DAILY closes for the Iranian metals market (TGJU), used by the
 * «دارایی ریالی و فلزات» PnL card (۷/۳۰/۹۰/۱۸۰ روز).
 *
 * Endpoint (discovered from the live tgju.org profile pages — same host the
 * site's own DataTables use, no auth):
 *   GET https://api.tgju.org/v1/market/indicator/summary-table-data/{symbol}
 *       ?lang=fa&order_dir=desc
 *   → { draw, recordsTotal, data: [[open, low, high, close, change, pct,
 *        "YYYY/MM/DD", "jalali"], …] }   (newest first, ~3500 rows back to 2013)
 *
 * Values are RIAL strings with commas → TOMAN = ÷10 (same unit fix as
 * iranMarketApi). Results are cached in memory per symbol for 10 minutes.
 */

const HISTORY_BASE = 'https://api.tgju.org/v1/market/indicator/summary-table-data';
const REQUEST_TIMEOUT_MS = 20_000;

/** TGJU symbols used by the rial/metals PnL (dollar added in v1.4.15). */
export const TgjuHistorySymbol = {
  gold18: 'geram18',
  gold24: 'geram24',
  silver999: 'silver_999',
  silver925: 'silver_925',
  coinEmami: 'sekee',
  coinBahar: 'sekeb',
  coinNim: 'nim',
  coinRob: 'rob',
  /** Free-market USD (paper dollars) — Toman per USD. */
  dollar: 'price_dollar_rl',
} as const;

export type TgjuHistoryKey = keyof typeof TgjuHistorySymbol;

export interface TgjuClosePoint {
  /** Epoch ms (midnight of the trading day). */
  t: number;
  /** Close price in TOMAN. */
  close: number;
}

interface CacheEntry {
  at: number;
  points: TgjuClosePoint[];
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 10 * 60 * 1000;

/** "264,961,000" (rial, with HTML spans around some cells) → 26,496,100 toman. */
function cellToToman(raw: unknown): number {
  const s = String(raw ?? '').replace(/<[^>]+>/g, '').replace(/[,،\s]/g, '');
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n / 10;
}

/** "2026/10/08" → epoch ms (local midnight). */
function gregorianCellToMs(raw: unknown): number {
  const s = String(raw ?? '').replace(/<[^>]+>/g, '').trim();
  const m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/**
 * Fetches the daily close series for one symbol (newest first in the raw
 * payload; returned ASCENDING by time). Throws on network/parse failure so
 * react-query can surface and retry it.
 */
export async function fetchTgjuCloses(symbol: string): Promise<TgjuClosePoint[]> {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.points;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${HISTORY_BASE}/${encodeURIComponent(symbol)}?lang=fa&order_dir=desc`,
      {
        signal: controller.signal,
        headers: {
          Accept: 'application/json, text/plain, */*',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `https://www.tgju.org/profile/${encodeURIComponent(symbol)}`,
        },
      }
    );
    if (!res.ok) throw new Error(`TGJU history HTTP ${res.status}`);
    const body = (await res.json()) as { data?: unknown };
    const rows = body?.data;
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('TGJU history خالی است');

    const points: TgjuClosePoint[] = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 8) continue;
      const t = gregorianCellToMs(row[6]);
      const close = cellToToman(row[3]);
      if (!Number.isFinite(t) || close <= 0) continue;
      points.push({ t, close });
    }
    if (points.length === 0) throw new Error('TGJU history قابل تجزیه نبود');

    points.sort((a, b) => a.t - b.t); // ascending
    cache.set(symbol, { at: Date.now(), points });
    return points;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The close price of the LAST trading day at-or-before `targetMs`.
 * Returns null when the series doesn't reach that far back.
 */
export function closeAtOrBefore(points: TgjuClosePoint[], targetMs: number): number | null {
  if (points.length === 0) return null;
  if (targetMs <= points[0].t) return points[0].close;
  if (targetMs >= points[points.length - 1].t) return points[points.length - 1].close;
  // Binary search for the last point ≤ target.
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (points[mid].t <= targetMs) lo = mid;
    else hi = mid - 1;
  }
  return points[lo].close;
}

/** The newest close (fallback when the live ajax feed is unavailable). */
export function latestClose(points: TgjuClosePoint[]): number | null {
  return points.length > 0 ? points[points.length - 1].close : null;
}
