/**
 * utils/growthSignals.ts — v1.4.0 «چشمک‌زن رشد/ریزش»
 *
 * همان منطق اعلان، اما روی صفحه: وقتی قیمت یک دارایی در بازهٔ انتخابی از
 * آستانه رد شود، کادرش سبز (رشد) یا قرمز (ریزش) چشمک می‌زند تا کاربر سریع
 * ببیند؛ به‌محض برگشت زیر آستانه، چشمک خودبه‌خود می‌ایستد.
 *
 * منبع داده در هر سطح:
 *   • کوین‌های بلاکچین — تغییر ٪ واقعی ۲۴ ساعتهٔ خودِ ردیف (change24hPct)
 *     که کارگر اعلان هم همان را می‌گیرد → چشمک و اعلان هم‌راستا هستند.
 *   • صرافی‌ها و چیپ‌های طلا/دلار — خط پایهٔ ۲۴ ساعتهٔ محلی (base+at در
 *     AsyncStorage؛ بعد از ۲۴ ساعت به قیمت فعلی ری‌ست می‌شود) چون این‌ها
 *     تغییر٪ ۲۴ ساعتهٔ آماده ندارند.
 * آستانه‌ها از همان تنظیمات «اعلان رشد قیمت» می‌آید (@price_alert_cfg_v1).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadAlertConfig, type PriceAlertConfig } from './priceAlertApi';

export type GrowthState = 'up' | 'down' | null;

const BASE_KEY = '@growth_baselines_v1';
const BASE_TTL_MS = 24 * 60 * 60 * 1000;

interface Baseline {
  base: number;
  at: number;
}

/** کش ماژول‌سطح — هر رندر AsyncStorage نمی‌خواند */
let baselinesCache: Record<string, Baseline> | null = null;
let baselinesLoad: Promise<void> | null = null;
let configCache: { cfg: PriceAlertConfig; at: number } | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

async function ensureBaselines(): Promise<void> {
  if (baselinesCache) return;
  if (!baselinesLoad) {
    baselinesLoad = (async () => {
      try {
        const raw = await AsyncStorage.getItem(BASE_KEY);
        baselinesCache = raw ? (JSON.parse(raw) as Record<string, Baseline>) : {};
      } catch {
        baselinesCache = {};
      }
    })();
  }
  await baselinesLoad;
}

function persistBaselines(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    AsyncStorage.setItem(BASE_KEY, JSON.stringify(baselinesCache ?? {})).catch(() => {});
  }, 800);
}

async function getConfig(): Promise<PriceAlertConfig> {
  if (configCache && Date.now() - configCache.at < 60_000) return configCache.cfg;
  const cfg = await loadAlertConfig();
  configCache = { cfg, at: Date.now() };
  return cfg;
}

/**
 * محاسبهٔ وضعیت رشد/ریزش برای یک دارایی.
 *   price24hPct — اگر تغییر ٪ ۲۴ ساعتهٔ واقعی موجود باشد (کوین‌های بلاکچین)،
 *   مستقیم همان؛ وگرنه از خط پایهٔ محلی محاسبه می‌شود.
 */
export function useGrowthBlink(
  key: string | null | undefined,
  currentPrice: number,
  price24hPct?: number | null,
): { state: GrowthState; pct: number } {
  const [state, setState] = useState<GrowthState>(null);
  const [pct, setPct] = useState(0);
  const keyRef = useRef(key);

  const evaluate = useCallback(
    async (p24?: number | null) => {
      const k = keyRef.current;
      if (!k) {
        setState(null);
        setPct(0);
        return;
      }
      const assetKey: string = k;
      const cfg = await getConfig();
      if (!cfg.enabled) {
        setState(null);
        setPct(0);
        return;
      }
      let value = Number.isFinite(p24 ?? NaN) ? (p24 as number) : NaN;
      if (!Number.isFinite(value)) {
        // خط پایهٔ محلی (فلزات/دلار/صرافی‌ها)
        if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
          setState(null);
          setPct(0);
          return;
        }
        await ensureBaselines();
        const store = baselinesCache!;
        const b = store[k];
        const now = Date.now();
        if (!b || b.base <= 0 || now - b.at > BASE_TTL_MS) {
          store[k] = { base: currentPrice, at: now };
          persistBaselines();
          setState(null);
          setPct(0);
          return;
        }
        value = ((currentPrice - b.base) / b.base) * 100;
      }
      const thr = assetKey.startsWith('metal:') || assetKey.startsWith('fiat:') ? cfg.metalPct : cfg.coinPct;
      setPct(value);
      setState(value >= thr ? 'up' : value <= -thr ? 'down' : null);
    },
    [currentPrice],
  );

  useEffect(() => {
    keyRef.current = key;
    void evaluate(price24hPct);
  }, [evaluate, key, price24hPct]);

  return { state, pct };
}
