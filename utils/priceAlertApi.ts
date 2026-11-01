/**
 * utils/priceAlertApi.ts — v1.4.0
 *
 * پل JS ↔ ماژول نیتیو PriceAlert (اندروید) برای «اعلان رشد/ریزش قیمت»:
 *   • configure()      — ذخیرهٔ تنظیمات + لیست دارایی‌های تحت‌نظر در نیتیو
 *   • syncPriceAlertConfig() — جمع‌کردن دارایی‌ها از کیف بلاکچین + آخرین کش
 *     موجودی صرافی‌ها + طلا/دلار همیشگی، و فرستادن به نیتیو (روی وب no-op)
 *   • noteWatchedExchangeAssets() — صفحهٔ کیف پول بعد از هر دریافت موفق
 *     موجودی صرافی این را صدا می‌زند تا سیمبل‌ها برای اعلان ذخیره شوند
 *   • testAlert() / checkNow() / getStatus() / باتری
 *
 * سیمبل بایننس: سیمبل‌های نگاشت‌شده به USDT (BTCUSDT…) — همان منبعی که
 * کارگر تغییر ٪ ۲۴ ساعته را از آن می‌گیرد.
 */

import { NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadBlockchainWallets } from './blockchainWallets';

const CFG_KEY = '@price_alert_cfg_v1';
const EXCHANGE_COINS_KEY = '@price_alert_exchange_coins';

export interface PriceAlertConfig {
  enabled: boolean;
  /** آستانهٔ رشد/ریزش کوین‌ها (٪ در ۲۴ ساعت) */
  coinPct: number;
  /** آستانهٔ رشد/ریزش طلا و دلار (٪ در ۲۴ ساعت) */
  metalPct: number;
}

export const DEFAULT_ALERT_CONFIG: PriceAlertConfig = {
  enabled: false,
  coinPct: 20,
  metalPct: 0.5,
};

export interface PriceAlertStatus {
  lastRun?: number;
  lastError?: string | null;
  okCount?: number;
  runCount?: number;
}

interface NativePriceAlert {
  configure(enabled: boolean, coinPct: number, metalPct: number, watchedJson: string): Promise<boolean>;
  testAlert(): Promise<boolean>;
  checkNow(): Promise<boolean>;
  getStatus(): Promise<string>;
  isIgnoringBatteryOptimizations(): Promise<boolean>;
  requestIgnoreBatteryOptimizations(): Promise<boolean>;
  openBatterySettings(): Promise<boolean>;
  openAppDetailsSettings(): Promise<boolean>;
}

function native(): NativePriceAlert | null {
  if (Platform.OS !== 'android') return null;
  const m = (NativeModules as Record<string, unknown>).PriceAlert as NativePriceAlert | undefined;
  return m ?? null;
}

/** تنظیمات فعلی (کپی JS برای UI و هوک چشمک‌زن) */
export async function loadAlertConfig(): Promise<PriceAlertConfig> {
  try {
    const raw = await AsyncStorage.getItem(CFG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PriceAlertConfig>;
      return { ...DEFAULT_ALERT_CONFIG, ...parsed };
    }
  } catch {}
  return { ...DEFAULT_ALERT_CONFIG };
}

export async function saveAlertConfigLocal(cfg: PriceAlertConfig): Promise<void> {
  try {
    await AsyncStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  } catch {}
}

/** کلیدهای فید TGJU — همان‌هایی که iranMarketApi می‌خواند */
const METAL_WATCHED = [
  { tgju: 'geram18', label: 'طلای ۱۸ عیار (گرم)', kind: 'metal' },
  { tgju: 'sekee', label: 'سکه امامی', kind: 'metal' },
  { tgju: 'price_dollar_rl', label: 'دلار آزاد', kind: 'fiat' },
] as const;

/** کاراکترهای غیرمجاز در سیمبل بایننس */
function toBinanceSymbol(sym: string): string | null {
  const s = sym.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s || s.length < 2 || s.length > 12) return null;
  // سیمبل‌هایی که خودشان کوته‌نوشت استیبل‌اند یا غیرقابل‌نگاشت‌اند رد می‌شوند
  if (['USDT', 'USDC', 'BUSD', 'TUSD', 'FDUSD', 'DAI', 'TRY', 'BRL', 'EUR'].includes(s)) {
    return `${s}USDT`; // تتر/استیبل‌ها مقابل خودشان معنا دارند (قیمت دلاری‌شان ~۱)
  }
  return `${s}USDT`;
}

const labelForSymbol = (sym: string): string => sym;

