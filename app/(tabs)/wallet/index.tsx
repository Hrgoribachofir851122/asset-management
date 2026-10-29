import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  TextInput,
  ActivityIndicator,
  Platform,
} from 'react-native';
import {
  Wallet,
  Plus,
  Trash2,
  RefreshCw,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronUp,
  Save,
  Key,
  ShieldAlert,
  DollarSign,
  TrendingUp,
  Mail,
  Bitcoin,
  Landmark,
  Sparkles,
  Link as LinkIcon,
  Info,
} from 'lucide-react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import CryptoJS from 'crypto-js';
import colors from '@/constants/colors';
import { createThemedStyles } from '@/utils/themeStyles';
import { EXCHANGE_LIST } from '@/constants/exchanges';
import { ExchangeId } from '@/types/crypto';
import DropdownPicker from '@/components/DropdownPicker';
import VpnWarningBanner from '@/components/VpnWarningBanner';
// v1.5.7 — همه پیغام‌ها با مودال درون‌برنامه‌ای هماهنگ با تم
import { ThemedAlert } from '@/components/ThemedAlert';
import { isForeignExchange, checkVpnStatus, VpnStatus } from '@/utils/vpnGuard';
import { isSanctionedIpMessage, sanctionedIpText } from '@/utils/geoBlock';
import { useApp } from '@/contexts/AppContext';
import { fetchUsdtTomanPrice, formatToman } from '@/utils/nobitexApi';
import { fetchArzinjaBalances } from '@/utils/arzinjaV2Api';
import {
  bitperpRequestOtp,
  bitperpVerifyOtp,
  bitperpRefresh,
  fetchBitperpAccount,
  fetchBitperpPositionHistory,
} from '@/utils/bitperpApi';
import { fetchForeignExchangeBalance } from '@/utils/foreignExchangeBalances';
import { fetchForeignPeriodPnl } from '@/utils/foreignExchangePnl';
import { exchangeNow, markClockStale } from '@/utils/exchangeClock';
import LocalAssetsSection from '@/components/LocalAssetsSection';
// v1.2.0 — کارت پیام IP تحریمی برای دو تب «کیف پول بلاکچین» و «ارز دیجیتال»
import IpBlockedNotice from '@/components/IpBlockedNotice';
import GoldPredictionSection from '@/components/GoldPredictionSection';
import BlockchainWalletsSection from '@/components/BlockchainWalletsSection';
import {
  BlockchainWallet,
  BlockchainWalletData,
  BlockchainNetwork,
  loadBlockchainWallets,
  saveBlockchainWallets,
  readBlockchainBalanceCache,
  removeBlockchainBalanceCache,
  validateAddressForNetworks,
} from '@/utils/blockchainWallets';
import {
  fetchBlockchainWalletData,
  computeBlockchainPnl,
} from '@/utils/blockchainWalletApi';
import {
  fetchTgjuCloses,
  closeAtOrBefore,
  TgjuHistorySymbol,
} from '@/utils/tgjuHistoryApi';

interface ExchangeWallet {
  id: string;
  exchangeId: ExchangeId;
  exchangeName: string;
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
  addedAt: number;
}

type WalletSection = 'spot' | 'earn' | 'funding' | 'futures' | 'alpha' | 'copy';

interface WalletBalance {
  asset: string;
  /** Which exchange account the asset lives in (اسپات/Earn/فاندینگ/فیوچرز/آلفا). */
  section?: WalletSection;
  free: number;
  locked: number;
  total: number;
  valueUsd: number;
  /** Average buy price from trade history (approximate cost basis). */
  avgCost?: number;
  /** Unrealized profit/loss for the held quantity (USD, approximate). */
  pnlUsd?: number;
  pnlPercent?: number;
}

interface FuturesPosition {
  symbol: string;
  positionSide: string;
  leverage: number;
  entryPrice: number;
  markPrice: number;
  notionalUsd: number;
  unrealizedPnl: number;
  roePercent: number;
}

interface ExchangeBalanceData {
  walletId: string;
  balances: WalletBalance[];
  totalValueUsd: number;
  lastUpdated: number;
  /** Open futures positions with unrealized PnL (Binance). */
  futuresPositions?: FuturesPosition[];
  futuresRealizedPnl?: number;
  futuresUnrealizedPnl?: number;
  /** Approximate total profit/loss of the whole exchange account. */
  totalPnlUsd?: number;
  /** Display note (e.g. approximation explanation). */
  pnlNote?: string;
}

// ---------------------------------------------------------------------------
// PnL periods (امروز / 30 / 90 / 180 / 360 روز) — per exchange, exchange-native data
// v1.5.12 — «تایم‌فریم امروز را در همه جای برنامه که در پی ان ال ها نداره بیار»
// ---------------------------------------------------------------------------

export type PnlPeriodDays = 1 | 30 | 90 | 180 | 360;
const PNL_PERIODS: PnlPeriodDays[] = [1, 30, 90, 180, 360];
const PNL_PERIOD_LABEL: Record<PnlPeriodDays, string> = {
  1: 'امروز',
  30: '۳۰ روز',
  90: '۹۰ روز',
  180: '۱۸۰ روز',
  360: '۳۶۰ روز',
};

/**
 * v1.5.12 — شروع بازه‌ی PnL: «امروز» = ابتدای روزِ محلی (۰۰:۰۰)؛ بقیه
 * بازه‌ها به اندازه‌ی N روز به عقب. همه‌ی صرافی‌ها از همین استفاده می‌کنند.
 */
function periodStartMs(days: PnlPeriodDays): number {
  if (days === 1) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return Date.now() - days * 86_400_000;
}

export interface PeriodPnl {
  periodDays: number;
  /** false → this exchange has no period-PnL API (a note is shown instead). */
  supported: boolean;
  unavailableReason?: string;
  /** Realized PnL of closed positions/contracts in the window. */
  realizedPnl: number;
  /** Funding fees paid/received in the window (futures). */
  fundingFees: number;
  /** Trading commissions in the window (futures). */
  commissions: number;
  /** Unrealized PnL of currently open positions (live). */
  unrealizedPnl: number;
  /** Number of closed positions counted in the window. */
  closedCount: number;
  note?: string;
}

const SECTION_LABEL: Record<WalletSection, string> = {
  spot: 'اسپات',
  earn: 'Earn (سپرده‌گذاری)',
  funding: 'فاندینگ',
  futures: 'فیوچرز',
  alpha: 'آلفا (Alpha)',
  copy: 'کپی‌تریدینگ',
};

function formatSignedUsd(value: number): string {
  const sign = value > 0 ? '+' : '';
  const abs = Math.abs(value);
  const digits = abs < 100 ? 2 : 0;
  return `${sign}$${abs.toLocaleString('en-US', { maximumFractionDigits: digits })}`;
}

const WALLETS_KEY = '@exchange_wallets';
const BALANCE_CACHE_PREFIX = '@wallet_balance_cache_';

/** Assets under this USD value are hidden from the lists (dust filter). */
const DUST_FILTER_USD = 1;

async function loadWallets(): Promise<ExchangeWallet[]> {
  try {
    const stored = await AsyncStorage.getItem(WALLETS_KEY);
    if (stored) return JSON.parse(stored);
  } catch (e) {
    console.log('[Wallet] Error loading wallets:', e);
  }
  return [];
}

/**
 * Last successful snapshot per exchange — shown instantly on screen entry.
 * v1.4.5: VALIDATES the parsed shape — a cache written by an older app
 * version (or a corrupted write) must never crash the render tree.
 */
async function readBalanceCache(walletId: string): Promise<ExchangeBalanceData | null> {
  try {
    const raw = await AsyncStorage.getItem(BALANCE_CACHE_PREFIX + walletId);
    if (raw) {
      const parsed = JSON.parse(raw) as ExchangeBalanceData | null;
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.walletId === 'string' &&
        Array.isArray(parsed.balances) &&
        typeof parsed.totalValueUsd === 'number' &&
        typeof parsed.lastUpdated === 'number'
      ) {
        // sanitize every row so .sort/.filter/.reduce can never throw
        parsed.balances = parsed.balances
          .filter((b) => b && typeof b.asset === 'string')
          .map((b) => ({
            ...b,
            free: Number(b.free) || 0,
            locked: Number(b.locked) || 0,
            total: Number(b.total) || 0,
            valueUsd: Number(b.valueUsd) || 0,
            section: b.section ?? 'spot',
          }));
        if (parsed.futuresPositions) {
          parsed.futuresPositions = parsed.futuresPositions.filter(
            (p) => p && typeof p.symbol === 'string'
          );
        }
        return parsed;
      }
      // invalid shape → drop the cache entry so it can't poison the app
      await AsyncStorage.removeItem(BALANCE_CACHE_PREFIX + walletId);
    }
  } catch {}
  return null;
}

async function writeBalanceCache(walletId: string, data: ExchangeBalanceData): Promise<void> {
  try {
    await AsyncStorage.setItem(BALANCE_CACHE_PREFIX + walletId, JSON.stringify(data));
  } catch {}
}

async function persistBitperpTokens(
  walletId: string,
  tokens: { accessToken: string; refreshToken: string }
): Promise<void> {
  try {
    const stored = await AsyncStorage.getItem(WALLETS_KEY);
    if (!stored) return;
    const wallets: ExchangeWallet[] = JSON.parse(stored);
    const idx = wallets.findIndex((w) => w.id === walletId);
    if (idx < 0) return;
    wallets[idx] = {
      ...wallets[idx],
      passphrase: tokens.accessToken,
      apiSecret: tokens.refreshToken,
    };
    await AsyncStorage.setItem(WALLETS_KEY, JSON.stringify(wallets));
  } catch (e) {
    console.log('[Wallet] persist bitperp tokens failed:', e);
  }
}

function signBinanceQuery(queryString: string, apiSecret: string): string {
  return CryptoJS.HmacSHA256(queryString, apiSecret).toString(CryptoJS.enc.Hex);
}

/**
 * Shared USD price map (asset -> USDT price) with a 60s cache — used to value
 * funding-wallet / Iranian-exchange assets that don't come with a USD value.
 * v1.4.17 — Binance FUTURES prices are merged in too: coins like POPCAT
 * trade ONLY on futures, so spot-only maps valued them at $0 and the dust
 * filter hid them («POPCAT نمایش داده نمی‌شود» — root fix).
 */
let usdPriceMapCache: { at: number; map: Record<string, number> } | null = null;

async function getUsdPriceMap(): Promise<Record<string, number>> {
  if (usdPriceMapCache && Date.now() - usdPriceMapCache.at < 60_000) {
    return usdPriceMapCache.map;
  }
  const map: Record<string, number> = {};
  try {
    const pricesRes = await fetch('https://api.binance.com/api/v3/ticker/price');
    if (pricesRes.ok) {
      const prices = await pricesRes.json();
      if (Array.isArray(prices)) {
        for (const p of prices) map[p.symbol] = parseFloat(p.price);
      }
    }
  } catch (e) {
    console.log('[Wallet] Price map fetch error:', e);
  }
  // v1.4.17 — futures tickers fill the gaps (spot-only coins stay as-is)
  try {
    const fRes = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
    if (fRes.ok) {
      const fPrices = await fRes.json();
      if (Array.isArray(fPrices)) {
        for (const p of fPrices) {
          const symbol: string = p.symbol;
          if (!symbol.endsWith('USDT')) continue;
          if (/(UP|DOWN|BULL|BEAR)USDT$/.test(symbol)) continue;
          if (!(symbol in map)) map[symbol] = parseFloat(p.price);
        }
      }
    }
  } catch (e) {
    console.log('[Wallet] Futures price map fetch error:', e);
  }
  usdPriceMapCache = { at: Date.now(), map };
  return map;
}

function stableCoinValueUsd(asset: string, amount: number): number | null {
  if (['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI'].includes(asset)) return amount;
  return null;
}

/**
 * v1.4.18 — BitPerp's OWN public market prices (keyless — from the live web
 * app bundle: GET /api/market-prices, auth:false). The exchange trades coins
 * Binance spot/futures doesn't list, so its own prices are tried FIRST; the
 * Binance spot+futures map fills the rest. Tolerant parse, 60s cache, silent
 * failure. (Ported from the GitHub v1.4.17 branch so nothing is lost.)
 */
let bitperpOwnPricesCache: { at: number; map: Record<string, number> } | null = null;

async function fetchBitperpOwnPrices(): Promise<Record<string, number>> {
  if (bitperpOwnPricesCache && Date.now() - bitperpOwnPricesCache.at < 60_000) {
    return bitperpOwnPricesCache.map;
  }
  const map: Record<string, number> = {};
  try {
    const res = await fetch('https://bitperp.com/api/market-prices', {
      headers: { Accept: 'application/json', 'ngrok-skip-browser-warning': 'true' },
    });
    if (res.ok) {
      const data: unknown = await res.json();
      const rows: unknown[] = Array.isArray(data)
        ? data
        : data && typeof data === 'object'
          ? (['data', 'prices', 'list', 'rows'] as const)
              .map((k) => (data as Record<string, unknown>)[k])
              .find((v): v is unknown[] => Array.isArray(v)) ?? []
          : [];
      for (const r of rows) {
        if (!r || typeof r !== 'object') continue;
        const rec = r as Record<string, unknown>;
        const sym = String(rec.symbol ?? rec.contract ?? rec.pair ?? rec.s ?? '').toUpperCase();
        const price = parseFloat(
          String(rec.price ?? rec.lastPrice ?? rec.markPrice ?? rec.last ?? rec.p ?? '')
        );
        if (sym && Number.isFinite(price) && price > 0) {
          map[sym] = price;
          if (!sym.endsWith('USDT') && !sym.endsWith('USDC')) map[`${sym}USDT`] = price;
        }
      }
    }
  } catch {}
  bitperpOwnPricesCache = { at: Date.now(), map };
  return map;
}

/**
 * Signed Binance request helper (HMAC SHA256). Each section is optional — a
 * missing permission / unsupported endpoint never breaks the whole overview.
 *
 * v1.4.10:
 *   1) The timestamp comes from Binance's own /api/v3/time (exchangeClock) —
 *      «موجودی یافت نشد» روی گوشی‌هایی که ساعتشان با سرور بایننس اختلاف
 *      دارد دیگر رخ نمی‌دهد (-1021 خارج از recvWindow بود).
 *   2) On required calls, TRANSIENT failures (-1021 timestamp, 429, 5xx,
 *      network) now THROW instead of returning null — react-query retries
 *      them (1.2s / 2.4s backoff) and the card shows the real reason instead
 *      of a fake «موجودی‌ای یافت نشد».
 */
