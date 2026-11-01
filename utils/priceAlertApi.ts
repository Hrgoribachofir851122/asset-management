/**
 * utils/priceAlertApi.ts — v1.3.8 «اعلان رشد قیمت، حتی وقتی برنامه بسته است»
 *
 * پل JS ↔ سرویس بومی اندروید (PriceAlertModule + PriceAlertWorker):
 *   • از کیف پول‌های بلاکچین و صرافی‌های کاربر، لیست ارزهای «تحت نظر» را
 *     می‌سازد (با برچسب فارسی «از کدام کیف پول/صرافی») و همراه تنظیمات به
 *     لایهٔ بومی می‌فرستد. سرویس بومی در پس‌زمینه (WorkManager، هر ۱۵ دقیقه،
 *     قید اینترنت) قیمت‌ها را چک می‌کند و رشد ≥ آستانه را نوتیف می‌کند.
 *   • طلای ۱۸ عیار و دلار همیشه در لیست‌اند (آستانهٔ خودشان — پیش‌فرض ۱٪).
 *   • روی وب ماژول بومی وجود ندارد — همهٔ توابع بی‌صدا no-op می‌شوند.
 */

import { NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadBlockchainWallets, readBlockchainBalanceCache, type BlockchainWallet } from '@/utils/blockchainWallets';

const SETTINGS_KEY = '@price_alert_settings_v1';
/** همان کلیدهایی که صفحهٔ کیف پول استفاده می‌کند (app/(tabs)/wallet/index.tsx) */
const EXCHANGE_WALLETS_KEY = '@exchange_wallets';
const EXCHANGE_BALANCE_PREFIX = '@wallet_balance_cache_';

export interface PriceAlertSettings {
  enabled: boolean;
  /** آستانهٔ رشد روزانهٔ کوین‌ها (درصد) — پیش‌فرض ۲۰ */
  coinPct: number;
  /** آستانهٔ رشد روزانهٔ طلا/دلار (درصد) — پیش‌فرض ۱ */
  metalPct: number;
}

export const DEFAULT_ALERT_SETTINGS: PriceAlertSettings = {
  enabled: false,
  coinPct: 20,
  metalPct: 1,
};

export interface PriceAlertStatus {
  enabled: boolean;
  hasPermission: boolean;
  assetCount: number;
  lastRunAt: number;
  lastError: string | null;
  lastAssetCount: number;
  available: boolean;
}

interface AlertAsset {
  id: string;
  kind: 'crypto' | 'stable' | 'metal' | 'fx';
  symbol: string;
  pair?: string;
  label: string;
}

interface ExchangeWalletRow {
  id: string;
  exchangeName?: string;
}

interface ExchangeBalanceRow {
  asset: string;
  total?: number;
  free?: number;
  locked?: number;
}

const STABLES = new Set(['USDT', 'USDC', 'DAI', 'TUSD', 'FDUSD', 'BUSD', 'USDP']);
const SKIP_SYMBOLS = new Set(['IRT', 'TMN', 'IRR', '']);

/** نمایش فارسی رایج‌ترین ارزها — بقیه با کد خودشان نشان داده می‌شوند. */
const FA_NAMES: Record<string, string> = {
  BTC: 'بیت‌کوین', ETH: 'اتریوم', USDT: 'تتر', TRX: 'ترون', BNB: 'بی‌ان‌بی',
  SOL: 'سولانا', XRP: 'ریپل', DOGE: 'دوج‌کوین', ADA: 'کاردانو', LTC: 'لایت‌کوین',
  SHIB: 'شیبا اینو', DOT: 'پولکادات', LINK: 'چین‌لینک', AVAX: 'آوالانچ',
  MATIC: 'پالیگان', TON: 'تون‌کوین', NOT: 'نات‌کوین', PEPE: 'پپه', UNI: 'یونی‌سواپ',
  XLM: 'استلار', ATOM: 'کازموس', NEAR: 'نیر', APT: 'اپتوس', ARB: 'آربیتروم',
  OP: 'اپتیمیزم', FIL: 'فایل‌کوین', XMR: 'مونرو', ETC: 'اتریوم کلاسیک',
  BCH: 'بیت‌کوین کش', DASH: 'دش', ZEC: 'زی‌کش', ALGO: 'آلگورند', FTM: 'فانتوم',
  XAUT: 'تتر طلا', PAXG: 'پکس گلد', WBTC: 'بیت‌کوین پوشیده', SUI: 'سویی',
  AAVE: 'اِیو', SAND: 'سندباکس', MANA: 'مانا', AXS: 'اکسی اینفینیتی', GRT: 'گراف',
};

