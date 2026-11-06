/**
 * geoBlock.ts — v1.4.12 per-exchange sanctioned/geo-blocked IP detection.
 *
 * When a foreign exchange answers HTTP 451 (Unavailable For Legal Reasons),
 * 403 or 418, it almost always means the EXIT IP of the user's VPN is
 * geo-blocked for that exchange (sanctioned country / restricted region).
 * This is DIFFERENT from a bad API key and from the app-wide Iran gate:
 *
 *   • Iran gate (vpnGuard)      → phone traffic exits from Iran → ALL foreign
 *                                  exchanges are refused app-wide.
 *   • geoBlock (this module)    → VPN is on (non-Iran exit IP) but THIS ONE
 *                                  exchange rejects that country/IP → only
 *                                  this exchange should be disconnected.
 *
 * rawFetch() in foreignExchangeBalances/foreignExchangePnl records every
 * non-2xx geo-block status per API host; the public fetch entry-points then
 * convert the error into a SanctionedIpError so the wallet can show the
 * «این صرافی IP شما را تحریم کرده» card + dialog (disconnect THIS exchange
 * only, everything else stays connected).
 */

/** Marker prefix so the wallet can recognize the error cheaply. */
export const SANCTIONED_IP_MARKER = 'SANCTIONED_IP_BLOCKED';

/** How long a recorded geo-block stays "recent" (ms). */
const GEO_BLOCK_TTL_MS = 90_000;

/** HTTP statuses that mean "geo / legal block" for exchanges. */
const GEO_BLOCK_STATUSES = new Set([451, 403, 418]);

/** host → last time a geo-block status was seen for it. */
const geoBlockSeen = new Map<string, number>();

/** Record a response status for a URL (called from rawFetch). */
export function noteResponseStatus(status: number, url: string): void {
  if (!GEO_BLOCK_STATUSES.has(status)) return;
  try {
    const host = new URL(url).host;
    geoBlockSeen.set(host, Date.now());
  } catch {
    // relative/invalid URL — ignore
  }
}

/** Was a geo-block status seen for this host recently? */
function recentlyGeoBlocked(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return false;
  }
  const at = geoBlockSeen.get(host);
  return at !== undefined && Date.now() - at < GEO_BLOCK_TTL_MS;
}

/** A list of the API hosts each exchange talks to. */
const EXCHANGE_HOSTS: Record<string, string[]> = {
  mexc: ['api.mexc.com'],
  kucoin: ['api.kucoin.com'],
  bitget: ['api.bitget.com'],
  gateio: ['api.gateio.ws', 'api.gateio.io'],
  htx: ['api.huobi.pro', 'api.htx.com', 'www.htx.com', 'www.huobi.com'],
  toobit: ['api.toobit.com'],
  bingx: ['open-api.bingx.com', 'api.bingx.com'],
  bitmart: ['open-api.bitmart.com', 'api-cloud.bitmart.com'],
  superex: ['open-api.superex.com', 'api.superex.com'],
  coinex: ['api.coinex.com'],
  phemex: ['api.phemex.com', 'vapi.phemex.com'],
  lbank: ['api.lbank.info', 'api.lbkex.com', 'www.lbkex.com'],
  xt: ['sapi.xt.com', 'fapi.xt.com'],
  bitunix: ['api.bitunix.com'],
  kcex: ['api.kcex.com', 'www.kcex.com'],
  orbiter: [],
};

/** Error thrown when the exchange geo-blocked the current exit IP. */
export class SanctionedIpError extends Error {
  readonly exchangeId: string;
  constructor(exchangeId: string, exchangeName: string) {
    super(
      `${SANCTIONED_IP_MARKER}|صرافی ${exchangeName} این IP را تحریم کرده — ` +
        `IP خروجی فیلترشکن شما توسط این صرافی بلاک جغرافیایی شده (کشور تحریمی/محدود). ` +
        `به یک IP غیرتحریمی (کشور دیگر) وصل شوید و دوباره تلاش کنید. ` +
        `بقیه صرافی‌ها در همین حالت کار خود را ادامه می‌دهند.`
    );
    this.name = 'SanctionedIpError';
    this.exchangeId = exchangeId;
  }
}

/** Cheap check used by the wallet UI. */
export function isSanctionedIpMessage(message: string | undefined): boolean {
  return !!message && message.startsWith(SANCTIONED_IP_MARKER);
}

/** Human-readable text (strips the marker). */
export function sanctionedIpText(message: string): string {
  return message.startsWith(SANCTIONED_IP_MARKER + '|')
    ? message.slice(SANCTIONED_IP_MARKER.length + 1)
    : message;
}

/**
 * Did THIS exchange just answer with a geo-block status? Call after a
 * fetcher failed — converts the (often vague) error into SanctionedIpError.
 */
export function geoBlockErrorFor(
  exchangeId: string,
  exchangeName: string
): SanctionedIpError | null {
  const hosts = EXCHANGE_HOSTS[exchangeId];
  if (!hosts || hosts.length === 0) return null;
  for (const h of hosts) {
    if (recentlyGeoBlocked(`https://${h}/`)) {
      return new SanctionedIpError(exchangeId, exchangeName);
    }
  }
  return null;
}
