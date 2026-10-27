const HYPERLIQUID_API = 'https://api.hyperliquid.xyz/info';

export interface HyperliquidPosition {
  coin: string;
  szi: string;
  leverage: { type: string; value: number };
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  returnOnEquity: string;
  liquidationPx: string | null;
  marginUsed: string;
}

export interface HyperliquidAssetPosition {
  position: HyperliquidPosition;
  type: string;
}

export interface HyperliquidAccountState {
  marginSummary: {
    accountValue: string;
    totalNtlPos: string;
    totalRawUsd: string;
    totalMarginUsed: string;
  };
  crossMarginSummary: {
    accountValue: string;
    totalNtlPos: string;
    totalRawUsd: string;
    totalMarginUsed: string;
  };
  assetPositions: HyperliquidAssetPosition[];
}

export interface HyperliquidSpotBalance {
  coin: string;
  hold: string;
  total: string;
  entryNtl: string;
  token: number;
}

export interface HyperliquidSpotState {
  balances: HyperliquidSpotBalance[];
}

export interface HyperliquidFill {
  coin: string;
  px: string;
  sz: string;
  side: string;
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  tid: number;
  feeToken: string;
}

export interface ParsedPosition {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  currentPrice: number;
  size: number;
  positionValue: number;
  pnl: number;
  pnlPercent: number;
  leverage: number;
  liquidationPrice: number | null;
  marginUsed: number;
}

export interface ParsedSpotBalance {
  coin: string;
  total: number;
  hold: number;
  available: number;
  valueUsd: number;
}

export interface ParsedFill {
  id: string;
  coin: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  valueUsd: number;
  time: number;
  pnl: number;
  fee: number;
}

async function postHyperliquid(body: Record<string, unknown>): Promise<unknown> {
  console.log('[HyperliquidAPI] POST request:', JSON.stringify(body));
  const response = await fetch(HYPERLIQUID_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    console.log('[HyperliquidAPI] Error response:', text);
    throw new Error(`Hyperliquid API error: ${response.status}`);
  }
  const data = await response.json();
  console.log('[HyperliquidAPI] Response received');
  return data;
}

export async function fetchAllMids(): Promise<Record<string, string>> {
  const data = await postHyperliquid({ type: 'allMids' });
  return data as Record<string, string>;
}

export async function fetchAccountState(address: string): Promise<HyperliquidAccountState> {
  const data = await postHyperliquid({
    type: 'clearinghouseState',
    user: address,
  });
  console.log('[HyperliquidAPI] Account state for', address.slice(0, 8), ':', JSON.stringify(data).slice(0, 500));
  return data as HyperliquidAccountState;
}

export async function fetchSpotState(address: string): Promise<HyperliquidSpotState> {
  const data = await postHyperliquid({
    type: 'spotClearinghouseState',
    user: address,
  });
  console.log('[HyperliquidAPI] Spot state for', address.slice(0, 8));
  return data as HyperliquidSpotState;
}

export async function fetchUserFills(address: string): Promise<HyperliquidFill[]> {
  const data = await postHyperliquid({
    type: 'userFills',
    user: address,
  });
  const fills = data as HyperliquidFill[];
  console.log('[HyperliquidAPI] Fills count:', fills.length);
  return fills;
}

export async function parsePositions(
  accountState: HyperliquidAccountState,
  mids: Record<string, string>
): Promise<ParsedPosition[]> {
  const positions: ParsedPosition[] = [];

  for (const ap of accountState.assetPositions) {
    const pos = ap.position;
    const size = parseFloat(pos.szi);
    if (Math.abs(size) < 0.0000001) continue;

    const entryPrice = parseFloat(pos.entryPx);
    const currentPrice = parseFloat(mids[pos.coin] ?? pos.entryPx);
    const side: 'long' | 'short' = size > 0 ? 'long' : 'short';
    const absSize = Math.abs(size);
    const positionValue = absSize * currentPrice;
    const pnl = parseFloat(pos.unrealizedPnl);
    const roe = parseFloat(pos.returnOnEquity) * 100;
    const leverageVal = pos.leverage?.value ?? 1;

    positions.push({
      id: `hl-${pos.coin}-${side}`,
      symbol: `${pos.coin}/USD`,
      side,
      entryPrice,
      currentPrice,
      size: absSize,
      positionValue,
      pnl,
      pnlPercent: roe,
      leverage: leverageVal,
      liquidationPrice: pos.liquidationPx ? parseFloat(pos.liquidationPx) : null,
      marginUsed: parseFloat(pos.marginUsed),
    });
  }

  return positions;
}

