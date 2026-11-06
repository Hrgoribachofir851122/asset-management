/**
 * app/(tabs)/prices/index.tsx — تب جدید «قیمت‌ها» (v1.5.0، جایگاه اول نوار پایین)
 *
 * تمام قیمت‌های لحظه‌ای اپ در یک صفحه، مستقیم از گوشی و بدون سرور:
 *   ۱) طلا و فلزات (همان چیدمان قبلی + کارت خرید/فروش طلاین)
 *   ۲) ارز (دلار آزاد + تتر)
 *   ۳) ارزهای دیجیتال (بیت‌کوین و اتریوم — دلاری + تومانی در یک کادر)
 *
 * محتوا از LocalAssetsSection به اینجا منتقل شد (components/PriceBoard.tsx) —
 * کارت «دارایی ریالی و فلزات» در تب مدیریت دارایی فقط دارایی‌ها/موجودی/PnL
 * را نشان می‌دهد.
 *
 * نرخ تتر با همان queryKey کیف پول گرفته می‌شود (['usdt-toman-price']) —
 * react-query کش مشترک را یک‌بار می‌گیرد.
 */

import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import colors from '@/constants/colors';
import { createThemedStyles } from '@/utils/themeStyles';
import { fetchUsdtTomanPrice } from '@/utils/nobitexApi';
import PriceBoard from '@/components/PriceBoard';

export default function PricesScreen() {
  const tomanQuery = useQuery({
    queryKey: ['usdt-toman-price'],
    queryFn: fetchUsdtTomanPrice,
    refetchInterval: 5 * 60 * 1000,
    staleTime: 30_000,
  });

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {/* هدر درون‌صفحه‌ای — هم‌خانواده با هدر «مدیریت دارایی» و «تنظیمات» */}
      <View style={styles.pageHeader}>
        <Text style={styles.pageHeaderTitle}>قیمت‌ها</Text>
        <View style={styles.pageHeaderAccent} />
      </View>

      <PriceBoard usdtToToman={tomanQuery.data?.usdtToToman ?? 0} />
    </ScrollView>
  );
}

const styles = createThemedStyles(() =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.dark.background,
    },
    content: {
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 40,
    },
    // همان هدر صفحات دیگر: عنوان وسط + خط تأکید طلایی
    pageHeader: {
      alignItems: 'center',
      paddingTop: 2,
      paddingBottom: 10,
    },
    pageHeaderTitle: {
      fontSize: 18,
      fontWeight: '800' as const,
      color: colors.dark.text,
      letterSpacing: 0.2,
      textAlign: 'center',
    },
    pageHeaderAccent: {
      width: 44,
      height: 3,
      borderRadius: 2,
      marginTop: 7,
      backgroundColor: colors.dark.accent,
    },
  })
);