async function binanceSigned<T>(
  url: string,
  wallet: ExchangeWallet,
  extra: Record<string, string> = {},
  method: 'GET' | 'POST' = 'GET',
  /** v1.4.6: when true (main spot-account call only), AUTH failures throw a
   * precise Persian error instead of silently returning null — the wallet card
   * then says WHY (invalid key) instead of showing a wrong empty portfolio. */
  required = false
): Promise<T | null> {
  try {
    const ts = await exchangeNow('binance');
    const params = new URLSearchParams({
      timestamp: String(ts),
      recvWindow: '30000',
      ...extra,
    });
    const signature = signBinanceQuery(params.toString(), wallet.apiSecret);
    const res = await fetch(`${url}?${params.toString()}&signature=${signature}`, {
      method,
      headers: { 'X-MBX-APIKEY': wallet.apiKey },
    });
    if (!res.ok) {
      const errData = (await res.json().catch(() => null)) as { code?: number; msg?: string } | null;
      console.log(`[Wallet] Binance ${url} -> ${res.status}`, errData);
      if (
        required &&
        (res.status === 401 || res.status === 403 || errData?.code === -2014 || errData?.code === -2015)
      ) {
        throw new Error(
          `کلید API بایننس معتبر نیست (${errData?.code ?? res.status}: ${errData?.msg ?? ''}) — کلید و Secret را در Binance → API Management بسازید و دسترسی «Enable Reading» بدهید`
        );
      }
      // v1.4.10 — timestamp drift: re-sync the clock so the react-query retry
      // fires with a correct stamp instead of the same wrong one.
      if (errData?.code === -1021 || errData?.code === -1022) {
        markClockStale('binance');
      }
      if (required) {
        // Transient (429/5xx/-1021) on the MAIN call → throw so react-query
        // retries with backoff; an empty success would lie to the user.
        throw new Error(
          `اتصال به بایننس موقتاً برقرار نشد (کد ${errData?.code ?? res.status}) — خودکار دوباره تلاش می‌شود`
        );
      }
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    // Re-throw our own precise Persian errors (thrown above inside try).
    if (e instanceof Error && /کلید|اتصال/.test(e.message)) throw e;
    if (required) {
      throw new Error(
        `اتصال به بایننس برقرار نشد — اینترنت/فیلترشکن را چک کنید (${e instanceof Error ? e.message : String(e)})`
      );
    }
    console.log(`[Wallet] Binance ${url} error:`, e);
    return null;
  }
}

/**
 * v1.4.3 — paginated rows reader for the Simple-Earn position endpoints.
 * The default page size is only 10, which silently HIDES earn assets when
 * the user has more products — the exact «بخش Earn همه دارایی‌هایش را نشان
 * نمی‌دهد» bug. We walk every page (up to 10 pages × 50 rows).
 */
async function binanceEarnRows<T>(
  path: string,
  wallet: ExchangeWallet,
  size = 50
): Promise<T[]> {
  const rows: T[] = [];
  let page = 1;
  for (;;) {
    const data = await binanceSigned<{ rows?: T[] }>(path, wallet, {
      current: String(page),
      size: String(size),
    });
    const pageRows = Array.isArray(data?.rows) ? data.rows : [];
    rows.push(...pageRows);
    if (pageRows.length < size || page >= 10) break;
    page++;
  }
  return rows;
}

interface MyTrade {
  id: number;
  price: string;
  qty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
}

/**
 * Approximate per-asset cost basis + unrealized PnL from spot trade history
 * (weighted-average method) — the same approach the Binance app uses for its
 * approximate PNL. Returns null for stablecoins / missing history.
 *
 * v1.4.8 fixes for «درصد سود/زیان همه ارزها نشان داده نمی‌شود»:
 *   • PAGINATION: myTrades is walked backwards via fromId (up to 5 pages =
 *     5000 trades) — assets with a long history previously only saw their
 *     most recent 1000 trades, so avgCost came out wrong or null.
 *   • QUOTE FALLBACK: if the asset has no USDT-pair trades, the FDUSD pair
 *     is tried too (FDUSD ≈ 1:1 USD → exact USD cost basis).
 */
async function computeAssetPnl(
  wallet: ExchangeWallet,
  asset: string,
  totalQty: number,
  currentPrice: number
): Promise<{ avgCost: number; pnlUsd: number; pnlPercent: number } | null> {
  const STABLES = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI'];
  if (STABLES.includes(asset) || totalQty <= 0 || currentPrice <= 0) return null;
  try {
    const quotes = ['USDT', 'FDUSD'];
    let trades: MyTrade[] | null = null;
    for (const quote of quotes) {
      // Walk pages backwards via fromId (myTrades returns ascending ids).
      const collected: MyTrade[] = [];
      let fromId: number | undefined = undefined;
      for (let page = 0; page < 5; page++) {
        const extra: Record<string, string> = { limit: '1000' };
        if (fromId !== undefined) extra.fromId = String(fromId);
        const batch = await binanceSigned<MyTrade[]>(
          'https://api.binance.com/api/v3/myTrades',
          wallet,
          { symbol: `${asset}${quote}`, ...extra }
        );
        if (!batch || batch.length === 0) break;
        collected.push(...batch);
        if (batch.length < 1000) break;
        const firstId = batch[0]?.id;
        if (typeof firstId !== 'number' || firstId <= 0) break;
        fromId = firstId - 1;
      }
      if (collected.length > 0) {
        trades = collected;
        break;
      }
    }
    if (!trades || trades.length === 0) return null;

    let qty = 0;
    let cost = 0;
    for (const t of trades) {
      const q = parseFloat(t.qty);
      const p = parseFloat(t.price);
      if (t.isBuyer) {
        qty += q;
        cost += q * p;
      } else {
        const avg = qty > 0 ? cost / qty : 0;
        const sellQty = Math.min(q, qty);
        qty -= sellQty;
        cost -= sellQty * avg;
      }
    }
    if (qty <= 0 || cost <= 0) return null;
    const avgCost = cost / qty;
    const heldQty = Math.min(totalQty, qty);
    const pnlUsd = (currentPrice - avgCost) * heldQty;
    const invested = avgCost * heldQty;
    const pnlPercent = invested > 0 ? (pnlUsd / invested) * 100 : 0;
    return { avgCost, pnlUsd, pnlPercent };
  } catch (e) {
    console.log(`[Wallet] myTrades error for ${asset}:`, e);
    return null;
  }
}

interface BinanceFullAccount {
  balances: WalletBalance[];
  futuresPositions: FuturesPosition[];
  futuresRealizedPnl: number;
  futuresUnrealizedPnl: number;
  totalPnlUsd: number;
}

/**
 * FULL Binance account overview: Spot + Earn (flexible & locked, ALL pages) +
 * Funding + Futures (balances, open positions, realized income) + Alpha —
 * with approximate per-asset PnL and a total PnL for the whole exchange.
 *
 * v1.4.3: the independent section requests now run in PARALLEL (they used to
 * be sequential — the #1 cause of the slow first load of the wallet screen).
 */
async function fetchBinanceFullAccount(wallet: ExchangeWallet): Promise<BinanceFullAccount> {
  const balances: WalletBalance[] = [];
  const futuresPositions: FuturesPosition[] = [];
  let futuresRealizedPnl = 0;
  let futuresUnrealizedPnl = 0;

  // ---- All independent sections in parallel ----
  const [spotData, earnFlexRows, earnLockedRows, fundData, alphaData, futBalances, positions] =
    await Promise.all([
      binanceSigned<{ balances?: Array<{ asset: string; free: string; locked: string }> }>(
        'https://api.binance.com/api/v3/account',
        wallet,
        {},
        'GET',
        true // required: invalid key → precise Persian error (v1.4.6)
      ),
      // Paginated → every earn product shows, not just the first page of 10.
      binanceEarnRows<{ asset?: string; totalAmount?: string; totalInUSDT?: string }>(
        'https://api.binance.com/sapi/v1/simple-earn/flexible/position',
        wallet
      ),
      binanceEarnRows<{ asset?: string; amount?: string; totalAmount?: string; totalInUSDT?: string }>(
        'https://api.binance.com/sapi/v1/simple-earn/locked/position',
        wallet
      ),
      binanceSigned<Array<{ asset: string; free: string; locked?: string }>>(
        'https://api.binance.com/sapi/v1/asset/get-funding-asset',
        wallet,
        {},
        'POST'
      ),
      binanceSigned<Array<{ asset?: string; balance?: string; walletType?: string }>>(
        'https://api.binance.com/sapi/v1/asset/wallet/balance',
        wallet,
        { walletType: 'ALPHA' }
      ),
      binanceSigned<Array<{ asset: string; balance: string; availableBalance: string; crossUnPnl?: string }>>(
        'https://fapi.binance.com/fapi/v2/balance',
        wallet
      ),
      binanceSigned<Array<{
        symbol: string; positionSide: string; leverage: string;
        entryPrice: string; markPrice: string; notional: string;
        unRealizedProfit: string; roePercent?: string; positionAmt: string;
      }>>('https://fapi.binance.com/fapi/v2/positionRisk', wallet),
    ]);

  // ---- Spot (api/v3/account) ----
  if (spotData?.balances) {
    for (const b of spotData.balances) {
      const free = parseFloat(b.free);
      const locked = parseFloat(b.locked);
      if (free > 0.0001 || locked > 0.0001) {
        balances.push({ asset: b.asset, section: 'spot', free, locked, total: free + locked, valueUsd: 0 });
      }
    }
  }

  // ---- Earn: Simple Earn flexible + locked positions (ALL pages) ----
  if (Array.isArray(earnFlexRows)) {
    for (const r of earnFlexRows) {
      const amount = parseFloat(r.totalAmount ?? '0');
      if (amount > 0.0001 && r.asset) {
        const valueUsd = parseFloat(r.totalInUSDT ?? '0');
        balances.push({
          asset: r.asset, section: 'earn', free: amount, locked: 0, total: amount,
          valueUsd: valueUsd > 0 ? valueUsd : 0,
        });
      }
    }
  }
  if (Array.isArray(earnLockedRows)) {
    for (const r of earnLockedRows) {
      const amount = parseFloat(r.amount ?? r.totalAmount ?? '0');
      if (amount > 0.0001 && r.asset) {
        const valueUsd = parseFloat(r.totalInUSDT ?? '0');
        const existing = balances.find((b) => b.section === 'earn' && b.asset === r.asset);
        if (existing) {
          existing.free += amount;
          existing.total += amount;
          existing.valueUsd += valueUsd;
        } else {
          balances.push({
            asset: r.asset, section: 'earn', free: amount, locked: 0, total: amount,
            valueUsd: valueUsd > 0 ? valueUsd : 0,
          });
        }
      }
    }
  }

  // ---- Funding wallet (sapi get-funding-asset, POST) ----
  if (Array.isArray(fundData)) {
    for (const b of fundData) {
      const free = parseFloat(b.free);
      const locked = parseFloat(b.locked ?? '0');
      if (free > 0.0001 || locked > 0.0001) {
        balances.push({ asset: b.asset, section: 'funding', free, locked, total: free + locked, valueUsd: 0 });
      }
    }
  }

  // ---- Alpha wallet (graceful — hidden when the API is unavailable) ----
  if (Array.isArray(alphaData)) {
    for (const b of alphaData) {
      const amount = parseFloat(b.balance ?? '0');
      if (amount > 0.0001 && b.asset) {
        balances.push({ asset: b.asset, section: 'alpha', free: amount, locked: 0, total: amount, valueUsd: 0 });
      }
    }
  }

  // ---- Futures: wallet balances ----
  if (Array.isArray(futBalances)) {
    for (const b of futBalances) {
      const balance = parseFloat(b.balance);
      if (balance > 0.001) {
        const available = parseFloat(b.availableBalance);
        const unPnl = parseFloat(b.crossUnPnl ?? '0');
        balances.push({
          asset: b.asset, section: 'futures',
          free: available, locked: Math.max(0, balance - available), total: balance,
          valueUsd: balance,
        });
        futuresUnrealizedPnl += unPnl;
      }
    }
  }

  // ---- Futures: open positions with unrealized PnL ----
  if (Array.isArray(positions)) {
    for (const p of positions) {
      const amt = Math.abs(parseFloat(p.positionAmt));
      if (amt <= 0) continue;
      futuresPositions.push({
        symbol: p.symbol,
        positionSide: p.positionSide,
        leverage: parseInt(p.leverage, 10) || 1,
        entryPrice: parseFloat(p.entryPrice),
        markPrice: parseFloat(p.markPrice),
        notionalUsd: Math.abs(parseFloat(p.notional)),
        unrealizedPnl: parseFloat(p.unRealizedProfit),
        roePercent: parseFloat(p.roePercent ?? '0'),
      });
    }
  }

  // ---- Futures: realized income (REALIZED_PNL, last 1000 records) ----
  const income = await binanceSigned<Array<{ incomeType: string; income: string; time: number }>>(
    'https://fapi.binance.com/fapi/v1/income',
    wallet,
    { incomeType: 'REALIZED_PNL', limit: '1000' }
  );
  if (Array.isArray(income)) {
    for (const row of income) futuresRealizedPnl += parseFloat(row.income);
  }

  // ---- USD pricing for spot / earn / funding / alpha + per-asset PnL ----
  try {
    const priceMap = await getUsdPriceMap();
    const derivedPrice = (asset: string): number => {
      const direct = priceMap[`${asset}USDT`];
      if (direct) return direct;
      const viaBtc = priceMap[`${asset}BTC`];
      if (viaBtc && priceMap['BTCUSDT']) return viaBtc * priceMap['BTCUSDT'];
      const viaBnb = priceMap[`${asset}BNB`];
      if (viaBnb && priceMap['BNBUSDT']) return viaBnb * priceMap['BNBUSDT'];
      return 0;
    };
    for (const bal of balances) {
      if (bal.valueUsd > 0) continue;
      const stable = stableCoinValueUsd(bal.asset, bal.total);
      if (stable !== null) {
        bal.valueUsd = stable;
      } else {
        const p = derivedPrice(bal.asset);
        if (p) bal.valueUsd = bal.total * p;
      }
    }

    const priceOf = (asset: string): number => {
      const stable = stableCoinValueUsd(asset, 1);
      if (stable !== null) return 1;
      const direct = priceMap[`${asset}USDT`];
      if (direct) return direct;
      // v1.4.8 — assets without a USDT pair (BTC/BNB-quoted listings) get
      // their price derived through the BTC/BNB pair so their VALUE and PnL%
      // can still be shown.
      const viaBtc = priceMap[`${asset}BTC`];
      if (viaBtc && priceMap['BTCUSDT']) return viaBtc * priceMap['BTCUSDT'];
      const viaBnb = priceMap[`${asset}BNB`];
      if (viaBnb && priceMap['BNBUSDT']) return viaBnb * priceMap['BNBUSDT'];
      return 0;
    };
    const nonFuturesAssets = new Set(
      balances.filter((b) => b.section !== 'futures').map((b) => b.asset)
    );
    // v1.4.8 — 25 → 40 assets (users with many holdings previously lost the
    // PnL% of everything after the 25th asset).
    const assetList = Array.from(nonFuturesAssets).slice(0, 40);
    const batchSize = 10;
    for (let i = 0; i < assetList.length; i += batchSize) {
      const batch = assetList.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (asset) => {
          const price = priceOf(asset);
          if (price <= 0) return;
          const totalQty = balances
            .filter((b) => b.asset === asset && b.section !== 'futures')
            .reduce((sum, b) => sum + b.total, 0);
          const pnl = await computeAssetPnl(wallet, asset, totalQty, price);
          if (!pnl) return;
          for (const b of balances) {
            if (b.asset === asset && b.section !== 'futures') {
              b.avgCost = pnl.avgCost;
              b.pnlUsd = pnl.pnlUsd * (b.total / Math.max(totalQty, 1e-12));
              b.pnlPercent = pnl.pnlPercent;
            }
          }
        })
      );
    }
  } catch (priceErr) {
    console.log('[Wallet] Price fetch error:', priceErr);
  }

  // ---- Total approximate PnL for the whole exchange ----
  const holdingPnl = balances
    .filter((b) => b.section !== 'futures')
    .reduce((sum, b) => sum + (b.pnlUsd ?? 0), 0);
  const totalPnlUsd = holdingPnl + futuresUnrealizedPnl + futuresRealizedPnl;

  return { balances, futuresPositions, futuresRealizedPnl, futuresUnrealizedPnl, totalPnlUsd };
}

// ---------------------------------------------------------------------------
// Binance period PnL — EXACTLY the numbers from Binance's own futures
// «PnL analysis» (realized PnL / funding / commission from /fapi/v1/income).
// ---------------------------------------------------------------------------

async function fetchBinancePeriodPnl(wallet: ExchangeWallet, days: PnlPeriodDays): Promise<PeriodPnl> {
  const startTime = periodStartMs(days);
  const income: Array<{ incomeType: string; income: string; time: number }> = [];

  // /fapi/v1/income returns newest-first (max 1000 per call) — walk endTime
  // backwards until the whole window is covered (up to 6 pages = 6000 rows).
  let endTime = Date.now();
  for (let i = 0; i < 6; i++) {
    const rows = await binanceSigned<Array<{ incomeType: string; income: string; time: number }>>(
      'https://fapi.binance.com/fapi/v1/income',
      wallet,
      { startTime: String(startTime), endTime: String(endTime), limit: '1000' }
    );
    if (!Array.isArray(rows) || rows.length === 0) break;
    income.push(...rows);
    if (rows.length < 1000) break;
    const oldest = rows[rows.length - 1]?.time;
    if (!oldest || oldest >= endTime) break;
    endTime = oldest - 1;
  }

  let realizedPnl = 0;
  let fundingFees = 0;
  let commissions = 0;
  let otherIncome = 0;
  for (const row of income) {
    const v = parseFloat(row.income);
    switch (row.incomeType) {
      case 'REALIZED_PNL':
        realizedPnl += v;
        break;
      case 'FUNDING_FEE':
        fundingFees += v;
        break;
      case 'COMMISSION':
      case 'LIMIT_MAKER':
      case 'LIMIT_TAKER':
      case 'MARKET_TAKER':
        commissions += v;
        break;
      default:
        otherIncome += v;
    }
  }

  // Live uPnL of open positions.
  let unrealizedPnl = 0;
  const positions = await binanceSigned<Array<{ positionAmt: string; unRealizedProfit: string }>>(
    'https://fapi.binance.com/fapi/v2/positionRisk',
    wallet
  );
  if (Array.isArray(positions)) {
    for (const p of positions) {
      if (Math.abs(parseFloat(p.positionAmt)) > 0) {
        unrealizedPnl += parseFloat(p.unRealizedProfit);
      }
    }
  }

  // ---- v1.4.8: SPOT realized PnL inside the window ----
  // Previously this function ONLY read the futures income endpoint — a
  // spot-only account answered with an EMPTY result («بایننس خالی نشان می‌دهد»).
  // Now the spot trade history of every HELD asset (USDT & FDUSD pairs) is
  // replayed: every SELL inside the window is valued against the running
  // average buy cost (weighted-average method) → realized spot PnL + the
  // USDT part of the spot commissions. Best-effort: trades of assets that
  // were fully sold-and-removed (no current balance) can't be discovered via
  // the symbol-scoped myTrades endpoint.
  let spotRealized = 0;
  let spotCommissions = 0;
  let spotSells = 0;
  try {
    const spotAccount = await binanceSigned<{
      balances?: Array<{ asset: string; free: string; locked: string }>;
    }>('https://api.binance.com/api/v3/account', wallet);
    const held = (spotAccount?.balances ?? [])
      .map((b) => b.asset)
      .filter((a) => !['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI', 'BNB'].includes(a))
      .slice(0, 15);

    // v1.4.9 — the myTrades calls for every held asset were SEQUENTIAL (up to
    // 30 requests back-to-back through the VPN) — one slow asset stalled the
    // whole PnL card. Now they run in batches of 5 in parallel with a 25s
    // overall budget (futures numbers are already in by then; spot PnL is
    // best-effort and must never hold the card hostage).
    const spotDeadline = Date.now() + 25_000;
    const BATCH = 5;
    for (let i = 0; i < held.length; i += BATCH) {
      if (Date.now() > spotDeadline) break;
      const batch = held.slice(i, i + BATCH);
      await Promise.all(
        batch.map(async (asset) => {
          for (const quote of ['USDT', 'FDUSD']) {
            const trades = await binanceSigned<MyTrade[]>(
              'https://api.binance.com/api/v3/myTrades',
              wallet,
              { symbol: `${asset}${quote}`, startTime: String(startTime), limit: '1000' }
            );
            if (!trades || trades.length === 0) continue;

            let qty = 0;
            let cost = 0;
            for (const t of trades) {
              const q = parseFloat(t.qty);
              const p = parseFloat(t.price);
              // commission (USDT-quoted trades charge commission in the quote or
              // BNB; only the quote part is USD-exact — BNB fees are ignored).
              const comm = parseFloat(t.commission ?? '0');
              if (t.commissionAsset === quote) spotCommissions -= comm;

              if (t.isBuyer) {
                qty += q;
                cost += q * p;
              } else {
                const avg = qty > 0 ? cost / qty : 0;
                const sellQty = Math.min(q, qty);
                qty -= sellQty;
                cost -= sellQty * avg;
                spotRealized += (p - avg) * sellQty;
                spotSells++;
              }
            }
            break; // first quote with trades is enough
          }
        })
      );
    }
  } catch (e) {
    console.log('[Wallet] Spot period PnL (best-effort) failed:', e);
  }

  return {
    periodDays: days,
    supported: true,
    realizedPnl: realizedPnl + otherIncome + spotRealized,
    fundingFees,
    commissions: commissions + spotCommissions,
    unrealizedPnl,
    closedCount:
      income.filter((r) => r.incomeType === 'REALIZED_PNL').length + spotSells,
    note: 'فیوچرز: دقیقاً از درآمد بایننس (مثل PnL Analysis خود صرافی) + اسپات: فروش‌های داخل بازه بر اساس میانگین خرید (تقریبی)',
  };
}
// ---------------------------------------------------------------------------
// Bybit — balance (+ best-effort Earn) + closed-PnL per period
// ---------------------------------------------------------------------------

async function fetchBybitBalance(wallet: ExchangeWallet): Promise<WalletBalance[]> {
  const balances: WalletBalance[] = [];
  const timestamp = Date.now().toString();
  const recvWindow = '10000';
  const accountType = 'UNIFIED';

  try {
    const queryString = `accountType=${accountType}`;
    const preSign = `${timestamp}${wallet.apiKey}${recvWindow}${queryString}`;
    const signature = CryptoJS.HmacSHA256(preSign, wallet.apiSecret).toString(CryptoJS.enc.Hex);

    const response = await fetch(
      `https://api.bybit.com/v5/account/wallet-balance?${queryString}`,
      {
        headers: {
          'X-BAPI-API-KEY': wallet.apiKey,
          'X-BAPI-SIGN': signature,
          'X-BAPI-SIGN-TYPE': '2',
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-RECV-WINDOW': recvWindow,
        },
      }
    );

    if (response.ok) {
      const data = (await response.json()) as {
        retCode?: number;
        retMsg?: string;
        result?: { list?: Array<{ coin?: Array<{ coin?: string; walletBalance?: string; availableToWithdraw?: string; usdValue?: string }> }> };
      };
      // v1.4.6 — Bybit answers HTTP 200 with retCode !== 0 on auth failures;
      // surfacing the exact error instead of a silent empty portfolio.
      if (Number(data?.retCode ?? 0) !== 0) {
        const code = Number(data?.retCode ?? 0);
        const isAuth = [10003, 10005, 10007, 10013].includes(code);
        throw new Error(
          isAuth
            ? `کلید بای‌بیت معتبر نیست (کد ${code}: ${data?.retMsg ?? ''}) — کلید و Secret را در Bybit → API بسازید و دسترسی read-only بدهید`
            : `خطای Bybit (کد ${code}): ${data?.retMsg ?? ''}`
        );
      }
      const accounts = data?.result?.list;
      if (Array.isArray(accounts)) {
        for (const account of accounts) {
          const coins = account?.coin;
          if (Array.isArray(coins)) {
            for (const c of coins) {
              const total = parseFloat(c.walletBalance || '0');
              const free = parseFloat(c.availableToWithdraw || '0');
              if (total > 0.0001) {
                balances.push({
                  asset: c.coin ?? '',
                  free,
                  locked: total - free,
                  total,
                  valueUsd: parseFloat(c.usdValue || '0'),
                });
              }
            }
          }
        }
      }
    } else {
      throw new Error(
        `خطای شبکه بای‌بیت (HTTP ${response.status}) — اینترنت/فیلترشکن را چک کنید`
      );
    }
  } catch (e) {
    // v1.4.6 — re-throw our precise Persian errors; wrap network errors.
    if (e instanceof Error && /بای‌بیت|Bybit|اتصال/.test(e.message)) throw e;
    throw new Error(
      `اتصال به بای‌بیت برقرار نشد — اینترنت/فیلترشکن را چک کنید (${e instanceof Error ? e.message : String(e)})`
    );
  }

  // Funding wallet — the UNIFIED query above misses the funding balance.
  try {
    const fundQuery = 'accountType=FUND';
    const fundPreSign = `${timestamp}${wallet.apiKey}${recvWindow}${fundQuery}`;
    const fundSignature = CryptoJS.HmacSHA256(fundPreSign, wallet.apiSecret).toString(
      CryptoJS.enc.Hex
    );
    const fundResponse = await fetch(
      `https://api.bybit.com/v5/asset/transfer/query-account-coins-balance?${fundQuery}`,
      {
        headers: {
          'X-BAPI-API-KEY': wallet.apiKey,
          'X-BAPI-SIGN': fundSignature,
          'X-BAPI-SIGN-TYPE': '2',
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-RECV-WINDOW': recvWindow,
        },
      }
    );
    if (fundResponse.ok) {
      const fundData = await fundResponse.json();
      const fundAccounts = fundData?.result?.list;
      if (Array.isArray(fundAccounts)) {
        for (const account of fundAccounts) {
          const coins = account?.coin;
          if (Array.isArray(coins)) {
            for (const c of coins) {
              const total = parseFloat(c.walletBalance || '0');
              if (total > 0.0001) {
                balances.push({
                  asset: c.coin,
                  section: 'funding',
                  free: parseFloat(c.transferBalance || c.walletBalance || '0'),
                  locked: total - parseFloat(c.transferBalance || c.walletBalance || '0'),
                  total,
                  valueUsd: parseFloat(c.usdValue || '0'),
                });
              }
            }
          }
        }
      }
    }
  } catch (e) {
    console.log('[Wallet] Bybit funding fetch error:', e);
  }

  // v1.4.3 — Bybit Earn (best-effort): the app previously ignored earn assets.
  // Tries the earn order endpoint; silently skipped when unavailable/empty.
  try {
    const earnQuery = 'category=flexible&limit=50';
    const earnPreSign = `${timestamp}${wallet.apiKey}${recvWindow}${earnQuery}`;
    const earnSignature = CryptoJS.HmacSHA256(earnPreSign, wallet.apiSecret).toString(
      CryptoJS.enc.Hex
    );
    const earnRes = await fetch(`https://api.bybit.com/v5/earn/order?${earnQuery}`, {
      headers: {
        'X-BAPI-API-KEY': wallet.apiKey,
        'X-BAPI-SIGN': earnSignature,
        'X-BAPI-SIGN-TYPE': '2',
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recvWindow,
      },
    });
    if (earnRes.ok) {
      const earnData = await earnRes.json();
      const list = earnData?.result?.list;
      if (Array.isArray(list)) {
        for (const item of list) {
          const asset = String(item.coin ?? item.asset ?? '').toUpperCase();
          const amount = parseFloat(
            String(item.amount ?? item.activeAmount ?? item.holdAmount ?? '0')
          );
          if (asset && amount > 0.0001) {
            balances.push({
              asset,
              section: 'earn',
              free: amount,
              locked: 0,
              total: amount,
              valueUsd: 0,
            });
          }
        }
      }
    }
  } catch (e) {
    console.log('[Wallet] Bybit earn fetch error:', e);
  }

  // Value the assets that came back without a USD value (funding/earn coins).
  try {
    const priceMap = await getUsdPriceMap();
    for (const bal of balances) {
      if (bal.valueUsd > 0) continue;
      const stable = stableCoinValueUsd(bal.asset, bal.total);
      if (stable !== null) {
        bal.valueUsd = stable;
      } else if (priceMap[`${bal.asset}USDT`]) {
        bal.valueUsd = bal.total * priceMap[`${bal.asset}USDT`];
      }
    }
  } catch {}

  return balances;
}

