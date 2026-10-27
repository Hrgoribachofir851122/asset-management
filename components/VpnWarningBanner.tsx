import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { AlertTriangle, RefreshCw, X } from 'lucide-react-native';
import colors from '@/constants/colors';
import { createThemedStyles } from '@/utils/themeStyles';
import { checkVpnStatus, VpnStatus } from '@/utils/vpnGuard';

interface VpnWarningBannerProps {
  /**
   * Parent decides relevance — e.g. the wallet screen passes true only when
   * at least one FOREIGN exchange (Binance/Bybit/OKX/BitPerp…) is connected.
   */
  show: boolean;
}

/**
 * «فیلترشکن خاموش است» warning banner.
 *
 * Shown ONLY when the exit-IP check positively detects an Iranian IP
 * ('unknown' never warns). Polls every 60s so the banner disappears by
 * itself when the user turns the VPN on. One manual dismiss per screen
 * session (it comes back on the next mount / after a re-check finds Iran
 * again — annoying by design, security-relevant).
 */
export default function VpnWarningBanner({ show }: VpnWarningBannerProps) {
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