function mod(): PriceAlertNativeModule | null {
  if (Platform.OS !== 'android') return null;
  const m = (NativeModules as Record<string, unknown>).PriceAlert;
  return (m as PriceAlertNativeModule) ?? null;
}

interface PriceAlertNativeModule {
  configure(configJson: string): Promise<boolean>;
  requestPermission(): Promise<boolean>;
  hasPermission(): Promise<boolean>;
  testNotification(): Promise<boolean>;
  runNow(): Promise<boolean>;
  openBatterySettings(): Promise<boolean>;
  getStatus(): Promise<{
    enabled: boolean; hasPermission: boolean; assetCount: number;
    lastRunAt: number; lastError: string | null; lastAssetCount: number;
  }>;
}

export async function loadAlertSettings(): Promise<PriceAlertSettings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_ALERT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<PriceAlertSettings>;
    return {
      enabled: !!parsed.enabled,
      coinPct: Number(parsed.coinPct) > 0 ? Number(parsed.coinPct) : DEFAULT_ALERT_SETTINGS.coinPct,
      metalPct: Number(parsed.metalPct) > 0 ? Number(parsed.metalPct) : DEFAULT_ALERT_SETTINGS.metalPct,
    };
  } catch {
    return { ...DEFAULT_ALERT_SETTINGS };
  }
}

export async function saveAlertSettings(patch: Partial<PriceAlertSettings>): Promise<PriceAlertSettings> {
  const merged = { ...(await loadAlertSettings()), ...patch };
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
  await pushAlertConfig(merged);
  return merged;
}

/** نمایش عمومی: تنظیمات ذخیره‌شده + دارایی‌های فعلی را به سرویس بومی می‌دهد. */
export async function syncPriceAlertConfig(): Promise<{ ok: boolean; assetCount: number }> {
  const m = mod();
  if (!m) return { ok: false, assetCount: 0 };
  try {
    const settings = await loadAlertSettings();
    return await pushAlertConfig(settings);
  } catch {
    return { ok: false, assetCount: 0 };
  }
}

