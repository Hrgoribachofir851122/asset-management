/**
 * components/IpStatusCard.tsx — v1.1.0 (درخواست کاربر)
 *
 * «در بخش تنظیمات قسمت مربوط به چک‌کردن ای‌پی هم بزار … هر ۳ ثانیه اتوماتیک»
 *
 * کارت وضعیت IP در تنظیمات:
 *   • هر ۳ ثانیه یک check مجبور (force) اجرا می‌شود — چون vpnGuard یک
 *     in-flight مشترک + کش ۳ ثانیه‌ای دارد، این ریتم سبک است و درخواست‌های
 *     موازی جمع می‌شوند (دقیقاً همان ریتم گیت ورودی پامپی).
 *   • وضعیت سه‌حالته: فیلترشکن روشن (سبز) / IP تحریمی — بدون فیلترشکن (قرمز)
 *     / نامشخص (خاکستری). IP و کشورِ آن هم نشان داده می‌شود.
 *   • با IP تحریمی (ایران و بقیهٔ SANCTIONED_COUNTRIES) دو بخش «ارز دیجیتال
 *     (صرافی‌های خارجی)» و «کیف پول بلاکچین» داده‌ای ارسال/دریافت نمی‌کنند؛
 *     همین‌جا پیغامش نمایش داده می‌شود. بقیهٔ بخش‌ها با IP ایران هم کامل
 *     کار می‌کنند (قیمت‌های TGJU، پیش‌بینی طلا، دارایی‌های ریالی، صرافی‌های
 *     ایرانی مثل نوبیتکس/ارزینجا).
 *
 * نمایش وضعیت بلاک‌شدن دو بخش به دادهٔ «کیف پول/صرافی اضاف‌شده» وابسته است؛
 * والدها props اختیاری hasTargets را می‌دهند تا متن دقیق باشد.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ShieldCheck, ShieldAlert, RefreshCw, HelpCircle } from 'lucide-react-native';
import colors from '@/constants/colors';
import { createThemedStyles } from '@/utils/themeStyles';
import { getIpInfo, isForeignExchange, type IpInfo } from '@/utils/vpnGuard';

const POLL_MS = 3_000; // «هر ۳ ثانیه اتوماتیک» — همان کش داخلی vpnGuard

/** کلیدهای کیف‌ها — همان کلیدهای wallet/index.tsx و blockchainWallets.ts */
const EXCHANGE_WALLETS_KEY = '@exchange_wallets';
const BLOCKCHAIN_WALLETS_KEY = '@blockchain_wallets_v1';

/**
 * آیا «هدف» وجود دارد؟ = کیف پول بلاکچین اضاف شده یا صرافیِ «خارجی»
 * (صرافی‌های ایرانی مثل نوبیتکس/ارزینجا با IP ایران هم کار می‌کنند و
 * هدف محسوب نمی‌شوند.)
 */
async function detectHasTargets(): Promise<boolean> {
  try {
    const rawBc = await AsyncStorage.getItem(BLOCKCHAIN_WALLETS_KEY);
    if (rawBc) {
      const list = JSON.parse(rawBc);
      if (Array.isArray(list) && list.length > 0) return true;
    }
    const rawEx = await AsyncStorage.getItem(EXCHANGE_WALLETS_KEY);
    if (rawEx) {
      const list = JSON.parse(rawEx);
      if (Array.isArray(list) && list.some((w) => isForeignExchange(String(w?.exchangeId ?? '')))) {
        return true;
      }
    }
  } catch {
    /* خواندن ناموفق → مثل بدون‌هدف */
  }
  return false;
}