async function fetchBybitPeriodPnl(wallet: ExchangeWallet, days: PnlPeriodDays): Promise<PeriodPnl> {
  const startTime = periodStartMs(days);
  let closedPnlSum = 0;
  let closedCount = 0;

  // /v5/position/closed-pnl — the exact numbers behind Bybit's own
  // «Closed PnL» history page (cursor-paginated, 200 per page).
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const qs =
      `category=linear&startTime=${startTime}&endTime=${Date.now()}&limit=200` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const timestamp = Date.now().toString();
    const recvWindow = '10000';
    const preSign = `${timestamp}${wallet.apiKey}${recvWindow}${qs}`;
    const signature = CryptoJS.HmacSHA256(preSign, wallet.apiSecret).toString(CryptoJS.enc.Hex);
    try {
      const res = await fetch(`https://api.bybit.com/v5/position/closed-pnl?${qs}`, {
        headers: {
          'X-BAPI-API-KEY': wallet.apiKey,
          'X-BAPI-SIGN': signature,
          'X-BAPI-SIGN-TYPE': '2',
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-RECV-WINDOW': recvWindow,
        },
      });
      if (!res.ok) break;
      const data = await res.json();
      const list = data?.result?.list;
      if (!Array.isArray(list) || list.length === 0) break;
      for (const item of list) {
        closedPnlSum += parseFloat(item.closedPnl ?? '0');
        closedCount++;
      }
      cursor = String(data?.result?.nextPageCursor ?? '');
      if (!cursor || cursor === 'NONE') break;
    } catch (e) {
      console.log('[Wallet] Bybit closed-pnl page error:', e);
      break;
    }
  }

  // Live uPnL of open linear positions.
  let unrealizedPnl = 0;
  try {
    const qs = 'category=linear&limit=200';
    const timestamp = Date.now().toString();
    const recvWindow = '10000';
    const preSign = `${timestamp}${wallet.apiKey}${recvWindow}${qs}`;
    const signature = CryptoJS.HmacSHA256(preSign, wallet.apiSecret).toString(CryptoJS.enc.Hex);
    const res = await fetch(`https://api.bybit.com/v5/position/list?${qs}`, {
      headers: {
        'X-BAPI-API-KEY': wallet.apiKey,
        'X-BAPI-SIGN': signature,
        'X-BAPI-SIGN-TYPE': '2',
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recvWindow,
      },
    });
    if (res.ok) {
      const data = await res.json();
      const list = data?.result?.list;
      if (Array.isArray(list)) {
        for (const p of list) {
          if (String(p.positionValue ?? '0') !== '0' && parseFloat(String(p.size ?? '0')) !== 0) {
            unrealizedPnl += parseFloat(String(p.unrealisedPnl ?? '0'));
          }
        }
      }
    }
  } catch {}

  return {
    periodDays: days,
    supported: true,
    realizedPnl: closedPnlSum,
    fundingFees: 0,
    commissions: 0,
    unrealizedPnl,
    closedCount,
    note: 'دقیقاً از تاریخچه Closed PnL خود بای‌بیت (معاملات فیوچرز linear)',
  };
}

// ---------------------------------------------------------------------------
// OKX — balance (+ savings/Earn) + positions-history PnL per period
// ---------------------------------------------------------------------------

function okxHeaders(
  wallet: ExchangeWallet,
  timestamp: string,
  method: string,
  requestPath: string
): Record<string, string> {
  const preSign = `${timestamp}${method}${requestPath}`;
  const signature = CryptoJS.enc.Base64.stringify(CryptoJS.HmacSHA256(preSign, wallet.apiSecret));
  return {
    'OK-ACCESS-KEY': wallet.apiKey,
    'OK-ACCESS-SIGN': signature,
    'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-PASSPHRASE': wallet.passphrase || '',
  };
}

