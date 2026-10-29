import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { AlertTriangle, RefreshCw, X, ShieldCheck } from 'lucide-react-native';
import colors from '@/constants/colors';
import { createThemedStyles } from '@/utils/themeStyles';
import { checkVpnStatus, VpnStatus } from '@/utils/vpnGuard';

interface VpnWarningBannerProps {
  /**
   * Parent decides relevance — e.g. the wallet screen passes true only when
   * at least one FOREIGN exchange (Binance/Bybit/OKX/BitPerp…) is connected.
   */
  show: boolean;
  /**
   * v1.3.0 — «وقتی ایپی ایران تشخیص داده میشه در دو تب ریالی و پیش بینی
   * پیغامی که نشون داده میشه را اصلاح کن و دقیقا طبق قطع ایپیهای تحریمی بگو
   * که این بخش با ایپی ایران بدون مشکل متصله و برا اینکه خطری دارایی را
   * تهدید نکنه دو بخش کیفو ارز هیچ ترافیکی با ایپی های تحریمی بهشون نمیرسه
   * و غیر فعال میشن»
   *
   * 'safe'     → تب‌های «دارایی ریالی و فلزات» / «پیش‌بینی طلا»: پیام سبز
   *              «این بخش با IP ایران بدون مشکل متصل است» + توضیح اینکه دو
   *              بخش کیف پول و ارز دیجیتال با IP تحریمی هیچ ترافیکی
   *              نمی‌گیرند و غیرفعال‌اند.
   * 'exchange' → تب‌های «کیف پول بلاکچین» / «ارز دیجیتال» (رفتار قبلی).
   */
  variant?: 'exchange' | 'safe';
}

/**
 * IP status banner.
 *
 * Shown ONLY when the exit-IP check positively detects an Iranian/sanctioned
 * IP ('unknown' never warns). Polls so the banner follows a VPN toggle.
 */
export default function VpnWarningBanner({ show, variant = 'exchange' }: VpnWarningBannerProps) {
  const [status, setStatus] = useState<VpnStatus>('unknown');
  const [dismissed, setDismissed] = useState(false);
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(async (force = false) => {
    setChecking(true);
    const s = await checkVpnStatus(force);
    setStatus(s);
    setChecking(false);
    // Turning the VPN back on clears any previous dismissal.
    if (s !== 'iran') setDismissed(false);
  }, []);

  useEffect(() => {
    if (!show) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(timer);
  }, [show, refresh]);

  if (!show || dismissed || status !== 'iran') return null;

  // ── v1.3.0 — نسخهٔ «این بخش با IP ایران بدون مشکل متصل است» ──
  if (variant === 'safe') {
    return (
      <View style={styles.safeBanner}>
        <ShieldCheck size={20} color={colors.dark.green} />
        <View style={styles.textCol}>
          <Text style={styles.safeTitle}>این بخش با IP ایران بدون مشکل متصل است</Text>
          <Text style={styles.safeBody}>
            منابع این صفحه داخلی‌اند (TGJU و سایت‌های ایرانی) و بدون فیلترشکن کامل کار می‌کنند.
            اما برای اینکه خطری دارایی شما را تهدید نکند، دو بخش «کیف پول بلاکچین» و «ارز
            دیجیتال» با IPهای ایران و تحریمی هیچ ترافیکی دریافت نمی‌کنند — حتی یک بایت از گوشی
            شما به صرافی‌ها و سرورهای بلاکچین نمی‌رسد — و غیرفعال می‌شوند. با روشن‌کردن
            فیلترشکن هر دو بخش خودکار فعال می‌شوند.
          </Text>
          <Pressable style={styles.safeBtn} onPress={() => void refresh(true)}>
            <RefreshCw size={12} color={colors.dark.green} />
            <Text style={styles.safeBtnText}>{checking ? 'در حال بررسی...' : 'بررسی مجدد IP'}</Text>
          </Pressable>
        </View>
        <Pressable style={styles.closeBtn} onPress={() => setDismissed(true)} hitSlop={8}>
          <X size={16} color={colors.dark.textMuted} />
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.banner}>
      <AlertTriangle size={20} color={colors.dark.orange} />
      <View style={styles.textCol}>
        <Text style={styles.title}>فیلترشکن خاموش است</Text>
        <Text style={styles.body}>
          ترافیک برنامه در حال حاضر با IP ایران به صرافی‌های خارجی می‌رسد. برای حفظ
          امنیت حساب کاربری خارجی، فیلترشکن را روشن کنید تا اتصال از IP فیلترشکن
          انجام شود.
        </Text>
        <Pressable style={styles.howBtn} onPress={() => void refresh(true)}>
          <RefreshCw size={12} color={colors.dark.orange} />
          <Text style={styles.howBtnText}>{checking ? 'در حال بررسی...' : 'بررسی مجدد'}</Text>
        </Pressable>
      </View>
      <Pressable style={styles.closeBtn} onPress={() => setDismissed(true)} hitSlop={8}>
        <X size={16} color={colors.dark.textMuted} />
      </Pressable>
    </View>
  );
}

const styles = createThemedStyles(() =>
  StyleSheet.create({
    banner: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      backgroundColor: colors.dark.orangeDim,
      borderWidth: 1,
      borderColor: colors.dark.orange + '66',
      borderRadius: 12,
      padding: 12,
      marginBottom: 12,
    },
    // ── v1.3.0 — نسخهٔ سبز «این بخش متصل است» ──
    safeBanner: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      backgroundColor: colors.dark.greenDim,
      borderWidth: 1,
      borderColor: colors.dark.green + '55',
      borderRadius: 12,
      padding: 12,
      marginBottom: 12,
    },
    safeTitle: {
      fontSize: 13,
      fontWeight: '800' as const,
      color: colors.dark.green,
      textAlign: 'right',
    },
    safeBody: {
      fontSize: 11,
      lineHeight: 18,
      color: colors.dark.textSecondary,
      textAlign: 'right',
    },
    safeBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      alignSelf: 'flex-start',
      backgroundColor: colors.dark.green + '22',
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 5,
      marginTop: 4,
    },
    safeBtnText: {
      fontSize: 11,
      fontWeight: '700' as const,
      color: colors.dark.green,
    },
    textCol: {
      flex: 1,
      gap: 4,
    },
    title: {
      fontSize: 13,
      fontWeight: '800' as const,
      color: colors.dark.orange,
      textAlign: 'right',
    },
    body: {
      fontSize: 11,
      lineHeight: 18,
      color: colors.dark.orange,
      textAlign: 'right',
    },
    howBtn: {
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
    howBtnText: {
      fontSize: 11,
      fontWeight: '700' as const,
      color: colors.dark.orange,
    },
    closeBtn: {
      padding: 4,
    },
  })
);
