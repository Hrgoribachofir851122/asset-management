import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * imeFuturesApi.ts — v1.4.14
 *
 * «پیش‌بینی قیمت طلا» data layer — the IME (بورس کالای ایران) raw-gold-bar
 * futures market, group «گروه شمش طلای خام»:
 *
 *     predicted 18k price (Toman/gram) = (750 ÷ 995) × futures price
 *
 * IMPORTANT: IME endpoints are geo-blocked to IRANIAN IPs only (verified —
 * every foreign exit, including the Railway server, is refused). The fetch
 * therefore runs ON-DEVICE and only works when the phone's exit IP is
 * Iranian (فیلترشکن خاموش). Multi-layer strategy:
 *
 *   1. IME futures endpoints (probed, tolerant JSON parse) — Iranian IP
 *   2. IME dataapi CDCTrades (CONFIRMED endpoint pattern — gold-bar trades)
 *   3. TGJU ajax.json `ime_futures_shemsh_tala_*` keys (may be stale — the
 *      last quote date is surfaced to the user)
 *   4. MANUAL entry (persisted) — the user reads the آتی price off the IME
 *      header (cdn.ime.co.ir) and types it once; the app does the math.
 *
 * Everything is cached in AsyncStorage so the tab renders instantly.
 */

const CACHE_KEY = '@ime_futures_cache_v1';
const MANUAL_KEY = '@ime_manual_ime_entry_v1';
const CACHE_TTL = 10 * 60 * 1000; // 10 min
const REQUEST_TIMEOUT_MS = 12_000;

/** Karat conversion: 18k gold content vs the 995-fine raw bar. */
export const GOLD_PURITY_RATIO = 750 / 995;

export interface ImeGoldContract {
  /** Persian expiry label, e.g. «اسفند ۱۴۰۵». */
  expiry: string;
  /** Raw gold (995) price — TOMAN per gram. */
  price995Toman: number;
  /** (750/995) × price — the predicted 18k TOMAN per gram. */
  predicted18Toman: number;
  /** Last trade timestamp when known (epoch ms). */
  tradedAt?: number;
}

export interface ImeFuturesResult {
  source: 'ime-futures' | 'ime-trades' | 'tgju' | 'manual';
  contracts: ImeGoldContract[];
  latest?: ImeGoldContract;
  fetchedAt: number;
  /** TGJU coverage of the IME آتی market is sometimes stale — surface it. */
  staleNote?: string;
}