export async function parseSpotBalances(
  spotState: HyperliquidSpotState,
  mids: Record<string, string>
): Promise<ParsedSpotBalance[]> {
  const balances: ParsedSpotBalance[] = [];

  for (const b of spotState.balances) {
    const total = parseFloat(b.total);
    const hold = parseFloat(b.hold);
    if (total < 0.0000001) continue;

    const price = b.coin === 'USDC' ? 1 : parseFloat(mids[b.coin] ?? '0');
    const valueUsd = total * price;

    balances.push({
      coin: b.coin,
      total,
      hold,
      available: total - hold,
      valueUsd,
    });
  }

  balances.sort((a, b) => b.valueUsd - a.valueUsd);
  return balances;
}

export async function parseFills(fills: HyperliquidFill[]): Promise<ParsedFill[]> {
  return fills.slice(0, 50).map((f) => ({
    id: `fill-${f.tid}`,
    coin: f.coin,
    side: f.side === 'B' ? 'buy' as const : 'sell' as const,
    price: parseFloat(f.px),
    size: parseFloat(f.sz),
    valueUsd: parseFloat(f.px) * parseFloat(f.sz),
    time: f.time,
    pnl: parseFloat(f.closedPnl),
    fee: parseFloat(f.fee),
  }));
}

export interface SpotTokenMeta {
  name: string;
  tokens: Array<{
    name: string;
    szDecimals: number;
    weiDecimals: number;
    index: number;
    tokenId: string;
    isCanonical: boolean;
    evmContract?: {
      address: string;
      chain: string;
    } | null;
    fullName?: string;
  }>;
}

export async function fetchSpotMeta(): Promise<SpotTokenMeta> {
  const data = await postHyperliquid({ type: 'spotMeta' });
  console.log('[HyperliquidAPI] Spot meta received');
  return data as SpotTokenMeta;
}

export function getContractAddress(
  spotMeta: SpotTokenMeta | null,
  coinName: string
): string {
  if (!spotMeta) return '';
  const token = spotMeta.tokens.find(
    (t) => t.name.toUpperCase() === coinName.toUpperCase()
  );
  if (token?.evmContract?.address) {
    return token.evmContract.address;
  }
  if (token?.tokenId) {
    return token.tokenId;
  }
  return '';
}

export async function fetchFullWalletData(address: string) {
  console.log('[HyperliquidAPI] Fetching full wallet data for:', address.slice(0, 8));

  const [accountState, spotState, fills, mids, spotMeta] = await Promise.all([
    fetchAccountState(address).catch((e) => {
      console.log('[HyperliquidAPI] Account state error:', e);
      return null;
    }),
    fetchSpotState(address).catch((e) => {
      console.log('[HyperliquidAPI] Spot state error:', e);
      return null;
    }),
    fetchUserFills(address).catch((e) => {
      console.log('[HyperliquidAPI] Fills error:', e);
      return [] as HyperliquidFill[];
    }),
    fetchAllMids().catch((e) => {
      console.log('[HyperliquidAPI] Mids error:', e);
      return {} as Record<string, string>;
    }),
    fetchSpotMeta().catch((e) => {
      console.log('[HyperliquidAPI] SpotMeta error:', e);
      return null as SpotTokenMeta | null;
    }),
  ]);

  const positions = accountState ? await parsePositions(accountState, mids) : [];
  const spotBalances = spotState ? await parseSpotBalances(spotState, mids) : [];
  const recentTrades = await parseFills(fills);

  const accountValue = accountState
    ? parseFloat(accountState.marginSummary.accountValue)
    : 0;
  const totalPnl = positions.reduce((sum, p) => sum + p.pnl, 0);
  const spotValue = spotBalances.reduce((sum, b) => sum + b.valueUsd, 0);

  return {
    positions,
    spotBalances,
    recentTrades,
    accountValue,
    totalPnl,
    spotValue,
    totalValue: accountValue + spotValue,
    spotMeta,
  };
}

