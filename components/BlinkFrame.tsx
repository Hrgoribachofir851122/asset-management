/**
 * components/BlinkFrame.tsx — v1.4.0 «کادر چشمک‌زن رشد/ریزش» — v1.4.2
 *
 * روی هر کارت/ردیف سوار می‌شود؛ وقتی state='up' باشد کادر سبز و وقتی
 * state='down' باشد کادر قرمز، نرم چشمک می‌زند (گلو + بوردر). وقتی state
 * null شود (برگشت زیر آستانه) چشمک فوراً می‌ایستد و هیچ اثری نمی‌ماند.
 * پیاده‌سازی رویهٔ absolute overlay است تا ارتفاع/چیدمان هیچ‌وقت تکون نخورد.
 *
 * v1.4.2:
 *   • ضخامت کادر از strength (نسبت |درصد| به آستانهٔ ست‌شدهٔ کاربر) می‌آید:
 *     هرچه رشد/ریزش بیشتر از آستانه باشد کادر ضخیم‌تر (۲ تا ۵dp). ضخامت
 *     از «داخل» کادر گرفته می‌شود (overlay روی خودِ قاب است، بیرون نمی‌زند)
 *     → ترتیب و چیدمان هیچ‌وقت به‌هم نمی‌خورد.
 *   • GroupBlinkFrame — کادرِ دور کل کارتِ کیف/صرافی: اگر هر دارایی داخلش
 *     چشمک‌زن باشد، دور کارت هم کادر چشمک‌زن می‌آید. اگر هم رشدی و هم
 *     ریزشی داخلش باشد، کادر دورنگ و به‌تناسب است (۲ قرمز + ۱ سبز = دو‌سوم
 *     قرمز، یک‌سوم سبز) — تا کاربر با یک نگاه بفهمد کدام کیف/صرافی است.
 *   • BlinkGroupSensor — ناظرِ نامرئی برای کیفِ جمع‌شده (بسته): ردیف‌هایش
 *     مانت نیستند، ولی سنسور با همان کلیدها چک می‌کند تا کارتِ بسته هم
 *     چشمک بزند.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, View, StyleSheet, ViewStyle } from 'react-native';
import colors from '@/constants/colors';
import { useGrowthBlink, useGroupBlink, type GrowthState } from '@/utils/growthSignals';

interface BlinkFrameProps {
  /** حالت آماده — اگر پدر خودش درصد را دارد (مثلاً change24hPct ردیف) */
  state?: GrowthState;
  /** یا خودکارسازی: کلید دارایی + قیمت فعلی (+ تغییر٪ ۲۴ ساعته اگر موجود) */
  blinkKey?: string | null;
  price?: number;
  pct24h?: number | null;
  /** v1.4.2 — گروه: دارایی‌های این قاب به شمارندهٔ همین گروه می‌روند */
  group?: string | null;
  children: React.ReactNode;
  style?: ViewStyle | ViewStyle[];
  borderRadius?: number;
  testID?: string;
}

/** ضخامت کادر بر اساس شدت حرکت نسبت به آستانهٔ کاربر — از داخل کادر */
export function strokeFor(strength: number, base = 2): number {
  if (!Number.isFinite(strength) || strength < 1.15) return base;
  if (strength < 1.5) return base + 1;
  if (strength < 2.25) return base + 2;
  return base + 3; // حداکثر ۵dp — بیرون نمی‌زند، داخل کادر است
}

function usePulse(active: boolean): Animated.Value {
  const pulse = useRef(new Animated.Value(active ? 1 : 0)).current;
  useEffect(() => {
    if (!active) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 650, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.25, duration: 650, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, pulse]);
  return pulse;
}

/**
 * دو حالت استفاده:
 *   ۱) <BlinkFrame state={blinkState}> — پدر خودش state می‌دهد
 *   ۲) <BlinkFrame blinkKey="coin:BTC" price={…} pct24h={…} group={walletId}>
 *      داخل map ها؛ هوک داخل همین کامپوننت است پس قواعد هوکس نقض نمی‌شود.
 */
export default function BlinkFrame({
  state: stateProp,
  blinkKey,
  price,
  pct24h,
  group,
  children,
  style,
  borderRadius = 14,
  testID,
}: BlinkFrameProps) {
  const computed = useGrowthBlink(blinkKey ?? null, price ?? 0, pct24h ?? null, { group });
  const state = stateProp !== undefined ? stateProp : computed.state;
  const pulse = usePulse(!!state);
  const stroke = strokeFor(computed.strength);

  const color = state === 'up' ? colors.dark.green : colors.dark.red;

  return (
    <View style={[style, styles.host]} testID={testID}>
      {children}
      {state ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.overlay,
            { borderRadius, borderWidth: stroke, borderColor: color, opacity: pulse },
          ]}
        >
          <View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: color, opacity: 0.07, borderRadius },
            ]}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}

/**
 * v1.4.1 — نسخهٔ بدونِ wrapper: خودِ کامپوننت مقصد را relative می‌کنیم و
 * این overlay را داخلش می‌گذاریم (برای چیپ‌های flexBasis‌دار تا شبکهٔ
 * قیمت‌های لحظه‌ای هیچ تغییری در اندازه/چیدمان نکند).
 * v1.4.2 — + group و ضخامت متغیر.
 */
