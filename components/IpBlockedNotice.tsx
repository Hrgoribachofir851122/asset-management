/**
 * IpBlockedNotice — v1.2.0
 *
 * «وقتی فیلترشکن خاموشه و IP ایرانه یا کلا IP غیرمجازه و تحریمه برا کیف و
 * صرافی‌ها بیاد و دو تب کیف و ارز را کلا خاموش کنن داده‌هاشون را غیرفعال کن
 * و یه پیغام خطای IP در این دو تب نشون بده و با توضیحات که چرا غیرفعاله»
 *
 * این کارت جایش محتوای تب را می‌گیرد — با IP تحریمی هیچ درخواستی به کیف‌های
 * بلاکچین / صرافی‌ها نمی‌رود (گیتِ داخل کوئری‌ها هم هست)، چون:
 *   1) صرافی‌های خارجی IP ایران را بلاک/ریسک‌فلگ می‌کنند (451/418) و حساب
 *      کاربری در خطر می‌افتد؛
 *   2) APIهای بلاکچین خارجی‌اند و با IP ایران در دسترس نیستند؛
 *   3) امنیت دارایی اولویت است — ترافیک این دو بخش هرگز با IP تحریمی
 *      از گوشی خارج نمی‌شود.
 *
 * تب «دارایی ریالی و فلزات» و «پیش‌بینی طلا» با IP ایران عادی کار می‌کنند
 * (منابعشان TGJU و سایت‌های ایرانی است).
 */

import React from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { ShieldAlert, RefreshCcw, Lock } from 'lucide-react-native';
import colors from '@/constants/colors';
import { createThemedStyles } from '@/utils/themeStyles';

export default function IpBlockedNotice({
  section,
  checking,
  onRecheck,
}: {
  /** 'crypto' = تب ارز دیجیتال (صرافی‌ها) | 'wallet' = تب کیف پول بلاکچین */
  section: 'crypto' | 'wallet';
  checking?: boolean;
  onRecheck?: () => void;
}) {
  const isCrypto = section === 'crypto';
  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <ShieldAlert size={26} color={colors.dark.red} />
        <Text style={styles.title}>
          {isCrypto
            ? 'اتصال به صرافی‌ها غیرفعال است — IP شما تحریمی/ایران است'
            : 'خواندن کیف پول بلاکچین غیرفعال است — IP شما تحریمی/ایران است'}
        </Text>
      </View>

      <Text style={styles.body}>
        {isCrypto
          ? 'فیلترشکن خاموش است و IP خروجی شما ایران (یا کشوری تحریمی) است. برای حفظ امنیت دارایی، برنامه با این IP هیچ داده‌ای از صرافی‌ها نمی‌خواند و هیچ درخواستی به صرافی‌ها نمی‌فرستد.'
          : 'فیلترشکن خاموش است و IP خروجی شما ایران (یا کشوری تحریمی) است. برای حفظ امنیت دارایی، برنامه با این IP هیچ داده‌ای از کیف پول‌های بلاکچین نمی‌خواند و هیچ درخواستی به سرورهای بلاکچین نمی‌فرستد.'}
      </Text>

      <View style={styles.whyBox}>
        <Text style={styles.whyTitle}>چرا این بخش با IP ایران غیرفعال است؟</Text>
        <Text style={styles.whyText}>
          {isCrypto
            ? '• صرافی‌های خارجی (بایننس، بای‌بیت، اوکی‌ایکس و…) با IP ایران به حساب شما مشکوک می‌شوند و ممکن است حساب موقتاً مسدود شود (خطای 451/418 و ریسک‌فلگ).\n• با IP ایران پاسخ صرافی‌ها قابل اتکا نیست و کلیدهای API شما در معرض ریسک اضافه می‌روند.\n• ترافیک این تب با IP ایران به هیچ صرافی‌ای نمی‌رسد — این یک گیت امنیتی سخت در خود برنامه است.'
            : '• سرورهای بلاکچین و اکسپلوررها سرویس خارجی‌اند و با IP ایران در دسترس نیستند.\n• خواندن موجودی از آدرس عمومی نیاز به اتصال بین‌المللی پایدار دارد.\n• ترافیک این تب با IP ایران به هیچ سرور بلاکچینی نمی‌رسد — این یک گیت امنیتی سخت در خود برنامه است.'}
        </Text>
      </View>

      <View style={styles.okBox}>
        <Lock size={12} color={colors.dark.green} />
        <Text style={styles.okText}>
          تب «دارایی ریالی و فلزات» و «پیش‌بینی قیمت طلا» بدون فیلترشکن عادی کار می‌کنند
          (منابع: TGJU و سایت‌های داخلی).
        </Text>
      </View>

      <Pressable style={styles.recheckBtn} onPress={onRecheck} disabled={checking}>
        {checking ? (
          <ActivityIndicator size="small" color={colors.dark.red} />
        ) : (
          <RefreshCcw size={14} color={colors.dark.red} />
        )}
        <Text style={styles.recheckText}>
          {checking ? 'در حال بررسی IP…' : 'بررسی مجدد IP (بعد از روشن‌کردن فیلترشکن)'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = createThemedStyles(() =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.dark.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.dark.red + '55',
      padding: 18,
      marginBottom: 16,
      gap: 10,
    },
    headRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    title: {
      flex: 1,
      fontSize: 13.5,
      fontWeight: '800' as const,
      color: colors.dark.red,
      textAlign: 'right',
      lineHeight: 21,
    },
    body: {
      fontSize: 12,
      lineHeight: 20,
      color: colors.dark.text,
      textAlign: 'right',
    },
    whyBox: {
      backgroundColor: colors.dark.red + '12',
      borderRadius: 12,
      padding: 12,
      gap: 6,
    },
    whyTitle: {
      fontSize: 12,
      fontWeight: '700' as const,
      color: colors.dark.red,
      textAlign: 'right',
    },
    whyText: {
      fontSize: 11,
      lineHeight: 19,
      color: colors.dark.textSecondary,
      textAlign: 'right',
    },
    okBox: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 8,
      backgroundColor: colors.dark.greenDim,
      borderRadius: 12,
      padding: 12,
    },
    okText: {
      flex: 1,
      fontSize: 11,
      lineHeight: 19,
      color: colors.dark.green,
      textAlign: 'right',
    },
    recheckBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      alignSelf: 'stretch',
      borderRadius: 12,
      paddingVertical: 11,
      backgroundColor: colors.dark.red + '18',
      borderWidth: 1,
      borderColor: colors.dark.red + '40',
    },
    recheckText: {
      fontSize: 12.5,
      fontWeight: '700' as const,
      color: colors.dark.red,
    },
  })
);