export default function IpStatusCard() {
  const [info, setInfo] = useState<IpInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [showWhy, setShowWhy] = useState(false);
  const [hasTargets, setHasTargets] = useState(false);
  const mountedRef = useRef(true);

  const check = useCallback(async (force = true) => {
    setChecking(true);
    try {
      const res = await getIpInfo(force);
      if (mountedRef.current) setInfo(res);
    } finally {
      if (mountedRef.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void check(true);
    // هر ۳ ثانیه: هم IP و هم وجود کیف/صرافی (خواندن AsyncStorage محلی و ارزان است)
    void detectHasTargets().then((t) => {
      if (mountedRef.current) setHasTargets(t);
    });
    const timer = setInterval(() => {
      void check(true);
      void detectHasTargets().then((t) => {
        if (mountedRef.current) setHasTargets(t);
      });
    }, POLL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [check]);

  const sanctioned = info?.status === 'iran';
  const unknown = !info || info.status === 'unknown';
  const countryLabel = info?.countryNameFa ?? (info?.country ? `کشور (${info.country})` : 'نامشخص');

  return (
    <View
      style={[
        styles.card,
        sanctioned ? styles.cardBlocked : unknown ? styles.cardUnknown : styles.cardOk,
      ]}
      testID="ip-status-card"
    >
      <View style={styles.headRow}>
        {unknown ? (
          <HelpCircle size={20} color={colors.dark.textSecondary} />
        ) : sanctioned ? (
          <ShieldAlert size={20} color={colors.dark.red} />
        ) : (
          <ShieldCheck size={20} color={colors.dark.green} />
        )}
        <Text style={styles.title}>بررسی IP و فیلترشکن</Text>
        <Pressable
          style={styles.refreshBtn}
          onPress={() => void check(true)}
          disabled={checking}
          hitSlop={8}
          testID="ip-status-refresh"
        >
          {checking ? (
            <ActivityIndicator size="small" color={colors.dark.accent} />
          ) : (
            <RefreshCw size={14} color={colors.dark.accent} />
          )}
        </Pressable>
      </View>

      <View style={styles.statusRow}>
        <View
          style={[
            styles.dot,
            unknown
              ? styles.dotUnknown
              : sanctioned
                ? styles.dotBlocked
                : styles.dotOk,
          ]}
        />
        <Text
          style={[
            styles.statusText,
            unknown
              ? styles.textUnknown
              : sanctioned
                ? styles.textBlocked
                : styles.textOk,
          ]}
          testID="ip-status-text"
        >
          {unknown
            ? 'در حال بررسی…'
            : sanctioned
              ? 'بدون فیلترشکن — IP تحریمی'
              : 'فیلترشکن روشن است'}
        </Text>
      </View>

      {!unknown && (
        <Text style={styles.metaText}>
          IP: {info?.ip ?? '—'} • کشور: {countryLabel}
          {info?.country ? ` (${info.country})` : ''}
        </Text>
      )}

      {sanctioned && (
        <View style={styles.warnBox}>
          <Text style={styles.warnText}>
            {hasTargets
              ? 'با این IP، اطلاعات کیف پول‌های بلاکچین و صرافی‌های خارجی شما ارسال یا دریافت نمی‌شود (محافظت خودکار). برای دیدن موجودی‌ها، فیلترشکن را روشن کنید.'
              : 'اگر کیف پول بلاکچین یا صرافی خارجی اضافه کنید، با این IP اطلاعات آن بخش‌ها ارسال نمی‌شود. برای استفاده از آن بخش‌ها فیلترشکن را روشن کنید.'}
          </Text>
          <Pressable onPress={() => setShowWhy((v) => !v)} hitSlop={6}>
            <Text style={styles.whyBtn}>{showWhy ? 'بستن توضیح' : 'چرا؟'}</Text>
          </Pressable>
          {showWhy && (
            <Text style={styles.whyText}>
              سرورهای صرافی‌های خارجی و بیشتر APIهای بلاکچین، IP کشورهای تحریمی (ایران، کوبا،
              کرهٔ شمالی، سوریه) را بلاک می‌کنند یا اکانت را پرریسک می‌کنند؛ به همین دلیل با این
              IPها هیچ درخواستی از بخش‌های مذکور فرستاده نمی‌شود. بقیهٔ برنامه (قیمت‌های لحظه‌ای
              تومان، سکه و طلا، پیش‌بینی طلا و صرافی‌های ایرانی) با همین IP کامل کار می‌کند.
            </Text>
          )}
        </View>
      )}

      <Text style={styles.hint}>بررسی خودکار هر ۳ ثانیه • بقیهٔ بخش‌ها با هر IP کار می‌کنند</Text>
    </View>
  );
}

const styles = createThemedStyles(() =>
  StyleSheet.create({
    card: {
      borderRadius: 16,
      padding: 14,
      borderWidth: 1,
      backgroundColor: colors.dark.card,
    },
    cardOk: {
      borderColor: colors.dark.green + '55',
    },
    cardBlocked: {
      borderColor: colors.dark.red + '66',
    },
    cardUnknown: {
      borderColor: colors.dark.cardBorder,
    },
    headRow: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: 8,
    },
    title: {
      flex: 1,
      fontSize: 15,
      fontWeight: '700' as const,
      color: colors.dark.text,
      textAlign: 'right',
    },
    refreshBtn: {
      padding: 6,
    },
    statusRow: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: 8,
      marginTop: 12,
    },
    dot: {
      width: 10,
      height: 10,
      borderRadius: 5,
    },
    dotOk: {
      backgroundColor: colors.dark.green,
    },
    dotBlocked: {
      backgroundColor: colors.dark.red,
    },
    dotUnknown: {
      backgroundColor: colors.dark.textMuted,
    },
    statusText: {
      fontSize: 14,
      fontWeight: '700' as const,
      textAlign: 'right',
      flex: 1,
    },
    textOk: {
      color: colors.dark.green,
    },
    textBlocked: {
      color: colors.dark.red,
    },
    textUnknown: {
      color: colors.dark.textSecondary,
    },
    metaText: {
      marginTop: 8,
      fontSize: 12,
      color: colors.dark.textSecondary,
      textAlign: 'right',
    },
    warnBox: {
      marginTop: 10,
      backgroundColor: colors.dark.redDim,
      borderRadius: 10,
      padding: 10,
      borderWidth: 1,
      borderColor: colors.dark.red + '33',
    },
    warnText: {
      fontSize: 12,
      lineHeight: 19,
      color: colors.dark.red,
      textAlign: 'right',
    },
    whyBtn: {
      marginTop: 6,
      fontSize: 12,
      fontWeight: '700' as const,
      color: colors.dark.accent,
      textAlign: 'right',
    },
    whyText: {
      marginTop: 6,
      fontSize: 11,
      lineHeight: 18,
      color: colors.dark.textSecondary,
      textAlign: 'right',
    },
    hint: {
      marginTop: 10,
      fontSize: 11,
      color: colors.dark.textMuted,
      textAlign: 'right',
    },
  })
);
