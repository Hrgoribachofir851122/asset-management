/**
 * blockchainWalletApi.ts — v1.4.17
 *
 * Keyless read-only balance fetching for the «کیف پول بلاکچین» 4th tab.
 * ONE wallet = one address tracked on MANY networks (v1.4.17).
 * EVERY source below was live-verified before implementation
 * (scripts/live-test-v1417*.mjs — 5 rounds, ~90 endpoint checks).
 *
 *  EVM (29 chains — one 0x address):
 *    - Primary: Blockscout API v2 where available (full ERC-20 discovery +
 *      per-token USD exchange_rate; browser User-Agent REQUIRED).
 *    - Universal fallback/extension: Multicall3 (0xcA11bde…, selector
 *      0x82ad56cb — verified against ethers' ABI encoder) probing a token
 *      REGISTRY built from CoinGecko's coins/list?include_platform=true
 *      (~4.5k BSC / 6k ETH contracts) + Trust Wallet tokenlists + curated
 *      extras — filtered to Binance-listed coins so every Binance currency
 *      on that network is probed (root fix of «FLAN ارز نمایش داده
 *      نمی‌شود»): SHIB / FLOKI / CTSI / FET / APE / TOSHI / SONIC / NIR …
 *    - Prices: Binance spot → Binance FUTURES (POPCAT fix) → CoinGecko
 *      simple/token_price (by contract) → stable=$1 → «قیمت نامشخص» (row
 *      stays visible — never dropped for missing price).
 *
 *  Independent networks (each with its own keyless reader):
 *    Tron (TronGrid), Solana (RPC + Jupiter + DexScreener), TON (tonapi.io
 *    + toncenter — Tonkeeper addresses), Bitcoin (mempool.space), Filecoin
 *    (glif StateGetActor/StateLookupID + FEVM), Litecoin, Dogecoin, BCH,
 *    XRP (xrpl), Cardano (koios), Polkadot (state_getStorage + BLAKE2b key
 *    derivation), Cosmos (publicnode REST), Near (view_account + FT),
 *    Aptos (resources), Sui (GraphQL), Stellar (horizon), Algorand
 *    (algonode), Tezos (tzkt), MultiversX, Hedera (mirror), Zilliqa (JSON
 *    RPC), VeChain (veblocks), Kaspa.
 *
 * PnL v1.4.17: per-wallet AND per-token market-change PnL over
 * ۷/۳۰/۹۰/۱۸۰ days — Binance klines for Binance coins, CoinGecko
 * market_chart for the rest.
 */

import {
  addressForNetwork,
  BlockchainNetwork,
  BlockchainTokenBalance,
  BlockchainWallet,
  BlockchainWalletData,
  CURATED_TRC20,
  NETWORKS,
  Trc20Token,
  isEvmNetwork,
  polkadotStorageKey,
  ss58Decode,
  tronHexAddress,
  zilliqaBase16,
  writeBlockchainBalanceCache,
} from './blockchainWallets';
import { STATIC_REGISTRY } from './tokenRegistry';
import { getServerUrl } from './scanServerApi';

const UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';

const TIMEOUT_MS = 20_000;

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json', ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function postJson<T>(url: string, body: unknown, timeoutMs = TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function hexToNumber(hex: string): number {
  if (!hex || hex === '0x') return 0;
  const n = parseInt(hex, 16);
  return Number.isFinite(n) ? n : 0;
}

