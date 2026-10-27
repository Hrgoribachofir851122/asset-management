/**
 * vpnGuard.ts — detects whether the phone's traffic currently exits from an
 * Iranian IP (VPN off) so the app can warn the user BEFORE their exchange
 * credentials/API keys touch blocked endpoints.
 *
 * Why it matters: Binance/Bybit/OKX/BitPerp (and Google's FCM servers) block
 * or geo-fence Iranian IPs. Connecting with the VPN off can trigger the
 * exchange's risk engine (451/418 responses, temporary API bans or — worst
 * case — account flags). One cheap country lookup up front prevents that.
 *
 * Detection = ask a tiny public geo-IP service where our request came from.
 * All endpoints are HTTPS, free, no API key, and reachable from Iran without
 * a VPN (they only ANSWER the question — they don't need to be unblocked).
 *
 * Result is cached briefly; every check has a short timeout and we try the
 * next provider on failure. 'unknown' never blocks anything — the banner is
 * only shown on a POSITIVE Iran match.
 *
 * v1.4.12 — the gate polls every 2 seconds (was 15). To survive that rate:
 *   • providers rotate round-robin (spread the load across all three)
 *   • forced checks share ONE in-flight promise (no request stacking)
 *   • per-provider timeout dropped 5s → 2.5s so a check fits one poll cycle
 *   • the non-forced cache is 3s (was 2min) so banners/other consumers
 *     follow a VPN toggle almost instantly without extra traffic.
 */

export type VpnStatus = 'vpn' | 'iran' | 'unknown';

interface GeoProvider {
  name: string;
  url: string;
  /** Extract the 2-letter country code; return null when the answer is unusable. */
  extract: (data: unknown) => string | null;
}

const PROVIDERS: GeoProvider[] = [
  {
    name: 'country.is',
    url: 'https://api.country.is/',
    extract: (d) => (typeof (d as { country?: unknown })?.country === 'string' ? (d as { country: string }).country : null),
  },
  {
    name: 'ipwho.is',
    url: 'https://ipwho.is/',
    extract: (d) => {
      const rec = d as { success?: boolean; country_code?: unknown };
      return rec?.success && typeof rec.country_code === 'string' ? rec.country_code : null;
    },
  },
  {
    name: 'ipapi.co',
    url: 'https://ipapi.co/json/',
    extract: (d) => (typeof (d as { country_code?: unknown })?.country_code === 'string' ? (d as { country_code: string }).country_code : null),
  },
];

let cache: { at: number; status: VpnStatus } | null = null;
const CACHE_MS = 3_000;

/** In-flight promise so parallel components share one check. */
let inflight: Promise<VpnStatus> | null = null;

/** v1.4.12 — round-robin index: each new check starts with the next provider. */
let providerCursor = 0;

/** v1.4.12 — short timeout so a check completes within one 2s poll cycle. */
const PROVIDER_TIMEOUT_MS = 2_500;

function providersInRotation(): GeoProvider[] {
  const n = PROVIDERS.length;
  const start = providerCursor % n;
  providerCursor = (providerCursor + 1) % n;
  return [...PROVIDERS.slice(start), ...PROVIDERS.slice(0, start)];
}

async function fetchWithTimeout(url: string, ms: number): Promise<unknown | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function checkOnce(): Promise<VpnStatus> {
  for (const p of providersInRotation()) {
    const data = await fetchWithTimeout(p.url, PROVIDER_TIMEOUT_MS);
    const country = data ? p.extract(data) : null;
    if (country) {
      return country.toUpperCase() === 'IR' ? 'iran' : 'vpn';
    }
  }
  return 'unknown';
}

/**
 * Current exit-IP status. 'iran' → the user's traffic is NOT going through a
 * VPN right now. 'vpn' → exit country is something else. 'unknown' → all
 * providers failed (rare) — treat as no-warning.
 */