/** ساختن لیست دارایی‌ها از کش‌های موجودی و ارسال به بومی */
async function pushAlertConfig(settings: PriceAlertSettings): Promise<{ ok: boolean; assetCount: number }> {
  const m = mod();
  if (!m) return { ok: false, assetCount: 0 };

  const sources = new Map<string, { kind: 'crypto' | 'stable'; pair?: string; labels: Set<string> }>();
  const addHolding = (symbolRaw: string, qty: number, label: string) => {
    const symbol = symbolRaw.trim().toUpperCase();
    if (SKIP_SYMBOLS.has(symbol)) return;
    if (!(qty > 0)) return;
    const kind: 'crypto' | 'stable' = STABLES.has(symbol) ? 'stable' : 'crypto';
    // جفت اسپات بایننس؛ استیبل‌ها (USDT/USDT وجود ندارد) و نمادهای غیرعادی
    // (لوریج‌شده/خیلی طولانی) جفت نمی‌گیرند → کارگر برایشان از نوبیتکس می‌پرسد
    const pair =
      kind === 'stable' || !/^[A-Z0-9]{2,10}$/.test(symbol) || LEVERAGED.some((s) => symbol.endsWith(s))
        ? undefined
        : `${symbol}USDT`;
    const entry = sources.get(symbol) ?? { kind, pair, labels: new Set<string>() };
    if (!entry.pair && pair) entry.pair = pair;
    entry.labels.add(label);
    sources.set(symbol, entry);
  };

  try {
    // ۱) صرافی‌های ارزی (ارز دیجیتال تب) — از کش موجودی هر صرافی
    const walletsRaw = await AsyncStorage.getItem(EXCHANGE_WALLETS_KEY);
    const wallets = walletsRaw ? (JSON.parse(walletsRaw) as ExchangeWalletRow[]) : [];
    for (const w of wallets) {
      if (!w?.id) continue;
      try {
        const raw = await AsyncStorage.getItem(EXCHANGE_BALANCE_PREFIX + w.id);
        if (!raw) continue;
        const rows = JSON.parse(raw) as ExchangeBalanceRow[];
        const exName = w.exchangeName || 'صرافی';
        for (const row of rows ?? []) {
          const total = Number(row.total ?? 0) || (Number(row.free ?? 0) || 0) + (Number(row.locked ?? 0) || 0);
          if (!(total > 0) || !row.asset) continue;
          addHolding(row.asset, total, `${FA_NAMES[row.asset.toUpperCase()] ?? row.asset.toUpperCase()} — صرافی ${exName}`);
        }
      } catch { /* کش این صرافی خراب است — بقیه ادامه می‌دهند */ }
    }

    // ۲) کیف پول‌های بلاکچین — از کش موجودی هر کیف
    const bcWallets: BlockchainWallet[] = await loadBlockchainWallets();
    for (const wallet of bcWallets) {
      try {
        const data = await readBlockchainBalanceCache(wallet.id);
        const wName = wallet.name || 'کیف پول';
        for (const t of data?.tokens ?? []) {
          if (!t.symbol) continue;
          addHolding(t.symbol, t.qty, `${FA_NAMES[t.symbol.toUpperCase()] ?? t.symbol} — کیف پول «${wName}»`);
        }
      } catch { /* کش این کیف خراب است — بقیه ادامه می‌دهند */ }
    }
  } catch { /* کش‌ها در دسترس نیستند — فقط طلا/دلار زیر نظر می‌مانند */ }

  const assets: AlertAsset[] = [];
  for (const [symbol, s] of sources) {
    const label = [...s.labels].slice(0, 2).join(' + ');
    assets.push({
      id: `${s.kind}:${symbol}`,
      kind: s.kind,
      symbol,
      pair: s.pair,
      label: label.length > 90 ? label.slice(0, 87) + '…' : label,
    });
  }
  // طلای ۱۸ عیار و دلار همیشه زیر نظر — فیلد dp خود TGJU
  assets.push({ id: 'metal:geram18', kind: 'metal', symbol: 'geram18', label: 'طلای ۱۸ عیار (طلاین)' });
  assets.push({ id: 'fx:dollar', kind: 'fx', symbol: 'price_dollar_rl', label: 'دلار آمریکا' });

  const config = {
    enabled: settings.enabled,
    coinPct: settings.coinPct,
    metalPct: settings.metalPct,
    assets,
  };
  await m.configure(JSON.stringify(config));
  return { ok: true, assetCount: assets.length };
}

const LEVERAGED = ['UP', 'DOWN', 'BULL', 'BEAR'];

/** اجازهٔ نوتیفیکیشن (اندروید ۱۳+) — برای لحظهٔ روشن‌کردن کلید در تنظیمات */
export async function requestAlertPermission(): Promise<boolean> {
  const m = mod();
  if (!m) return false;
  try {
    return await m.requestPermission();
  } catch {
    return false;
  }
}

/** اجازهٔ نوتیفیکیشن (اندروید ۱۳+) + یک اعلان آزمایشی */
export async function testAlertNotification(): Promise<boolean> {
  const m = mod();
  if (!m) return false;
  try {
    const granted = await m.requestPermission();
    if (!granted) return false;
    return await m.testNotification();
  } catch {
    return false;
  }
}

export async function getPriceAlertStatus(): Promise<PriceAlertStatus> {
  const m = mod();
  if (!m) {
    return {
      enabled: false, hasPermission: false, assetCount: 0,
      lastRunAt: 0, lastError: null, lastAssetCount: 0, available: false,
    };
  }
  try {
    const s = await m.getStatus();
    return { ...s, available: true };
  } catch {
    return {
      enabled: false, hasPermission: false, assetCount: 0,
      lastRunAt: 0, lastError: null, lastAssetCount: 0, available: true,
    };
  }
}

/** صفحهٔ «بدون بهینه‌سازی باتری» — برای گوشی‌هایی که اپ‌های پس‌زمینه را می‌کشند */
export async function openBatteryOptimizationSettings(): Promise<boolean> {
  const m = mod();
  if (!m) return false;
  try {
    return await m.openBatterySettings();
  } catch {
    return false;
  }
}

/** اجرای فوری یک دورهٔ چک (دکمهٔ «بررسی همین حالا») */
export async function runAlertCheckNow(): Promise<boolean> {
  const m = mod();
  if (!m) return false;
  try {
    return await m.runNow();
  } catch {
    return false;
  }
}