async function fetchOkxBalance(wallet: ExchangeWallet): Promise<WalletBalance[]> {
  const balances: WalletBalance[] = [];
  const timestamp = new Date().toISOString();

  try {
    const requestPath = '/api/v5/account/balance';
    const response = await fetch(`https://www.okx.com${requestPath}`, {
      headers: okxHeaders(wallet, timestamp, 'GET', requestPath),
    });

    if (response.ok) {
      const data = (await response.json()) as {
        code?: string;
        msg?: string;
        data?: Array<{ details?: Array<{ ccy?: string; cashBal?: string; availBal?: string; eqUsd?: string }> }>;
      };
      // v1.4.6 — OKX answers HTTP 200 even for auth failures (code !== '0');
      // previously this silently returned an EMPTY portfolio which looked like
      // «no assets» with no explanation. Now the exact OKX error is surfaced.
      if (String(data?.code ?? '0') !== '0') {
        const code = String(data?.code ?? '');
        const isAuth = ['50113', '50110', '50111', '50112'].includes(code);
        throw new Error(
          isAuth
            ? `کلید OKX معتبر نیست (کد ${code}: ${data?.msg ?? ''}) — کلید/Secret/Passphrase را چک کنید؛ Passphrase همان رمز دلخواهی است که موقع ساخت کلید در OKX وارد کردید`
            : `خطای OKX (کد ${code}): ${data?.msg ?? ''}`
        );
      }
      const details = data?.data?.[0]?.details;
      if (Array.isArray(details)) {
        for (const d of details) {
          const total = parseFloat(d.cashBal || '0');
          const free = parseFloat(d.availBal || '0');
          if (total > 0.0001) {
            balances.push({
              asset: d.ccy ?? '',
              free,
              locked: total - free,
              total,
              valueUsd: parseFloat(d.eqUsd || '0'),
            });
          }
        }
      }
    } else {
      throw new Error(
        `خطای شبکه OKX (HTTP ${response.status}) — اینترنت/فیلترشکن را چک کنید`
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('OKX')) throw e;
    throw new Error(
      `اتصال به OKX برقرار نشد — اینترنت/فیلترشکن را چک کنید (${e instanceof Error ? e.message : String(e)})`
    );
  }

  // Funding wallet — the trading-account query above misses funding assets.
  try {
    const fundPath = '/api/v5/asset/balances';
    const fundResponse = await fetch(`https://www.okx.com${fundPath}`, {
      headers: okxHeaders(wallet, timestamp, 'GET', fundPath),
    });
    if (fundResponse.ok) {
      const fundData = await fundResponse.json();
      const fundDetails = fundData?.data;
      if (Array.isArray(fundDetails)) {
        for (const d of fundDetails) {
          const total = parseFloat(d.bal || '0');
          const free = parseFloat(d.availBal || '0');
          if (total > 0.0001) {
            balances.push({
              asset: d.ccy,
              section: 'funding',
              free,
              locked: total - free,
              total,
              valueUsd: 0,
            });
          }
        }
      }
    }
  } catch (e) {
    console.log('[Wallet] OKX funding fetch error:', e);
  }

  // v1.4.3 — OKX Savings (Earn): /api/v5/finance/savings/balance. Previously
  // the earn section stayed EMPTY for OKX — the «بخش Earn خالی است» bug.
  try {
    const savingsPath = '/api/v5/finance/savings/balance';
    const savingsRes = await fetch(`https://www.okx.com${savingsPath}`, {
      headers: okxHeaders(wallet, timestamp, 'GET', savingsPath),
    });
    if (savingsRes.ok) {
      const savingsData = await savingsRes.json();
      const rows = savingsData?.data;
      if (Array.isArray(rows)) {
        for (const d of rows) {
          const amount = parseFloat(String(d.amt ?? '0'));
          const asset = String(d.ccy ?? '').toUpperCase();
          if (asset && amount > 0.0001) {
            const existing = balances.find((b) => b.section === 'earn' && b.asset === asset);
            if (existing) {
              existing.free += amount;
              existing.total += amount;
            } else {
              balances.push({
                asset,
                section: 'earn',
                free: amount,
                locked: 0,
                total: amount,
                valueUsd: 0,
              });
            }
          }
        }
      }
    }
  } catch (e) {
    console.log('[Wallet] OKX savings fetch error:', e);
  }

  // Value assets that came back without a USD value (funding/savings coins).
  try {
    const priceMap = await getUsdPriceMap();
    for (const bal of balances) {
      if (bal.valueUsd > 0) continue;
      const stable = stableCoinValueUsd(bal.asset, bal.total);
      if (stable !== null) {
        bal.valueUsd = stable;
      } else if (priceMap[`${bal.asset}USDT`]) {
        bal.valueUsd = bal.total * priceMap[`${bal.asset}USDT`];
      }
    }
  } catch {}

  return balances;
}

async function fetchOkxPeriodPnl(wallet: ExchangeWallet, days: PnlPeriodDays): Promise<PeriodPnl> {
  const windowStart = periodStartMs(days);
  let realizedPnl = 0;
  let closedCount = 0;

  // /api/v5/account/positions-history — OKX's own position history
  // (instId-independent when instType is given per instrument family).
  for (const instType of ['SWAP', 'FUTURES']) {
    let after = Date.now();
    for (let page = 0; page < 6; page++) {
      const requestPath = `/api/v5/account/positions-history?instType=${instType}&after=${after}&limit=100`;
      try {
        const res = await fetch(`https://www.okx.com${requestPath}`, {
          headers: okxHeaders(wallet, new Date().toISOString(), 'GET', requestPath),
        });
        if (!res.ok) break;
        const data = await res.json();
        const rows = data?.data;
        if (!Array.isArray(rows) || rows.length === 0) break;
        for (const r of rows) {
          const uTime = Number(r.uTime ?? 0);
          if (uTime && uTime < windowStart) continue;
          realizedPnl += parseFloat(String(r.pnl ?? r.realizedPnl ?? '0'));
          closedCount++;
        }
        if (rows.length < 100) break;
        const oldest = Number(rows[rows.length - 1]?.uTime ?? 0);
        if (!oldest || oldest >= after) break;
        after = oldest - 1;
      } catch (e) {
        console.log('[Wallet] OKX positions-history page error:', e);
        break;
      }
    }
  }

  // Live uPnL of open positions.
  let unrealizedPnl = 0;
  try {
    const requestPath = '/api/v5/account/positions';
    const res = await fetch(`https://www.okx.com${requestPath}`, {
      headers: okxHeaders(wallet, new Date().toISOString(), 'GET', requestPath),
    });
    if (res.ok) {
      const data = await res.json();
      const rows = data?.data;
      if (Array.isArray(rows)) {
        for (const p of rows) {
          unrealizedPnl += parseFloat(String(p.upl ?? '0'));
        }
      }
    }
  } catch {}

  return {
    periodDays: days,
    supported: true,
    realizedPnl,
    fundingFees: 0,
    commissions: 0,
    unrealizedPnl,
    closedCount,
    note:
      days > 90
        ? 'OKX سابقه پوزیشن‌ها را حدود ۹۰ روز نگه می‌دارد — برای بازه‌های بلندتر فقط ۹۰ روز آخر قابل محاسبه است'
        : 'دقیقاً از تاریخچه پوزیشن خود OKX (فیوچرز و سواپ)',
  };
}

// ---------------------------------------------------------------------------
// Nobitex (نوبیتکس) — v1.4.7: apiv2.nobitex.ir (old api.nobitex.ir is NXDOMAIN).
// Arzinja moved to its OWN v2 API (arzinjaV2Api.ts) and no longer shares this
// fetcher — the two platforms are NOT compatible.
// ---------------------------------------------------------------------------

async function fetchNobitexBalance(wallet: ExchangeWallet): Promise<WalletBalance[]> {
  const balances: WalletBalance[] = [];
  const bases = ['https://apiv2.nobitex.ir'];

  // The wallet's OWN apiKey/apiSecret — a Nobitex API token is a single string,
  // so both "Token key" and "Token key:secret" shapes are tried (the user may
  // paste the whole token into either field).
  const authVariants: Array<Record<string, string>> = [];
  const k = wallet.apiKey?.trim() ?? '';
  const s = wallet.apiSecret?.trim() ?? '';
  if (k && s) {
    authVariants.push({ Authorization: `Token ${k}:${s}` });
    authVariants.push({ Authorization: `Token ${k}` });
    authVariants.push({ Authorization: `ApiKey ${k}:${s}` });
  } else if (k) {
    authVariants.push({ Authorization: `Token ${k}` });
  }

  let walletsPayload: unknown = null;
  let lastError = 'unknown';

  // v1.4.5: 12s timeout per attempt — no more multi-minute hangs.
  for (const base of bases) {
    for (const headers of authVariants) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12_000);
        let response: Response;
        try {
          response = await fetch(`${base}/users/wallets/list`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({ tokens: 'all' }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (response.ok) {
          const data = await response.json();
          if (data?.wallets) {
            walletsPayload = data;
            break;
          }
          if (data?.balances) {
            walletsPayload = { wallets: Object.entries(data.balances).map(([currency, balance]) => ({
              currency,
              balance: String(balance),
              blockedBalance: '0',
            })) };
            break;
          }
        } else {
          lastError = `HTTP ${response.status}`;
          // 401/403 → this key pair is rejected; stop retrying IT, not everything.
        }
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    if (walletsPayload) break;
  }

  if (!walletsPayload) {
    throw new Error(
      `دریافت موجودی ${wallet.exchangeName} ناموفق بود (${lastError}). توکن API نوبیتکس را از پنل نوبیتکس → بخش API بسازید و دقیقاً همان توکن را وارد کنید.`
    );
  }

  // Value Toman balances at the live USDT/Toman rate.
  let usdtToToman = 0;
  try {
    usdtToToman = (await fetchUsdtTomanPrice()).usdtToToman;
  } catch {}

  const payload = walletsPayload as {
    wallets?: Array<{ currency?: string; balance?: string; blockedBalance?: string }>;
  };

  for (const w of payload.wallets ?? []) {
    const currency = (w.currency ?? '').toLowerCase();
    const free = parseFloat(w.balance ?? '0');
    const locked = parseFloat(w.blockedBalance ?? '0');
    const total = free + locked;
    if (!currency || total <= 0) continue;

    if (currency === 'rls' || currency === 'irt') {
      const toman = currency === 'rls' ? total / 10 : total;
      const valueUsd = usdtToToman > 0 ? toman / usdtToToman : 0;
      balances.push({
        asset: 'تومان',
        free: currency === 'rls' ? free / 10 : free,
        locked: currency === 'rls' ? locked / 10 : locked,
        total: toman,
        valueUsd,
      });
    } else {
      const assetName = currency === 'usdt' ? 'تتر' : currency.toUpperCase();
      const priceMap = await getUsdPriceMap();
      const stable = currency === 'usdt' ? total : stableCoinValueUsd(currency.toUpperCase(), total);
      const valueUsd = stable !== null ? stable : (priceMap[`${currency.toUpperCase()}USDT`] ?? 0) * total;
      balances.push({
        asset: assetName,
        free,
        locked,
        total,
        valueUsd,
      });
    }
  }

  return balances;
}

// ---------------------------------------------------------------------------
// Arzinja (ارزینجا) — v1.4.7: the REAL API v2 (api-v2.arzinja.app, signed
// X-ARZ-* headers). The previous «Nobitex-compatible» calls hit a domain that
// no longer resolves (api.arzinja.ir → NXDOMAIN) which is exactly why the
// wallet always failed while the key itself was perfectly valid + read-only.
// ---------------------------------------------------------------------------

async function fetchArzinjaWalletBalance(wallet: ExchangeWallet): Promise<WalletBalance[]> {
  const rows = await fetchArzinjaBalances(wallet.apiKey, wallet.apiSecret);
  if (rows.length === 0) return [];

  // Fiat (IRT) rows are priced at the live tether rate, like the Toman row
  // of the Nobitex fetcher above.
  let usdtToToman = 0;
  try {
    usdtToToman = (await fetchUsdtTomanPrice()).usdtToToman;
  } catch {}

  const priceMap = await getUsdPriceMap().catch(() => ({}) as Record<string, number>);

  const balances: WalletBalance[] = [];
  for (const row of rows) {
    if (row.isFiat || row.asset === 'IRT' || row.asset === 'IRR') {
      const toman = row.asset === 'IRR' ? row.total / 10 : row.total;
      const valueUsd = usdtToToman > 0 ? toman / usdtToToman : 0;
      if (toman <= 0) continue;
      balances.push({
        asset: 'تومان',
        free: row.asset === 'IRR' ? row.free / 10 : row.free,
        locked: row.asset === 'IRR' ? row.locked / 10 : row.locked,
        total: toman,
        valueUsd,
        section: 'spot',
      });
      continue;
    }
    const assetName = row.asset === 'USDT' ? 'تتر' : row.asset;
    const stable = row.asset === 'USDT' ? row.total : stableCoinValueUsd(row.asset, row.total);
    const valueUsd =
      row.valueUsd > 0
        ? row.valueUsd
        : stable !== null
          ? stable
          : (priceMap[`${row.asset}USDT`] ?? 0) * row.total;
    balances.push({
      asset: assetName,
      free: row.free,
      locked: row.locked,
      total: row.total,
      valueUsd,
      section: 'spot',
    });
  }
  return balances;
}

// ---------------------------------------------------------------------------
// BitPerp (بیت‌پرپ) — JWT auth (email OTP), auto-refresh, balances + PnL
// ---------------------------------------------------------------------------

/**
 * v1.4.7 — the wallet object is MUTATED after a successful token refresh
 * (passphrase=access, apiSecret=refresh) IN ADDITION to persisting to
 * AsyncStorage. Previously only AsyncStorage was updated, but the in-memory
 * `wallets` react-query cache kept the OLD (already-consumed, single-use)
 * refresh token — every subsequent balance fetch then failed the rotation
 * and wrongly reported «نشست منقضی شده» even though the session was alive.
 * Mutating the shared object keeps the session stable for the whole app run.
 */
async function bitperpRotateTokens(
  wallet: ExchangeWallet,
  tokens: { accessToken: string; refreshToken: string }
): Promise<void> {
  wallet.passphrase = tokens.accessToken;
  wallet.apiSecret = tokens.refreshToken;
  await persistBitperpTokens(wallet.id, tokens);
}

async function fetchBitperpBalance(wallet: ExchangeWallet): Promise<WalletBalance[]> {
  let account = await fetchBitperpAccount(wallet.passphrase ?? '');

  if (account.authFailed && wallet.apiSecret) {
    const refresh = await bitperpRefresh(wallet.apiSecret);
    if (refresh.ok && refresh.tokens) {
      await bitperpRotateTokens(wallet, refresh.tokens);
      account = await fetchBitperpAccount(refresh.tokens.accessToken);
    } else if (refresh.kind === 'transient') {
      // v1.4.7 — network hiccup ≠ expired session. The web app does the same
      // (keeps the session, surfaces a retryable network error).
      throw new Error(
        `اتصال به بیت‌پرپ برقرار نشد (${refresh.error ?? 'خطای شبکه'}) — فیلترشکن/اینترنت را چک کنید و دوباره تازه‌سازی بزنید`
      );
    }
  }

  if (account.authFailed) {
    throw new Error(
      'نشست BitPerp منقضی شده است — صرافی «بیت‌پرپ» را از لیست حذف کنید و دوباره با ایمیل و کد یکبارمصرف اضافه کنید (دکمه «دریافت کد» در فرم افزودن).'
    );
  }

  // v1.4.7 — HTTP 200 with a business error body: show the exchange's own
  // message instead of a silently-empty wallet.
  if (account.errorMsg) {
    throw new Error(`بیت‌پرپ خطا برگرداند: ${account.errorMsg}`);
  }

  // ── v1.4.14 — NEW wallet structure (Funding / Spot / Perp / Copy) ──
  // BitPerp rebuilt its account model (live web app now reads
  // /api/spot/fund-balance, /api/spot/balance, /api/v2/perp-balances and
  // /api/wallet/overview). The legacy /api/balance now serves STALE data —
  // the root cause of «دارایی‌های جدید نشان داده نمی‌شوند». When the new
  // endpoints hold ANY data, they are the source of truth.
  if (
    account.newWallet &&
    (account.fundingBalances.length > 0 ||
      account.spotBalances.length > 0 ||
      account.perpBalancesV2.length > 0)
  ) {
    const balances: WalletBalance[] = [];

    for (const item of account.fundingBalances) {
      balances.push({
        asset: item.asset,
        section: 'funding',
        free: item.free,
        locked: item.locked,
        total: item.total,
        valueUsd: item.valueUsd,
      });
    }

    for (const item of account.spotBalances) {
      balances.push({
        asset: item.asset,
        section: 'spot',
        free: item.free,
        locked: item.locked,
        total: item.total,
        valueUsd: item.valueUsd,
      });
    }

    for (const item of account.perpBalancesV2) {
      balances.push({
        asset: item.asset,
        section: 'futures',
        free: item.available,
        locked: 0,
        total: item.equity > 0 ? item.equity : item.available,
        valueUsd: 0,
      });
    }

    // Copy-trading sub-account (USDT-denominated).
    if ((account.copyEquity ?? 0) > 0) {
      balances.push({
        asset: 'USDT',
        section: 'copy',
        free: account.copyEquity ?? 0,
        locked: 0,
        total: account.copyEquity ?? 0,
        valueUsd: account.copyEquity ?? 0,
      });
    }

    // USD valuation for items without an API-provided value.
    // v1.4.18 — BitPerp's OWN market prices come FIRST (coins Binance
    // spot/futures doesn't list — e.g. POPCAT-like rows), then the Binance
    // spot+futures map fills the rest. Rows with NO price anywhere are KEPT
    // and shown as «قیمت نامشخص» (never silently dropped).
    try {
      const ownPrices = await fetchBitperpOwnPrices();
      const priceMap = await getUsdPriceMap();
      for (const bal of balances) {
        if (bal.valueUsd > 0) continue;
        const stable = stableCoinValueUsd(bal.asset, bal.total);
        if (stable !== null) {
          bal.valueUsd = stable;
        } else if (ownPrices[bal.asset]) {
          bal.valueUsd = bal.total * ownPrices[bal.asset];
        } else if (ownPrices[`${bal.asset}USDT`]) {
          bal.valueUsd = bal.total * ownPrices[`${bal.asset}USDT`];
        } else if (priceMap[`${bal.asset}USDT`]) {
          bal.valueUsd = bal.total * priceMap[`${bal.asset}USDT`];
        }
      }
    } catch {}

    // Sum spot/perp rows with identical asset+section after valuation.
    return balances.filter((b) => b.valueUsd !== 0 || b.total > 0.000001);
  }

  // ── LEGACY path (older server / new endpoints dead) — v1.4.9 logic ──
  const balances: WalletBalance[] = [];

  // Funding (main) wallet — always USDT-denominated on BitPerp.
  // v1.4.9 — threshold lowered to > 0: even a 5-cent row must appear
  // («۵ سنت موجودی دارم اما نشون داده نمیشه»).
  if (account.fundingUsdt > 0) {
    balances.push({
      asset: 'USDT',
      section: 'funding',
      free: account.fundingUsdt,
      locked: 0,
      total: account.fundingUsdt,
      valueUsd: account.fundingUsdt,
    });
  }

  // Perpetual wallet assets.
  for (const b of account.perpBalances) {
    balances.push({
      asset: b.asset,
      section: 'futures',
      free: b.amount,
      locked: 0,
      total: b.amount,
      valueUsd: 0,
    });
  }

  // v1.4.9 — /api/fund-balance's own perpetual_balance: when the perp wallet
  // list gave no USDT row (or rounded it away), this fallback still shows the
  // perp margin — another path the «۵ سنت» could hide in.
  if ((account.fundPerpUsdt ?? 0) > 0) {
    const perpUsdt = balances.find((b) => b.section === 'futures' && b.asset === 'USDT');
    if (!perpUsdt || perpUsdt.total <= 0) {
      if (!perpUsdt) {
        balances.push({
          asset: 'USDT',
          section: 'futures',
          free: account.fundPerpUsdt!,
          locked: 0,
          total: account.fundPerpUsdt!,
          valueUsd: account.fundPerpUsdt!,
        });
      } else {
        perpUsdt.total = account.fundPerpUsdt!;
        perpUsdt.free = account.fundPerpUsdt!;
        perpUsdt.valueUsd = account.fundPerpUsdt!;
      }
    }
  }

  // USD valuation for perp assets without a value.
  try {
    const priceMap = await getUsdPriceMap();
    for (const bal of balances) {
      if (bal.valueUsd > 0) continue;
      const stable = stableCoinValueUsd(bal.asset, bal.total);
      if (stable !== null) {
        bal.valueUsd = stable;
      } else if (priceMap[`${bal.asset}USDT`]) {
        bal.valueUsd = bal.total * priceMap[`${bal.asset}USDT`];
      }
    }
  } catch {}

  // When the perp-balance endpoint reported equity, prefer it for USDT total.
  if (account.equity && account.equity > 0) {
    const perpUsdt = balances.find((b) => b.section === 'futures' && b.asset === 'USDT');
    if (perpUsdt && perpUsdt.total === 0) {
      perpUsdt.total = account.equity;
      perpUsdt.free = account.availableMargin ?? account.equity;
      perpUsdt.valueUsd = account.equity;
    }
  }

  return balances;
}

async function fetchBitperpPeriodPnl(wallet: ExchangeWallet, days: PnlPeriodDays): Promise<PeriodPnl> {
  let access = wallet.passphrase ?? '';
  let history = await fetchBitperpPositionHistory(access);

  if (history.authFailed && wallet.apiSecret) {
    const refresh = await bitperpRefresh(wallet.apiSecret);
    if (refresh.ok && refresh.tokens) {
      await bitperpRotateTokens(wallet, refresh.tokens);
      access = refresh.tokens.accessToken;
      history = await fetchBitperpPositionHistory(access);
    } else if (refresh.kind === 'transient') {
      return {
        periodDays: days,
        supported: false,
        unavailableReason: `اتصال به بیت‌پرپ برقرار نشد (${refresh.error ?? 'خطای شبکه'}) — اینترنت/فیلترشکن را چک کنید`,
        realizedPnl: 0,
        fundingFees: 0,
        commissions: 0,
        unrealizedPnl: 0,
        closedCount: 0,
      };
    }
  }
  if (history.authFailed) {
    return {
      periodDays: days,
      supported: false,
      unavailableReason: 'نشست BitPerp منقضی شده — صرافی را حذف و دوباره با ایمیل + کد یکبارمصرف اضافه کنید',
      realizedPnl: 0,
      fundingFees: 0,
      commissions: 0,
      unrealizedPnl: 0,
      closedCount: 0,
    };
  }

  const windowStart = periodStartMs(days);
  let realizedPnl = 0;
  let closedCount = 0;
  for (const p of history.positions) {
    if (p.closedAt !== null && p.closedAt < windowStart) continue;
    realizedPnl += p.pnl;
    closedCount++;
  }

  // Live uPnL of open positions.
  let unrealizedPnl = 0;
  try {
    const account = await fetchBitperpAccount(access);
    if (!account.authFailed) {
      for (const p of account.positions) {
        unrealizedPnl += p.unrealizedPnl;
      }
    }
  } catch {}

  return {
    periodDays: days,
    supported: true,
    realizedPnl,
    fundingFees: 0,
    commissions: 0,
    unrealizedPnl,
    closedCount,
    note: 'از تاریخچه پوزیشن‌های بسته‌شده بیت‌پرپ در همین بازه زمانی',
  };
}

// ---------------------------------------------------------------------------
// PnL dispatcher — 30 / 90 / 180 / 360 روز, per exchange
// ---------------------------------------------------------------------------

async function fetchPeriodPnl(wallet: ExchangeWallet, days: PnlPeriodDays): Promise<PeriodPnl> {
  switch (wallet.exchangeId) {
    case 'binance':
      return fetchBinancePeriodPnl(wallet, days);
    case 'bybit':
      return fetchBybitPeriodPnl(wallet, days);
    case 'okx':
      return fetchOkxPeriodPnl(wallet, days);
    case 'bitperp':
      return fetchBitperpPeriodPnl(wallet, days);
    default: {
      // v1.4.8 — MEXC + Bitget closed-position history (foreignExchangePnl).
      // Returns null for other exchanges → the note below applies.
      const foreign = await fetchForeignPeriodPnl(
        wallet.exchangeId,
        { apiKey: wallet.apiKey, apiSecret: wallet.apiSecret, passphrase: wallet.passphrase },
        days
      );
      if (foreign) {
        return {
          periodDays: days,
          supported: true,
          realizedPnl: foreign.realizedPnl,
          fundingFees: foreign.fundingFees,
          commissions: foreign.commissions,
          unrealizedPnl: 0,
          closedCount: foreign.closedCount,
          note: `از تاریخچه پوزیشن‌های بسته‌شده فیوچرز ${wallet.exchangeName} در همین بازه`,
        };
      }
      return {
        periodDays: days,
        supported: false,
        unavailableReason: `صرافی ${wallet.exchangeName} در API خود سود/زیان دوره‌ای ارائه نمی‌دهد — این قابلیت برای بایننس، بای‌بیت، OKX، مکسی، بیتگت و بیت‌پرپ فعال است`,
        realizedPnl: 0,
        fundingFees: 0,
        commissions: 0,
        unrealizedPnl: 0,
        closedCount: 0,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Balance dispatcher (with snapshot caching handled by the react-query layer)
// ---------------------------------------------------------------------------

/**
 * v1.4.7 — IRAN-IP HARD GATE. Every balance fetch passes through here first.
 * When the phone's exit IP is Iranian AND the exchange is a foreign one
 * (Binance/Bybit/OKX/BitPerp/MEXC/…), the request is REFUSED before a single
 * byte leaves the phone — the user's exchange credentials must never touch
 * geo-blocked endpoints. The wallet UI shows the «فیلترشکن را وصل کنید» card
 * instead. Iranian exchanges (Arzinja/Nobitex/Iranicart) are unaffected.
 */
export const IRAN_GATE_ERROR = 'IRAN_IP_BLOCKED';

async function assertNotIranFor(wallet: ExchangeWallet): Promise<void> {
  if (!isForeignExchange(wallet.exchangeId)) return;
  const status = await checkVpnStatus();
  if (status === 'iran') {
    throw new Error(IRAN_GATE_ERROR);
  }
}

async function fetchExchangeBalance(wallet: ExchangeWallet): Promise<ExchangeBalanceData> {
  console.log('[Wallet] Fetching balance for', wallet.exchangeName, wallet.exchangeId);

  await assertNotIranFor(wallet);

  let balances: WalletBalance[] = [];
  let account: BinanceFullAccount | null = null;

  try {
    switch (wallet.exchangeId) {
      case 'binance':
        account = await fetchBinanceFullAccount(wallet);
        balances = account.balances;
        break;
      case 'bybit':
        balances = await fetchBybitBalance(wallet);
        break;
      case 'okx':
        balances = await fetchOkxBalance(wallet);
        break;
      case 'arzinja':
        balances = await fetchArzinjaWalletBalance(wallet);
        break;
      case 'nobitex':
        balances = await fetchNobitexBalance(wallet);
        break;
      case 'bitperp':
        balances = await fetchBitperpBalance(wallet);
        break;
      default: {
        // v1.4.6 — EVERY other exchange in the list now fetches real balances
        // (MEXC, KuCoin, Bitget, Gate, HTX/Huobi, Toobit, BingX, BitMart,
        // SuperEx, CoinEx, Phemex, LBank, XT, Bitunix, KCEX, Iranicart, …).
        // Precise Persian errors are thrown by the module itself.
        const foreign = await fetchForeignExchangeBalance(wallet.exchangeId, {
          apiKey: wallet.apiKey,
          apiSecret: wallet.apiSecret,
          passphrase: wallet.passphrase,
          exchangeName: wallet.exchangeName,
        });
        balances = foreign.map((b) => ({
          asset: b.asset,
          free: b.free,
          locked: b.locked,
          total: b.total,
          valueUsd: b.valueUsd,
          section: b.section ?? 'spot',
        }));
        break;
      }
    }
  } catch (e) {
    console.log('[Wallet] Fetch error:', e);
    throw e;
  }

  // Normalize sections: legacy fetchers mark accounts via asset suffixes
  // ("BTC (فاندینگ)") — strip them into the proper section field.
  for (const bal of balances) {
    if (bal.asset.endsWith(' (فاندینگ)')) {
      bal.asset = bal.asset.replace(' (فاندینگ)', '');
      bal.section = bal.section ?? 'funding';
    } else if (bal.asset.endsWith(' (فیوچرز)')) {
      bal.asset = bal.asset.replace(' (فیوچرز)', '');
      bal.section = bal.section ?? 'futures';
    }
    bal.section = bal.section ?? 'spot';
  }

  const sectionOrder: Record<WalletSection, number> = { spot: 0, copy: 1, earn: 2, funding: 3, futures: 4, alpha: 5 };
  balances.sort(
    (a, b) =>
      (sectionOrder[a.section!] - sectionOrder[b.section!]) || b.valueUsd - a.valueUsd
  );
  const totalValueUsd = balances.reduce((sum, b) => sum + b.valueUsd, 0);

  const result: ExchangeBalanceData = {
    walletId: wallet.id,
    balances,
    totalValueUsd,
    lastUpdated: Date.now(),
  };

  // Binance extras: open positions + realized/unrealized + total exchange PnL
  if (account) {
    result.futuresPositions = account.futuresPositions;
    result.futuresRealizedPnl = account.futuresRealizedPnl;
    result.futuresUnrealizedPnl = account.futuresUnrealizedPnl;
    result.totalPnlUsd = account.totalPnlUsd;
    result.pnlNote =
      'PnL تقریبی بر اساس تاریخچه معاملات اسپات + پوزیشن‌های باز و سود/زیان محقق‌شده فیوچرز';
  }

  return result;
}
// ---------------------------------------------------------------------------
// UI — tabbed asset management (همه + per-exchange) with instant cached data
// ---------------------------------------------------------------------------

export default function WalletScreen() {
  const queryClient = useQueryClient();
  const { settings } = useApp();
  const [expandedWallet, setExpandedWallet] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  // v1.4.14 — three top-level tabs of the asset-management screen + v1.4.16
  // 4th tab «کیف پول بلاکچین» (read-only blockchain wallets):
  //   ۱. ارز دیجیتال   ۲. دارایی ریالی و فلزات   ۳. پیش‌بینی طلا   ۴. کیف پول بلاکچین
  // Persisted so the user returns to the tab they last used.
  // v1.5.7 — R8: «وقتی وارد تب مدیریت دارایی می‌شم همیشه تب ریالی و فلزات اول
  // بهم نشون داده بشه» — دیگر آخرین تبِ بازشده ذخیره/بازیابی نمی‌شود؛ هر بار
  // ورود به «مدیریت دارایی» همیشه از «دارایی ریالی و فلزات» شروع می‌شود.
  const [activeMainTab, setActiveMainTab] = useState<'crypto' | 'rial' | 'gold' | 'blockchain'>('rial');
  const switchMainTab = useCallback((t: 'crypto' | 'rial' | 'gold' | 'blockchain') => {
    setActiveMainTab(t);
  }, []);
  const [selectedExchange, setSelectedExchange] = useState<ExchangeId>('binance');
  const [newApiKey, setNewApiKey] = useState('');
  const [newApiSecret, setNewApiSecret] = useState('');
  const [newPassphrase, setNewPassphrase] = useState('');
  const [showSecrets, setShowSecrets] = useState(false);
  const [otpStatus, setOtpStatus] = useState<string | null>(null);
  const [otpBusy, setOtpBusy] = useState(false);
  const [balanceCaches, setBalanceCaches] = useState<Record<string, ExchangeBalanceData | null>>({});
  const [cachesLoaded, setCachesLoaded] = useState(false);

  const walletsQuery = useQuery({
    queryKey: ['exchange-wallets'],
    queryFn: loadWallets,
    staleTime: Infinity,
  });

  // Refresh cadence follows the app's own «بازه بروزرسانی» setting (minutes;
  // the default 5 = exactly the requested 5-minute tether price refresh).
  const refreshMs = Math.max((settings.refreshInterval ?? 5) * 60_000, 10_000);

  const tomanQuery = useQuery({
    queryKey: ['usdt-toman-price'],
    queryFn: fetchUsdtTomanPrice,
    refetchInterval: refreshMs,
    staleTime: 30_000,
  });

  const usdtToToman = tomanQuery.data?.usdtToToman ?? 0;
  const wallets = walletsQuery.data ?? [];

  // v1.4.7 — IRAN-IP HARD GATE STATE. Polled every 60s while foreign
  // exchanges are connected; shared by the queries (enabled flag), the
  // per-exchange gate cards and the auto-refresh-on-VPN logic below.
  const [vpnStatus, setVpnStatus] = useState<VpnStatus>('unknown');
  const [vpnChecking, setVpnChecking] = useState(false);

  const recheckVpn = useCallback(async (force = false) => {
    setVpnChecking(true);
    try {
      setVpnStatus(await checkVpnStatus(force));
    } finally {
      setVpnChecking(false);
    }
  }, []);

  const hasForeignWallet = useMemo(
    () => wallets.some((w) => isForeignExchange(w.exchangeId)),
    [wallets]
  );

  // v1.2.0 — poll همیشه فعال (قبلاً فقط با صرافی خارجی متصل):
  // دو تب «کیف پول بلاکچین» و «ارز دیجیتال» باید حتی بدون هیچ کیف/صرافیِ
  // متصل هم وضعیت IP را بدانند تا با IP ایران بلافاصله غیرفعال شوند.
  useEffect(() => {
    void recheckVpn();
    const timer = setInterval(() => void recheckVpn(), 30_000);
    return () => clearInterval(timer);
  }, [recheckVpn]);

  // When the VPN comes back ON (status flips to 'vpn'), every foreign
  // balance query is invalidated so the wallets refresh themselves without a
  // manual pull — exactly the requested behavior.
  const prevVpnRef = useRef<VpnStatus>('unknown');
  useEffect(() => {
    if (prevVpnRef.current === 'iran' && vpnStatus === 'vpn') {
      wallets.forEach((w) => {
        if (isForeignExchange(w.exchangeId)) {
          queryClient.invalidateQueries({ queryKey: ['exchange-balance', w.id] });
          queryClient.invalidateQueries({ queryKey: ['exchange-pnl', w.id] });
        }
      });
      // v1.4.16 — blockchain wallets refresh themselves too when the VPN
      // comes back (their balance/PnL APIs are all foreign).
      queryClient.invalidateQueries({ queryKey: ['blockchain-balance'] });
      queryClient.invalidateQueries({ queryKey: ['blockchain-pnl'] });
    }
    prevVpnRef.current = vpnStatus;
  }, [vpnStatus, wallets, queryClient]);

  // While the exit IP is Iranian, foreign-exchange queries are DISABLED —
  // react-query will not auto-refetch, poll or refetch-on-mount them (the
  // cached snapshot stays visible, but NO request leaves the phone). The
  // queryFn itself double-guards via assertNotIranFor().
  const foreignBlocked = vpnStatus === 'iran' && hasForeignWallet;
  // v1.2.0 — گیت سخت IP تحریمی: کل دو تب «کیف پول بلاکچین» و «ارز دیجیتال»
  // (حتی صرافی‌های ایرانی) با IP ایران/تحریمی غیرفعال می‌شوند — امنیت دارایی.
  const ipBlocked = vpnStatus === 'iran';

  // v1.4.3 — load the persisted balance snapshots BEFORE the queries mount so
  // the whole portfolio (all exchanges + totals) appears INSTANTLY on screen
  // entry, then silently refreshes in the background (no manual refresh, no
  // long spinner on revisit).
  const walletsKey = useMemo(() => wallets.map((w) => w.id).join('|'), [wallets]);
  useEffect(() => {
    let cancelled = false;
    setCachesLoaded(false);
    (async () => {
      const ids = walletsKey ? walletsKey.split('|') : [];
      const entries = await Promise.all(
        ids.map(async (id) => [id, await readBalanceCache(id)] as const)
      );
      if (!cancelled) {
        setBalanceCaches(Object.fromEntries(entries));
        setCachesLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [walletsKey]);

  // The query set is created only AFTER the caches load: react-query applies
  // `initialData` at query creation, so the array must go from [] to the full
  // set with the cached snapshots in place — that is what makes the whole
  // portfolio appear instantly on screen entry.
  const balanceQueries = useQueries({
    queries: cachesLoaded
      ? wallets.map((w, idx) => ({
          queryKey: ['exchange-balance', w.id],
          queryFn: async (): Promise<ExchangeBalanceData> => {
            // v1.2.0 — گارد سخت داخل fetch: با IP تحریمی حتی اگر react-query
            // به هر دلیلی queryFn را صدا بزند، هیچ بایتی به صرافی نمی‌رسد.
            if (ipBlocked || (await checkVpnStatus()) === 'iran') {
              throw new Error('IRAN_IP_BLOCKED_EXCHANGE');
            }
            // v1.4.9 — STAGGER: entering the wallet screen used to fire every
            // exchange's balance fetch (plus the PnL section) at the SAME
            // instant — dozens of requests through one VPN tunnel, the #1
            // cause of «بایننس یکی در میان» cold-start failures. An offset
            // per wallet smooths the burst; old data stays visible while
            // refetching, so the delay is invisible to the user.
            // v1.2.0 — 300ms → 150ms («موجودی سریع‌تر خوانده شود»)
            if (idx > 0) {
              await new Promise((r) => setTimeout(r, Math.min(idx, 8) * 150));
            }
            const fresh = await fetchExchangeBalance(w);
            await writeBalanceCache(w.id, fresh);
            return fresh;
          },
          initialData: balanceCaches[w.id] ?? undefined,
          initialDataUpdatedAt: balanceCaches[w.id]?.lastUpdated,
          // v1.2.0 — با IP تحریمی کوئری‌های صرافی کلا غیرفعال‌اند (بدون هیچ fetch)
          enabled: !ipBlocked,
          refetchInterval: foreignBlocked && isForeignExchange(w.exchangeId) ? false : refreshMs,
          refetchOnMount: foreignBlocked && isForeignExchange(w.exchangeId) ? false : 'always',
          staleTime: 30_000,
          // v1.4.9 — two DELAYED retries (react-query's retry has no built-in
          // backoff): an immediate retry re-fires into the same congestion
          // burst and fails again; 1.2s/2.4s later the network has calmed.
          retry: 2,
          retryDelay: (attempt: number) => 1200 * (attempt + 1),
        }))
      : [],
  });

  const balanceByWalletId = useMemo(() => {
    const map: Record<string, ExchangeBalanceData | undefined> = {};
    wallets.forEach((w, i) => {
      map[w.id] = balanceQueries[i]?.data;
    });
    return map;
  }, [wallets, balanceQueries]);

  const totalPortfolioUsd = useMemo(() => {
    let total = 0;
    for (const w of wallets) {
      const data = balanceByWalletId[w.id];
      if (data) total += data.totalValueUsd;
    }
    return total;
  }, [wallets, balanceByWalletId]);

  // Approximate total profit/loss across every connected exchange.
  const totalPortfolioPnl = useMemo(() => {
    let total = 0;
    let found = false;
    for (const w of wallets) {
      const data = balanceByWalletId[w.id];
      if (data && data.totalPnlUsd !== undefined) {
        total += data.totalPnlUsd;
        found = true;
      }
    }
    return found ? total : null;
  }, [wallets, balanceByWalletId]);

  // ── v1.4.16 — READ-ONLY blockchain wallets (4th tab «کیف پول بلاکچین») ──
  // Only PUBLIC addresses are stored; balances are read from keyless public
  // APIs. The same query machinery pattern as the exchange wallets above:
  // cache-first snapshots → staggered background refresh → VPN gate.
  const blockchainWalletsQuery = useQuery({
    queryKey: ['blockchain-wallets'],
    queryFn: loadBlockchainWallets,
    staleTime: Infinity,
  });
  const bcWallets = blockchainWalletsQuery.data ?? [];
  const hasBlockchainWallet = bcWallets.length > 0;

  // v1.4.3 pattern — persisted balance snapshots BEFORE the queries mount, so
  // the whole blockchain portfolio appears INSTANTLY, then silently refreshes.
  const bcWalletsKey = useMemo(() => bcWallets.map((w) => w.id).join('|'), [bcWallets]);
  const [bcCaches, setBcCaches] = useState<Record<string, BlockchainWalletData | null>>({});
  const [bcCachesLoaded, setBcCachesLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setBcCachesLoaded(false);
    (async () => {
      const ids = bcWalletsKey ? bcWalletsKey.split('|') : [];
      const entries = await Promise.all(
        ids.map(async (id) => [id, await readBlockchainBalanceCache(id)] as const)
      );
      if (!cancelled) {
        setBcCaches(Object.fromEntries(entries));
        setBcCachesLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bcWalletsKey]);

  const bcBalanceQueries = useQueries({
    queries: bcCachesLoaded
      ? bcWallets.map((w, idx) => ({
          queryKey: ['blockchain-balance', w.id],
          queryFn: async (): Promise<BlockchainWalletData> => {
            // same stagger as exchange balances — smooths the cold-start burst
            // v1.2.0 — 250ms → 120ms (خواندن سریع‌تر موجودی در تب ریالی)
            if (idx > 0) {
              await new Promise((r) => setTimeout(r, Math.min(idx, 6) * 120));
            }
            // v1.1.0 — دوباره‌چک داخل خودِ fetch: با IP تحریمی هیچ بایتی از
            // گوشی خارج نمی‌شود (حتی اگر react-query به هر دلیلی صدا بزند).
            if ((await checkVpnStatus()) === 'iran') {
              throw new Error('IRAN_IP_BLOCKED_BC');
            }
            return fetchBlockchainWalletData(w);
          },
          initialData: bcCaches[w.id] ?? undefined,
          initialDataUpdatedAt: bcCaches[w.id]?.fetchedAt,
          refetchInterval: vpnStatus === 'iran' ? false : refreshMs,
          refetchOnMount: vpnStatus === 'iran' ? false : 'always',
          staleTime: 30_000,
          retry: 2,
          retryDelay: (attempt: number) => 1200 * (attempt + 1),
        }))
      : [],
  });

  const bcBalanceByWallet = useMemo(() => {
    const map: Record<
      string,
      { data?: BlockchainWalletData; isFetching: boolean; error?: unknown }
    > = {};
    bcWallets.forEach((w, i) => {
      map[w.id] = {
        data: bcBalanceQueries[i]?.data,
        isFetching: bcBalanceQueries[i]?.isFetching ?? false,
        error: bcBalanceQueries[i]?.error,
      };
    });
    return map;
  }, [bcWallets, bcBalanceQueries]);

  const blockchainTotalUsd = useMemo(
    () =>
      bcWallets.reduce((s, w) => s + (bcBalanceByWallet[w.id]?.data?.totalUsd ?? 0), 0),
    [bcWallets, bcBalanceByWallet]
  );
  const blockchainToman = usdtToToman > 0 ? blockchainTotalUsd * usdtToToman : 0;

  // PnL over all four periods at once — keyed by the aggregated holdings so
  // it recomputes whenever balances change (qty/asset shifts).
  const bcTokensKey = useMemo(
    () =>
      bcWallets
        .map((w) => {
          const d = bcBalanceByWallet[w.id]?.data;
          const nets = w.networks.join(',');
          return d
            ? `${w.id}:${nets}:${d.tokens
                .map((t) => `${t.symbol}:${t.qty.toFixed(6)}`)
                .join(',')}`
            : `${w.id}:${nets}:-`;
        })
        .join('|'),
    [bcWallets, bcBalanceByWallet]
  );
  const bcPnlQuery = useQuery({
    queryKey: ['blockchain-pnl', bcTokensKey],
    queryFn: () =>
      computeBlockchainPnl(
        bcWallets,
        Object.fromEntries(bcWallets.map((w) => [w.id, bcBalanceByWallet[w.id]?.data]))
      ),
    enabled:
      hasBlockchainWallet &&
      vpnStatus !== 'iran' &&
      bcWallets.some((w) => bcBalanceByWallet[w.id]?.data),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  // Toman FX basis for the rial-tab blockchain PnL row — the free-market
  // dollar daily series (TGJU has no tether history; same source the paper-USD
  // PnL row already uses).
  const bcDollarQuery = useQuery({
    queryKey: ['tgju-history-blockchain-dollar'],
    queryFn: () => fetchTgjuCloses(TgjuHistorySymbol.dollar),
    enabled: hasBlockchainWallet,
    staleTime: 10 * 60_000,
    retry: 1,
  });

  /** Per-period TOMAN PnL of the blockchain holdings (market change incl. FX). */
  const blockchainPnlTomanByPeriod = useMemo(() => {
    const out: Record<number, { pnlToman: number; basisToman: number } | null> = {
      1: null,
      7: null,
      30: null,
      90: null,
      180: null,
    };
    const summary = bcPnlQuery.data;
    const series = bcDollarQuery.data;
    if (!summary) return out;
    for (const p of [1, 7, 30, 90, 180] as const) {
      const per = summary.byPeriod[p];
      if (!per || per.usdThen <= 0 || usdtToToman <= 0) continue;
      if (!series || series.length === 0) continue;
      // v1.5.12 — «امروز» = ابتدای روز محلی؛ بقیه N روز به عقب.
      const dollarThen = closeAtOrBefore(
        series,
        p === 1
          ? (() => {
              const d = new Date();
              d.setHours(0, 0, 0, 0);
              return d.getTime();
            })()
          : Date.now() - p * 86_400_000
      );
      if (dollarThen === null || dollarThen <= 0) continue;
      const basisToman = per.usdThen * dollarThen;
      out[p] = { pnlToman: per.usdNow * usdtToToman - basisToman, basisToman };
    }
    return out;
  }, [bcPnlQuery.data, bcDollarQuery.data, usdtToToman]);

  const bcSaveMutation = useMutation({
    mutationFn: async (list: BlockchainWallet[]) => {
      await saveBlockchainWallets(list);
      return list;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['blockchain-wallets'] });
    },
  });

  // v1.4.19 — refresh DOES A REAL FETCH, bypassing every react-query gate
  // (staleTime / refetchOnMount / the iran-VPN poll gate) AND the 60s price
  // cache. The v1.4.17 refetchQueries fix still hit three invisible walls:
  //  1) vpnStatus === 'iran' disables refetchOnMount/refetchInterval → the
  //     refetch was silently dropped exactly for the users who press it most.
  //  2) even when it ran, the 60s ticker cache returned IDENTICAL prices →
  //     «هیچ اتفاقی نمی‌افتد».
  //  3) no visible feedback (a <2s fetch with no spinner/toast looks dead).
  // Now: direct fetch → setQueryData → toast with the result. Manual action
  // = user intent → always attempt, even from an Iranian IP (per-network
  // failures surface in the card's notice line).
  const [bcManualRefresh, setBcManualRefresh] = useState<Record<string, boolean>>({});
  const [bcRefreshToast, setBcRefreshToast] = useState<string | null>(null);
  const bcRefreshToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bcWalletsRef = useRef<BlockchainWallet[]>(bcWallets);
  bcWalletsRef.current = bcWallets;

  const runBlockchainManualFetch = useCallback(
    async (id: string, force: boolean): Promise<void> => {
      const w = bcWalletsRef.current.find((x) => x.id === id);
      if (!w) return;
      // v1.1.0 — «با IP ایران داده به این بخش‌ها ارسال نشه»: حتی اکشن دستی هم
      // وقتی خروجی ترافیک IP تحریمی است، هیچ درخواستی نمی‌فرستد — فقط پیغام.
      const ipStatus = await checkVpnStatus();
      if (ipStatus === 'iran') {
        setBcRefreshToast(
          'فیلترشکن خاموش است — برای دریافت موجودی کیف پول بلاکچین، فیلترشکن را روشن کنید'
        );
        if (bcRefreshToastTimer.current) clearTimeout(bcRefreshToastTimer.current);
        bcRefreshToastTimer.current = setTimeout(() => setBcRefreshToast(null), 4000);
        return;
      }
      setBcManualRefresh((m) => ({ ...m, [id]: true }));
      try {
        const data = await fetchBlockchainWalletData(w, { force });
        queryClient.setQueryData(['blockchain-balance', id], data);
        const n = data.tokens.length;
        const usd = data.totalUsd;
        setBcRefreshToast(
          data.notice
            ? `به‌روز شد (${n} دارایی) — بعضی شبکه‌ها پاسخ ندادند`
            : `به‌روز شد — ${n} دارایی • $${usd < 1000 ? usd.toFixed(2) : usd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
        );
      } catch (e) {
        setBcRefreshToast(`به‌روزرسانی ناموفق — ${e instanceof Error ? e.message.slice(0, 50) : 'خطای شبکه'}`);
      } finally {
        setBcManualRefresh((m) => ({ ...m, [id]: false }));
        queryClient.invalidateQueries({ queryKey: ['blockchain-pnl'] });
        queryClient.invalidateQueries({ queryKey: ['usdt-toman-price'] });
        if (bcRefreshToastTimer.current) clearTimeout(bcRefreshToastTimer.current);
        bcRefreshToastTimer.current = setTimeout(() => setBcRefreshToast(null), 4000);
      }
    },
    [queryClient]
  );

  const handleAddBlockchainWallet = useCallback(
    async (
      name: string,
      networks: BlockchainNetwork[],
      address: string,
      networkAddresses?: Partial<Record<BlockchainNetwork, string>>
    ): Promise<boolean> => {
      const v = validateAddressForNetworks(networks, address, networkAddresses);
      if (!v.ok) {
        ThemedAlert.alert('آدرس نامعتبر', v.message ?? 'آدرس را بررسی کنید');
        return false;
      }
      const wallet: BlockchainWallet = {
        id: `bc-${Date.now()}`,
        name,
        networks,
        address,
        ...(networkAddresses && Object.keys(networkAddresses).length > 0 ? { networkAddresses } : {}),
        addedAt: Date.now(),
      };
      bcSaveMutation.mutate([...bcWallets, wallet], {
        onSuccess: () => {
          // v1.4.19 — fetch the brand-new wallet IMMEDIATELY (the poll gate
          // would otherwise leave the card on the empty snapshot).
          setTimeout(() => void runBlockchainManualFetch(wallet.id, true), 600);
        },
      });
      return true;
    },
    [bcWallets, bcSaveMutation, runBlockchainManualFetch]
  );

  // v1.4.19 — edit an existing wallet's name / network selection AND the
  // per-network addresses (e.g. keep the 0x base for Ethereum+BSC while
  // adding the wallet's own Filecoin f1 address — the form asks for it in
  // place: «در همون قسمت خودش آدرسشو بخواد»).
  const handleEditBlockchainWallet = useCallback(
    async (
      id: string,
      name: string,
      networks: BlockchainNetwork[],
      networkAddresses?: Partial<Record<BlockchainNetwork, string>>
    ): Promise<boolean> => {
      const target = bcWallets.find((w) => w.id === id);
      if (!target) return false;
      const cleanPer: Partial<Record<BlockchainNetwork, string>> = {};
      for (const [k, v] of Object.entries(networkAddresses ?? {})) {
        if (typeof v === 'string' && v.trim().length > 0) {
          cleanPer[k as BlockchainNetwork] = v.trim();
        }
      }
      const v = validateAddressForNetworks(networks, target.address, cleanPer);
      if (!v.ok) {
        ThemedAlert.alert(
          'شبکه با آدرس نمی‌خواند',
          `${v.message}`
        );
        return false;
      }
      const updated: BlockchainWallet = {
        ...target,
        name,
        networks,
        ...(Object.keys(cleanPer).length > 0 ? { networkAddresses: cleanPer } : {}),
      };
      bcSaveMutation.mutate(
        bcWallets.map((w) => (w.id === id ? updated : w))
      );
      // network selection / per-network addresses changed → REAL refetch of
      // this wallet right away (v1.4.19: the old removeQueries + gate meant
      // «اضاف کردم فایل‌کوین، ارزهاشو نمیاره» until the next poll).
      setTimeout(() => {
        bcWalletsRef.current = bcWalletsRef.current.map((w) => (w.id === id ? updated : w));
        void runBlockchainManualFetch(id, true);
      }, 600);
      queryClient.invalidateQueries({ queryKey: ['blockchain-pnl'] });
      return true;
    },
    [bcWallets, bcSaveMutation, runBlockchainManualFetch]
  );

  const handleRemoveBlockchainWallet = useCallback(
    (id: string, name: string) => {
      ThemedAlert.alert('حذف کیف پول', `آیا از حذف "${name}" اطمینان دارید؟`, [
        { text: 'لغو', style: 'cancel' },
        {
          text: 'حذف',
          style: 'destructive',
          onPress: () => {
            bcSaveMutation.mutate(bcWallets.filter((w) => w.id !== id));
            queryClient.removeQueries({ queryKey: ['blockchain-balance', id] });
            void removeBlockchainBalanceCache(id);
          },
        },
      ]);
    },
    [bcWallets, bcSaveMutation]
  );

  const handleRefreshBlockchainAll = useCallback(() => {
    bcWallets.forEach((w) => {
      void runBlockchainManualFetch(w.id, true);
    });
  }, [bcWallets, runBlockchainManualFetch]);

  // v1.4.19 — «دکمه رفرش هر کیف کار نمیده» ROOT fix: direct fetch + forced
  // fresh prices + visible toast/spinner (see runBlockchainManualFetch).
  const handleRefreshBlockchainWallet = useCallback(
    (id: string) => {
      void runBlockchainManualFetch(id, true);
    },
    [runBlockchainManualFetch]
  );

  const saveMutation = useMutation({
    mutationFn: async (newWallets: ExchangeWallet[]) => {
      await AsyncStorage.setItem(WALLETS_KEY, JSON.stringify(newWallets));
      return newWallets;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['exchange-wallets'] });
    },
  });

  const exchangeOptions = useMemo(
    () => EXCHANGE_LIST.map((ex) => ({ key: ex.id, label: ex.name })),
    []
  );

  const needsPassphrase =
    selectedExchange === 'okx' ||
    selectedExchange === 'kucoin' ||
    selectedExchange === 'bitget';
  const isBitperp = selectedExchange === 'bitperp';

  const handleSendOtp = useCallback(async () => {
    if (!newApiKey.trim()) {
      ThemedAlert.alert('خطا', 'ابتدا ایمیل حساب BitPerp را وارد کنید');
      return;
    }
    setOtpBusy(true);
    setOtpStatus('⏳ در حال ارسال کد به ایمیل شما...');
    const r = await bitperpRequestOtp(newApiKey.trim());
    setOtpBusy(false);
    if (r.ok) {
      setOtpStatus('✅ کد یکبارمصرف به ایمیل شما ارسال شد — کد را در کادر پایین وارد کنید و ذخیره بزنید');
    } else {
      setOtpStatus(`❌ ${r.error ?? 'ارسال کد ناموفق بود'}`);
    }
  }, [newApiKey]);

  const handleAddWallet = useCallback(async () => {
    if (!newApiKey.trim()) {
      ThemedAlert.alert('خطا', isBitperp ? 'لطفاً ایمیل حساب BitPerp را وارد کنید' : 'لطفاً API Key را وارد کنید');
      return;
    }
    if (!newApiSecret.trim()) {
      ThemedAlert.alert('خطا', isBitperp ? 'لطفاً کد یکبارمصرف (OTP) را وارد کنید' : 'لطفاً API Secret را وارد کنید');
      return;
    }
    if (needsPassphrase && !newPassphrase.trim()) {
      ThemedAlert.alert('خطا', 'لطفاً Passphrase را وارد کنید');
      return;
    }

    const exchangeInfo = EXCHANGE_LIST.find((e) => e.id === selectedExchange);

    // BitPerp — verify the emailed OTP once; the returned JWT pair is stored
    // (access token in passphrase, refresh token in apiSecret, email in apiKey).
    if (isBitperp) {
      setOtpBusy(true);
      setOtpStatus('⏳ در حال تأیید کد...');
      const v = await bitperpVerifyOtp(newApiKey.trim(), newApiSecret.trim());
      setOtpBusy(false);
      if (!v.ok || !v.tokens) {
        setOtpStatus(`❌ ${v.error ?? 'کد تأیید ناموفق بود'}`);
        ThemedAlert.alert('خطا', v.error ?? 'کد یکبارمصرف اشتباه است یا منقضی شده');
        return;
      }
      const newWallet: ExchangeWallet = {
        id: `wallet-${Date.now()}`,
        exchangeId: 'bitperp',
        exchangeName: exchangeInfo?.name ?? 'BitPerp',
        apiKey: newApiKey.trim(),
        apiSecret: v.tokens.refreshToken,
        passphrase: v.tokens.accessToken,
        addedAt: Date.now(),
      };
      saveMutation.mutate([...wallets, newWallet]);
      setNewApiKey('');
      setNewApiSecret('');
      setNewPassphrase('');
      setOtpStatus(null);
      setShowAddForm(false);
      ThemedAlert.alert('موفق', 'صرافی بیت‌پرپ متصل شد — موجودی و پوزیشن‌هایتان نمایش داده می‌شود');
      return;
    }

    const newWallet: ExchangeWallet = {
      id: `wallet-${Date.now()}`,
      exchangeId: selectedExchange,
      exchangeName: exchangeInfo?.name ?? selectedExchange,
      apiKey: newApiKey.trim(),
      apiSecret: newApiSecret.trim(),
      passphrase: newPassphrase.trim() || undefined,
      addedAt: Date.now(),
    };

    const updated = [...wallets, newWallet];
    saveMutation.mutate(updated);
    setNewApiKey('');
    setNewApiSecret('');
    setNewPassphrase('');
    setShowAddForm(false);
    ThemedAlert.alert('موفق', `صرافی ${exchangeInfo?.name} اضافه شد`);
  }, [newApiKey, newApiSecret, newPassphrase, selectedExchange, wallets, needsPassphrase, isBitperp, saveMutation]);

  // BitPerp — ورود خودکار: به‌محض کامل شدن کد ۶ رقمی، تأیید و ذخیره انجام می‌شود
  // (کاربر لازم نیست دکمه‌ای بزند؛ دکمه «ورود» هم برای حالت دستی مانده است).
  const lastOtpRef = useRef('');
  useEffect(() => {
    if (!isBitperp) return;
    const code = newApiSecret.trim();
    if (/^\d{6}$/.test(code) && code !== lastOtpRef.current) {
      lastOtpRef.current = code;
      void handleAddWallet();
    } else if (code.length < 6) {
      lastOtpRef.current = '';
    }
  }, [newApiSecret, isBitperp, handleAddWallet]);

  const handleRemoveWallet = useCallback(
    (id: string, name: string) => {
      ThemedAlert.alert('حذف صرافی', `آیا از حذف "${name}" اطمینان دارید؟`, [
        { text: 'لغو', style: 'cancel' },
        {
          text: 'حذف',
          style: 'destructive',
          onPress: () => {
            const updated = wallets.filter((w) => w.id !== id);
            saveMutation.mutate(updated);
            queryClient.removeQueries({ queryKey: ['exchange-balance', id] });
            queryClient.removeQueries({ queryKey: ['exchange-pnl', id] });
            AsyncStorage.removeItem(BALANCE_CACHE_PREFIX + id).catch(() => {});
          },
        },
      ]);
    },
    [wallets, saveMutation]
  );

  const handleRefreshAll = useCallback(() => {
    // v1.2.0 — با IP تحریمی رفرشِ بخش صرافی‌ها هیچ درخواستی نمی‌زند (فقط پیغام)
    if (ipBlocked) {
      void checkVpnStatus(true).then((s) => {
        if (s === 'iran') {
          ThemedAlert.alert(
            'IP تحریمی — رفرش صرافی‌ها غیرفعال است',
            'فیلترشکن خاموش است و IP خروجی شما ایران است. برای امنیت دارایی، هیچ درخواستی به صرافی‌ها فرستاده نمی‌شود؛ فیلترشکن را روشن کنید و دوباره تلاش کنید.'
          );
        }
      });
      return;
    }
    wallets.forEach((w) => {
      queryClient.invalidateQueries({ queryKey: ['exchange-balance', w.id] });
    });
    queryClient.invalidateQueries({ queryKey: ['usdt-toman-price'] });
    queryClient.invalidateQueries({ queryKey: ['iran-market-prices'] });
  }, [wallets, ipBlocked]);

  // هشدار فیلترشکن فقط وقتی معنی دارد که صرافی خارجی متصل است (یا در حال
  // افزودن آن هستیم) — صرافی‌های ایرانی با IP ایران مشکلی ندارند.
  // v1.4.7: نمایش بنر + کارت گیت داخل هر صرافی خارجی (hasForeignWallet
  // بالاتر در کامپوننت تعریف شده و توسط کوئری‌ها هم استفاده می‌شود).

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {/* ── هشدار امنیتی: فیلترشکن خاموش ──
          v1.3.0 — در دو تب «دارایی ریالی و فلزات» و «پیش‌بینی طلا» پیام سبز
          «این بخش با IP ایران بدون مشکل متصل است» نشان داده می‌شود (منابع
          داخلی‌اند) + توضیح اینکه دو بخش کیف پول و ارز دیجیتال با IP تحریمی
          هیچ ترافیکی نمی‌گیرند. در دو تب خودِ کیف/ارز، محتوای تب جایگزین کارت
          خطای IP می‌شود و بنر نارنجی قدیمی دیگر لازم نیست. ── */}
      <VpnWarningBanner
        variant={activeMainTab === 'rial' || activeMainTab === 'gold' ? 'safe' : 'exchange'}
        show={
          !ipBlocked &&
          (hasForeignWallet ||
            hasBlockchainWallet ||
            (showAddForm && isForeignExchange(selectedExchange)))
        }
      />

      {/* ── v1.5.6 (بازیابی ترتیب v1.5.4) — ترتیب تب‌ها از سمت راست:
          دارایی و فلزات، پیش‌بینی، کیف پول، ارز دیجیتال (در RTL اولین آیتم
          در سمت راست قرار می‌گیرد).
          v1.4.14: تب‌های بالای صفحه + v1.4.16: تب چهارم ── */}
      <View style={styles.mainTabBar}>
        <Pressable
          style={[styles.mainTab, activeMainTab === 'rial' && styles.mainTabActive]}
          onPress={() => switchMainTab('rial')}
          testID="main-tab-rial"
        >
          <Landmark size={12} color={activeMainTab === 'rial' ? colors.dark.accent : colors.dark.textSecondary} />
          <Text style={[styles.mainTabText, activeMainTab === 'rial' && styles.mainTabTextActive]}>
            دارایی ریالی و فلزات
          </Text>
        </Pressable>
        <Pressable
          style={[styles.mainTab, activeMainTab === 'gold' && styles.mainTabActive]}
          onPress={() => switchMainTab('gold')}
          testID="main-tab-gold"
        >
          <Sparkles size={12} color={activeMainTab === 'gold' ? colors.dark.accent : colors.dark.textSecondary} />
          <Text style={[styles.mainTabText, activeMainTab === 'gold' && styles.mainTabTextActive]}>
            پیش‌بینی قیمت طلا
          </Text>
        </Pressable>
        {/* ── v1.4.16 — تب چهارم: کیف پول بلاکچین (فقط خواندنی) ── */}
        <Pressable
          style={[styles.mainTab, activeMainTab === 'blockchain' && styles.mainTabActive]}
          onPress={() => switchMainTab('blockchain')}
          testID="main-tab-blockchain"
        >
          <LinkIcon size={12} color={activeMainTab === 'blockchain' ? colors.dark.accent : colors.dark.textSecondary} />
          <Text style={[styles.mainTabText, activeMainTab === 'blockchain' && styles.mainTabTextActive]}>
            کیف پول بلاکچین
          </Text>
        </Pressable>
        <Pressable
          style={[styles.mainTab, activeMainTab === 'crypto' && styles.mainTabActive]}
          onPress={() => switchMainTab('crypto')}
          testID="main-tab-crypto"
        >
          <Bitcoin size={12} color={activeMainTab === 'crypto' ? colors.dark.accent : colors.dark.textSecondary} />
          <Text style={[styles.mainTabText, activeMainTab === 'crypto' && styles.mainTabTextActive]}>
            ارز دیجیتال
          </Text>
        </Pressable>
      </View>

      {activeMainTab === 'crypto' && (
      ipBlocked ? (
        /* v1.2.0 — با IP تحریمی کل محتوای این تب (مجموع + صرافی‌ها + فرم)
           جای خود را به کارت پیام IP می‌دهد؛ هیچ درخواستی فعال نیست. */
        <IpBlockedNotice
          section="crypto"
          checking={vpnChecking}
          onRecheck={() => void recheckVpn(true)}
        />
      ) : (
      <>
      {/* ── کارت مجموع دارایی‌ها ── */}
          <View style={styles.portfolioCard}>
            <View style={styles.portfolioHeader}>
              <Wallet size={20} color={colors.dark.accent} />
              <Text style={styles.portfolioTitle}>مجموع دارایی‌ها (همه صرافی‌ها)</Text>
              <Pressable style={styles.refreshAllBtn} onPress={handleRefreshAll}>
                <RefreshCw size={16} color={colors.dark.accent} />
              </Pressable>
            </View>

            <View style={styles.portfolioValues}>
              <View style={styles.portfolioValueRow}>
                <DollarSign size={14} color={colors.dark.green} />
                <Text style={styles.portfolioValueLabel}>ارزش دلاری:</Text>
                <Text style={styles.portfolioValueAmount}>
                  ${totalPortfolioUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </Text>
              </View>
              {usdtToToman > 0 && (
                <View style={styles.portfolioValueRow}>
                  <TrendingUp size={14} color={colors.dark.blue} />
                  <Text style={styles.portfolioValueLabel}>ارزش تومانی:</Text>
                  <Text style={[styles.portfolioValueAmount, { color: colors.dark.blue }]}>
                    {formatToman(totalPortfolioUsd * usdtToToman)} تومان
                  </Text>
                </View>
              )}
              {totalPortfolioPnl !== null && totalPortfolioPnl !== 0 && (
                <View style={styles.portfolioValueRow}>
                  <TrendingUp
                    size={14}
                    color={totalPortfolioPnl > 0 ? colors.dark.green : colors.dark.red}
                  />
                  <Text style={styles.portfolioValueLabel}>سود/زیان کل (تقریبی):</Text>
                  <Text
                    style={[
                      styles.portfolioValueAmount,
                      { color: totalPortfolioPnl > 0 ? colors.dark.green : colors.dark.red },
                    ]}
                  >
                    {totalPortfolioPnl > 0 ? '+' : ''}
                    {formatSignedUsd(totalPortfolioPnl)}
                  </Text>
                </View>
              )}
            </View>

            <View style={styles.tomanPriceRow}>
              <Text style={styles.tomanPriceLabel}>قیمت تتر</Text>
              <Text style={styles.tomanPriceValue}>
                {usdtToToman > 0 ? `${usdtToToman.toLocaleString('fa-IR')} تومان` : 'در حال دریافت...'}
              </Text>
              {tomanQuery.isFetching && (
                <ActivityIndicator size="small" color={colors.dark.accent} />
              )}
            </View>

            {/* ── تفکیک هر صرافی: مجموع کل دارایی همان صرافی ── */}
            {wallets.length > 0 && (
              <View style={styles.portfolioBreakdown}>
                {wallets.map((w) => {
                  const data = balanceByWalletId[w.id];
                  return (
                    <View key={w.id} style={styles.portfolioBreakdownRow}>
                      <Text style={styles.portfolioBreakdownName}>{w.exchangeName}</Text>
                      <Text style={styles.portfolioBreakdownValue}>
                        {data
                          ? `$${data.totalValueUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
                          : '—'}
                      </Text>
                    </View>
                  );
                })}
              </View>
            )}

            <Text style={styles.portfolioSub}>{wallets.length} صرافی متصل</Text>

            {/* ── v1.4.7: سود/زیان دوره‌ای کل پرتفوی (مجموع همه صرافی‌ها) ── */}
            {wallets.length > 0 && (
              <TotalPnlPeriodSection
                wallets={wallets}
                foreignBlocked={foreignBlocked}
                ipBlocked={ipBlocked}
              />
            )}
          </View>

      {/* ── کارت هر صرافی — با فلش باز/بسته می‌شود؛ سربرگ‌های داخلی ── */}
      {wallets.map((wallet, idx) => (
        <WalletItem
          key={wallet.id}
          wallet={wallet}
          isExpanded={expandedWallet === wallet.id}
          usdtToToman={usdtToToman}
          balanceQuery={balanceQueries[idx]}
          vpnStatus={vpnStatus}
          vpnChecking={vpnChecking}
          onRecheckVpn={() => void recheckVpn(true)}
          onToggle={() => setExpandedWallet(expandedWallet === wallet.id ? null : wallet.id)}
          onRemove={() => handleRemoveWallet(wallet.id, wallet.exchangeName)}
          onRefresh={() => {
            if (foreignBlocked && isForeignExchange(wallet.exchangeId)) {
              void recheckVpn(true);
              return;
            }
            queryClient.invalidateQueries({ queryKey: ['exchange-balance', wallet.id] });
          }}
        />
      ))}

      {wallets.length === 0 && !showAddForm && (
        <View style={styles.emptyState}>
          <Wallet size={48} color={colors.dark.textMuted} />
          <Text style={styles.emptyTitle}>صرافی‌ای اضافه نشده</Text>
          <Text style={styles.emptySubtitle}>
            با افزودن API صرافی، موجودی و ارزش دارایی‌های خود را مشاهده کنید
          </Text>
        </View>
      )}

      {showAddForm ? (
        <View style={styles.addForm}>
          <Text style={styles.addFormTitle}>افزودن صرافی جدید</Text>

          <Text style={styles.inputLabel}>انتخاب صرافی</Text>
          <DropdownPicker
            label="صرافی"
            value={selectedExchange}
            options={exchangeOptions}
            onSelect={(key) => {
              setSelectedExchange(key as ExchangeId);
              setOtpStatus(null);
            }}
            testID="wallet-exchange-dropdown"
          />

          <View style={styles.spacer} />
          <Text style={styles.inputLabel}>
            {isBitperp ? 'ایمیل حساب BitPerp' : 'API Key'}
          </Text>
          <TextInput
            style={[styles.input, isBitperp && styles.emailInput]}
            value={newApiKey}
            onChangeText={(t) => {
              setNewApiKey(t);
              if (isBitperp) setOtpStatus(null);
            }}
            placeholder={isBitperp ? 'example@mail.com' : 'API Key را وارد کنید'}
            placeholderTextColor={colors.dark.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType={isBitperp ? 'email-address' : 'default'}
            testID="wallet-api-key-input"
          />

          {isBitperp && (
            <Pressable
              style={({ pressed }) => [styles.otpButton, pressed && { opacity: 0.8 }]}
              disabled={otpBusy}
              onPress={handleSendOtp}
            >
              <Mail size={14} color="#FFF" />
              <Text style={styles.otpButtonText}>
                {otpBusy ? 'در حال ارسال...' : 'دریافت کد یکبارمصرف از بیت‌پرپ'}
              </Text>
            </Pressable>
          )}

          <Text style={styles.inputLabel}>
            {isBitperp ? 'کد یکبارمصرف (OTP) از ایمیل' : 'API Secret'}
          </Text>
          <View style={styles.secretRow}>
            <TextInput
              style={[styles.input, styles.secretInput]}
              value={newApiSecret}
              onChangeText={setNewApiSecret}
              placeholder={isBitperp ? 'کد ۶ رقمی' : 'API Secret را وارد کنید'}
              placeholderTextColor={colors.dark.textMuted}
              secureTextEntry={!showSecrets}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType={isBitperp ? 'number-pad' : 'default'}
              testID="wallet-api-secret-input"
            />
            <Pressable
              style={styles.eyeBtn}
              onPress={() => setShowSecrets(!showSecrets)}
            >
              {showSecrets ? (
                <EyeOff size={18} color={colors.dark.textMuted} />
              ) : (
                <Eye size={18} color={colors.dark.textMuted} />
              )}
            </Pressable>
          </View>

          {!isBitperp && needsPassphrase && (
            <>
              <Text style={styles.inputLabel}>Passphrase</Text>
              <TextInput
                style={styles.input}
                value={newPassphrase}
                onChangeText={setNewPassphrase}
                placeholder="Passphrase را وارد کنید"
                placeholderTextColor={colors.dark.textMuted}
                secureTextEntry={!showSecrets}
                autoCapitalize="none"
                autoCorrect={false}
                testID="wallet-passphrase-input"
              />
            </>
          )}

          {otpStatus ? <Text style={styles.otpStatus}>{otpStatus}</Text> : null}

          <View style={styles.infoBox}>
            <Text style={styles.infoIcon}>ℹ️</Text>
            <Text style={styles.infoText}>
              {isBitperp
                ? 'ورود بیت‌پرپ با ایمیل و کد یکبارمصرف انجام می‌شود (بدون API Key). کد به ایمیل شما ارسال می‌شود و نشست به‌صورت خودکار تمدید می‌شود.'
                : 'فقط از API با دسترسی Read-Only استفاده کنید. اطلاعات به صورت محلی ذخیره می‌شوند.'}
            </Text>
          </View>

          <View style={styles.formActions}>
            <Pressable
              style={[styles.formBtn, styles.formBtnSave]}
              disabled={otpBusy}
              onPress={() => void handleAddWallet()}
            >
              <Save size={16} color={colors.dark.background} />
              <Text style={styles.formBtnSaveText}>
                {isBitperp ? 'ورود به بیت‌پرپ' : 'ذخیره'}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.formBtn, styles.formBtnCancel]}
              onPress={() => {
                setShowAddForm(false);
                setNewApiKey('');
                setNewApiSecret('');
                setNewPassphrase('');
                setOtpStatus(null);
              }}
            >
              <Text style={styles.formBtnCancelText}>لغو</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable
          style={styles.addButton}
          onPress={() => setShowAddForm(true)}
          testID="add-wallet-button"
        >
          <Plus size={18} color={colors.dark.accent} />
          <Text style={styles.addButtonText}>افزودن صرافی جدید</Text>
        </Pressable>
      )}
      </>
      )
      )}

      {/* ── تب ۲: دارایی ریالی و فلزات (ریال + طلا + نقره + سکه + ارز + کیف بلاکچین) ── */}
      {activeMainTab === 'rial' && (
        <>
          <LocalAssetsSection
            usdtToToman={usdtToToman}
            totalPortfolioUsd={totalPortfolioUsd}
            blockchainToman={blockchainToman}
            hasBlockchainWallet={hasBlockchainWallet}
            blockchainPnlTomanByPeriod={blockchainPnlTomanByPeriod}
            blockchainTotalUsd={blockchainTotalUsd}
          />
        </>
      )}

      {/* ── تب ۳: پیش‌بینی قیمت طلا (IME آتی شمش خام ۹۹۵) ── */}
      {activeMainTab === 'gold' && (
        <>
          <GoldPredictionSection />
        </>
      )}

      {/* ── تب ۴ (v1.4.16): کیف پول بلاکچین — فقط خواندنی ── */}
      {activeMainTab === 'blockchain' && (
        <BlockchainWalletsSection
          wallets={bcWallets}
          balanceByWallet={bcBalanceByWallet}
          usdtToToman={usdtToToman}
          pnlSummary={bcPnlQuery.data}
          pnlLoading={bcPnlQuery.isLoading}
          vpnStatus={vpnStatus}
          vpnChecking={vpnChecking}
          onRecheckVpn={() => void recheckVpn(true)}
          onAddWallet={handleAddBlockchainWallet}
          onEditWallet={handleEditBlockchainWallet}
          onRemoveWallet={handleRemoveBlockchainWallet}
          onRefreshAll={handleRefreshBlockchainAll}
          onRefreshWallet={handleRefreshBlockchainWallet}
          manualRefreshing={bcManualRefresh}
          refreshToast={bcRefreshToast}
        />
      )}

      <View style={styles.disclaimer}>
        <Text style={styles.disclaimerText}>
          ⚠️ اطلاعات API به صورت محلی ذخیره می‌شوند و به هیچ سروری ارسال نمی‌شوند.
        </Text>
      </View>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Per-exchange card (collapsible) with INNER section tabs:
// «همه» (one row per asset, summed across sections) + اسپات/ارن/آلفا/فیوچرز/فاندینگ
// ---------------------------------------------------------------------------

/** Short labels for the inner tab chips. */
const SECTION_TAB_LABEL: Record<WalletSection, string> = {
  spot: 'اسپات',
  earn: 'ارن',
  funding: 'فاندینگ',
  futures: 'فیوچرز',
  alpha: 'آلفا',
  copy: 'کپی‌ترید',
};

/** Tab order — matches the user-requested اسپات/ارن/آلفا/فیوچرز/فاندینگ. */
const SECTION_ORDER: WalletSection[] = ['spot', 'copy', 'earn', 'alpha', 'futures', 'funding'];

interface AggregatedBalance extends WalletBalance {
  sections: WalletSection[];
}

interface WalletItemProps {
  wallet: ExchangeWallet;
  isExpanded: boolean;
  usdtToToman: number;
  balanceQuery: ReturnType<typeof useQuery<ExchangeBalanceData>>;
  /** v1.4.7 — exit-IP status drives the per-exchange Iran gate card. */
  vpnStatus: VpnStatus;
  vpnChecking: boolean;
  onRecheckVpn: () => void;
  onToggle: () => void;
  onRemove: () => void;
  onRefresh: () => void;
}

function WalletItem({
  wallet,
  isExpanded,
  usdtToToman,
  balanceQuery,
  vpnStatus,
  vpnChecking,
  onRecheckVpn,
  onToggle,
  onRemove,
  onRefresh,
}: WalletItemProps) {
  const [activeSection, setActiveSection] = useState<'all' | WalletSection>('all');
  // v1.4.12 — sanctioned-IP (geo-blocked) state for THIS exchange: the VPN is
  // on and the exit IP is NOT Iranian, but this one exchange answered with a
  // geo-block status (451/403/418) → «این صرافی IP شما را تحریم کرده».
  const balanceErrorMessage =
    balanceQuery?.error instanceof Error ? balanceQuery.error.message : undefined;
  const sanctionedIp = isSanctionedIpMessage(balanceErrorMessage);
  const sanctionedDialogShown = useRef(false);
  useEffect(() => {
    if (!sanctionedIp || sanctionedDialogShown.current) return;
    sanctionedDialogShown.current = true;
    ThemedAlert.alert(
      `صرافی ${wallet.exchangeName} تحریم است`,
      `IP خروجی فیلترشکن شما توسط این صرافی بلاک جغرافیایی شده (کشور تحریمی/محدود).\n\nبقیه صرافی‌ها اوکی هستند و به کار خود ادامه می‌دهند — می‌توانید فقط همین صرافی را قطع کنید یا با یک IP غیرتحریمی (کشور دیگر) دوباره تلاش کنید.`,
      [
        { text: 'قطع این صرافی', style: 'destructive', onPress: onRemove },
        { text: 'باشه، بعداً' },
      ]
    );
  }, [sanctionedIp, wallet.exchangeName, onRemove]);
  // v1.4.5 CRASH FIX: `balanceQueries` (useQueries) is EMPTY while the cached
  // snapshots are still loading (cachesLoaded=false), yet `wallets` already
  // holds every saved exchange — `balanceQueries[idx]` is undefined for a
  // moment and `balanceQuery.data` crashed the whole app on screen entry.
  // Every access is now null-safe; a missing query simply renders as "loading".
  const data = balanceQuery?.data;
  const isLoading = balanceQuery?.isLoading ?? false;
  const isFetching = balanceQuery?.isFetching ?? false;
  const hasError = !!balanceQuery?.error;

  // v1.4.7 — IRAN GATE for THIS exchange: foreign exchange + Iranian exit IP.
  const foreignExchange = isForeignExchange(wallet.exchangeId);
  const iranGated = foreignExchange && vpnStatus === 'iran';
  // The gate swallows any query error while active (the real reason IS the
  // gate — showing «خطا در دریافت موجودی» under it would be misleading).
  const gateError =
    balanceQuery?.error instanceof Error && balanceQuery.error.message === IRAN_GATE_ERROR;
  const showBalanceError = hasError && !iranGated && !gateError;
  // v1.4.12 — the sanctioned card replaces the generic error card.
  const showGenericBalanceError = showBalanceError && !sanctionedIp;

  // v1.4.8 — per-exchange dust threshold. BitPerp's own wallet page shows
  // even a 5-cent balance («۵ سنت موجودی دارم اما صفر می‌زند»), and any
  // exchange whose TOTAL portfolio is under $1 also shows everything it has
  // (hiding the whole wallet behind a $1-per-asset filter made it look empty).
  // v1.4.17 — rows with NO resolved price (price source down / futures-only
  // coin) are KEPT and shown as «قیمت نامشخص» instead of silently dropped.
  const dustFilterUsd = useMemo(() => {
    if (wallet.exchangeId === 'bitperp') return 0.0001;
    if (data && data.totalValueUsd > 0 && data.totalValueUsd < 1) return 0.0001;
    return DUST_FILTER_USD;
  }, [wallet.exchangeId, data]);

  // Only the sections that actually hold something get a tab.
  const presentSections = useMemo(() => {
    if (!data) return [] as WalletSection[];
    return SECTION_ORDER.filter((s) => data.balances.some((b) => (b.section ?? 'spot') === s));
  }, [data]);

  // «همه» — one row per asset summed across sections
  // (e.g. BTC in both اسپات and ارن → a single BTC row with the total).
  const aggregated = useMemo(() => {
    if (!data) return [] as AggregatedBalance[];
    const map = new Map<string, AggregatedBalance>();
    for (const bal of data.balances) {
      const section = bal.section ?? 'spot';
      const existing = map.get(bal.asset);
      if (existing) {
        existing.free += bal.free;
        existing.locked += bal.locked;
        existing.total += bal.total;
        existing.valueUsd += bal.valueUsd;
        if (bal.pnlUsd !== undefined) existing.pnlUsd = (existing.pnlUsd ?? 0) + bal.pnlUsd;
        if (bal.pnlPercent !== undefined) existing.pnlPercent = bal.pnlPercent;
        if (bal.avgCost !== undefined) existing.avgCost = bal.avgCost;
        if (!existing.sections.includes(section)) existing.sections.push(section);
      } else {
        map.set(bal.asset, { ...bal, sections: [section] });
      }
    }
    return [...map.values()]
      .filter((b) => b.valueUsd >= dustFilterUsd || (b.valueUsd <= 0 && b.total > 0))
      .sort((a, b) => b.valueUsd - a.valueUsd);
  }, [data, dustFilterUsd]);

  const sectionRows = useMemo(() => {
    if (!data || activeSection === 'all') return [] as WalletBalance[];
    return data.balances.filter(
      (b) =>
        (b.section ?? 'spot') === activeSection &&
        (b.valueUsd >= dustFilterUsd || (b.valueUsd <= 0 && b.total > 0))
    );
  }, [data, activeSection, dustFilterUsd]);

  const futuresPositions = useMemo(
    () => (data?.futuresPositions ?? []).filter((pos) => pos.notionalUsd >= dustFilterUsd),
    [data, dustFilterUsd]
  );

  const sectionTotalUsd = useMemo(
    () => sectionRows.reduce((sum, b) => sum + b.valueUsd, 0),
    [sectionRows]
  );

  return (
    <View style={styles.walletCard}>
      <Pressable style={styles.walletHeader} onPress={onToggle}>
        <View style={styles.walletLeft}>
          <View style={styles.walletIcon}>
            <Key size={18} color={colors.dark.blue} />
          </View>
          <View style={styles.walletInfo}>
            <Text style={styles.walletName}>{wallet.exchangeName}</Text>
            <Text style={styles.walletKey}>
              {wallet.exchangeId === 'bitperp'
                ? wallet.apiKey
                : `${wallet.apiKey.slice(0, 8)}...${wallet.apiKey.slice(-4)}`}
            </Text>
          </View>
        </View>
        <View style={styles.walletRight}>
          <View style={styles.walletHeaderTop}>
            <Text style={styles.walletTotal}>
              ${(data?.totalValueUsd ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}
            </Text>
            {usdtToToman > 0 && data?.totalValueUsd !== undefined && (
              <Text style={styles.walletToman}>
                ≈ {formatToman((data.totalValueUsd ?? 0) * usdtToToman)} ت
              </Text>
            )}
            {(isLoading || isFetching) && (
              <ActivityIndicator size="small" color={colors.dark.accent} />
            )}
          </View>
          {data?.totalPnlUsd !== undefined && data.totalPnlUsd !== 0 && (
            <Text
              style={[
                styles.walletPnl,
                { color: data.totalPnlUsd > 0 ? colors.dark.green : colors.dark.red },
              ]}
            >
              {data.totalPnlUsd > 0 ? '▲' : '▼'} {formatSignedUsd(data.totalPnlUsd)}
            </Text>
          )}
          <View style={styles.walletActions}>
            <Pressable style={styles.actionBtn} onPress={onRefresh} hitSlop={6}>
              <RefreshCw size={14} color={colors.dark.accent} />
            </Pressable>
            <Pressable style={styles.actionBtn} onPress={onRemove} hitSlop={6}>
              <Trash2 size={14} color={colors.dark.red} />
            </Pressable>
            {isExpanded ? (
              <ChevronUp size={16} color={colors.dark.textMuted} />
            ) : (
              <ChevronDown size={16} color={colors.dark.textMuted} />
            )}
          </View>
        </View>
      </Pressable>

      {isExpanded && (
        <View style={styles.walletExpanded}>
          {/* ── v1.4.7: گیت سخت ایران — هیچ درخواستی به این صرافی زده نمی‌شود ── */}
          {iranGated && (
            <View style={styles.iranGateCard}>
              <ShieldAlert size={18} color={colors.dark.orange} />
              <View style={styles.iranGateTextCol}>
                <Text style={styles.iranGateTitle}>فیلترشکن را وصل کنید</Text>
                <Text style={styles.iranGateBody}>
                  IP فعلی گوشی ایران است. برای امنیت حساب‌تان، با IP ایران هیچ اطلاعاتی از
                  این صرافی خوانده نمی‌شود (نه موجودی و نه سود/زیان). فیلترشکن را روشن کنید —
                  به‌محض وصل شدن، موجودی خودکار تازه می‌شود.
                </Text>
                <Pressable style={styles.iranGateBtn} onPress={onRecheckVpn} disabled={vpnChecking}>
                  <RefreshCw size={12} color={colors.dark.orange} />
                  <Text style={styles.iranGateBtnText}>
                    {vpnChecking ? 'در حال بررسی...' : 'بررسی مجدد فیلترشکن'}
                  </Text>
                </Pressable>
              </View>
            </View>
          )}

          {isLoading && !data && !iranGated && (
            <View style={styles.balanceLoading}>
              <ActivityIndicator size="small" color={colors.dark.accent} />
              <Text style={styles.balanceLoadingText}>دریافت موجودی...</Text>
            </View>
          )}

          {/* ── v1.4.12: تحریم IP توسط همین صرافی (۴۵۱/۴۰۳) — بقیه صرافی‌ها اوکی ── */}
          {sanctionedIp && (
            <View style={styles.sanctionCard}>
              <ShieldAlert size={18} color={colors.dark.red} />
              <View style={styles.iranGateTextCol}>
                <Text style={styles.sanctionTitle}>
                  صرافی {wallet.exchangeName} این IP را تحریم کرده
                </Text>
                <Text style={styles.iranGateBody}>
                  {sanctionedIpText(balanceErrorMessage ?? '')}
                </Text>
                <View style={styles.sanctionBtnRow}>
                  <Pressable style={styles.sanctionBtn} onPress={onRemove}>
                    <Text style={styles.sanctionBtnText}>قطع این صرافی</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.sanctionBtn, styles.sanctionBtnGhost]}
                    onPress={() => void onRecheckVpn()}
                  >
                    <Text style={styles.sanctionBtnGhostText}>بررسی مجدد IP</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          )}

          {showGenericBalanceError && (
            <View style={styles.balanceError}>
              <ShieldAlert size={14} color={colors.dark.red} />
              <Text style={styles.balanceErrorText}>
                {balanceErrorMessage
                  ? sanctionedIpText(balanceErrorMessage)
                  : 'خطا در دریافت موجودی — مطمئن شوید API معتبر است'}
              </Text>
            </View>
          )}

          {/* v1.5.5 — محدودیت رسمی LBank: API کلید فقط موجودی اسپات را می‌دهد؛
              فیوچرز/بخش‌های دیگر فقط داخل اپ خود LBank قابل مشاهده‌اند. اگر
              LBank مسیر API فیوچرز را باز کند، خودِ برنامه ردیف‌های فیوچرز را
              می‌آورد و این توضیح خودکار حذف می‌شود. */}
          {wallet.exchangeId === 'lbank' && !!data && !presentSections.includes('futures') && (
            <View style={styles.lbankNoteBox}>
              <Info size={13} color={colors.dark.accent} />
              <Text style={styles.lbankNoteText}>
                LBank فقط موجودی اسپات را از طریق API کلید می‌دهد — موجودی فیوچرز و بخش‌های دیگر آن محدودیتِ خود صرافی LBank است (برای همه اپ‌های شخص ثالث) و فقط داخل اپ/سایت خود LBank قابل مشاهده است. موجودی اسپات شما در بالا دقیق و کامل است.
              </Text>
            </View>
          )}

          {data && data.balances.length > 0 && (
            <View style={styles.balanceList}>
              {/* ── سربرگ‌های داخلی: همه + هر بخش ── */}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.sectionTabBar}
              >
                <Pressable
                  style={[
                    styles.sectionTabChip,
                    activeSection === 'all' && styles.sectionTabChipActive,
                  ]}
                  onPress={() => setActiveSection('all')}
                >
                  <Text
                    style={[
                      styles.sectionTabChipText,
                      activeSection === 'all' && styles.sectionTabChipTextActive,
                    ]}
                  >
                    همه
                  </Text>
                </Pressable>
                {presentSections.map((s) => (
                  <Pressable
                    key={s}
                    style={[
                      styles.sectionTabChip,
                      activeSection === s && styles.sectionTabChipActive,
                    ]}
                    onPress={() => setActiveSection(s)}
                  >
                    <Text
                      style={[
                        styles.sectionTabChipText,
                        activeSection === s && styles.sectionTabChipTextActive,
                      ]}
                    >
                      {SECTION_TAB_LABEL[s]}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>

              {/* ── v1.4.7: PnL دوره‌ای — بالای لیست ارزها (قبل از ردیف‌ها) ── */}
              <PnlPeriodSection wallet={wallet} iranGated={iranGated} />

              {activeSection === 'all' ? (
                <>
                  {aggregated.map((bal) => (
                    <AggregatedRow key={bal.asset} bal={bal} usdtToToman={usdtToToman} />
                  ))}
                  {aggregated.length === 0 && (
                    <Text style={styles.noBalance}>
                      موجودی قابل نمایشی نیست (ارزهای کوچک زیر ۱ دلار مخفی می‌شوند — بجز بیت‌پرپ که همه موجودی‌ها حتی چند سنت را نشان می‌دهد)
                    </Text>
                  )}

                  {/* پوزیشن‌های باز فیوچرز */}
                  {futuresPositions.length > 0 && (
                    <View style={styles.sectionBlock}>
                      <View style={styles.sectionHeader}>
                        <Text style={styles.sectionTitle}>پوزیشن‌های باز فیوچرز</Text>
                        {data.futuresUnrealizedPnl !== undefined && (
                          <Text
                            style={[
                              styles.sectionTotal,
                              {
                                color:
                                  data.futuresUnrealizedPnl > 0
                                    ? colors.dark.green
                                    : colors.dark.red,
                              },
                            ]}
                          >
                            uPnL: {formatSignedUsd(data.futuresUnrealizedPnl)}
                          </Text>
                        )}
                      </View>
                      {futuresPositions.map((pos) => (
                        <FuturesPositionRow key={`${pos.symbol}-${pos.positionSide}`} pos={pos} />
                      ))}
                      {data.futuresRealizedPnl !== undefined && (
                        <Text style={styles.futuresRealized}>
                          سود/زیان محقق‌شده فیوچرز (کل تاریخچه):{' '}
                          {formatSignedUsd(data.futuresRealizedPnl)}
                        </Text>
                      )}
                    </View>
                  )}

                  {/* سود/زیان کل این صرافی */}
                  {data.totalPnlUsd !== undefined && (
                    <View style={styles.walletPnlRow}>
                      <Text style={styles.walletPnlLabel}>سود/زیان کل این صرافی (تقریبی)</Text>
                      <Text
                        style={[
                          styles.walletPnlValue,
                          {
                            color:
                              data.totalPnlUsd > 0 ? colors.dark.green : colors.dark.red,
                          },
                        ]}
                      >
                        {formatSignedUsd(data.totalPnlUsd)}
                      </Text>
                    </View>
                  )}
                  {data.pnlNote && <Text style={styles.pnlNote}>{data.pnlNote}</Text>}
                </>
              ) : (
                <>
                  <View style={styles.sectionHeader}>
                    <Text style={styles.sectionTitle}>{SECTION_LABEL[activeSection]}</Text>
                    <Text style={styles.sectionTotal}>
                      ${sectionTotalUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </Text>
                  </View>
                  {sectionRows.map((bal) => (
                    <BalanceRow
                      key={`${activeSection}-${bal.asset}`}
                      bal={bal}
                      usdtToToman={usdtToToman}
                    />
                  ))}
                  {activeSection === 'futures' && futuresPositions.length > 0 && (
                    <View style={styles.sectionBlock}>
                      <View style={styles.sectionHeader}>
                        <Text style={styles.sectionTitle}>پوزیشن‌های باز</Text>
                        {data.futuresUnrealizedPnl !== undefined && (
                          <Text
                            style={[
                              styles.sectionTotal,
                              {
                                color:
                                  data.futuresUnrealizedPnl > 0
                                    ? colors.dark.green
                                    : colors.dark.red,
                              },
                            ]}
                          >
                            uPnL: {formatSignedUsd(data.futuresUnrealizedPnl)}
                          </Text>
                        )}
                      </View>
                      {futuresPositions.map((pos) => (
                        <FuturesPositionRow key={`${pos.symbol}-${pos.positionSide}`} pos={pos} />
                      ))}
                      {data.futuresRealizedPnl !== undefined && (
                        <Text style={styles.futuresRealized}>
                          سود/زیان محقق‌شده فیوچرز (کل تاریخچه):{' '}
                          {formatSignedUsd(data.futuresRealizedPnl)}
                        </Text>
                      )}
                    </View>
                  )}
                  {sectionRows.length === 0 && (
                    <Text style={styles.noBalance}>در این بخش موجودی‌ای نیست</Text>
                  )}
                </>
              )}
            </View>
          )}

          {data && data.balances.length === 0 && !isLoading && (
            <Text style={styles.noBalance}>موجودی‌ای یافت نشد</Text>
          )}

          {data?.lastUpdated && (
            <Text style={styles.lastUpdate}>
              آخرین بروزرسانی: {new Date(data.lastUpdated).toLocaleTimeString('fa-IR')}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

function BalanceRow({ bal, usdtToToman }: { bal: WalletBalance; usdtToToman: number }) {
  return (
    <View style={styles.balanceRow}>
      <View style={styles.balanceLeft}>
        <View style={styles.assetBadge}>
          <Text style={styles.assetBadgeText}>{bal.asset.slice(0, 3)}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.assetName}>{bal.asset}</Text>
          <Text style={styles.assetAmount}>
            {bal.free.toFixed(4)}{bal.locked > 0 ? ` (+${bal.locked.toFixed(4)} قفل)` : ''}
          </Text>
          {bal.avgCost !== undefined && bal.avgCost > 0 && (
            <Text style={styles.assetAvg}>
              میانگین خرید: ${bal.avgCost < 1 ? bal.avgCost.toPrecision(4) : bal.avgCost.toFixed(2)}
            </Text>
          )}
        </View>
      </View>
      <View style={styles.balanceRight}>
        <Text style={styles.balanceValue}>
          ≈ ${bal.valueUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}
        </Text>
        {bal.pnlUsd !== undefined && bal.pnlUsd !== 0 && (
          <Text
            style={[
              styles.balancePnl,
              { color: bal.pnlUsd > 0 ? colors.dark.green : colors.dark.red },
            ]}
          >
            {formatSignedUsd(bal.pnlUsd)}
            {bal.pnlPercent !== undefined &&
              ` (${bal.pnlPercent > 0 ? '+' : ''}${bal.pnlPercent.toFixed(1)}%)`}
          </Text>
        )}
        {usdtToToman > 0 && bal.valueUsd > 0 && (
          <Text style={styles.balanceToman}>
            ≈ {formatToman(bal.valueUsd * usdtToToman)} ت
          </Text>
        )}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// «همه» aggregated row — per-asset sum across sections with section chips
// ---------------------------------------------------------------------------

function AggregatedRow({ bal, usdtToToman }: { bal: AggregatedBalance; usdtToToman: number }) {
  // Chips only when the asset lives in more than one (or a non-spot) section.
  const showSectionChips =
    bal.sections.length > 1 || (bal.sections.length === 1 && bal.sections[0] !== 'spot');
  return (
    <View style={styles.balanceRow}>
      <View style={styles.balanceLeft}>
        <View style={styles.assetBadge}>
          <Text style={styles.assetBadgeText}>{bal.asset.slice(0, 3)}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.assetName}>{bal.asset}</Text>
          <Text style={styles.assetAmount}>
            {bal.free.toFixed(4)}{bal.locked > 0 ? ` (+${bal.locked.toFixed(4)} قفل)` : ''}
          </Text>
          {showSectionChips && (
            <Text style={styles.assetSections}>
              {bal.sections.map((s) => SECTION_TAB_LABEL[s]).join(' + ')}
            </Text>
          )}
        </View>
      </View>
      <View style={styles.balanceRight}>
        <Text style={styles.balanceValue}>
          ≈ ${bal.valueUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}
        </Text>
        {bal.pnlUsd !== undefined && bal.pnlUsd !== 0 && (
          <Text
            style={[
              styles.balancePnl,
              { color: bal.pnlUsd > 0 ? colors.dark.green : colors.dark.red },
            ]}
          >
            {formatSignedUsd(bal.pnlUsd)}
            {bal.pnlPercent !== undefined &&
              ` (${bal.pnlPercent > 0 ? '+' : ''}${bal.pnlPercent.toFixed(1)}%)`}
          </Text>
        )}
        {usdtToToman > 0 && bal.valueUsd > 0 && (
          <Text style={styles.balanceToman}>
            ≈ {formatToman(bal.valueUsd * usdtToToman)} ت
          </Text>
        )}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Open futures position row
// ---------------------------------------------------------------------------

function FuturesPositionRow({ pos }: { pos: FuturesPosition }) {
  return (
    <View style={styles.positionRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.positionSymbol}>
          {pos.symbol.replace('USDT', '/USDT')}{' '}
          <Text
            style={{
              color:
                pos.positionSide === 'SHORT' || pos.unrealizedPnl < 0
                  ? colors.dark.red
                  : colors.dark.green,
            }}
          >
            {pos.positionSide === 'BOTH' ? '' : pos.positionSide} {pos.leverage}x
          </Text>
        </Text>
        <Text style={styles.positionDetail}>
          ورود: ${pos.entryPrice < 1 ? pos.entryPrice.toPrecision(4) : pos.entryPrice.toFixed(2)} → قیمت: ${pos.markPrice < 1 ? pos.markPrice.toPrecision(4) : pos.markPrice.toFixed(2)}
        </Text>
        <Text style={styles.positionDetail}>
          ارزش پوزیشن: ${pos.notionalUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}
        </Text>
      </View>
      <View style={styles.positionRight}>
        <Text
          style={[
            styles.positionPnl,
            {
              color: pos.unrealizedPnl > 0 ? colors.dark.green : colors.dark.red,
            },
          ]}
        >
          {formatSignedUsd(pos.unrealizedPnl)}
        </Text>
        <Text
          style={[
            styles.positionRoe,
            {
              color: pos.roePercent > 0 ? colors.dark.green : colors.dark.red,
            },
          ]}
        >
          ROE: {pos.roePercent > 0 ? '+' : ''}
          {pos.roePercent.toFixed(2)}%
        </Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// PnL period selector + result (exchange-native numbers)
// ---------------------------------------------------------------------------

function PnlPeriodSection({ wallet, iranGated }: { wallet: ExchangeWallet; iranGated?: boolean }) {
  const [period, setPeriod] = useState<PnlPeriodDays>(30);
  const pnlQuery = useQuery({
    queryKey: ['exchange-pnl', wallet.id, period],
    queryFn: () => fetchPeriodPnl(wallet, period),
    staleTime: 5 * 60_000,
    // v1.4.9 — retry: 0 meant ONE transient failure at screen-open (network
    // burst when all queries fire at once) permanently showed the error card
    // until the period chip was toggled. Two delayed retries fix it.
    retry: 2,
    retryDelay: (attempt) => 1200 * (attempt + 1),
    // v1.4.7 — the PnL endpoints hit the exchange API too: they are fully
    // disabled while the exit IP is Iranian (same hard gate as balances).
    enabled: !iranGated,
  });
  const pnl = pnlQuery.data;
  // v1.4.9 — manual refetch button on the error card.
  const refetchPnl = useCallback(() => {
    void pnlQuery.refetch();
  }, [pnlQuery]);

  return (
    <View style={styles.pnlSection}>
      <View style={styles.pnlSectionHeader}>
        <TrendingUp size={14} color={colors.dark.accent} />
        <Text style={styles.pnlSectionTitle}>سود/زیان (PnL) دوره‌ای</Text>
        {pnlQuery.isFetching && (
          <ActivityIndicator size="small" color={colors.dark.accent} />
        )}
      </View>

      {iranGated ? (
        <Text style={styles.pnlNote}>
          🔒 با IP ایران، سود/زیان این صرافی خوانده نمی‌شود — فیلترشکن را وصل کنید.
        </Text>
      ) : (
        <>
      <View style={styles.pnlChipsRow}>
        {PNL_PERIODS.map((p) => {
          const active = period === p;
          return (
            <Pressable
              key={p}
              style={[styles.pnlChip, active && styles.pnlChipActive]}
              onPress={() => setPeriod(p)}
            >
              <Text style={[styles.pnlChipText, active && styles.pnlChipTextActive]}>
                {PNL_PERIOD_LABEL[p]}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {pnlQuery.error && !pnl && (
        <View>
          <Text style={styles.pnlNote}>
            {pnlQuery.error instanceof Error
              ? sanctionedIpText(pnlQuery.error.message)
              : 'خطا در دریافت اطلاعات این بازه — کلید API و اتصال اینترنت را بررسی کنید.'}
          </Text>
          <Pressable style={styles.pnlRetryBtn} onPress={refetchPnl} disabled={pnlQuery.isFetching}>
            <Text style={styles.pnlRetryBtnText}>
              {pnlQuery.isFetching ? 'در حال تلاش مجدد…' : 'تلاش مجدد'}
            </Text>
          </Pressable>
        </View>
      )}

      {pnl && !pnl.supported && (
        <Text style={styles.pnlNote}>ℹ️ {pnl.unavailableReason}</Text>
      )}

      {pnl && pnl.supported && (
        <View style={styles.pnlResult}>
          <View style={styles.pnlRow}>
            <Text style={styles.pnlRowLabel}>سود/زیان محقق‌شده ({pnl.closedCount} معامله بسته):</Text>
            <Text
              style={[
                styles.pnlRowValue,
                { color: pnl.realizedPnl > 0 ? colors.dark.green : pnl.realizedPnl < 0 ? colors.dark.red : colors.dark.text },
              ]}
            >
              {formatSignedUsd(pnl.realizedPnl)}
            </Text>
          </View>
          {pnl.fundingFees !== 0 && (
            <View style={styles.pnlRow}>
              <Text style={styles.pnlRowLabel}>کارمزد فاندینگ:</Text>
              <Text
                style={[
                  styles.pnlRowValue,
                  { color: pnl.fundingFees > 0 ? colors.dark.green : colors.dark.red },
                ]}
              >
                {formatSignedUsd(pnl.fundingFees)}
              </Text>
            </View>
          )}
          {pnl.commissions !== 0 && (
            <View style={styles.pnlRow}>
              <Text style={styles.pnlRowLabel}>کارمزد معاملات:</Text>
              <Text
                style={[
                  styles.pnlRowValue,
                  { color: pnl.commissions > 0 ? colors.dark.green : colors.dark.red },
                ]}
              >
                {formatSignedUsd(pnl.commissions)}
              </Text>
            </View>
          )}
          <View style={styles.pnlRow}>
            <Text style={styles.pnlRowLabel}>سود/زیان پوزیشن‌های باز (لحظه‌ای):</Text>
            <Text
              style={[
                styles.pnlRowValue,
                { color: pnl.unrealizedPnl > 0 ? colors.dark.green : pnl.unrealizedPnl < 0 ? colors.dark.red : colors.dark.text },
              ]}
            >
              {formatSignedUsd(pnl.unrealizedPnl)}
            </Text>
          </View>
          <View style={[styles.pnlRow, styles.pnlTotalRow]}>
            <Text style={styles.pnlTotalLabel}>مجموع دوره {PNL_PERIOD_LABEL[pnl.periodDays as PnlPeriodDays]}:</Text>
            <Text
              style={[
                styles.pnlTotalValue,
                {
                  color:
                    pnl.realizedPnl + pnl.fundingFees + pnl.commissions > 0
                      ? colors.dark.green
                      : pnl.realizedPnl + pnl.fundingFees + pnl.commissions < 0
                        ? colors.dark.red
                        : colors.dark.text,
                },
              ]}
            >
              {formatSignedUsd(pnl.realizedPnl + pnl.fundingFees + pnl.commissions)}
            </Text>
          </View>
          {pnl.note && <Text style={styles.pnlNote}>{pnl.note}</Text>}
        </View>
      )}
        </>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// v1.4.7 — Total Portfolio PnL with periods (مجموع همه صرافی‌ها)
// Aggregates the exchange-native period PnL of every wallet that supports it
// (Binance / Bybit / OKX / BitPerp) into one card in the portfolio header.
// ---------------------------------------------------------------------------

const PERIOD_PNL_EXCHANGES: ReadonlySet<string> = new Set([
  'binance',
  'bybit',
  'okx',
  'bitperp',
  'mexc',
  'bitget',
]);

function TotalPnlPeriodSection({
  wallets,
  foreignBlocked,
  ipBlocked,
}: {
  wallets: ExchangeWallet[];
  foreignBlocked: boolean;
  /** v1.2.0 — گیت سخت IP تحریمی: کل PnL صرافی‌ها غیرفعال */
  ipBlocked?: boolean;
}) {
  const [period, setPeriod] = useState<PnlPeriodDays>(30);

  // Only exchanges whose API actually provides period PnL.
  const supportedWallets = useMemo(
    () => wallets.filter((w) => PERIOD_PNL_EXCHANGES.has(w.exchangeId)),
    [wallets]
  );

  const pnlQueries = useQueries({
    queries: supportedWallets.map((w) => ({
      queryKey: ['exchange-pnl', w.id, period] as const,
      queryFn: () => fetchPeriodPnl(w, period),
      staleTime: 5 * 60_000,
      // v1.4.9 — same delayed-retry policy as the per-exchange section: a
      // single network hiccup must NOT permanently exclude an exchange from
      // the TOTAL (that was the «مجموع کامل نشان نمی‌دهد مخصوصاً بایننس» bug:
      // a failed Binance query was silently skipped in the aggregate).
      retry: 2,
      retryDelay: (attempt: number) => 1200 * (attempt + 1),
      // Same Iran hard gate: foreign exchange PnL endpoints stay untouched.
      // v1.2.0 — با IP تحریمی کل PnL صرافی‌ها (حتی ایرانی‌ها) غیرفعال.
      enabled: !ipBlocked && !(foreignBlocked && isForeignExchange(w.exchangeId)),
    })),
  });

  const aggregate = useMemo(() => {
    let realized = 0;
    let funding = 0;
    let commissions = 0;
    let unrealized = 0;
    let closed = 0;
    let supportedCount = 0;
    let loading = false;
    // v1.4.9 — exchanges whose PnL fetch FAILED (query error, no data) —
    // shown as an explicit warning instead of silently vanishing from the sum.
    const failedNames: string[] = [];
    supportedWallets.forEach((w, i) => {
      const q = pnlQueries[i];
      const pnl = q?.data;
      if (!pnl) {
        if (q?.isFetching) loading = true;
        else if (q?.isError) failedNames.push(w.exchangeName);
        return;
      }
      if (pnl.supported) {
        supportedCount++;
        realized += pnl.realizedPnl;
        funding += pnl.fundingFees;
        commissions += pnl.commissions;
        unrealized += pnl.unrealizedPnl;
        closed += pnl.closedCount;
      }
    });
    return { realized, funding, commissions, unrealized, closed, supportedCount, loading, failedNames };
  }, [supportedWallets, pnlQueries]);

  // v1.4.9 — one-button retry: refetches every failed/loaded query.
  const refetchAllPnl = useCallback(() => {
    pnlQueries.forEach((q) => {
      if (q && (q.isError || !q.data)) void q.refetch();
    });
  }, [pnlQueries]);

  if (supportedWallets.length === 0) return null;

  const total = aggregate.realized + aggregate.funding + aggregate.commissions;

  return (
    <View style={styles.pnlSection}>
      <View style={styles.pnlSectionHeader}>
        <TrendingUp size={14} color={colors.dark.accent} />
        <Text style={styles.pnlSectionTitle}>سود/زیان دوره‌ای کل دارایی‌ها (مجموع صرافی‌ها)</Text>
        {aggregate.loading && (
          <ActivityIndicator size="small" color={colors.dark.accent} />
        )}
      </View>

      <View style={styles.pnlChipsRow}>
        {PNL_PERIODS.map((p) => {
          const active = period === p;
          return (
            <Pressable
              key={p}
              style={[styles.pnlChip, active && styles.pnlChipActive]}
              onPress={() => setPeriod(p)}
            >
              <Text style={[styles.pnlChipText, active && styles.pnlChipTextActive]}>
                {PNL_PERIOD_LABEL[p]}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {foreignBlocked ? (
        <Text style={styles.pnlNote}>
          🔒 با IP ایران، سود/زیان صرافی‌های خارجی خوانده نمی‌شود — فیلترشکن را وصل کنید.
        </Text>
      ) : aggregate.supportedCount === 0 && !aggregate.loading ? (
        <Text style={styles.pnlNote}>
          ℹ️ سود/زیان دوره‌ای از API خود صرافی‌ها خوانده می‌شود و برای بایننس، بای‌بیت، OKX، مکسی،
          بیتگت و بیت‌پرپ فعال است — صرافی‌های دیگر هنوز در API خود این داده را ارائه نمی‌دهند.
        </Text>
      ) : (
        <View style={styles.pnlResult}>
          <View style={styles.pnlRow}>
            <Text style={styles.pnlRowLabel}>سود/زیان محقق‌شده ({aggregate.closed} معامله بسته):</Text>
            <Text
              style={[
                styles.pnlRowValue,
                { color: aggregate.realized > 0 ? colors.dark.green : aggregate.realized < 0 ? colors.dark.red : colors.dark.text },
              ]}
            >
              {formatSignedUsd(aggregate.realized)}
            </Text>
          </View>
          {aggregate.funding !== 0 && (
            <View style={styles.pnlRow}>
              <Text style={styles.pnlRowLabel}>کارمزد فاندینگ:</Text>
              <Text
                style={[
                  styles.pnlRowValue,
                  { color: aggregate.funding > 0 ? colors.dark.green : colors.dark.red },
                ]}
              >
                {formatSignedUsd(aggregate.funding)}
              </Text>
            </View>
          )}
          {aggregate.commissions !== 0 && (
            <View style={styles.pnlRow}>
              <Text style={styles.pnlRowLabel}>کارمزد معاملات:</Text>
              <Text
                style={[
                  styles.pnlRowValue,
                  { color: aggregate.commissions > 0 ? colors.dark.green : colors.dark.red },
                ]}
              >
                {formatSignedUsd(aggregate.commissions)}
              </Text>
            </View>
          )}
          <View style={styles.pnlRow}>
            <Text style={styles.pnlRowLabel}>سود/زیان پوزیشن‌های باز (لحظه‌ای):</Text>
            <Text
              style={[
                styles.pnlRowValue,
                { color: aggregate.unrealized > 0 ? colors.dark.green : aggregate.unrealized < 0 ? colors.dark.red : colors.dark.text },
              ]}
            >
              {formatSignedUsd(aggregate.unrealized)}
            </Text>
          </View>
          <View style={[styles.pnlRow, styles.pnlTotalRow]}>
            <Text style={styles.pnlTotalLabel}>
              مجموع دوره {PNL_PERIOD_LABEL[period]} ({aggregate.supportedCount} صرافی):
            </Text>
            <Text
              style={[
                styles.pnlTotalValue,
                {
                  color:
                    total > 0
                      ? colors.dark.green
                      : total < 0
                        ? colors.dark.red
                        : colors.dark.text,
                },
              ]}
            >
              {formatSignedUsd(total)}
            </Text>
          </View>
          {aggregate.failedNames.length > 0 && (
            <View style={styles.pnlFailedBox}>
              <Text style={styles.pnlFailedText}>
                ⚠️ داده‌ی این صرافی‌ها در این مجموع دریافت نشد: {aggregate.failedNames.join('، ')} — ممکن است
                مجموع کمی ناقص باشد.
              </Text>
              <Pressable
                style={styles.pnlRetryBtn}
                onPress={refetchAllPnl}
                disabled={aggregate.loading}
              >
                <Text style={styles.pnlRetryBtnText}>
                  {aggregate.loading ? 'در حال تلاش مجدد…' : 'تلاش مجدد برای همه'}
                </Text>
              </Pressable>
            </View>
          )}
          <Text style={styles.pnlNote}>
            مجموع سود/زیان بایننس، بای‌بیت، OKX، مکسی، بیتگت و بیت‌پرپ در {PNL_PERIOD_LABEL[period]} انتخابی — دقیقاً از
            API خود صرافی‌ها (صرافی‌های بدون این قابلیت در مجموع لحاظ نمی‌شوند)
          </Text>
        </View>
      )}
    </View>
  );
}
const styles = createThemedStyles(() => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.dark.background,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 40,
  },
  // v1.4.14 — three top-level tabs (ارز دیجیتال | ریالی و فلزات | پیش‌بینی طلا)
  mainTabBar: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 14,
  },
  mainTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 9,
    borderRadius: 12,
    backgroundColor: colors.dark.card,
    borderWidth: 1,
    borderColor: colors.dark.border,
  },
  mainTabActive: {
    backgroundColor: colors.dark.accent + '18',
    borderColor: colors.dark.accent + '55',
  },
  mainTabText: {
    // v1.4.16 — 9px (was 10): the 4th tab «کیف پول بلاکچین» needs the room
    fontSize: 9,
    fontWeight: '700' as const,
    color: colors.dark.textSecondary,
    textAlign: 'center',
  },
  mainTabTextActive: {
    color: colors.dark.accent,
    fontWeight: '800' as const,
  },
  sectionTabBar: {
    flexDirection: 'row',
    gap: 6,
    paddingVertical: 4,
    marginBottom: 6,
  },
  sectionTabChip: {
    backgroundColor: colors.dark.surface,
    borderWidth: 1,
    borderColor: colors.dark.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    minWidth: 44,
    alignItems: 'center',
  },
  sectionTabChipActive: {
    backgroundColor: colors.dark.accentDim,
    borderColor: colors.dark.accent,
  },
  sectionTabChipText: {
    fontSize: 11,
    fontWeight: '600' as const,
    color: colors.dark.textSecondary,
  },
  sectionTabChipTextActive: {
    color: colors.dark.accent,
    fontWeight: '700' as const,
  },
  assetSections: {
    fontSize: 9,
    color: colors.dark.blue,
    marginTop: 1,
    letterSpacing: 0.2,
  },
  portfolioBreakdown: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.dark.border,
    gap: 4,
  },
  portfolioBreakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  portfolioBreakdownName: {
    fontSize: 12,
    color: colors.dark.textSecondary,
  },
  portfolioBreakdownValue: {
    fontSize: 12,
    fontWeight: '600' as const,
    color: colors.dark.text,
  },
  portfolioCard: {
    backgroundColor: colors.dark.surface,
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.dark.accent + '33',
  },
  portfolioHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  portfolioTitle: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: colors.dark.textSecondary,
    flex: 1,
    textAlign: 'right',
  },
  refreshAllBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: colors.dark.accentDim,
  },
  portfolioValues: {
    gap: 8,
    marginBottom: 10,
  },
  portfolioValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.dark.card,
    padding: 10,
    borderRadius: 10,
  },
  portfolioValueLabel: {
    fontSize: 12,
    color: colors.dark.textSecondary,
  },
  portfolioValueAmount: {
    flex: 1,
    textAlign: 'left',
    fontSize: 15,
    fontWeight: '700' as const,
    color: colors.dark.green,
  },
  tomanPriceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 10,
    paddingTop: 12,
    paddingBottom: 4,
    borderTopWidth: 1,
    borderTopColor: colors.dark.border,
  },
  tomanPriceLabel: {
    fontSize: 15,
    fontWeight: '700' as const,
    color: colors.dark.textSecondary,
  },
  tomanPriceValue: {
    fontSize: 20,
    fontWeight: '800' as const,
    color: colors.dark.accent,
    letterSpacing: 0.3,
  },
  portfolioSub: {
    fontSize: 12,
    color: colors.dark.textMuted,
    textAlign: 'center',
    marginTop: 6,
  },
  walletCard: {
    backgroundColor: colors.dark.surface,
    borderRadius: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.dark.border,
    overflow: 'hidden',
  },
  walletHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
  },
  walletLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  walletIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.dark.blueDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  walletInfo: {
    flex: 1,
  },
  walletName: {
    fontSize: 14,
    fontWeight: '700' as const,
    color: colors.dark.text,
    textAlign: 'right',
  },
  walletKey: {
    fontSize: 10,
    color: colors.dark.textMuted,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 2,
  },
  walletRight: {
    alignItems: 'flex-end',
    gap: 4,
  },
  walletHeaderTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  walletTotal: {
    fontSize: 15,
    fontWeight: '700' as const,
    color: colors.dark.text,
  },
  walletToman: {
    fontSize: 11,
    fontWeight: '600' as const,
    color: colors.dark.blue,
  },
  walletPnl: {
    fontSize: 12,
    fontWeight: '700' as const,
  },
  walletActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  actionBtn: {
    padding: 4,
  },
  walletExpanded: {
    borderTopWidth: 1,
    borderTopColor: colors.dark.border,
    padding: 14,
  },
  balanceLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 20,
  },
  balanceLoadingText: {
    fontSize: 13,
    color: colors.dark.textSecondary,
  },
  balanceError: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 16,
  },
  balanceErrorText: {
    fontSize: 13,
    color: colors.dark.red,
    flex: 1,
    textAlign: 'right',
  },
  // v1.5.5 — توضیح محدودیت LBank (فقط اسپات از طریق API)
  lbankNoteBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: colors.dark.accent + '12',
    borderColor: colors.dark.accent + '33',
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginTop: 6,
  },
  lbankNoteText: {
    fontSize: 11.5,
    color: colors.dark.textSecondary,
    flex: 1,
    textAlign: 'right',
    lineHeight: 17,
  },
  // ── v1.4.7: کارت گیت ایران (فیلترشکن خاموش) ──
  iranGateCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: colors.dark.orangeDim,
    borderWidth: 1,
    borderColor: colors.dark.orange + '66',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  iranGateTextCol: {
    flex: 1,
    gap: 4,
  },
  iranGateTitle: {
    fontSize: 13,
    fontWeight: '800' as const,
    color: colors.dark.orange,
    textAlign: 'right',
  },
  iranGateBody: {
    fontSize: 11,
    lineHeight: 18,
    color: colors.dark.orange,
    textAlign: 'right',
  },
  iranGateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: colors.dark.orange + '22',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginTop: 4,
  },
  iranGateBtnText: {
    fontSize: 11,
    fontWeight: '700' as const,
    color: colors.dark.orange,
  },
  // ── v1.4.12 — sanctioned-IP (geo-block) card styles ──
  sanctionCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: colors.dark.red + '14',
    borderWidth: 1,
    borderColor: colors.dark.red + '66',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  sanctionTitle: {
    fontSize: 13,
    fontWeight: '800' as const,
    color: colors.dark.red,
    textAlign: 'right',
  },
  sanctionBtnRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  sanctionBtn: {
    backgroundColor: colors.dark.red + '22',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  sanctionBtnText: {
    fontSize: 11,
    fontWeight: '700' as const,
    color: colors.dark.red,
  },
  sanctionBtnGhost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.dark.red + '55',
  },
  sanctionBtnGhostText: {
    fontSize: 11,
    fontWeight: '700' as const,
    color: colors.dark.red,
  },
  balanceList: {
    gap: 8,
  },
  sectionBlock: {
    gap: 6,
    marginBottom: 6,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.dark.surface,
    borderWidth: 1,
    borderColor: colors.dark.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700' as const,
    color: colors.dark.accent,
  },
  sectionTotal: {
    fontSize: 12,
    fontWeight: '600' as const,
    color: colors.dark.text,
  },
  sectionPnl: {
    fontSize: 11,
    fontWeight: '700' as const,
  },
  balanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.dark.border,
  },
  balanceLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  assetBadge: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: colors.dark.blueDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  assetBadgeText: {
    fontSize: 9,
    fontWeight: '700' as const,
    color: colors.dark.blue,
  },
  assetName: {
    fontSize: 13,
    fontWeight: '700' as const,
    color: colors.dark.text,
    textAlign: 'right',
  },
  assetAmount: {
    fontSize: 11,
    color: colors.dark.textSecondary,
    marginTop: 1,
  },
  assetAvg: {
    fontSize: 10,
    color: colors.dark.textMuted,
    marginTop: 1,
  },
  balanceRight: {
    alignItems: 'flex-end',
  },
  balanceValue: {
    fontSize: 13,
    fontWeight: '700' as const,
    color: colors.dark.text,
  },
  balancePnl: {
    fontSize: 11,
    fontWeight: '700' as const,
    marginTop: 1,
  },
  balanceToman: {
    fontSize: 10,
    color: colors.dark.blue,
    marginTop: 1,
  },
  positionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.dark.border,
  },
  positionSymbol: {
    fontSize: 13,
    fontWeight: '700' as const,
    color: colors.dark.text,
    textAlign: 'right',
  },
  positionDetail: {
    fontSize: 10,
    color: colors.dark.textMuted,
    marginTop: 2,
  },
  positionRight: {
    alignItems: 'flex-end',
  },
  positionPnl: {
    fontSize: 12,
    fontWeight: '700' as const,
  },
  positionRoe: {
    fontSize: 10,
    fontWeight: '600' as const,
    marginTop: 1,
  },
  futuresRealized: {
    fontSize: 11,
    color: colors.dark.textSecondary,
    marginTop: 6,
    textAlign: 'right',
  },
  walletPnlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.dark.card,
    borderRadius: 8,
    padding: 10,
    marginTop: 4,
  },
  walletPnlLabel: {
    fontSize: 11,
    color: colors.dark.textSecondary,
    flex: 1,
    textAlign: 'right',
  },
  walletPnlValue: {
    fontSize: 13,
    fontWeight: '800' as const,
  },
  pnlNote: {
    fontSize: 10,
    color: colors.dark.textMuted,
    marginTop: 6,
    textAlign: 'right',
  },
  noBalance: {
    fontSize: 13,
    color: colors.dark.textSecondary,
    textAlign: 'center',
    paddingVertical: 12,
  },
  lastUpdate: {
    fontSize: 10,
    color: colors.dark.textMuted,
    textAlign: 'center',
    marginTop: 8,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 40,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '700' as const,
    color: colors.dark.text,
  },
  emptySubtitle: {
    fontSize: 12,
    color: colors.dark.textMuted,
    textAlign: 'center',
  },
  addForm: {
    backgroundColor: colors.dark.surface,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.dark.accent + '33',
  },
  addFormTitle: {
    fontSize: 15,
    fontWeight: '700' as const,
    color: colors.dark.text,
    marginBottom: 12,
    textAlign: 'right',
  },
  inputLabel: {
    fontSize: 12,
    color: colors.dark.textSecondary,
    marginBottom: 6,
    textAlign: 'right',
  },
  input: {
    backgroundColor: colors.dark.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.dark.border,
    color: colors.dark.text,
    fontSize: 14,
    padding: 12,
    marginBottom: 12,
  },
  emailInput: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13,
  },
  otpButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.dark.accent,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  otpButtonText: {
    color: '#FFF',
    fontSize: 13,
    fontWeight: '700' as const,
  },
  otpStatus: {
    fontSize: 12,
    color: colors.dark.textSecondary,
    marginBottom: 10,
    textAlign: 'right',
  },
  secretRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  secretInput: {
    flex: 1,
    marginBottom: 0,
  },
  eyeBtn: {
    padding: 10,
    backgroundColor: colors.dark.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.dark.border,
  },
  spacer: {
    height: 8,
  },
  infoBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.dark.accentDim,
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
    marginTop: 4,
  },
  infoIcon: {
    fontSize: 14,
  },
  infoText: {
    flex: 1,
    fontSize: 11,
    color: colors.dark.textSecondary,
    textAlign: 'right',
  },
  formActions: {
    flexDirection: 'row',
    gap: 10,
  },
  formBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 10,
    padding: 12,
    flex: 1,
  },
  formBtnSave: {
    backgroundColor: colors.dark.accent,
  },
  formBtnSaveText: {
    color: colors.dark.background,
    fontSize: 14,
    fontWeight: '700' as const,
  },
  formBtnCancel: {
    backgroundColor: colors.dark.card,
    borderWidth: 1,
    borderColor: colors.dark.border,
  },
  formBtnCancelText: {
    color: colors.dark.textSecondary,
    fontSize: 14,
    fontWeight: '600' as const,
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.dark.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.dark.accent + '55',
    borderStyle: 'dashed' as const,
    padding: 16,
    marginBottom: 16,
  },
  addButtonText: {
    color: colors.dark.accent,
    fontSize: 14,
    fontWeight: '700' as const,
  },
  disclaimer: {
    padding: 10,
  },
  disclaimerText: {
    fontSize: 10,
    color: colors.dark.textMuted,
    textAlign: 'center',
  },
  pnlSection: {
    marginTop: 10,
    backgroundColor: colors.dark.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.dark.border,
    padding: 12,
  },
  pnlSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  pnlSectionTitle: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700' as const,
    color: colors.dark.text,
    textAlign: 'right',
  },
  pnlChipsRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 10,
  },
  pnlChip: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: colors.dark.surface,
    borderWidth: 1,
    borderColor: colors.dark.border,
    borderRadius: 10,
    paddingVertical: 7,
  },
  pnlChipActive: {
    backgroundColor: colors.dark.accentDim,
    borderColor: colors.dark.accent,
  },
  pnlChipText: {
    fontSize: 11,
    fontWeight: '600' as const,
    color: colors.dark.textSecondary,
  },
  pnlChipTextActive: {
    color: colors.dark.accent,
    fontWeight: '700' as const,
  },
  pnlResult: {
    gap: 6,
  },
  pnlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pnlRowLabel: {
    flex: 1,
    fontSize: 11,
    color: colors.dark.textSecondary,
    textAlign: 'right',
  },
  pnlRowValue: {
    fontSize: 12,
    fontWeight: '700' as const,
  },
  pnlTotalRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.dark.border,
    paddingTop: 8,
    marginTop: 2,
  },
  pnlTotalLabel: {
    flex: 1,
    fontSize: 12,
    fontWeight: '700' as const,
    color: colors.dark.text,
    textAlign: 'right',
  },
  pnlTotalValue: {
    fontSize: 14,
    fontWeight: '800' as const,
  },
  // v1.4.9 — retry button + failed-exchange warning box in the PnL sections.
  pnlRetryBtn: {
    alignSelf: 'flex-start',
    marginTop: 6,
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: colors.dark.accent,
  },
  pnlRetryBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700' as const,
  },
  pnlFailedBox: {
    marginTop: 8,
    padding: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#B8860B',
    backgroundColor: 'rgba(184,134,11,0.12)',
  },
  pnlFailedText: {
    fontSize: 11,
    lineHeight: 17,
    color: colors.dark.text,
  },
}));