export async function checkVpnStatus(force = false): Promise<VpnStatus> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) {
    return cache.status;
  }
  if (inflight) return inflight;
  inflight = checkOnce()
    .then((status) => {
      cache = { at: Date.now(), status };
      return status;
    })
    .catch(() => 'unknown' as const)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// ---------------------------------------------------------------------------
// v1.4.7 — full IP info (address + country) for the STARTUP gate screen
// («IP فعلی شما X، کشور Y»). Providers are the same as checkVpnStatus but
// here the raw answer (ip + country) is kept for display.
// ---------------------------------------------------------------------------

export interface IpInfo {
  status: VpnStatus;
  /** The public exit IPv4/IPv6 as the provider saw it. */
  ip?: string;
  /** 2-letter country code, uppercase (e.g. 'DE'). */
  country?: string;
  /** Persian country name for the common exit countries ('آلمان'…). */
  countryNameFa?: string;
}

const COUNTRY_FA: Record<string, string> = {
  IR: 'ایران',
  DE: 'آلمان',
  NL: 'هلند',
  US: 'آمریکا',
  GB: 'انگلستان',
  FR: 'فرانسه',
  TR: 'ترکیه',
  AE: 'امارات',
  SE: 'سوئد',
  FI: 'فنلاند',
  CH: 'سوئیس',
  CA: 'کانادا',
  AT: 'اتریش',
  LU: 'لوکزامبورگ',
  SG: 'سنگاپور',
  JP: 'ژاپن',
  RU: 'روسیه',
  KZ: 'قزاقستان',
};

/** v1.4.12 — in-flight promise for the FULL info check (forced path). */
let infoInflight: Promise<IpInfo> | null = null;

/** Reads the ip+country from the SAME providers used by checkVpnStatus. */
export async function getIpInfo(force = false): Promise<IpInfo> {
  if (!force) {
    const s = await checkVpnStatus();
    if (s !== 'unknown' && ipInfoCache && Date.now() - ipInfoCache.at < CACHE_MS) {
      return ipInfoCache.info;
    }
  }
  // Forced (2s gate poll): share one network round between overlapping ticks.
  if (infoInflight) return infoInflight;
  infoInflight = getIpInfoUncached()
    .catch(() => ({ status: 'unknown' }) as IpInfo)
    .finally(() => {
      infoInflight = null;
    });
  return infoInflight;
}

async function getIpInfoUncached(): Promise<IpInfo> {
  for (const p of providersInRotation()) {
    const data = (await fetchWithTimeout(p.url, PROVIDER_TIMEOUT_MS)) as Record<string, unknown> | null;
    if (!data) continue;
    const ip =
      typeof data.ip === 'string'
        ? data.ip
        : typeof (data as { query?: unknown }).query === 'string'
          ? (data as { query: string }).query
          : undefined;
    const country =
      p.extract(data) ?? (typeof data.country_code === 'string' ? (data.country_code as string) : undefined);
    if (country) {
      const code = country.toUpperCase();
      const info: IpInfo = {
        status: code === 'IR' ? 'iran' : 'vpn',
        ip,
        country: code,
        countryNameFa: COUNTRY_FA[code],
      };
      ipInfoCache = { at: Date.now(), info };
      cache = { at: Date.now(), status: info.status };
      return info;
    }
  }
  return { status: 'unknown' };
}

let ipInfoCache: { at: number; info: IpInfo } | null = null;

/**
 * The exchanges whose APIs are unreachable (or actively risky) from an
 * Iranian IP — used to decide whether the warning is relevant.
 */
const FOREIGN_EXCHANGE_IDS = new Set([
  'binance',
  'bybit',
  'okx',
  'kucoin',
  'toobit',
  'bingx',
  'mexc',
  'bitunix',
  'bitget',
  'gateio',
  'htx',
  'coinex',
  'xt',
  'lbank',
  'phemex',
  'superex',
  'bitmart',
  'kcex',
  'orbiter',
  'huobi',
  'bitperp',
]);

export function isForeignExchange(exchangeId: string): boolean {
  return FOREIGN_EXCHANGE_IDS.has(exchangeId);
}