// ---------------------------------------------------------------------------
// v1.4.19 — Whale PnL per timeframe (7/30/90/180 days)
// «برا نهنگها هم اضاف میکنم pnl در تایمهای مختلف اضاف کن بدون کاراییشون
//  چی بوده» — realized PnL from closed fills in the window + current
// unrealized PnL of open positions. One fills call + one accountState call.
// ---------------------------------------------------------------------------

export interface WhalePnlByPeriod {
  /** realized (closed) PnL of fills within the window, USD */
  realized: number;
  /** number of closed trades in the window */
  trades: number;
}

export interface WhalePnl {
  /** v1.5.12 — امروز (از ابتدای روزِ محلی). */
  d1: WhalePnlByPeriod;
  d7: WhalePnlByPeriod;
  d30: WhalePnlByPeriod;
  d90: WhalePnlByPeriod;
  d180: WhalePnlByPeriod;
  /** current unrealized PnL of open positions (USD) */
  unrealized: number;
  /** open position count */
  openPositions: number;
  /** account value (USD) */
  accountValue: number;
  fetchedAt: number;
}

const DAY_MS = 86_400_000;

export async function fetchWhalePnl(address: string): Promise<WhalePnl> {
  const [fills, accountState] = await Promise.all([
    fetchUserFills(address).catch(() => [] as HyperliquidFill[]),
    fetchAccountState(address).catch(() => null as HyperliquidAccountState | null),
  ]);

  const now = Date.now();
  // v1.5.12 — «امروز» = از ابتدای روزِ محلی (۰۰:۰۰)، نه ۲۴ ساعت اخیر.
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayStartMs = dayStart.getTime();
  const d1 = { realized: 0, trades: 0 };
  const acc: Record<number, { realized: number; trades: number }> = {
    7: { realized: 0, trades: 0 },
    30: { realized: 0, trades: 0 },
    90: { realized: 0, trades: 0 },
    180: { realized: 0, trades: 0 },
  };
  for (const f of fills) {
    const pnl = parseFloat(f.closedPnl ?? '0');
    if (!Number.isFinite(pnl) || pnl === 0) continue;
    if (f.time >= dayStartMs) {
      d1.realized += pnl;
      d1.trades += 1;
    }
    const ageDays = (now - f.time) / DAY_MS;
    for (const d of [7, 30, 90, 180] as const) {
      if (ageDays <= d) {
        acc[d].realized += pnl;
        acc[d].trades += 1;
      }
    }
  }

  const unrealized = accountState
    ? accountState.assetPositions.reduce((s, ap) => {
        const p = parseFloat(ap.position.unrealizedPnl ?? '0');
        return s + (Number.isFinite(p) ? p : 0);
      }, 0)
    : 0;
  const openPositions = accountState
    ? accountState.assetPositions.filter((ap) => Math.abs(parseFloat(ap.position.szi)) > 1e-7).length
    : 0;
  const accountValue = accountState
    ? parseFloat(accountState.marginSummary.accountValue ?? '0')
    : 0;

  return {
    d1,
    d7: acc[7],
    d30: acc[30],
    d90: acc[90],
    d180: acc[180],
    unrealized,
    openPositions,
    accountValue,
    fetchedAt: Date.now(),
  };
}