/**
 * سیمبل‌های صرافی‌ها از آخرین کش موجودی — صفحهٔ کیف پول بعد از هر دریافت
 * موفق این را صدا می‌زند (writeBalanceCache). لیست کوتاه (۶۰ سیمبل) تا
 * درخواست بایننس سبک بماند.
 */
export async function noteWatchedExchangeAssets(balances: Array<{ asset?: string; symbol?: string }>): Promise<void> {
  try {
    const syms = new Set<string>();
    for (const b of balances ?? []) {
      const s = String(b?.asset ?? b?.symbol ?? '').toUpperCase();
      if (s && s !== 'UNKNOWN') syms.add(s);
    }
    const prev = new Set<string>(JSON.parse((await AsyncStorage.getItem(EXCHANGE_COINS_KEY)) ?? '[]') as string[]);
    for (const s of syms) prev.add(s);
    const list = Array.from(prev).slice(0, 60);
    await AsyncStorage.setItem(EXCHANGE_COINS_KEY, JSON.stringify(list));
  } catch {}
}

/** سیمبل‌های کیف‌های بلاکچین (از خود کیف‌ها) + صرافی‌ها (از کش) */
async function collectWatchedCoins(): Promise<Array<{ key: string; label: string; kind: string; symbol: string; tgju: string }>> {
  const out = new Map<string, { key: string; label: string; kind: string; symbol: string; tgju: string }>();
  try {
    const wallets = await loadBlockchainWallets();
    for (const w of wallets) {
      const sym = String((w as { symbol?: string }).symbol ?? '').trim();
      const b = toBinanceSymbol(sym);
      if (b) out.set(b, { key: `coin:${b.replace('USDT', '')}`, label: labelForSymbol(b.replace('USDT', '')), kind: 'coin', symbol: b, tgju: '' });
    }
  } catch {}
  try {
    const ex = JSON.parse((await AsyncStorage.getItem(EXCHANGE_COINS_KEY)) ?? '[]') as string[];
    for (const s of ex) {
      const b = toBinanceSymbol(s);
      if (b && !out.has(b)) out.set(b, { key: `coin:${b.replace('USDT', '')}`, label: labelForSymbol(b.replace('USDT', '')), kind: 'coin', symbol: b, tgju: '' });
    }
  } catch {}
  return Array.from(out.values());
}

/**
 * همگام‌سازی کامل با نیتیو — در لانچ برنامه (app/_layout) و بعد از هر
 * تغییر تنظیمات. اگر سرویس روشن باشد لیست تازه می‌رود؛ روی وب no-op.
 */
export async function syncPriceAlertConfig(): Promise<void> {
  try {
    if (Platform.OS !== 'android') return;
    const cfg = await loadAlertConfig();
    const coins = await collectWatchedCoins();
    const watched = [
      ...coins,
      ...METAL_WATCHED.map((m) => ({ key: `metal:${m.tgju}`, label: m.label, kind: m.kind, symbol: '', tgju: m.tgju })),
    ];
    const n = native();
    await n?.configure(cfg.enabled, cfg.coinPct, cfg.metalPct, JSON.stringify(watched));
  } catch {}
}

export async function testAlert(): Promise<boolean> {
  try {
    return (await native()?.testAlert()) ?? false;
  } catch {
    return false;
  }
}

export async function checkNow(): Promise<boolean> {
  try {
    return (await native()?.checkNow()) ?? false;
  } catch {
    return false;
  }
}

export async function getAlertStatus(): Promise<PriceAlertStatus> {
  try {
    const raw = await native()?.getStatus();
    if (!raw) return {};
    return JSON.parse(raw) as PriceAlertStatus;
  } catch {
    return {};
  }
}

export async function isIgnoringBatteryOptimizations(): Promise<boolean> {
  try {
    return (await native()?.isIgnoringBatteryOptimizations()) ?? true;
  } catch {
    return true;
  }
}

export async function requestIgnoreBatteryOptimizations(): Promise<boolean> {
  try {
    return (await native()?.requestIgnoreBatteryOptimizations()) ?? false;
  } catch {
    return false;
  }
}

export async function openBatterySettings(): Promise<boolean> {
  try {
    return (await native()?.openBatterySettings()) ?? false;
  } catch {
    return false;
  }
}

/** v1.4.1 — صفحهٔ اطلاعات برنامه (شیائومی/هوآوی: Battery → No restrictions) */
export async function openAppDetailsSettings(): Promise<boolean> {
  try {
    return (await native()?.openAppDetailsSettings()) ?? false;
  } catch {
    return false;
  }
}