/** "0x…" hex or decimal string → number (lossy ok for balances we display). */
function bigStrToNumber(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  const s = String(raw);
  if (s.startsWith('0x') || s.startsWith('0X')) return hexToNumber(s);
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// v1.4.17 — Binance price system: SPOT + FUTURES tickers in one map.
// POPCAT (futures-only) and every other futures-only coin now get prices.
// The map also seeds the "Binance coin set" used to filter the probe
// registry (user: «همه ارزهای بایننس روی همان شبکه‌ها»).
// ---------------------------------------------------------------------------

const BINANCE_SPOT_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
const BINANCE_FAPI_HOST = 'https://fapi.binance.com';

export interface BinancePriceEntry {
  price: number;
  chg: number | null;
  /** spot (preferred) or futures */
  src: 'spot' | 'futures';
}

interface BinanceTicker24 {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
}

let allTickerCache: {
  at: number;
  bySymbol: Record<string, BinancePriceEntry>;
  coins: Set<string>;
} | null = null;

const ALL_TICKERS_TTL = 60_000;

/** Coins to ignore (leveraged tokens). */
function isLeveraged(symbol: string): boolean {
  return /(UP|DOWN|BULL|BEAR)USDT$/.test(symbol);
}

/**
 * Fetches ALL spot + futures USDT tickers ONCE (60s cache) →
 * { 'ETHUSDT': {price, chg}, … } + the Binance coin set.
 */
export async function getBinancePriceMap(): Promise<{
  bySymbol: Record<string, BinancePriceEntry>;
  coins: Set<string>;
}> {
  if (allTickerCache && Date.now() - allTickerCache.at < ALL_TICKERS_TTL) {
    return { bySymbol: allTickerCache.bySymbol, coins: allTickerCache.coins };
  }
  const bySymbol: Record<string, BinancePriceEntry> = {};
  const coins = new Set<string>();

  // spot
  let spotOk = false;
  for (const host of BINANCE_SPOT_HOSTS) {
    try {
      const data = await fetchJson<BinanceTicker24[]>(`${host}/api/v3/ticker/24hr`, undefined);
      if (!Array.isArray(data)) continue;
      for (const t of data) {
        if (!t.symbol.endsWith('USDT') || isLeveraged(t.symbol)) continue;
        const price = parseFloat(t.lastPrice);
        const chg = parseFloat(t.priceChangePercent);
        if (!Number.isFinite(price)) continue;
        bySymbol[t.symbol] = {
          price,
          chg: Number.isFinite(chg) ? chg : null,
          src: 'spot',
        };
        coins.add(t.symbol.slice(0, -4));
      }
      spotOk = true;
      break;
    } catch {}
  }

  // futures (fills gaps like POPCAT + adds futures-only coins)
  try {
    const f = await fetchJson<BinanceTicker24[]>(`${BINANCE_FAPI_HOST}/fapi/v1/ticker/24hr`);
    if (Array.isArray(f)) {
      for (const t of f) {
        if (!t.symbol.endsWith('USDT') || isLeveraged(t.symbol)) continue;
        const price = parseFloat(t.lastPrice);
        const chg = parseFloat(t.priceChangePercent);
        if (!Number.isFinite(price)) continue;
        const coin = t.symbol.slice(0, -4);
        coins.add(coin);
        if (!bySymbol[t.symbol]) {
          bySymbol[t.symbol] = {
            price,
            chg: Number.isFinite(chg) ? chg : null,
            src: 'futures',
          };
        }
      }
    }
  } catch {}

  const fresh = { at: Date.now(), bySymbol, coins };
  allTickerCache = fresh;
  return { bySymbol, coins };
}

/** Symbol → Binance pair guess (ETH → ETHUSDT). */
function binancePairFor(symbol: string): string | undefined {
  const s = symbol.toUpperCase();
  if (['USDT', 'USDC', 'DAI', 'TUSD', 'FDUSD', 'BUSD', 'USDD', 'PYUSD', 'USDC.E'].includes(s)) {
    return undefined; // stables are $1
  }
  if (['POL', 'MATIC'].includes(s)) return 'POLUSDT';
  if (s === 'WBTC') return 'BTCUSDT';
  if (s === 'WETH' || s === 'WBETH' || s === 'RETH' || s === 'STETH' || s === 'WSTETH') return 'ETHUSDT';
  if (s === 'WSOL') return 'SOLUSDT';
  if (s === 'MULTI') return 'MULTIUSDT';
  return `${s}USDT`;
}

const STABLE_SYMBOLS = [
  'USDT', 'USDC', 'DAI', 'USDD', 'USDC.E', 'TUSD', 'FDUSD', 'BUSD',
  'PYUSD', 'USDT.E', 'USDCB', 'FDUSD',
];

function isStableSymbol(symbol: string): boolean {
  return STABLE_SYMBOLS.includes(symbol.toUpperCase());
}

// ---------------------------------------------------------------------------
// v1.4.17 — Token REGISTRY: CoinGecko coins/list?include_platform=true
// (~3.8MB, 24h in-memory cache) + Trust Wallet tokenlists + curated extras.
// Only contracts whose symbol is Binance-listed (or in TW/curated) are
// probed — full coverage of real coins without thousands of spam probes.
// ---------------------------------------------------------------------------

export interface RegistryToken {
  symbol: string;
  name: string;
  contract: string;
  decimals: number;
  cgId?: string;
}

interface CgCoin {
  id: string;
  symbol: string;
  name: string;
  platforms: Record<string, string>;
}

let registryCache: {
  at: number;
  byChain: Partial<Record<BlockchainNetwork, RegistryToken[]>>;
} = { at: 0, byChain: {} };

const REGISTRY_TTL = 24 * 3600_000;
/** Max tokens probed per chain per refresh (cap API cost). */
const REGISTRY_PROBE_CAP = 900;

let cgCoinsCache: { at: number; coins: CgCoin[] | null } | null = null;

async function fetchCgCoins(): Promise<CgCoin[] | null> {
  // the coins/list download is ~3.8MB — at most once per 24h
  if (cgCoinsCache && Date.now() - cgCoinsCache.at < REGISTRY_TTL) return cgCoinsCache.coins;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch('https://api.coingecko.com/api/v3/coins/list?include_platform=true', {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const coins = (await res.json()) as CgCoin[];
      cgCoinsCache = { at: Date.now(), coins };
      return coins;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    if (cgCoinsCache) return cgCoinsCache.coins;
    return null;
  }
}

interface TwToken {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  extensions?: { coingeckoId?: string };
}

async function fetchTwTokenlist(dir: string): Promise<TwToken[] | null> {
  try {
    const d = await fetchJson<{ tokens: TwToken[] }>(
      `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${dir}/tokenlist.json`
    );
    return Array.isArray(d?.tokens) ? d.tokens : null;
  } catch {
    return null;
  }
}

/** Build (and cache for 24h) the per-chain probe registry. */
async function getTokenRegistry(network: BlockchainNetwork): Promise<RegistryToken[]> {
  const cached = registryCache.byChain[network];
  if (cached && Date.now() - registryCache.at < REGISTRY_TTL) return cached;

  const meta = NETWORKS[network];
  const [cg, tw, { coins }] = await Promise.all([
    fetchCgCoins(),
    meta.twList ? fetchTwTokenlist(meta.twList) : Promise.resolve(null),
    getBinancePriceMap(),
  ]);

  const byContract = new Map<string, RegistryToken>();
  const add = (t: RegistryToken) => {
    const key = t.contract.toLowerCase();
    if (!byContract.has(key)) byContract.set(key, t);
  };

  // 0) v1.4.19 — STATIC baked registry FIRST (zero network! covers every
  // Binance coin on every chain incl. the Binance-peg DOGE/ZIL/VET/SAND/
  // PHA/FLOKI that neither TW lists nor a reachable-from-Iran CoinGecko
  // download provides). Runtime sources below only ADD contracts.
  for (const t of STATIC_REGISTRY[network] ?? []) {
    add({
      symbol: t.s.toUpperCase(),
      name: t.n ?? t.s,
      contract: t.c,
      decimals: Number.isFinite(t.d) ? t.d : 18,
      cgId: t.g,
    });
  }

  // 1) Trust Wallet list (trusted contracts, always probed)
  if (tw) {
    for (const t of tw) {
      if (!t.address || !/^0x[0-9a-fA-F]{40}$/.test(t.address)) continue;
      add({
        symbol: t.symbol.toUpperCase(),
        name: t.name,
        contract: t.address,
        decimals: Number.isFinite(t.decimals) ? t.decimals : 18,
        cgId: t.extensions?.coingeckoId,
      });
    }
  }

  // 2) CoinGecko contracts — filtered to Binance coins + already-known symbols
  if (cg && meta.cgPlatform) {
    let added = 0;
    for (const coin of cg) {
      if (added >= REGISTRY_PROBE_CAP) break;
      const contract = coin.platforms?.[meta.cgPlatform];
      if (!contract || !/^0x[0-9a-fA-F]{40}$/.test(contract)) continue;
      const sym = (coin.symbol ?? '').toUpperCase();
      if (!sym || sym.length > 16) continue;
      // probe only real coins: Binance-listed OR already in the trusted list
      if (!coins.has(sym) && !byContract.has(contract.toLowerCase())) continue;
      add({ symbol: sym, name: coin.name, contract, decimals: 18, cgId: coin.id });
      added++;
    }
  }

  const list = [...byContract.values()];
  registryCache.byChain[network] = list;
  if (!registryCache.at) registryCache.at = Date.now();
  return list;
}

// ---------------------------------------------------------------------------
// v1.4.17 — Multicall3 aggregate3 (VERIFIED against ethers' encoder live on
// BSC/Polygon/Base/etc. — selector 0x82ad56cb, two-level offset tables).
// ---------------------------------------------------------------------------

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const BALANCE_OF_SELECTOR = '0x70a08231';

const WORD = (hexOrNum: string | number, len = 64): string => {
  const s = typeof hexOrNum === 'string' ? hexOrNum.replace(/^0x/i, '').toLowerCase() : hexOrNum.toString(16);
  return s.padStart(len, '0');
};

interface Mc3Call {
  target: string;
  data: string;
}

function encodeAggregate3(calls: Mc3Call[]): string {
  const n = calls.length;
  const headLen = 96;
  const elems = calls.map((c) => {
    const dataNo0x = c.data.replace(/^0x/i, '').toLowerCase();
    const dataLen = dataNo0x.length / 2;
    const paddedWords = Math.ceil(dataLen / 32);
    return { dataNo0x, dataLen, size: headLen + 32 + paddedWords * 32 };
  });
  let out = '0x82ad56cb';
  out += WORD('20'); // offset to array
  out += WORD(n);
  let cur = n * 32;
  for (const e of elems) {
    out += WORD(cur);
    cur += e.size;
  }
  calls.forEach((c, i) => {
    const e = elems[i];
    out += WORD(c.target.replace(/^0x/i, ''));
    out += '0'.repeat(64); // allowFailure = false
    out += WORD('60'); // offset to callData relative to element start
    out += WORD(e.dataLen);
    out += e.dataNo0x.padEnd(Math.ceil(e.dataLen / 32) * 64, '0');
  });
  return out;
}

function decodeAggregate3Result(hex: string): { success: boolean; data: string }[] {
  const h = hex.replace(/^0x/i, '').toLowerCase();
  const word = (i: number) => h.slice(i * 64, i * 64 + 64);
  const arrLenWordIdx = parseInt(word(0), 16) / 32;
  const n = parseInt(word(arrLenWordIdx), 16);
  const out: { success: boolean; data: string }[] = [];
  for (let k = 0; k < n; k++) {
    const elemOffBytes = parseInt(word(arrLenWordIdx + 1 + k), 16);
    if (!Number.isFinite(elemOffBytes)) continue;
    const elemWord = arrLenWordIdx + 1 + elemOffBytes / 32;
    const success = word(elemWord) === '0'.repeat(63) + '1';
    const dataOffBytes = parseInt(word(elemWord + 1), 16);
    const lenWord = elemWord + dataOffBytes / 32;
    const len = parseInt(word(lenWord), 16);
    const data = h.slice((lenWord + 1) * 64, (lenWord + 1) * 64 + len * 2);
    out.push({ success, data: '0x' + data });
  }
  return out;
}

async function rpcCall<T>(urls: string[], method: string, params: unknown[], timeoutMs = TIMEOUT_MS): Promise<T> {
  let lastErr: unknown = null;
  for (const url of urls) {
    try {
      const d = await postJson<{ result?: T; error?: { message: string } }>(url, {
        jsonrpc: '2.0',
        id: 1,
        method,
        params,
      }, timeoutMs);
      if (d.error) throw new Error(d.error.message);
      return d.result as T;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('RPC ناموفق');
}

/**
 * balanceOf for many ERC-20s in a handful of eth_calls (batches of 120).
 * Returns contract(lowercase) → raw bigint (only > 0 entries included).
 */
async function multicallBalances(
  rpcs: string[],
  wallet: string,
  contracts: { contract: string; decimals: number }[]
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  const BATCH = 120;
  const ownerPadded = WORD(wallet.slice(2));
  for (let i = 0; i < contracts.length; i += BATCH) {
    const batch = contracts.slice(i, i + BATCH);
    try {
      const raw = await rpcCall<string>(rpcs, 'eth_call', [
        { to: MULTICALL3, data: encodeAggregate3(batch.map((b) => ({ target: b.contract, data: BALANCE_OF_SELECTOR + ownerPadded }))) },
        'latest',
      ]);
      if (!raw || raw === '0x') continue;
      const decoded = decodeAggregate3Result(raw);
      decoded.forEach((r, k) => {
        if (!r.success || !r.data || r.data === '0x') return;
        try {
          const v = BigInt(r.data);
          if (v > 0n) out.set(batch[k].contract.toLowerCase(), v);
        } catch {}
      });
    } catch {
      // one failed batch must not kill the whole discovery
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CoinGecko price by contract (batch) — for tokens with no Binance listing
// ---------------------------------------------------------------------------

const cgPriceCache = new Map<string, { at: number; price: number; chg: number | null; id?: string }>();
const CG_PRICE_TTL = 120_000;

async function cgTokenPrices(
  platform: string,
  contracts: string[]
): Promise<Map<string, { price: number; chg: number | null; id: string }>> {
  const out = new Map<string, { price: number; chg: number | null; id: string }>();
  if (contracts.length === 0) return out;
  const now = Date.now();
  const missing: string[] = [];
  for (const c of contracts) {
    const hit = cgPriceCache.get(`${platform}:${c.toLowerCase()}`);
    if (hit && now - hit.at < CG_PRICE_TTL) {
      if (hit.price > 0) out.set(c.toLowerCase(), { price: hit.price, chg: hit.chg, id: hit.id ?? '' });
    } else {
      missing.push(c);
    }
  }
  if (missing.length === 0) return out;
  // batches of 60 contracts
  for (let i = 0; i < missing.length; i += 60) {
    const part = missing.slice(i, i + 60);
    try {
      const url =
        `https://api.coingecko.com/api/v3/simple/token_price/${platform}` +
        `?contract_addresses=${part.join(',')}&vs_currencies=usd&include_24hr_change=true`;
      const d = await fetchJson<Record<string, { usd?: number; usd_24h_change?: number }>>(url);
      for (const [contract, v] of Object.entries(d ?? {})) {
        const price = Number(v?.usd);
        if (!Number.isFinite(price) || price <= 0) continue;
        const chg = Number(v?.usd_24h_change);
        const entry = {
          at: now,
          price,
          chg: Number.isFinite(chg) ? chg : null,
        };
        cgPriceCache.set(`${platform}:${contract.toLowerCase()}`, entry);
        out.set(contract.toLowerCase(), { price, chg: entry.chg, id: '' });
      }
    } catch {}
  }
  return out;
}

// ---------------------------------------------------------------------------
// EVM balances — Blockscout primary + registry/Multicall3 universal path
// ---------------------------------------------------------------------------

interface BsToken {
  token: {
    address_hash: string;
    symbol: string | null;
    name: string | null;
    decimals: string | null;
    exchange_rate: string | null;
    type: string | null;
  } | null;
  value: string | null;
}

interface BsAddress {
  coin_balance: string | null;
  exchange_rate: string | null;
}

/** v1.4.16 fallback set (kept — famous verified contracts per chain). */
const FALLBACK_EVM_TOKENS: Partial<Record<BlockchainNetwork, { symbol: string; name: string; contract: string; decimals: number }[]>> = {
  ethereum: [
    { symbol: 'USDT', name: 'Tether USD', contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    { symbol: 'USDC', name: 'USD Coin', contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    { symbol: 'DAI', name: 'Dai Stablecoin', contract: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
    { symbol: 'LINK', name: 'Chainlink', contract: '0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals: 18 },
    { symbol: 'SHIB', name: 'Shiba Inu', contract: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', decimals: 18 },
    { symbol: 'PEPE', name: 'Pepe', contract: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', decimals: 18 },
    { symbol: 'UNI', name: 'Uniswap', contract: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals: 18 },
    { symbol: 'WBTC', name: 'Wrapped BTC', contract: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 },
  ],
  bsc: [
    { symbol: 'USDT', name: 'Tether USD (BSC)', contract: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    { symbol: 'USDC', name: 'USD Coin (BSC)', contract: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
    { symbol: 'CAKE', name: 'PancakeSwap (BSC)', contract: '0x0E09FaBB73BD3aDE0a17ECC321fD13a19e81cE82', decimals: 18 },
    { symbol: 'ETH', name: 'Ethereum (Pegged)', contract: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', decimals: 18 },
    { symbol: 'BTCB', name: 'Bitcoin (Pegged)', contract: '0x7130d2A12B9BCBFAe4f2634d864A1Ee1Ce3Ead9c', decimals: 18 },
    { symbol: 'SHIB', name: 'Shiba Inu (BSC)', contract: '0x2859E4544C4aBb03966803b044A93563Bd2D0DD4', decimals: 18 },
    // v1.4.19 — FLOKI official BEP-20 (verified via PancakeSwap list +
    // on-chain symbol(); the old address here was a lookalike typo).
    { symbol: 'FLOKI', name: 'Floki (BSC)', contract: '0xfb5B838b6cfEEdC2873aB27866079AC55363D37E', decimals: 9 },
    { symbol: 'DOGE', name: 'Dogecoin (Binance-peg)', contract: '0xba2aE424d960c26247Dd6c32edC70B295c744C43', decimals: 8 },
    { symbol: 'ZIL', name: 'Zilliqa (Binance-peg)', contract: '0xb86AbCb37C3A4B64f74F59301AFF131a1BEcC787', decimals: 12 },
    { symbol: 'VET', name: 'VeChain (Binance-peg)', contract: '0x6FDcdfef7c496407cCb0cEC90f9C5Aaa1Cc8D888', decimals: 18 },
    { symbol: 'SAND', name: 'The Sandbox (Binance-peg)', contract: '0x67b725d7e342d7B611fa85e859Df9697D9378B2e', decimals: 18 },
    { symbol: 'PHA', name: 'Phala (Binance-peg)', contract: '0x0112e557d400474717056C4e6D40eDD846F38351', decimals: 18 },
  ],
  polygon: [
    { symbol: 'USDC', name: 'USD Coin', contract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
    { symbol: 'USDC.e', name: 'USD Coin (bridged)', contract: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', decimals: 6 },
    { symbol: 'USDT', name: 'Tether USD (Polygon)', contract: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
  ],
  arbitrum: [
    { symbol: 'USDC', name: 'USD Coin', contract: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    { symbol: 'USDT', name: 'Tether USD (Arbitrum)', contract: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
  ],
  base: [
    { symbol: 'USDC', name: 'USD Coin', contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    { symbol: 'TOSHI', name: 'Toshi (Base)', contract: '0x2f5dbf70521b4bc5ec81be0aac36f1e7a0e7c1ac', decimals: 9 },
  ],
  avalanche: [
    { symbol: 'USDT', name: 'Tether USD (Avalanche)', contract: '0x9702230A8Ea53601f5cD2dc00fDBc13d4d449Faf', decimals: 6 },
    { symbol: 'USDC.e', name: 'USD Coin (bridged)', contract: '0xA7D7079b0FEaD0F8028A7f440910011d9cF1aF0e', decimals: 6 },
    { symbol: 'JOE', name: 'Trader Joe', contract: '0x6e84a6216eA6dACC71eE8E6b0a5B7A47B5A6786E', decimals: 18 },
  ],
  sonic: [
    { symbol: 'S', name: 'Sonic (native bridged)', contract: '0x039e2fB6610e3298d0c1c252705555530e46752c', decimals: 18 },
    { symbol: 'wS', name: 'Wrapped Sonic', contract: '0x549A6e4821e5b0BbE3A8f7f26bF4467A86f61D9D', decimals: 18 },
  ],
};

/** Internal row with the token contract attached (for CoinGecko price fills). */
interface EvmTokenRow extends BlockchainTokenBalance {
  contract?: string;
}

async function fetchEvmBalances(
  network: BlockchainNetwork,
  address: string
): Promise<BlockchainTokenBalance[]> {
  const meta = NETWORKS[network];
  const tokens: EvmTokenRow[] = [];
  let nativeQty = 0;
  let nativePrice = 0;
  let discoveredAny = false;

  // ── primary: Blockscout (full ERC-20 discovery + USD rates) ──
  if (meta.blockscout) {
    try {
      const addr = await fetchJson<BsAddress>(
        `${meta.blockscout}/api/v2/addresses/${address}`
      );
      nativeQty = bigStrToNumber(addr.coin_balance) / 1e18;
      nativePrice = parseFloat(addr.exchange_rate ?? '') || 0;
      const list = await fetchJson<BsToken[]>(
        `${meta.blockscout}/api/v2/addresses/${address}/token-balances`
      );
      for (const t of list) {
        if (!t.token || t.token.type !== 'ERC-20' || !t.value) continue;
        const qty = bigStrToNumber(t.value) / Math.pow(10, bigStrToNumber(t.token.decimals));
        if (!(qty > 0)) continue;
        let price = parseFloat(t.token.exchange_rate ?? '') || 0;
        // v1.4.17 — blockscout's rate is UNRELIABLE for illiquid/spam tokens
        // (a fake trillion-dollar row was observed in testing). A personal
        // wallet never holds > $1T of one token — treat as unknown price.
        if (qty * price > 1e12) price = 0;
        const symbol = (t.token.symbol ?? '?').toUpperCase();
        tokens.push({
          symbol,
          name: t.token.name ?? symbol,
          kind: 'token' as const,
          qty,
          priceUsd: price,
          change24hPct: null,
          valueUsd: qty * price,
          binancePair: binancePairFor(symbol),
          network,
          contract: t.token.address_hash?.toLowerCase(),
        });
      }
      discoveredAny = true;
    } catch {
      discoveredAny = false;
    }
  }

  // ── universal: registry + Multicall3 (ALSO runs when Blockscout gave
  // nothing, or on chains without a Blockscout — BSC/AVAX/Fantom/…).
  // This is the v1.4.17 root fix for «X ارز نمایش داده نمی‌شود».
  {
    let registry = await getTokenRegistry(network).catch(() => [] as RegistryToken[]);
    if (registry.length === 0) {
      // last-resort curated set (tiny but famous contracts)
      registry = (FALLBACK_EVM_TOKENS[network] ?? []).map((t) => ({
        symbol: t.symbol,
        name: t.name,
        contract: t.contract,
        decimals: t.decimals,
      }));
    }
    if (registry.length > 0) {
      const foundRaw = await multicallBalances(meta.rpcs, address, registry).catch(
        () => new Map<string, bigint>()
      );
      const foundContracts: { token: RegistryToken; raw: bigint }[] = [];
      for (const t of registry) {
        const raw = foundRaw.get(t.contract.toLowerCase());
        if (raw) foundContracts.push({ token: t, raw });
      }
      // CG prices by contract for the found tokens (fills non-Binance coins)
      let cgPrices = new Map<string, { price: number; chg: number | null; id: string }>();
      if (foundContracts.length > 0 && meta.cgPlatform) {
        cgPrices = await cgTokenPrices(
          meta.cgPlatform,
          foundContracts.map((f) => f.token.contract)
        ).catch(() => new Map<string, { price: number; chg: number | null; id: string }>());
      }
      for (const f of foundContracts) {
        const sym = f.token.symbol.toUpperCase();
        const qty = Number(f.raw) / Math.pow(10, f.token.decimals ?? 18);
        if (!(qty > 0)) continue;
        const cg = cgPrices.get(f.token.contract.toLowerCase());
        tokens.push({
          symbol: sym,
          name: f.token.name ?? sym,
          kind: 'token' as const,
          qty,
          priceUsd: cg?.price ?? 0,
          change24hPct: cg?.chg ?? null,
          valueUsd: cg ? qty * cg.price : 0,
          binancePair: binancePairFor(sym),
          coingeckoId: f.token.cgId ?? (cg?.id || undefined),
          network,
          contract: f.token.contract.toLowerCase(),
        });
      }
    }

    // native balance via RPC (covers no-Blockscout chains + cross-check)
    if (!discoveredAny || nativeQty <= 0) {
      try {
        nativeQty =
          bigStrToNumber(
            await rpcCall<string>(meta.rpcs, 'eth_getBalance', [address, 'latest'])
          ) / 1e18;
      } catch {}
    }
  }

  if (nativeQty > 0) {
    tokens.unshift({
      symbol: meta.native,
      name: `${meta.label} — ${meta.native}`,
      kind: 'native' as const,
      qty: nativeQty,
      priceUsd: nativePrice,
      change24hPct: null,
      valueUsd: nativeQty * nativePrice,
      binancePair: binancePairFor(meta.native),
      network,
    });
  }

  // Fill missing prices: Binance spot → Binance futures → CoinGecko by
  // contract → stable=$1. Rows with no price STAY (shown as «قیمت نامشخص»).
  await fillPricesFromBinance(tokens);
  if (meta.cgPlatform) {
    const orphans = tokens.filter((t) => t.priceUsd <= 0 && t.contract);
    if (orphans.length > 0) {
      const cg = await cgTokenPrices(
        meta.cgPlatform,
        orphans.map((t) => t.contract as string)
      ).catch(() => new Map<string, { price: number; chg: number | null; id: string }>());
      for (const t of orphans) {
        const hit = cg.get((t.contract as string).toLowerCase());
        if (hit && hit.price > 0) {
          t.priceUsd = hit.price;
          t.change24hPct = hit.chg;
          t.valueUsd = t.qty * hit.price;
          if (!t.coingeckoId && hit.id) t.coingeckoId = hit.id;
        }
      }
    }
  }
  return tokens;
}

async function fillPricesFromBinance(tokens: BlockchainTokenBalance[]): Promise<void> {
  const needMap = tokens.some((t) => t.priceUsd <= 0 || t.binancePair);
  if (!needMap) return;
  const { bySymbol } = await getBinancePriceMap().catch(() => ({
    bySymbol: {} as Record<string, BinancePriceEntry>,
  }));
  for (const t of tokens) {
    if (isStableSymbol(t.symbol) && t.priceUsd <= 0) {
      t.priceUsd = 1;
      t.change24hPct = 0;
      t.valueUsd = t.qty;
      continue;
    }
    // v1.4.17 — Binance is the REFERENCE price: it overrides explorer rates
    // (spot AND futures) whenever the coin trades there; the explorer rate
    // only survives for coins with no Binance listing. Fixes the fake
    // trillion-dollar rows produced by illiquid tokens' exchange rates.
    const hit = t.binancePair ? bySymbol[t.binancePair] : undefined;
    if (hit && hit.price > 0) {
      t.priceUsd = hit.price;
      t.change24hPct = hit.chg;
      t.valueUsd = t.qty * hit.price;
      continue;
    }
    // no Binance price → keep the explorer/registry price if present (0 = unknown)
  }
}

// ---------------------------------------------------------------------------
// Tron — TRX + curated TRC-20 probes
// ---------------------------------------------------------------------------

async function trc20Balance(ownerHex: string, token: Trc20Token): Promise<number> {
  const contractHex = tronHexAddress(token.contract);
  if (!contractHex) return 0;
  const d = await postJson<{ constant_result?: string[] }>(
    'https://api.trongrid.io/wallet/triggerconstantcontract',
    {
      owner_address: ownerHex,
      contract_address: contractHex,
      function_selector: 'balanceOf(address)',
      parameter: '0'.repeat(24) + ownerHex.slice(2),
      visible: false,
    }
  );
  const raw = d.constant_result?.[0];
  if (!raw) return 0;
  const n = parseInt(raw, 16);
  return Number.isFinite(n) ? n / Math.pow(10, token.decimals) : 0;
}

async function fetchTronBalances(network: BlockchainNetwork, address: string): Promise<BlockchainTokenBalance[]> {
  const ownerHex = tronHexAddress(address);
  if (!ownerHex) throw new Error('آدرس ترون نامعتبر است');
  const acct = await postJson<{ balance?: number }>(
    'https://api.trongrid.io/wallet/getaccount',
    { address: ownerHex, visible: false }
  );
  const tokens: BlockchainTokenBalance[] = [];
  const trxQty = (acct.balance ?? 0) / 1e6;
  if (trxQty > 0) {
    tokens.push({
      symbol: 'TRX',
      name: 'ترون',
      kind: 'native' as const,
      qty: trxQty,
      priceUsd: 0,
      change24hPct: null,
      valueUsd: 0,
      binancePair: 'TRXUSDT',
      network,
    });
  }
  const probes = await Promise.allSettled(CURATED_TRC20.map((t) => trc20Balance(ownerHex, t)));
  probes.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !(r.value > 0)) return;
    const t = CURATED_TRC20[i];
    tokens.push({
      symbol: t.symbol,
      name: t.name,
      kind: 'token' as const,
      qty: r.value,
      priceUsd: t.stable ? 1 : 0,
      change24hPct: t.stable ? 0 : null,
      valueUsd: t.stable ? r.value : 0,
      binancePair: binancePairFor(t.symbol),
      network,
    });
  });
  await fillPricesFromBinance(tokens);
  return tokens;
}

// ---------------------------------------------------------------------------
// Solana — SOL + SPL discovery (Jupiter → DexScreener prices)
// ---------------------------------------------------------------------------

async function fetchSolanaBalances(network: BlockchainNetwork, address: string): Promise<BlockchainTokenBalance[]> {
  const tokens: BlockchainTokenBalance[] = [];
  const rpcs = NETWORKS.solana.rpcs;
  const call = <T>(method: string, params: unknown[]): Promise<T> =>
    (async () => {
      let lastErr: unknown = null;
      for (const url of rpcs) {
        try {
          const d = await postJson<{ result?: T; error?: { message: string } }>(url, {
            jsonrpc: '2.0',
            id: 1,
            method,
            params,
          });
          if (d.error) throw new Error(d.error.message);
          return d.result as T;
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr ?? new Error('RPC سولانا ناموفق');
    })();

  const lamports = await call<number>('getBalance', [address]);
  const solQty = (lamports ?? 0) / 1e9;
  if (solQty > 0) {
    tokens.push({
      symbol: 'SOL',
      name: 'سولانا',
      kind: 'native' as const,
      qty: solQty,
      priceUsd: 0,
      change24hPct: null,
      valueUsd: 0,
      binancePair: 'SOLUSDT',
      network,
    });
  }

  try {
    const accounts = await call<{
      value: {
        account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number | null } } } } };
      }[];
    }>('getTokenAccountsByOwner', [
      address,
      { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
      { encoding: 'jsonParsed' },
    ]);
    const spl = (accounts?.value ?? [])
      .map((a) => ({
        mint: a.account.data.parsed.info.mint,
        qty: a.account.data.parsed.info.tokenAmount.uiAmount ?? 0,
      }))
      .filter((x) => x.qty > 0);
    if (spl.length > 0) {
      // v1.4.17 — Jupiter primary, DexScreener fallback (same mint set)
      let priceMap: Record<string, { usdPrice?: number; priceChange24h?: number | null }> = {};
      try {
        priceMap = await fetchJson<Record<string, { usdPrice?: number; priceChange24h?: number }>>(
          `https://lite-api.jup.ag/price/v3?ids=${spl.map((x) => x.mint).join(',')}`
        );
      } catch {}
      const missingForDs = spl.filter((x) => !priceMap[x.mint]?.usdPrice);
      if (missingForDs.length > 0) {
        try {
          const ds = await fetchJson<{ pairs?: { baseToken?: { address?: string }; priceUsd?: string; priceChange?: { h24?: number } }[] }>(
            `https://api.dexscreener.com/latest/dex/tokens/${missingForDs.map((x) => x.mint).join(',')}`
          );
          for (const p of ds?.pairs ?? []) {
            const mint = p.baseToken?.address;
            if (!mint) continue;
            const price = parseFloat(p.priceUsd ?? '');
            if (Number.isFinite(price) && price > 0 && !priceMap[mint]) {
              priceMap[mint] = {
                usdPrice: price,
                priceChange24h: p.priceChange?.h24 ?? null,
              };
            }
          }
        } catch {}
      }
      for (const x of spl) {
        const price = priceMap[x.mint]?.usdPrice ?? 0;
        const symbol = mintSymbol(x.mint);
        tokens.push({
          symbol,
          name: symbol,
          kind: 'token' as const,
          qty: x.qty,
          priceUsd: price,
          change24hPct: priceMap[x.mint]?.priceChange24h ?? null,
          valueUsd: x.qty * price,
          binancePair: binancePairFor(symbol),
          network,
        });
      }
    }
  } catch {
    // token accounts are optional — SOL alone is still a valid result
  }

  await fillPricesFromBinance(tokens);
  return tokens;
}

/** Well-known Solana mints → symbol (prices keyed by mint). */
const KNOWN_MINTS: Record<string, string> = {
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
  'Es9vMFrzaCERMLJz2bZhufEhZLXBAPhbhcTXt4y2zKdd': 'USDT',
  'So11111111111111111111111111111111111111112': 'SOL',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 'JUP',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
  '85VBFQZC9TZKEktBGjDZM1thZccqulu6o3dyiDrcC4US': 'WIF',
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': 'USDC',
  'J1tigo1qU4of4uLQaGE8y3vjgapYgBLptDLtDypqulN': 'JTO',
  'EwjBaeR7WMw7GhERv9Bh1n6tY3sWw6MDrBS3JcZKrfU': 'PYTH',
  '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr': 'POPCAT',
  '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump': 'GOAT',
  '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU': 'PONKE',
};

function mintSymbol(mint: string): string {
  return (
    KNOWN_MINTS[mint] ??
    (mint === 'So11111111111111111111111111111111111111112' ? 'SOL' : `${mint.slice(0, 4)}…${mint.slice(-4)}`)
  );
}

// ---------------------------------------------------------------------------
// TON — tonapi.io v2 (Tonkeeper / Trust / MyTonWallet addresses)
// ---------------------------------------------------------------------------

/** v1.2.0 — retry کوتاه برای 429/5xx (rate-limit های tonapi/toncenter روی IPهای مشترک VPN) */
async function fetchWithRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : '';
      if (/HTTP (429|5\d\d)/.test(msg) && i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/** v1.2.0 — نماد/اعشار جتون‌ها از IPFS metadata (کش دائمی در حافظه) */
const tonJettonMetaCache = new Map<string, { symbol?: string; decimals?: number }>();
async function tonJettonMeta(masterAddress: string): Promise<{ symbol?: string; decimals?: number }> {
  const key = masterAddress.toLowerCase();
  const hit = tonJettonMetaCache.get(key);
  if (hit) return hit;
  const out: { symbol?: string; decimals?: number } = {};
  try {
    const m = await fetchJson<{
      jetton_masters?: {
        jetton_content?: { uri?: string; symbol?: string; decimals?: string };
      }[];
    }>(
      `https://toncenter.com/api/v3/jetton/masters?addresses=${encodeURIComponent(key)}`
    );
    const content = m?.jetton_masters?.[0]?.jetton_content;
    if (content?.symbol) out.symbol = String(content.symbol).toUpperCase();
    if (content?.decimals) out.decimals = Number(content.decimals);
    if (!out.symbol && content?.uri) {
      const uri = content.uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
      const meta = await fetchJson<{ symbol?: string; decimals?: string }>(uri);
      if (meta?.symbol) out.symbol = String(meta.symbol).toUpperCase();
      if (meta?.decimals) out.decimals = Number(meta.decimals);
    }
  } catch {}
  tonJettonMetaCache.set(key, out);
  return out;
}

async function fetchTonBalances(network: BlockchainNetwork, address: string): Promise<BlockchainTokenBalance[]> {
  const tokens: BlockchainTokenBalance[] = [];
  let nativeNano: number | null = null;

  // v1.2.0 — زنجیرهٔ ۳گانه + retry: tonapi → toncenter v2 → toncenter v3
  // («کیف تون‌کیپر را اضافه کردم موجودی را نمی‌خواند» — tonapi روی IPهای
  // شلوغ VPN محدود می‌شود؛ حالا دو فال‌بک دیگر هم هست و 429 دوباره تلاش می‌شود.)
  try {
    const acc = await fetchWithRetry(() =>
      fetchJson<{ balance?: string | number }>(
        `https://tonapi.io/v2/accounts/${encodeURIComponent(address)}`
      )
    );
    nativeNano = bigStrToNumber(acc?.balance);
  } catch {}

  if (!nativeNano) {
    try {
      const d = await fetchWithRetry(() =>
        fetchJson<{ result?: { balance?: string | number } }>(
          `https://toncenter.com/api/v2/getExtendedAddressInformation?address=${encodeURIComponent(address)}`
        )
      );
      nativeNano = bigStrToNumber(d?.result?.balance);
    } catch {}
  }
  if (!nativeNano) {
    try {
      const d = await fetchWithRetry(() =>
        fetchJson<{ balance?: string | number }>(
          `https://toncenter.com/api/v3/addressInformation?address=${encodeURIComponent(address)}`
        )
      );
      nativeNano = bigStrToNumber(d?.balance);
    } catch {}
  }

  if (nativeNano && nativeNano > 0) {
    tokens.push({
      symbol: 'TON',
      name: 'تون (The Open Network)',
      kind: 'native' as const,
      qty: nativeNano / 1e9,
      priceUsd: 0,
      change24hPct: null,
      valueUsd: 0,
      binancePair: 'TONUSDT',
      network,
    });
  }

  // jettons (TON's fungible tokens) — full discovery via tonapi
  let jettonsFromTonapi = false;
  try {
    const jets = await fetchWithRetry(() =>
      fetchJson<{
        balances?: {
          balance: string | number;
          jetton?: { symbol?: string; name?: string; decimals?: number | string; address?: string };
        }[];
      }>(`https://tonapi.io/v2/accounts/${encodeURIComponent(address)}/jettons`)
    );
    for (const j of jets?.balances ?? []) {
      const sym = (j.jetton?.symbol ?? '?').toUpperCase();
      const dec = bigStrToNumber(j.jetton?.decimals ?? 9) || 9;
      const qty = bigStrToNumber(j.balance) / Math.pow(10, dec);
      if (!(qty > 0)) continue;
      tokens.push({
        symbol: sym,
        name: j.jetton?.name ?? sym,
        kind: 'token' as const,
        qty,
        priceUsd: isStableSymbol(sym) ? 1 : 0,
        change24hPct: isStableSymbol(sym) ? 0 : null,
        valueUsd: isStableSymbol(sym) ? qty : 0,
        binancePair: binancePairFor(sym),
        network,
      });
      if (j.jetton?.address) {
        tonJettonMetaCache.set(String(j.jetton.address).toLowerCase(), {
          symbol: sym,
          decimals: dec,
        });
      }
    }
    jettonsFromTonapi = tokens.some((t) => t.kind === 'token');
  } catch {}

  // v1.2.0 — فال‌بک جتون‌ها با toncenter v3 (وقتی tonapi جواب نداد):
  // jetton/wallets?owner_address → برای هر master، نماد از jetton/masters + IPFS
  if (!jettonsFromTonapi) {
    try {
      const w = await fetchWithRetry(() =>
        fetchJson<{
          jetton_wallets?: { balance?: string | number; jetton?: string }[];
        }>(
          `https://toncenter.com/api/v3/jetton/wallets?owner_address=${encodeURIComponent(address)}`
        )
      );
      for (const row of w?.jetton_wallets ?? []) {
        const qtyRaw = bigStrToNumber(row?.balance);
        if (!(qtyRaw > 0) || !row?.jetton) continue;
        const meta = await tonJettonMeta(row.jetton);
        const sym = (meta.symbol ?? '?').toUpperCase();
        const dec = meta.decimals ?? 9;
        const qty = qtyRaw / Math.pow(10, dec);
        if (!(qty > 0)) continue;
        tokens.push({
          symbol: sym,
          name: sym,
          kind: 'token' as const,
          qty,
          priceUsd: isStableSymbol(sym) ? 1 : 0,
          change24hPct: isStableSymbol(sym) ? 0 : null,
          valueUsd: isStableSymbol(sym) ? qty : 0,
          binancePair: binancePairFor(sym),
          network,
        });
      }
    } catch {}
  }

  await fillPricesFromBinance(tokens);
  return tokens;
}

// ---------------------------------------------------------------------------
// UTXO family — Bitcoin / Litecoin / Dogecoin / BCH
// ---------------------------------------------------------------------------

interface UtxoAddrStats {
  chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
  mempool_stats: { funded_txo_sum: number; spent_txo_sum: number };
}

async function fetchMempoolStyle(
  hosts: string[],
  address: string,
  symbol: string,
  faName: string,
  network: BlockchainNetwork,
  decimals: number
): Promise<BlockchainTokenBalance[]> {
  let lastErr: unknown = null;
  for (const host of hosts) {
    try {
      const d = await fetchJson<UtxoAddrStats>(`${host}/address/${encodeURIComponent(address)}`);
      const raw =
        d.chain_stats.funded_txo_sum -
        d.chain_stats.spent_txo_sum +
        d.mempool_stats.funded_txo_sum -
        d.mempool_stats.spent_txo_sum;
      const qty = raw / Math.pow(10, decimals);
      if (qty <= 0) return [];
      return [
        {
          symbol,
          name: faName,
          kind: 'native' as const,
          qty,
          priceUsd: 0,
          change24hPct: null,
          valueUsd: 0,
          binancePair: `${symbol}USDT`,
          network,
        },
      ];
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error(`دریافت موجودی ${faName} ناموفق بود`);
}

async function fetchBitcoinBalances(network: BlockchainNetwork, address: string) {
  return fetchMempoolStyle(
    ['https://mempool.space/api', 'https://blockstream.info/api'],
    address, 'BTC', 'بیت‌کوین', network, 8
  );
}

async function fetchLitecoinBalances(network: BlockchainNetwork, address: string) {
  return fetchMempoolStyle(
    ['https://litecoin.space/api', 'https://blockstream.info/api'],
    address, 'LTC', 'لایت‌کوین', network, 8
  ).catch(async () => {
    // blockchair fallback
    const d = await fetchJson<{ data?: Record<string, { address?: { balance?: number } }> }>(
      `https://api.blockchair.com/litecoin/dashboards/address/${encodeURIComponent(address)}`
    );
    const sats = d?.data?.[address]?.address?.balance ?? 0;
    if (!(sats > 0)) return [] as BlockchainTokenBalance[];
    return [
      {
        symbol: 'LTC', name: 'لایت‌کوین', kind: 'native' as const,
        qty: sats / 1e8, priceUsd: 0, change24hPct: null, valueUsd: 0,
        binancePair: 'LTCUSDT', network,
      },
    ];
  });
}

async function fetchDogecoinBalances(network: BlockchainNetwork, address: string) {
  const d = await fetchJson<{ balance?: number | string }>(
    `https://dogechain.info/api/v1/address/balance/${encodeURIComponent(address)}`
  );
  const qty = bigStrToNumber(d?.balance);
  if (!(qty > 0)) return [] as BlockchainTokenBalance[];
  return [
    {
      symbol: 'DOGE', name: 'دوج‌کوین', kind: 'native' as const,
      qty, priceUsd: 0, change24hPct: null, valueUsd: 0,
      binancePair: 'DOGEUSDT', network,
    },
  ];
}

async function fetchBchBalances(network: BlockchainNetwork, address: string) {
  const d = await fetchJson<{ data?: Record<string, { address?: { balance?: number } }> }>(
    `https://api.blockchair.com/bitcoin-cash/dashboards/address/${encodeURIComponent(address.replace(/^bitcoincash:/i, ''))}`
  );
  const sats = d?.data?.[address]?.address?.balance ?? d?.data?.[address.replace(/^bitcoincash:/i, '')]?.address?.balance ?? 0;
  if (!(sats > 0)) return [] as BlockchainTokenBalance[];
  return [
    {
      symbol: 'BCH', name: 'بیت‌کوین کش', kind: 'native' as const,
      qty: sats / 1e8, priceUsd: 0, change24hPct: null, valueUsd: 0,
      binancePair: 'BCHUSDT', network,
    },
  ];
}

// ---------------------------------------------------------------------------
// XRP / Stellar / Algorand / Tezos / MultiversX / Cosmos / Cardano
// ---------------------------------------------------------------------------

async function fetchXrpBalances(network: BlockchainNetwork, address: string): Promise<BlockchainTokenBalance[]> {
  const d = await postJson<{ result?: { account_data?: { Balance?: string } } }>(
    'https://xrplcluster.com',
    { method: 'account_info', params: [{ account: address, ledger_index: 'validated' }] }
  );
  const drops = bigStrToNumber(d?.result?.account_data?.Balance);
  if (!(drops > 0)) return [];
  return [
    {
      symbol: 'XRP', name: 'ریپل', kind: 'native' as const,
      qty: drops / 1e6, priceUsd: 0, change24hPct: null, valueUsd: 0,
      binancePair: 'XRPUSDT', network,
    },
  ];
}

async function fetchStellarBalances(network: BlockchainNetwork, address: string): Promise<BlockchainTokenBalance[]> {
  const d = await fetchJson<{
    balances?: { asset_type: string; asset_code?: string; balance: string }[];
  }>(`https://horizon.stellar.org/accounts/${encodeURIComponent(address)}`);
  const tokens: BlockchainTokenBalance[] = [];
  for (const b of d?.balances ?? []) {
    const qty = parseFloat(b.balance ?? '');
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const isNative = b.asset_type === 'native';
    const symbol = isNative ? 'XLM' : (b.asset_code ?? '?').toUpperCase();
    tokens.push({
      symbol,
      name: isNative ? 'استلار' : `${symbol} (Stellar)`,
      kind: isNative ? 'native' : 'token',
      qty,
      priceUsd: isStableSymbol(symbol) ? 1 : 0,
      change24hPct: isStableSymbol(symbol) ? 0 : null,
      valueUsd: isStableSymbol(symbol) ? qty : 0,
      binancePair: binancePairFor(symbol),
      network,
    });
  }
  await fillPricesFromBinance(tokens);
  return tokens;
}

async function fetchAlgorandBalances(network: BlockchainNetwork, address: string): Promise<BlockchainTokenBalance[]> {
  const d = await fetchJson<{
    amount?: number;
    'min-balance'?: number;
    assets?: { 'asset-id': number; amount: number; decimals?: number; 'unit-name'?: string; name?: string }[];
  }>(`https://mainnet-api.algonode.cloud/v2/accounts/${encodeURIComponent(address)}`);
  const tokens: BlockchainTokenBalance[] = [];
  const algoQty = ((d?.amount ?? 0) - (d?.['min-balance'] ?? 0)) / 1e6;
  if (algoQty > 0) {
    tokens.push({
      symbol: 'ALGO', name: 'الگورند', kind: 'native' as const,
      qty: algoQty, priceUsd: 0, change24hPct: null, valueUsd: 0,
      binancePair: 'ALGOUSDT', network,
    });
  }
  for (const a of d?.assets ?? []) {
    const dec = a.decimals ?? 0;
    const qty = a.amount / Math.pow(10, dec);
    if (!(qty > 0)) continue;
    const symbol = (a['unit-name'] ?? a.name ?? `ASA${a['asset-id']}`).toUpperCase();
    tokens.push({
      symbol: symbol.slice(0, 12),
      name: a.name ?? symbol,
      kind: 'token' as const,
      qty,
      priceUsd: isStableSymbol(symbol) ? 1 : 0,
      change24hPct: isStableSymbol(symbol) ? 0 : null,
      valueUsd: isStableSymbol(symbol) ? qty : 0,
      binancePair: binancePairFor(symbol),
      network,
    });
  }
  await fillPricesFromBinance(tokens);
  return tokens;
}

async function fetchTezosBalances(network: BlockchainNetwork, address: string): Promise<BlockchainTokenBalance[]> {
  const acct = await fetchJson<{ balance?: number | string }>(
    `https://api.tzkt.io/v1/accounts/${encodeURIComponent(address)}`
  );
  const tokens: BlockchainTokenBalance[] = [];
  const xtzQty = bigStrToNumber(acct?.balance) / 1e6;
  if (xtzQty > 0) {
    tokens.push({
      symbol: 'XTZ', name: 'تزوس', kind: 'native' as const,
      qty: xtzQty, priceUsd: 0, change24hPct: null, valueUsd: 0,
      binancePair: 'XTZUSDT', network,
    });
  }
  try {
    const list = await fetchJson<{
      token?: { symbol?: string; name?: string; decimals?: number };
      balance: string | number;
    }[]>(`https://api.tzkt.io/v1/tokens/balances?account=${encodeURIComponent(address)}&limit=100`);
    for (const t of list ?? []) {
      const sym = (t.token?.symbol ?? '?').toUpperCase();
      const dec = bigStrToNumber(t.token?.decimals ?? 0);
      const qty = bigStrToNumber(t.balance) / Math.pow(10, dec || 0);
      if (!(qty > 0)) continue;
      tokens.push({
        symbol: sym.slice(0, 12),
        name: t.token?.name ?? sym,
        kind: 'token' as const,
        qty,
        priceUsd: isStableSymbol(sym) ? 1 : 0,
        change24hPct: isStableSymbol(sym) ? 0 : null,
        valueUsd: isStableSymbol(sym) ? qty : 0,
        binancePair: binancePairFor(sym),
        network,
      });
    }
  } catch {}
  await fillPricesFromBinance(tokens);
  return tokens;
}

async function fetchMultiversxBalances(network: BlockchainNetwork, address: string): Promise<BlockchainTokenBalance[]> {
  const acct = await fetchJson<{ balance?: string }>(
    `https://api.multiversx.com/accounts/${encodeURIComponent(address)}`
  );
  const tokens: BlockchainTokenBalance[] = [];
  const egldQty = bigStrToNumber(acct?.balance) / 1e18;
  if (egldQty > 0) {
    tokens.push({
      symbol: 'EGLD', name: 'مالتی‌ورس‌ایکس', kind: 'native' as const,
      qty: egldQty, priceUsd: 0, change24hPct: null, valueUsd: 0,
      binancePair: 'EGLDUSDT', network,
    });
  }
  try {
    const list = await fetchJson<{
      symbol?: string; name?: string; decimals?: number; balance?: string;
    }[]>(`https://api.multiversx.com/accounts/${encodeURIComponent(address)}/tokens`);
    for (const t of list ?? []) {
      const sym = (t.symbol ?? '?').toUpperCase();
      const qty = bigStrToNumber(t.balance) / Math.pow(10, bigStrToNumber(t.decimals ?? 18));
      if (!(qty > 0)) continue;
      tokens.push({
        symbol: sym.slice(0, 12),
        name: t.name ?? sym,
        kind: 'token' as const,
        qty,
        priceUsd: isStableSymbol(sym) ? 1 : 0,
        change24hPct: isStableSymbol(sym) ? 0 : null,
        valueUsd: isStableSymbol(sym) ? qty : 0,
        binancePair: binancePairFor(sym),
        network,
      });
    }
  } catch {}
  await fillPricesFromBinance(tokens);
  return tokens;
}

async function fetchCosmosBalances(network: BlockchainNetwork, address: string): Promise<BlockchainTokenBalance[]> {
  const d = await fetchJson<{ balances?: { denom: string; amount: string | number }[] }>(
    `https://cosmos-rest.publicnode.com/cosmos/bank/v1beta1/balances/${encodeURIComponent(address)}`
  );
  const tokens: BlockchainTokenBalance[] = [];
  for (const b of d?.balances ?? []) {
    const raw = bigStrToNumber(b.amount);
    if (!(raw > 0)) continue;
    if (b.denom === 'uatom') {
      tokens.push({
        symbol: 'ATOM', name: 'کازموس هاب', kind: 'native' as const,
        qty: raw / 1e6, priceUsd: 0, change24hPct: null, valueUsd: 0,
        binancePair: 'ATOMUSDT', network,
      });
    } else if (b.denom === 'uusd' || b.denom === 'uusdc') {
      tokens.push({
        symbol: 'USDC', name: 'USDC (Cosmos)', kind: 'token' as const,
        qty: raw / 1e6, priceUsd: 1, change24hPct: 0, valueUsd: raw / 1e6,
        network,
      });
    } else if (!b.denom.startsWith('ibc/')) {
      tokens.push({
        symbol: b.denom.toUpperCase().slice(0, 12),
        name: `${b.denom} (Cosmos)`,
        kind: 'token' as const,
        qty: raw / 1e6, priceUsd: 0, change24hPct: null, valueUsd: 0,
        network,
      });
    }
  }
  await fillPricesFromBinance(tokens);
  return tokens;
}

async function fetchCardanoBalances(network: BlockchainNetwork, address: string): Promise<BlockchainTokenBalance[]> {
  // koios POST account_info — native lovelace (stake addresses AND payment
  // addresses are accepted; empty result = nothing held)
  const d = await postJson<{ status?: string; balance?: { amount?: string | number } }[]>(
    'https://api.koios.rest/api/v1/account_info',
    { _addresses: [address] }
  );
  const lovelace = bigStrToNumber(d?.[0]?.balance?.amount);
  if (!(lovelace > 0)) return [];
  return [
    {
      symbol: 'ADA', name: 'کاردانو', kind: 'native' as const,
      qty: lovelace / 1e6, priceUsd: 0, change24hPct: null, valueUsd: 0,
      binancePair: 'ADAUSDT', network,
    },
  ];
}

// ---------------------------------------------------------------------------
// Near / Aptos / Sui / Hedera / Zilliqa / VeChain / Kaspa / Polkadot
// ---------------------------------------------------------------------------

async function fetchNearBalances(network: BlockchainNetwork, address: string): Promise<BlockchainTokenBalance[]> {
  const named = /^[a-z0-9_-]/.test(address) && !address.startsWith('0x');
  const d = await postJson<{ result?: { amount?: string } }>(
    'https://rpc.mainnet.near.org',
    {
      jsonrpc: '2.0',
      id: 'dontcare',
      method: 'query',
      params: named
        ? { request_type: 'view_account', finality: 'final', account_id: address }
        : {
            request_type: 'view_account',
            finality: 'final',
            account_id: 'system',
          },
    }
  );
  // hex form is not supported by view_account directly — named accounts only
  const yocto = bigStrToNumber(d?.result?.amount);
  if (!(yocto > 0)) return [];
  return [
    {
      symbol: 'NEAR', name: 'نیر پروتکل', kind: 'native' as const,
      qty: yocto / 1e24, priceUsd: 0, change24hPct: null, valueUsd: 0,
      binancePair: 'NEARUSDT', network,
    },
  ];
}

async function fetchAptosBalances(network: BlockchainNetwork, address: string): Promise<BlockchainTokenBalance[]> {
  const d = await fetchJson<Record<string, unknown>[]>(
    `https://fullnode.mainnet.aptoslabs.com/v1/accounts/${encodeURIComponent(address)}/resources`
  );
  const tokens: BlockchainTokenBalance[] = [];
  for (const res of d ?? []) {
    const type = String((res as { type?: string }).type ?? '');
    const data = (res as { data?: Record<string, unknown> }).data ?? {};
    // CoinStore<T> → { coin: { value: "123" } }
    const m = /^0x[0-9a-fA-F]+::coin::CoinStore<(.+)>$/.exec(type);
    if (!m) continue;
    const coinType = m[1];
    const value = bigStrToNumber((data.coin as { value?: string } | undefined)?.value);
    if (!(value > 0)) continue;
    const isApt = /aptos_coin::AptosCoin$/i.test(coinType);
    const tail = coinType.split('::').pop() ?? '?';
    const symbol = isApt ? 'APT' : tail.toUpperCase().slice(0, 12);
    tokens.push({
      symbol,
      name: isApt ? 'آپتوس' : `${symbol} (Aptos)`,
      kind: isApt ? 'native' : 'token',
      qty: value,
      priceUsd: isStableSymbol(symbol) ? 1 : 0,
      change24hPct: isStableSymbol(symbol) ? 0 : null,
      valueUsd: isStableSymbol(symbol) ? value : 0,
      binancePair: binancePairFor(symbol),
      network,
    });
  }
  await fillPricesFromBinance(tokens);
  return tokens;
}

async function fetchSuiBalances(network: BlockchainNetwork, address: string): Promise<BlockchainTokenBalance[]> {
  const d = await postJson<{
    data?: { owner?: { balances?: { edges?: { node?: { totalBalance?: string; coinType?: { repr?: string } } }[] } } };
  }>('https://sui-mainnet.mystenlabs.com/graphql', {
    query:
      'query b($o: SuiAddress!) { owner(address: $o) { address balances { edges { node { coinObjectCount totalBalance coinType { repr } } } } } }',
    variables: { o: address },
  });
  const edges = d?.data?.owner?.balances?.edges ?? [];
  const tokens: BlockchainTokenBalance[] = [];
  for (const e of edges) {
    const raw = bigStrToNumber(e?.node?.totalBalance);
    if (!(raw > 0)) continue;
    const repr = e?.node?.coinType?.repr ?? '';
    const isSui = /::sui::SUI$/i.test(repr);
    const tail = (repr.split('::').pop() ?? '?').toUpperCase().slice(0, 12);
    const symbol = isSui ? 'SUI' : isStableSymbol(tail) ? tail : tail;
    tokens.push({
      symbol,
      name: isSui ? 'سویی' : `${symbol} (Sui)`,
      kind: isSui ? 'native' : 'token',
      qty: isSui ? raw / 1e9 : raw,
      priceUsd: isStableSymbol(symbol) ? 1 : 0,
      change24hPct: isStableSymbol(symbol) ? 0 : null,
      valueUsd: isStableSymbol(symbol) ? raw : 0,
      binancePair: binancePairFor(symbol),
      network,
    });
  }
  await fillPricesFromBinance(tokens);
  return tokens;
}

async function fetchHederaBalances(network: BlockchainNetwork, address: string): Promise<BlockchainTokenBalance[]> {
  const acct = await fetchJson<{ balance?: { balance?: number | string } }>(
    `https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${encodeURIComponent(address)}`
  );
  const tiny = bigStrToNumber(acct?.balance?.balance);
  if (!(tiny > 0)) return [];
  return [
    {
      symbol: 'HBAR', name: 'هدرا', kind: 'native' as const,
      qty: tiny / 1e8, priceUsd: 0, change24hPct: null, valueUsd: 0,
      binancePair: 'HBARUSDT', network,
    },
  ];
}

async function fetchZilliqaBalances(network: BlockchainNetwork, address: string): Promise<BlockchainTokenBalance[]> {
  const base16 = zilliqaBase16(address) ?? address;
  const d = await postJson<{ result?: { balance?: string } }>(
    'https://api.zilliqa.com',
    { id: 1, jsonrpc: '2.0', method: 'GetBalance', params: [base16.replace(/^0x/i, '')] }
  );
  const qa = bigStrToNumber(d?.result?.balance);
  if (!(qa > 0)) return [];
  return [
    {
      symbol: 'ZIL', name: 'زیلیکا', kind: 'native' as const,
      qty: qa / 1e12, priceUsd: 0, change24hPct: null, valueUsd: 0,
      binancePair: 'ZILUSDT', network,
    },
  ];
}

async function fetchVechainBalances(network: BlockchainNetwork, address: string): Promise<BlockchainTokenBalance[]> {
  const d = await fetchJson<{ balance?: string }>(
    `https://mainnet.veblocks.net/accounts/${encodeURIComponent(address)}`
  );
  const wei = bigStrToNumber(d?.balance);
  if (!(wei > 0)) return [];
  return [
    {
      symbol: 'VET', name: 'وی‌چین', kind: 'native' as const,
      qty: wei / 1e18, priceUsd: 0, change24hPct: null, valueUsd: 0,
      binancePair: 'VETUSDT', network,
    },
  ];
}

async function fetchKaspaBalances(network: BlockchainNetwork, address: string): Promise<BlockchainTokenBalance[]> {
  const d = await fetchJson<{ balance?: number | string }>(
    `https://api.kaspa.org/addresses/${encodeURIComponent(address)}/balance`
  );
  const sompi = bigStrToNumber(d?.balance);
  if (!(sompi > 0)) return [];
  return [
    {
      symbol: 'KAS', name: 'کسپا', kind: 'native' as const,
      qty: sompi / 1e8, priceUsd: 0, change24hPct: null, valueUsd: 0,
      binancePair: 'KASUSDT', network,
    },
  ];
}

async function fetchPolkadotBalances(network: BlockchainNetwork, address: string): Promise<BlockchainTokenBalance[]> {
  const accountId = ss58Decode(address);
  if (!accountId) throw new Error('آدرس پولکادات قابل رمزگشایی نیست');
  const key = polkadotStorageKey(accountId);
  const raw = await rpcCall<string | null>(['https://rpc.polkadot.io', 'https://polkadot.api.onfinality.io/public'], 'state_getStorage', [key]);
  if (!raw || raw === '0x' || raw === 'null') {
    return []; // account never used → zero balance is a VALID result
  }
  // SCALE AccountInfo: nonce u32, consumers u32, providers u32, sufficients u32
  // (4 × 8 hex chars = 32 hex chars), then Data { free u128, reserved u128, … }
  const hex = raw.replace(/^0x/i, '');
  const readU128 = (off: number): number => {
    const words = hex.slice(off, off + 32).match(/../g) ?? [];
    return Number(BigInt('0x' + [...words].reverse().join('')));
  };
  const free = readU128(32);
  const reserved = readU128(64);
  const transferable = free + reserved;
  if (!(transferable > 0)) return [];
  return [
    {
      symbol: 'DOT', name: 'پولکادات', kind: 'native' as const,
      qty: transferable / 1e10, priceUsd: 0, change24hPct: null, valueUsd: 0,
      binancePair: 'DOTUSDT', network,
    },
  ];
}

// ---------------------------------------------------------------------------
// Filecoin — f1/f3/f4/f0 (Trust Wallet) OR 0x FEVM addresses
// ---------------------------------------------------------------------------

const GLIF_RPC = 'https://api.node.glif.io/rpc/v1';

/** f0/f1/f3/f4 → 0x FEVM form ('0x' + actor-ID padded to 20 bytes), else null. */
async function filecoinToEvm(address: string): Promise<string | null> {
  const a = address.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return a;
  let idAddress = a;
  if (/^f[134][0-9a-zA-Z]+$/.test(a)) {
    try {
      const d = await postJson<{ result?: string }>(GLIF_RPC, {
        jsonrpc: '2.0',
        id: 1,
        method: 'Filecoin.StateLookupID',
        params: [a, null],
      });
      if (d?.result) idAddress = d.result;
    } catch {
      return null;
    }
  }
  const m = /^f0(\d+)$/.exec(idAddress);
  if (!m) return null;
  const id = BigInt(m[1]);
  return '0x' + id.toString(16).padStart(40, '0');
}

async function fetchFilecoinBalances(network: BlockchainNetwork, address: string): Promise<BlockchainTokenBalance[]> {
  const tokens: BlockchainTokenBalance[] = [];
  let evmAddress: string | null = null;

  // native FIL via StateGetActor (works for f1/f0/… forms)
  try {
    const d = await postJson<{ result?: { Balance?: string } }>(GLIF_RPC, {
      jsonrpc: '2.0',
      id: 1,
      method: 'Filecoin.StateGetActor',
      params: [address.trim(), null],
    });
    const atto = bigStrToNumber(d?.result?.Balance);
    if (atto > 0) {
      tokens.push({
        symbol: 'FIL', name: 'فایل‌کوین', kind: 'native' as const,
        qty: atto / 1e18, priceUsd: 0, change24hPct: null, valueUsd: 0,
        binancePair: 'FILUSDT', network,
      });
    }
  } catch {}

  // FEVM (0x) path — native + ERC-20 tokens via glif RPC + filecoin.blockscout
  evmAddress = await filecoinToEvm(address);
  if (evmAddress) {
    try {
      const evmTokens = await fetchEvmBalances('filecoin' as BlockchainNetwork, evmAddress);
      for (const t of evmTokens) {
        if (t.kind === 'native') continue; // already counted via StateGetActor (0x → skip double)
        tokens.push(t);
      }
      // if the address is 0x-form, StateGetActor may fail — include native from EVM path
      if (/^0x/.test(address.trim()) && !tokens.some((t) => t.symbol === 'FIL')) {
        const native = evmTokens.find((t) => t.kind === 'native');
        if (native) tokens.unshift({ ...native, symbol: 'FIL', binancePair: 'FILUSDT' });
      }
    } catch {}
  }

  await fillPricesFromBinance(tokens);
  return tokens;
}

// ---------------------------------------------------------------------------
// Public entry — fetch ONE wallet across ALL its selected networks
// ---------------------------------------------------------------------------

async function fetchNetworkBalances(
  network: BlockchainNetwork,
  address: string
): Promise<BlockchainTokenBalance[]> {
  if (isEvmNetwork(network)) return fetchEvmBalances(network, address);
  switch (network) {
    case 'filecoin': return fetchFilecoinBalances(network, address);
    case 'tron': return fetchTronBalances(network, address);
    case 'solana': return fetchSolanaBalances(network, address);
    case 'ton': return fetchTonBalances(network, address);
    case 'bitcoin': return fetchBitcoinBalances(network, address);
    case 'litecoin': return fetchLitecoinBalances(network, address);
    case 'dogecoin': return fetchDogecoinBalances(network, address);
    case 'bitcoin-cash': return fetchBchBalances(network, address);
    case 'xrp': return fetchXrpBalances(network, address);
    case 'stellar': return fetchStellarBalances(network, address);
    case 'algorand': return fetchAlgorandBalances(network, address);
    case 'tezos': return fetchTezosBalances(network, address);
    case 'multiversx': return fetchMultiversxBalances(network, address);
    case 'cosmos': return fetchCosmosBalances(network, address);
    case 'cardano': return fetchCardanoBalances(network, address);
    case 'near': return fetchNearBalances(network, address);
    case 'aptos': return fetchAptosBalances(network, address);
    case 'sui': return fetchSuiBalances(network, address);
    case 'hedera': return fetchHederaBalances(network, address);
    case 'zilliqa': return fetchZilliqaBalances(network, address);
    case 'vechain': return fetchVechainBalances(network, address);
    case 'kaspa': return fetchKaspaBalances(network, address);
    case 'polkadot': return fetchPolkadotBalances(network, address);
  }
  return [];
}

// ---------------------------------------------------------------------------
// v1.2.0 — آیکون واقعی ارزها: «دارایی را با آیکون همون ارز نشون بده»
// منبع: CoinGecko markets (image) از طریق پروکسی سرور خودمان /cg-icons
// (از ایران هم در دسترس است؛ کش حافظه ۱ ساعته + کش per-symbol دائمی).
// ---------------------------------------------------------------------------

const tokenIconCache = new Map<string, string>(); // SYMBOL → url
const tokenIconIdCache = new Map<string, string>(); // cgId → url
let tokenIconListFetchedAt = 0;
const TOKEN_ICON_TTL = 60 * 60_000; // 1h

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchIconMaps(
  ids: string[],
  symbols: string[]
): Promise<{ byId: Record<string, string>; bySymbol: Record<string, string> }> {
  const byId: Record<string, string> = {};
  const bySymbol: Record<string, string> = {};
  const base = (await getServerUrl().catch(() => 'https://asset-management1.up.railway.app')).replace(
    /\/+$/,
    ''
  );
  const idChunks = chunk(ids, 100);
  const symChunks = chunk(symbols, 80);
  const jobs: Promise<void>[] = [];
  for (const ic of idChunks) {
    jobs.push(
      (async () => {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 15_000);
          const res = await fetch(`${base}/cg-icons?ids=${encodeURIComponent(ic.join(','))}`, {
            signal: ctrl.signal,
          });
          clearTimeout(timer);
          if (!res.ok) return;
          const d = (await res.json()) as { byId?: Record<string, string> };
          Object.assign(byId, d?.byId ?? {});
        } catch {}
      })()
    );
  }
  for (const sc of symChunks) {
    jobs.push(
      (async () => {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 15_000);
          const res = await fetch(`${base}/cg-icons?symbols=${encodeURIComponent(sc.join(',').toLowerCase())}`, {
            signal: ctrl.signal,
          });
          clearTimeout(timer);
          if (!res.ok) return;
          const d = (await res.json()) as { bySymbol?: Record<string, string> };
          Object.assign(bySymbol, d?.bySymbol ?? {});
        } catch {}
      })()
    );
  }
  await Promise.all(jobs);
  return { byId, bySymbol };
}

/** آیکون هر توکن را (best-effort) پر می‌کند — خطا هرگز فچ موجودی را نمی‌شکند. */
async function attachTokenIcons(tokens: BlockchainTokenBalance[]): Promise<void> {
  const needIds = new Set<string>();
  const needSymbols = new Set<string>();
  for (const t of tokens) {
    const sym = t.symbol.toUpperCase();
    if (tokenIconCache.has(sym) || tokenIconIdCache.has(t.coingeckoId ?? '')) continue;
    if (t.coingeckoId) needIds.add(t.coingeckoId);
    else needSymbols.add(sym);
  }
  const now = Date.now();
  if ((needIds.size > 0 || needSymbols.size > 0) && now - tokenIconListFetchedAt > 3_000) {
    tokenIconListFetchedAt = now;
    const { byId, bySymbol } = await fetchIconMaps([...needIds], [...needSymbols]);
    for (const [id, url] of Object.entries(byId)) tokenIconIdCache.set(id, url);
    for (const [sym, url] of Object.entries(bySymbol)) {
      if (!tokenIconCache.has(sym)) tokenIconCache.set(sym, url);
    }
  }
  for (const t of tokens) {
    const sym = t.symbol.toUpperCase();
    const url = (t.coingeckoId ? tokenIconIdCache.get(t.coingeckoId) : undefined) ?? tokenIconCache.get(sym);
    if (url) t.icon = url;
  }
}

const NETWORK_FETCH_CONCURRENCY = 4;

/**
 * Reads one wallet on every selected network (EVM networks share the 0x
 * address; each independent network uses its own address form). Merges rows
 * by symbol, keeps unknown-price rows VISIBLE (v1.4.17 — user demand), and
 * writes the balance snapshot cache.
 */
export async function fetchBlockchainWalletData(
  wallet: BlockchainWallet,
  opts?: { force?: boolean }
): Promise<BlockchainWalletData> {
  const networks = wallet.networks.length > 0 ? wallet.networks : (['ethereum'] as BlockchainNetwork[]);
  const address = wallet.address.trim();
  const notices: string[] = [];
  const collected: BlockchainTokenBalance[] = [];

  // v1.4.19 — manual refresh forces FRESH prices (bypasses the 60s ticker
  // cache so the numbers really move when the user presses «رفرش»).
  if (opts?.force) allTickerCache = null;

  // small concurrency pool across networks (one EVM registry fetch is shared)
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < networks.length) {
      const idx = cursor++;
      const net = networks[idx];
      try {
        // v1.4.19 — per-network address override (base 0x for EVM chains +
        // e.g. a Filecoin f1 / Solana / TON address for that network).
        const addr = addressForNetwork(wallet, net) || address;
        const rows = await fetchNetworkBalances(net, addr);
        collected.push(...rows);
      } catch (e) {
        notices.push(`${NETWORKS[net].label}: دریافت ناموفق (${e instanceof Error ? e.message.slice(0, 60) : 'خطا'})`);
      }
    }
  }
  await Promise.all(
    new Array(Math.min(NETWORK_FETCH_CONCURRENCY, networks.length)).fill(0).map(() => worker())
  );

  // merge rows with the same symbol (same asset on several networks, e.g.
  // USDT on Ethereum + BSC + Tron in one multi-network wallet)
  const merged = new Map<string, BlockchainTokenBalance>();
  for (const t of collected) {
    const key = t.symbol.toUpperCase();
    const existing = merged.get(key);
    if (existing) {
      existing.qty += t.qty;
      existing.valueUsd += t.valueUsd;
      if (existing.priceUsd <= 0 && t.priceUsd > 0) {
        existing.priceUsd = t.priceUsd;
        existing.change24hPct = t.change24hPct;
      }
      if (!existing.network && t.network) existing.network = t.network;
    } else {
      merged.set(key, { ...t });
    }
  }

  // v1.4.17 — sanity cap: spam/airdrop tokens carry absurd supplies and fake
  // prices (a trillion-dollar row was observed in live testing). A personal
  // wallet NEVER holds > $1B of one token — such rows lose their price and
  // fall back to «قیمت نامشخص» (the row itself stays visible).
  for (const t of merged.values()) {
    if (t.priceUsd > 0 && t.qty * t.priceUsd > 1e9) {
      t.priceUsd = 0;
      t.change24hPct = null;
      t.valueUsd = 0;
    }
  }

  // dust filter: drop rows worth < $0.01 ONLY when their price is KNOWN;
  // unknown-price rows stay visible (max 15 of them) — «فلان ارز نمایش
  // داده نمی‌شود» is exactly what v1.4.17 must never do again.
  const known = [...merged.values()]
    .filter((t) => t.priceUsd > 0)
    .filter((t) => t.valueUsd >= 0.01);
  const unknown = [...merged.values()]
    .filter((t) => t.priceUsd <= 0 && t.qty > 0)
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 15);

  const tokens = [...known, ...unknown]
    .sort((a, b) => b.valueUsd - a.valueUsd)
    .slice(0, 60);

  // v1.2.0 — آیکون واقعی هر ارز (best-effort؛ نبودش فقط یعنی آواتار حرفی)
  await attachTokenIcons(tokens);

  const totalUsd = tokens.reduce((s, t) => s + (Number.isFinite(t.valueUsd) ? t.valueUsd : 0), 0);
  const data: BlockchainWalletData = {
    walletId: wallet.id,
    tokens,
    totalUsd,
    fetchedAt: Date.now(),
    notice: notices.length > 0 ? notices.join(' • ') : undefined,
  };
  await writeBlockchainBalanceCache(data);
  return data;
}

// ---------------------------------------------------------------------------
// PnL — per-WALLET and per-token market change over ۷/۳۰/۹۰/۱۸۰ days
// v1.4.17: three levels — total (all wallets), per wallet (one line), and
// per token inside each wallet. Binance klines for Binance coins, CoinGecko
// market_chart for CG-known tokens (TOSHI, MOONKIN-style coverage).
// ---------------------------------------------------------------------------

// v1.5.12 — «تایم‌فریم امروز» به همه‌ی PnLها اضافه شد (۱ = از ابتدای روز محلی).
export const PNL_PERIODS = [1, 7, 30, 90, 180] as const;
export type PnlPeriod = (typeof PNL_PERIODS)[number];

export interface BlockchainTokenPnl {
  label: string;
  /** qty × (priceNow − priceThen) — USD. */
  pnl: number;
  /** qty × priceThen — USD basis. */
  basis: number;
}

export interface BlockchainPnlPeriod {
  /** Σ qty × priceNow — USD (today's holdings at today's prices). */
  usdNow: number;
  /** Σ qty × priceThen — USD (today's holdings at the period-start price). */
  usdThen: number;
  tokens: BlockchainTokenPnl[];
}

export interface BlockchainPnlSummary {
  byPeriod: Record<number, BlockchainPnlPeriod>;
  /** v1.4.17 — per-wallet breakdown (the one-line PnL under each wallet). */
  perWallet: Record<string, Record<number, BlockchainPnlPeriod>>;
  fetchedAt: number;
}

const klineCache = new Map<string, { at: number; closes: { t: number; c: number }[] }>();
const KLINE_TTL = 10 * 60_000;

const BINANCE_KLINE_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];

/** Daily closes for a Binance pair covering the last ~185 days (1 call). */
async function fetchDailyCloses(pair: string): Promise<{ t: number; c: number }[]> {
  const cached = klineCache.get(pair);
  if (cached && Date.now() - cached.at < KLINE_TTL) return cached.closes;
  const start = Date.now() - 186 * 86_400_000;
  let lastErr: unknown = null;
  for (const host of BINANCE_KLINE_HOSTS) {
    try {
      const k = await fetchJson<unknown[][]>(
        `${host}/api/v3/klines?symbol=${pair}&interval=1d&startTime=${start}&limit=1000`
      );
      const closes = k.map((c) => ({ t: Number(c[0]), c: parseFloat(String(c[4])) }));
      klineCache.set(pair, { at: Date.now(), closes });
      return closes;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('klines ناموفق');
}

/** v1.4.17 — CoinGecko daily closes (days=180; free API auto-daily >90d). */
const cgKlineCache = new Map<string, { at: number; closes: { t: number; c: number }[] }>();
async function fetchCgCloses(cgId: string): Promise<{ t: number; c: number }[]> {
  const cached = cgKlineCache.get(cgId);
  if (cached && Date.now() - cached.at < KLINE_TTL) return cached.closes;
  const d = await fetchJson<{ prices?: [number, number][] }>(
    `https://api.coingecko.com/api/v3/coins/${cgId}/market_chart?days=180`
  );
  const closes = (d?.prices ?? []).map(([t, p]) => ({ t, c: p }));
  cgKlineCache.set(cgId, { at: Date.now(), closes });
  return closes;
}

/** CG id lookup by symbol for tokens that carry no id (best-effort, cached). */
let cgSymbolIndex: { at: number; map: Map<string, string> } | null = null;
async function cgIdForSymbol(symbol: string): Promise<string | undefined> {
  if (!cgSymbolIndex || Date.now() - cgSymbolIndex.at > REGISTRY_TTL) {
    const coins = await fetchCgCoins().catch(() => null);
    const map = new Map<string, string>();
    for (const c of coins ?? []) {
      const s = (c.symbol ?? '').toUpperCase();
      if (s && !map.has(s)) map.set(s, c.id);
    }
    cgSymbolIndex = { at: Date.now(), map };
  }
  return cgSymbolIndex.map.get(symbol.toUpperCase());
}

function closeAtOrBefore(series: { t: number; c: number }[], target: number): number | null {
  if (series.length === 0) return null;
  if (target <= series[0].t) return series[0].c;
  let lo = 0;
  let hi = series.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (series[mid].t <= target) lo = mid;
    else hi = mid - 1;
  }
  return series[lo].c;
}

interface PnlEntry {
  key: string;
  symbol: string;
  qty: number;
  pair?: string;
  cgId?: string;
  stable: boolean;
}

/** Aggregate a wallet's holdings into price-source-keyed entries. */
function aggregateEntries(
  wallets: BlockchainWallet[],
  balanceByWallet: Record<string, BlockchainWalletData | undefined>,
  onlyWalletId?: string
): Map<string, PnlEntry> {
  const agg = new Map<string, PnlEntry>();
  for (const w of wallets) {
    if (onlyWalletId && w.id !== onlyWalletId) continue;
    const data = balanceByWallet[w.id];
    if (!data) continue;
    for (const t of data.tokens) {
      if (!(t.qty > 0)) continue;
      const key = t.binancePair ?? t.coingeckoId ?? t.symbol;
      const cur = agg.get(key) ?? {
        key,
        symbol: t.symbol,
        qty: 0,
        pair: t.binancePair,
        cgId: t.coingeckoId,
        stable: isStableSymbol(t.symbol),
      };
      cur.qty += t.qty;
      if (!cur.cgId && t.coingeckoId) cur.cgId = t.coingeckoId;
      agg.set(key, cur);
    }
  }
  return agg;
}

/** Adds one entry's period math into a period map. */
async function addEntryToPeriods(
  e: PnlEntry,
  byPeriod: Record<number, BlockchainPnlPeriod>,
  live: Record<string, BinancePriceEntry>
): Promise<{ series?: { t: number; c: number }[] }> {
  let series: { t: number; c: number }[] | undefined;
  if (!e.stable) {
    if (e.pair) {
      try {
        series = await fetchDailyCloses(e.pair);
      } catch {}
    }
    if (!series && e.cgId) {
      try {
        series = await fetchCgCloses(e.cgId);
      } catch {}
    }
    // v1.4.17 — Binance-less, id-less token (TOSHI/MOONKIN style): resolve
    // its CoinGecko id by symbol so its PnL history still works.
    if (!series && !e.pair && !e.cgId) {
      const id = await cgIdForSymbol(e.symbol).catch(() => undefined);
      if (id) {
        e.cgId = id;
        try {
          series = await fetchCgCloses(id);
        } catch {}
      }
    }
  }
  const nowPrice = e.stable
    ? 1
    : e.pair && live[e.pair]
      ? live[e.pair].price
      : series && series.length > 0
        ? series[series.length - 1].c
        : 0;
  for (const p of PNL_PERIODS) {
    // v1.5.12 — «امروز» = ابتدای روزِ محلی (۰۰:۰۰)؛ بقیه N روز به عقب.
    const target =
      p === 1
        ? (() => {
            const d = new Date();
            d.setHours(0, 0, 0, 0);
            return d.getTime();
          })()
        : Date.now() - p * 86_400_000;
    let thenPrice: number | null = null;
    if (e.stable) thenPrice = 1;
    else if (series) thenPrice = closeAtOrBefore(series, target);
    if (nowPrice <= 0 || thenPrice === null || thenPrice <= 0) continue;
    const per = byPeriod[p];
    const pnl = e.qty * (nowPrice - thenPrice);
    const basis = e.qty * thenPrice;
    per.usdNow += e.qty * nowPrice;
    per.usdThen += basis;
    const existing = per.tokens.find((x) => x.label === e.symbol);
    if (existing) {
      existing.pnl += pnl;
      existing.basis += basis;
    } else {
      per.tokens.push({ label: e.symbol, pnl, basis });
    }
  }
  return { series };
}

/**
 * Computes the market-change PnL of the CURRENT holdings over all four
 * periods at once — total AND per-wallet (v1.4.17). Same semantics as the
 * rial/metals PnL card: change of market value of what you hold today.
 */
export async function computeBlockchainPnl(
  wallets: BlockchainWallet[],
  balanceByWallet: Record<string, BlockchainWalletData | undefined>
): Promise<BlockchainPnlSummary> {
  const byPeriod: Record<number, BlockchainPnlPeriod> = {};
  for (const p of PNL_PERIODS) byPeriod[p] = { usdNow: 0, usdThen: 0, tokens: [] };
  const perWallet: Record<string, Record<number, BlockchainPnlPeriod>> = {};

  // live prices once for everything
  let live: Record<string, BinancePriceEntry> = {};
  try {
    live = (await getBinancePriceMap()).bySymbol;
  } catch {}

  // total across all wallets
  const totalEntries = [...aggregateEntries(wallets, balanceByWallet).values()].filter((e) => e.qty > 0);
  for (const e of totalEntries) {
    await addEntryToPeriods(e, byPeriod, live);
  }

  // per wallet (single-line PnL under each wallet card)
  for (const w of wallets) {
    const wp: Record<number, BlockchainPnlPeriod> = {};
    for (const p of PNL_PERIODS) wp[p] = { usdNow: 0, usdThen: 0, tokens: [] };
    const entries = [...aggregateEntries(wallets, balanceByWallet, w.id).values()].filter((e) => e.qty > 0);
    for (const e of entries) {
      await addEntryToPeriods(e, wp, live);
    }
    perWallet[w.id] = wp;
  }

  for (const p of PNL_PERIODS) {
    byPeriod[p].tokens.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
  }
  for (const w of Object.keys(perWallet)) {
    for (const p of PNL_PERIODS) {
      perWallet[w][p].tokens.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
    }
  }
  return { byPeriod, perWallet, fetchedAt: Date.now() };
}

/** v1.4.17 — helper: resolve CG ids for tokens that lack them (background). */
export async function ensureCgIds(tokens: BlockchainTokenBalance[]): Promise<void> {
  for (const t of tokens) {
    if (!t.coingeckoId && !t.binancePair && !isStableSymbol(t.symbol)) {
      const id = await cgIdForSymbol(t.symbol).catch(() => undefined);
      if (id) t.coingeckoId = id;
    }
  }
}