export function BlinkOverlay({
  state,
  borderRadius = 12,
  group,
  blinkKey,
  price,
  pct24h,
  strength,
}: {
  state?: GrowthState;
  borderRadius?: number;
  group?: string | null;
  blinkKey?: string | null;
  price?: number;
  pct24h?: number | null;
  /** اگر پدر strength را خودش دارد (محاسبهٔ مشترک) */
  strength?: number;
}) {
  const computed = useGrowthBlink(blinkKey ?? null, price ?? 0, pct24h ?? null, { group });
  const st = state !== undefined ? state : computed.state;
  const s = strength ?? computed.strength;
  const pulse = usePulse(!!st);
  const stroke = strokeFor(s);

  if (!st) return null;
  const color = st === 'up' ? colors.dark.green : colors.dark.red;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.overlay,
        { borderRadius, borderWidth: stroke, borderColor: color, opacity: pulse },
      ]}
    >
      <View style={[StyleSheet.absoluteFill, { backgroundColor: color, opacity: 0.07, borderRadius }]} />
    </Animated.View>
  );
}

// ─── v1.4.2 — کادر دور کل کیف/صرافی (دورنگ به‌تناسب رشد/ریزش) ────────────

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function GroupBlinkFrame({
  group,
  children,
  style,
  borderRadius = 14,
  testID,
}: {
  group: string | null | undefined;
  children: React.ReactNode;
  style?: ViewStyle | ViewStyle[];
  borderRadius?: number;
  testID?: string;
}) {
  const { up, down } = useGroupBlink(group);
  const total = up + down;
  const pulse = usePulse(total > 0);

  // سهم سبز/قرمز دور کارت به‌تناسب تعداد دارایی‌های رشدی/ریزشی؛ حداقل ۲۰٪
  // برای هر رنگ تا همیشه دیده شود (۱ سبز + ۵ قرمز هم ۲۰٪ سبز دارد).
  const greenShare = useMemo(
    () => (total > 0 && up > 0 && down > 0 ? clamp(up / total, 0.2, 0.8) : null),
    [up, down, total],
  );

  const singleColor = up > 0 ? colors.dark.green : colors.dark.red;

  return (
    <View style={[style, styles.host]} testID={testID}>
      {children}
      {total > 0 ? (
        <Animated.View pointerEvents="none" style={[styles.overlay, { opacity: pulse }]}>
          {greenShare == null ? (
            // تک‌رنگ — همهٔ دارایی‌های چشمک‌زن یک جهت‌اند
            <View
              style={{
                ...StyleSheet.absoluteFillObject,
                borderWidth: 3,
                borderColor: singleColor,
                borderRadius,
              }}
            />
          ) : (
            // دورنگ — قابِ چپ/راست به‌تناسب؛ ضخامت از داخل (بیرون نمی‌زند)
            <>
              <View
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: `${Math.round(greenShare * 100)}%` as `${number}%`,
                  borderTopWidth: 3,
                  borderBottomWidth: 3,
                  borderLeftWidth: 3,
                  borderRightWidth: 0,
                  borderTopLeftRadius: borderRadius,
                  borderBottomLeftRadius: borderRadius,
                  borderColor: colors.dark.green,
                }}
              />
              <View
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 0,
                  bottom: 0,
                  width: `${Math.round((1 - greenShare) * 100)}%` as `${number}%`,
                  borderTopWidth: 3,
                  borderBottomWidth: 3,
                  borderRightWidth: 3,
                  borderLeftWidth: 0,
                  borderTopRightRadius: borderRadius,
                  borderBottomRightRadius: borderRadius,
                  borderColor: colors.dark.red,
                }}
              />
            </>
          )}
        </Animated.View>
      ) : null}
    </View>
  );
}

// ─── v1.4.2 — سنسور نامرئی: کیفِ جمع‌شده هم چشمک بزند ────────────────────

export interface BlinkSensorItem {
  key: string;
  price: number;
  pct24h?: number | null;
}

/**
 * ردیف‌های بازِ کیف خودشان ثبت می‌شوند؛ وقتی کیف بسته است ردیف‌ها مانت
 * نیستند → این سنسورِ صفر-ارتفاع با همان کلیدها ناظر می‌ماند تا کادرِ دور
 * کارتِ بسته هم روشن بماند. روی استیبل‌ها (USDT و…) که حرکتی ندارند صرفه‌جو
 * است و مانت نمی‌شود.
 */
export function BlinkGroupSensor({
  group,
  items,
}: {
  group: string | null | undefined;
  items: BlinkSensorItem[];
}) {
  if (!group) return null;
  return (
    <View style={styles.sensor} pointerEvents="none" collapsable>
      {items.map((it) => (
        <BlinkGroupSensorItem
          key={it.key}
          group={group}
          blinkKey={it.key}
          price={it.price}
          pct24h={it.pct24h ?? null}
        />
      ))}
    </View>
  );
}

const STABLE_SYMBOLS = new Set(['USDT', 'USDC', 'FDUSD', 'TUSD', 'DAI', 'BUSD']);

function BlinkGroupSensorItem({
  group,
  blinkKey,
  price,
  pct24h,
}: {
  group: string;
  blinkKey: string;
  price: number;
  pct24h?: number | null;
}) {
  useGrowthBlink(blinkKey, price, pct24h, { group });
  return null;
}

export function sensorItemsFrom(
  rows: Array<{ symbol?: string; price?: number | null; pct24h?: number | null }>,
): BlinkSensorItem[] {
  const out: BlinkSensorItem[] = [];
  for (const r of rows) {
    const sym = String(r.symbol ?? '').toUpperCase();
    if (!sym || STABLE_SYMBOLS.has(sym)) continue;
    if (!Number.isFinite(r.price ?? NaN) || (r.price ?? 0) <= 0) continue;
    out.push({ key: `coin:${sym}`, price: r.price as number, pct24h: r.pct24h ?? null });
  }
  return out;
}

const styles = StyleSheet.create({
  host: {
    position: 'relative',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
  sensor: {
    width: 0,
    height: 0,
    opacity: 0,
  },
});
