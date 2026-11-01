/**
 * components/BlinkFrame.tsx — v1.4.0 «کادر چشمک‌زن رشد/ریزش»
 *
 * روی هر کارت/ردیف سوار می‌شود؛ وقتی state='up' باشد کادر سبز و وقتی
 * state='down' باشد کادر قرمز، نرم چشمک می‌زند (گلو + بوردر). وقتی state
 * null شود (برگشت زیر آستانه) چشمک فوراً می‌ایستد و هیچ اثری نمی‌ماند.
 * پیاده‌سازی رویهٔ absolute overlay است تا ارتفاع/چیدمان هیچ‌وقت تکون نخورد.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, View, StyleSheet, ViewStyle } from 'react-native';
import colors from '@/constants/colors';
import { useGrowthBlink, type GrowthState } from '@/utils/growthSignals';

interface BlinkFrameProps {
  /** حالت آماده — اگر پدر خودش درصد را دارد (مثلاً change24hPct ردیف) */
  state?: GrowthState;
  /** یا خودکارسازی: کلید دارایی + قیمت فعلی (+ تغییر٪ ۲۴ ساعته اگر موجود) */
  blinkKey?: string | null;
  price?: number;
  pct24h?: number | null;
  children: React.ReactNode;
  style?: ViewStyle | ViewStyle[];
  borderRadius?: number;
  testID?: string;
}

/**
 * دو حالت استفاده:
 *   ۱) <BlinkFrame state={blinkState}> — پدر خودش state می‌دهد
 *   ۲) <BlinkFrame blinkKey="coin:BTC" price={…} pct24h={…}> — داخل map ها؛
 *      هوک داخل همین کامپوننت است پس قواعد هوکس نقض نمی‌شود.
 */
export default function BlinkFrame({
  state: stateProp,
  blinkKey,
  price,
  pct24h,
  children,
  style,
  borderRadius = 14,
  testID,
}: BlinkFrameProps) {
  const computed = useGrowthBlink(blinkKey ?? null, price ?? 0, pct24h ?? null);
  const state = stateProp !== undefined ? stateProp : computed.state;
  const pulse = useRef(new Animated.Value(state ? 1 : 0)).current;

  useEffect(() => {
    if (!state) {
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
  }, [state, pulse]);

  const color = state === 'up' ? colors.dark.green : colors.dark.red;

  return (
    <View style={[style, styles.host]} testID={testID}>
      {children}
      {state ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.overlay,
            { borderRadius, borderWidth: 2, borderColor: color, opacity: pulse },
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

const styles = StyleSheet.create({
  host: {
    position: 'relative',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
});