export interface ImeManualEntry {
  priceToman: number;
  expiry: string;
  setAt: number;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** "38,460,000" / 38460000 / "۳۸٬۴۶۰٬۰۰۰" → 38460000. */
function parsePersianNumber(v: unknown): number {
  const fa = '۰۱۲۳۴۵۶۷۸۹';
  let s = String(v ?? '');
  for (let i = 0; i < 10; i++) s = s.split(fa[i]).join(String(i));
  s = s.replace(/[,،٬\s]/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/** RIAL → TOMAN for IME-style quotes (IME quotes are rial per gram). */
function rialToToman(n: number): number {
  return n > 0 ? n / 10 : n;
}

async function fetchWithTimeout(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/html, */*',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

const prediction = (price995Toman: number): number =>
  Math.round(price995Toman * GOLD_PURITY_RATIO);

function makeContract(expiry: string, price995Toman: number, tradedAt?: number): ImeGoldContract {
  return { expiry, price995Toman, predicted18Toman: prediction(price995Toman), tradedAt };
}

/** Persian month name → month index (1=فروردین). 0 when unrecognized. */
const PERSIAN_MONTHS: Array<[string, number]> = [
  ['فروردین', 1], ['اردیبهشت', 2], ['خرداد', 3], ['تیر', 4], ['مرداد', 5],
  ['شهریور', 6], ['مهر', 7], ['آبان', 8], ['آذر', 9], ['دی', 10],
  ['بهمن', 11], ['اسفند', 12],
];

/** Extracts an expiry label like «اسفند ۱۴۰۵» from free contract text. */
function extractExpiry(text: string): string | null {
  const t = String(text ?? '');
  for (const [name, num] of PERSIAN_MONTHS) {
    if (!t.includes(name)) continue;
    const yearMatch = t.match(/۱۴(\d{2})/);
    const year = yearMatch ? `۱۴${yearMatch[1]}` : null;
    return year ? `${name} ${year}` : name;
  }
  // English/pattern fallback: "05" style month-year codes (e.g. mordad_05).
  return null;
}

/** A gold-bar row: name contains both «شمش» and «طلا» (خام optional). */
function isGoldBarRow(rowText: string): boolean {
  const t = String(rowText ?? '');
  return t.includes('شمش') && t.includes('طلا');
}

// ---------------------------------------------------------------------------
// layer 1 — IME futures endpoint probes (Iranian IP only)
// ---------------------------------------------------------------------------

interface RawRow {
  [k: string]: unknown;
}

function rowsFromJson(json: unknown): RawRow[] {
  if (Array.isArray(json)) return json as RawRow[];
  if (json && typeof json === 'object') {
    const rec = json as Record<string, unknown>;
    for (const key of ['Data', 'data', 'rows', 'list', 'contracts', 'result']) {
      if (Array.isArray(rec[key])) return rec[key] as RawRow[];
    }
  }
  return [];
}

/** Tolerant row → contract. priceKey/expiryKey candidates are tried in order. */
function rowToContract(row: RawRow): ImeGoldContract | null {
  const name =
    String(row.ContractName ?? row.Name ?? row.Title ?? row.Symbol ?? row.Description ?? '') +
    ' ' +
    String(row.Contract ?? row.CommodityName ?? '');
  if (!isGoldBarRow(name)) return null;

  const expiry =
    extractExpiry(String(row.Expiry ?? row.DeliveryDate ?? row.ContractName ?? row.Name ?? '')) ??
    extractExpiry(name);

  const priceRaw =
    row.SettlementPrice ?? row.ClosePrice ?? row.Price ?? row.LastPrice ?? row.FinalPrice ??
    row.TradePrice ?? row.Settle ?? row.Open ?? null;
  const priceRial = parsePersianNumber(priceRaw);
  if (priceRial <= 0) return null;

  const tradedAtStr = String(row.TradeDate ?? row.Date ?? row.LastTradeDate ?? '');
  const tradedAt = Date.parse(tradedAtStr.replace(/\/(\d)(?!\d)/g, '/0$1')) || undefined;

  const priceToman = rialToToman(priceRial);
  return makeContract(expiry ?? '—', priceToman, tradedAt);
}

async function probeImeFutures(): Promise<ImeGoldContract[]> {
  const urls = [
    'https://www.ime.co.ir/api/Futures/GetContracts',
    'https://www.ime.co.ir/api/futures',
    'https://cdn.ime.co.ir/api/futures',
    'https://dataapi.ime.co.ir/api/Futures/Contracts',
  ];
  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url, 8000);
      if (!res.ok) continue;
      const text = await res.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        continue; // HTML page — wrong endpoint
      }
      const contracts = rowsFromJson(json)
        .map(rowToContract)
        .filter((c): c is ImeGoldContract => c !== null);
      if (contracts.length > 0) return contracts;
    } catch {
      // timeout / geo-blocked / DNS — try the next pattern
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// layer 2 — IME dataapi CDCTrades (gold-bar trade history)
// ---------------------------------------------------------------------------

/**
 * CONFIRMED endpoint pattern (public GitHub collectors use it): POST with a
 * date window → {Data: [{CommodityID, TradeDate, Price, …}], TotalPages…}.
 * CommodityID 2 = GoldBar (شمش طلا). The latest gold-bar trade price is the
 * best on-device IME benchmark for the raw 995 gold price when the آتی
 * header itself can't be parsed.
 */
async function probeImeGoldBarTrades(): Promise<ImeGoldContract[]> {
  const url = 'https://dataapi.ime.co.ir/api/CDC/CDCTrades';
  const from = new Date(Date.now() - 7 * 86_400_000);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          fromDate: fmt(from),
          toDate: fmt(new Date()),
          pageNumber: 1,
          pageSize: 100,
        }),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return [];
    const body = (await res.json()) as { Data?: RawRow[] };
    const rows = Array.isArray(body?.Data) ? body.Data : [];
    // GoldBar CommodityID = 2; tolerate name-based matching too.
    const goldRows = rows.filter((r) => {
      const id = parsePersianNumber(r.CommodityID);
      const name = String(r.CommodityName ?? r.Commodity ?? '');
      return id === 2 || isGoldBarRow(name);
    });
    if (goldRows.length === 0) return [];
    // newest first by TradeDate
    goldRows.sort((a, b) =>
      String(b.TradeDate ?? '').localeCompare(String(a.TradeDate ?? ''))
    );
    const latest = goldRows[0];
    const priceRial = parsePersianNumber(
      latest.Price ?? latest.TradePrice ?? latest.ClosePrice ?? latest.SettlementPrice
    );
    if (priceRial <= 0) return [];
    const tradedAt = Date.parse(String(latest.TradeDate ?? '')) || Date.now();
    return [
      makeContract('آخرین معامله بازار نقدی IME', rialToToman(priceRial), tradedAt),
    ];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// layer 3 — TGJU fallback (ime_futures_shemsh_tala_* keys)
// ---------------------------------------------------------------------------

async function probeTgjuImeFutures(): Promise<ImeGoldContract[]> {
  const urls = [
    'https://call1.tgju.org/ajax.json',
    'https://call.tgju.org/ajax.json',
    'https://call2.tgju.org/ajax.json',
  ];
  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url, 12000);
      if (!res.ok) continue;
      const text = await res.text();
      const data = JSON.parse(text) as {
        current?: Record<string, { p?: string; ts?: string }>;
      };
      const cur = data?.current ?? {};
      const contracts: ImeGoldContract[] = [];
      for (const [key, entry] of Object.entries(cur)) {
        if (!key.startsWith('ime_futures_shemsh_tala_')) continue;
        const priceRial = parsePersianNumber(entry?.p);
        if (priceRial <= 0) continue;
        // key: ime_futures_shemsh_tala_{month_en}_{yy}
        const parts = key.split('_');
        const monthEn = parts[4] ?? '';
        const yy = parts[5] ?? '';
        const monthMap: Record<string, string> = {
          farvardin: 'فروردین', ordibehesht: 'اردیبهشت', khordad: 'خرداد',
          tir: 'تیر', mordad: 'مرداد', shahrivar: 'شهریور', mehr: 'مهر',
          aban: 'آبان', azar: 'آذر', dey: 'دی', bahman: 'بهمن', esfand: 'اسفند',
        };
        const faDigits = (s: string) =>
          s.split('').map((ch) => '۰۱۲۳۴۵۶۷۸۹'[Number(ch)] ?? ch).join('');
        const month = monthMap[monthEn] ?? monthEn;
        const year = yy ? `۱۴${faDigits(yy)}` : '';
        const tradedAt = entry?.ts ? Date.parse(entry.ts) || undefined : undefined;
        contracts.push(
          makeContract(year ? `${month} ${year}` : month, rialToToman(priceRial), tradedAt)
        );
      }
      if (contracts.length > 0) {
        contracts.sort((a, b) => (a.tradedAt ?? 0) - (b.tradedAt ?? 0));
        return contracts;
      }
    } catch {
      // next mirror
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// cache + public API
// ---------------------------------------------------------------------------

async function readCache(): Promise<ImeFuturesResult | null> {
  try {
    const stored = await AsyncStorage.getItem(CACHE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as ImeFuturesResult;
    if (!parsed?.contracts || Date.now() - parsed.fetchedAt > CACHE_TTL) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(result: ImeFuturesResult): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(result));
  } catch {}
}

/** Manual override — persists until the user clears it. */
export async function getImeManualEntry(): Promise<ImeManualEntry | null> {
  try {
    const stored = await AsyncStorage.getItem(MANUAL_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as ImeManualEntry;
    if (parsed && parsed.priceToman > 0 && parsed.expiry) return parsed;
  } catch {}
  return null;
}

export async function setImeManualEntry(entry: ImeManualEntry | null): Promise<void> {
  try {
    if (entry) await AsyncStorage.setItem(MANUAL_KEY, JSON.stringify(entry));
    else await AsyncStorage.removeItem(MANUAL_KEY);
  } catch {}
}

/**
 * The full fetch chain (manual entry takes priority). Throws only when
 * NOTHING is available — the UI then offers manual entry.
 */
export async function fetchImeFutures(force = false): Promise<ImeFuturesResult> {
  // manual override first
  const manual = await getImeManualEntry();
  if (manual) {
    return {
      source: 'manual',
      contracts: [makeContract(manual.expiry, manual.priceToman, manual.setAt)],
      latest: makeContract(manual.expiry, manual.priceToman, manual.setAt),
      fetchedAt: Date.now(),
    };
  }

  if (!force) {
    const cached = await readCache();
    if (cached) return cached;
  }

  // layer 1 — IME futures (Iranian IP)
  let contracts = await probeImeFutures();
  let source: ImeFuturesResult['source'] = 'ime-futures';
  let staleNote: string | undefined;

  // layer 2 — IME gold-bar trades
  if (contracts.length === 0) {
    contracts = await probeImeGoldBarTrades();
    source = 'ime-trades';
  }

  // layer 3 — TGJU (stale-marked)
  if (contracts.length === 0) {
    contracts = await probeTgjuImeFutures();
    source = 'tgju';
    const newestTrade = Math.max(...contracts.map((c) => c.tradedAt ?? 0), 0);
    if (newestTrade > 0 && Date.now() - newestTrade > 7 * 86_400_000) {
      const days = Math.round((Date.now() - newestTrade) / 86_400_000);
      staleNote = `آخرین داده ثبت‌شده ${days} روز پیش است — بازار آتی شمش در TGJU پوشش زنده ندارد؛ مقدار را دستی از cdn.ime.co.ir وارد کنید.`;
    }
  }

  if (contracts.length === 0) {
    throw new Error(
      'داده آتی IME در دسترس نبود — IME فقط با IP ایران پاسخ می‌دهد (فیلترشکن خاموش) یا قیمت را دستی وارد کنید.'
    );
  }

  contracts.sort((a, b) => a.predicted18Toman - b.predicted18Toman);
  const latest = contracts[contracts.length - 1];
  const result: ImeFuturesResult = { source, contracts, latest, fetchedAt: Date.now(), staleNote };
  await writeCache(result);
  return result;
}

/** (750 ÷ 995) × price — exposed for the UI's formula chip. */
export function predict18From995(price995Toman: number): number {
  return prediction(price995Toman);
}
