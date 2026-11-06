/**
 * utils/growthSignals.ts — v1.4.0 «چشمک‌زن رشد/ریزش» — v1.4.2
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
 *
 * v1.4.2:
 *   • strength — نسبت |درصد| به آستانه؛ BlinkFrame با آن «ضخامت کادر» را
 *     تعیین می‌کند: هرچه رشد از آستانهٔ ست‌شدهٔ کاربر بیشتر بگذرد، کادر
 *     ضخیم‌تر (ضخامت از داخل کادر — چیدمان هیچ‌وقت تکون نمی‌خورد).
 *   • گروه‌ها: هر هوک می‌تواند خودش را زیر یک «گروه» (مثلاً id صرافی یا
 *     کیف بلاکچین یا کارت فلزات) ثبت کند. useGroupBlink(group) تعداد
 *     دارایی‌های رشدی/ریزشیِ همان گروه را می‌دهد → کادرِ دور کل کارتِ
 *     کیف/صرافی، دو‌رنگ و به‌تناسب (دو رشد + یک ریزش = دو‌سوم سبز، یک‌سوم
 *     قرمز) چشمک می‌زند — بدون بازکردن تک‌تک کارت‌ها.
 *   • سنسور کیفِ بسته: BlinkGroupSensor (در BlinkFrame.tsx) با همین هوک،
 *     ردیف‌های کیفِ جمع‌شده را هم ناظر می‌شود تا کارتِ بسته هم چشمک بزند.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
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

// ─── v1.4.2 — رجیستری گروه‌ها (کادر دور کیف/صرافی) ──────────────────────

/** هر دارایی می‌تواند از چند ناظر (ردیف باز + سنسور کارتِ بسته) دیده شود */
type GroupEntry = { states: Map<string, GrowthState>; last: GrowthState };
const groupStore = new Map<string, Map<string, GroupEntry>>();
const groupSnapshots = new Map<string, { up: number; down: number }>();
const groupListeners = new Map<string, Set<() => void>>();
const EMPTY_GROUP: { up: number; down: number } = { up: 0, down: 0 };

function recomputeGroup(group: string): void {
  const g = groupStore.get(group);
  let up = 0;
  let down = 0;
  if (g) {
    for (const entry of g.values()) {
      if (entry.last === 'up') up++;
      else if (entry.last === 'down') down++;
    }
  }
  groupSnapshots.set(group, { up, down });
  groupListeners.get(group)?.forEach((l) => l());
}

/** ناظر owner (یک کامپوننت) وضعیت یک دارایی در گروه را ثبت/عوض/پاک می‌کند */
function setGroupState(group: string, key: string, owner: string, state: GrowthState): void {
  let g = groupStore.get(group);
  if (!g) {
    g = new Map();
    groupStore.set(group, g);
  }
  let entry = g.get(key);
  if (!entry) {
    entry = { states: new Map(), last: null };
    g.set(key, entry);
  }
  const prev = entry.states.get(owner) ?? null;
  if (prev === state) return;
  if (state == null) entry.states.delete(owner);
  else entry.states.set(owner, state);
  entry.last = entry.states.size > 0
    ? Array.from(entry.states.values()).reverse()[0] ?? null
    : null;
  recomputeGroup(group);
}

export function subscribeGroup(group: string, cb: () => void): () => void {
  let set = groupListeners.get(group);
  if (!set) {
    set = new Set();
    groupListeners.set(group, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
  };
}

export function getGroupSnapshot(group: string): { up: number; down: number } {
  return groupSnapshots.get(group) ?? EMPTY_GROUP;
}

/** v1.4.2 — تعداد رشدی/ریزشی‌های یک گروه → کادر دور کل کارت */
export function useGroupBlink(group: string | null | undefined): { up: number; down: number } {
  const g = group ?? '';
  return useSyncExternalStore(
    useCallback((cb: () => void) => subscribeGroup(g, cb), [g]),
    useCallback(() => (g ? getGroupSnapshot(g) : EMPTY_GROUP), [g]),
  );
}

/**
 * محاسبهٔ وضعیت رشد/ریزش برای یک دارایی.
 *   price24hPct — اگر تغییر ٪ ۲۴ ساعتهٔ واقعی موجود باشد (کوین‌های بلاکچین)،
 *   مستقیم همان؛ وگرنه از خط پایهٔ محلی محاسبه می‌شود.
 *   opts.group — ثبت در گروه (کادر دور کیف/صرافی)؛ owner جداکردن ناظرها.
 */
export function useGrowthBlink(
  key: string | null | undefined,
  currentPrice: number,
  price24hPct?: number | null,
  opts?: { group?: string | null },
): { state: GrowthState; pct: number; strength: number } {
  const [state, setState] = useState<GrowthState>(null);
  const [pct, setPct] = useState(0);
  const [strength, setStrength] = useState(1);
  const keyRef = useRef(key);
  const groupRef = useRef(opts?.group ?? null);
  // هر کامپوننتِ ناظر یک شناسه دارد تا با بسته‌شدن ردیف، فقط ثبتِ خودش پاک شود
  const ownerRef = useRef<string>('');
  if (!ownerRef.current) ownerRef.current = `o${Math.random().toString(36).slice(2)}`;

  const evaluate = useCallback(
    async (p24?: number | null) => {
      const k = keyRef.current;
      if (!k) {
        setState(null);
        setPct(0);
        setStrength(1);
        return;
      }
      const assetKey: string = k;
      const cfg = await getConfig();
      if (!cfg.enabled) {
        setState(null);
        setPct(0);
        setStrength(1);
        return;
      }
      let value = Number.isFinite(p24 ?? NaN) ? (p24 as number) : NaN;
      if (!Number.isFinite(value)) {
        // خط پایهٔ محلی (فلزات/دلار/صرافی‌ها)
        if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
          setState(null);
          setPct(0);
          setStrength(1);
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
          setStrength(1);
          return;
        }
        value = ((currentPrice - b.base) / b.base) * 100;
      }
      const thr = assetKey.startsWith('metal:') || assetKey.startsWith('fiat:') ? cfg.metalPct : cfg.coinPct;
      const next: GrowthState = value >= thr ? 'up' : value <= -thr ? 'down' : null;
      setPct(value);
      setStrength(thr > 0 ? Math.abs(value) / thr : 1);
      setState(next);
      const g = groupRef.current;
      if (g && k) setGroupState(g, k, ownerRef.current, next);
    },
    [currentPrice],
  );

  useEffect(() => {
    keyRef.current = key;
    groupRef.current = opts?.group ?? null;
    void evaluate(price24hPct);
    return () => {
      // unmount → فقط ثبتِ همین ناظر پاک می‌شود (ناظرهای دیگرِ همان دارایی
      // — مثلاً سنسور کارت — سر جایشان می‌مانند)
      const g = groupRef.current;
      if (g && keyRef.current) setGroupState(g, keyRef.current, ownerRef.current, null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evaluate, key, price24hPct, opts?.group]);

  return { state, pct, strength };
}
