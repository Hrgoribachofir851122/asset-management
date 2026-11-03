import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Pressable, Image } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Landmark, RefreshCw } from 'lucide-react-native';
import colors from '@/constants/colors';
import { createThemedStyles } from '@/utils/themeStyles';
// v1.5.0 — تمام این محتوا از LocalAssetsSection به تب مستقل «قیمت‌ها» منتقل شد
// (طرح تأییدشده: طلا/فلزات با همان چیدمان + کارت طلاین ← ارز ← ارزهای دیجیتال)
import { BlinkOverlay, GroupBlinkFrame } from '@/components/BlinkFrame';
import { useGrowthBlink } from '@/utils/growthSignals';
import {
  fetchIranMarketPrices,
  formatFullToman,
  IranMarketPrices,
  clearIranMarketMemoryCache,
} from '@/utils/iranMarketApi';
import { formatToman } from '@/utils/nobitexApi';
import {
  isGlobalGoldMarketOpen,
  globalGoldMarketLabel,
} from '@/utils/globalMarketHours';
import { fetchTalineGold, clearTalineGoldMemoryCache } from '@/utils/talineApi';
import {
  fetchCryptoPrices,
  CryptoPrice,
  clearCryptoPricesMemoryCache,
} from '@/utils/cryptoPricesApi';

/**
 * PriceBoard — v1.5.0
 *
 * محتوای کامل تب جدید «قیمت‌ها» (جایگاه اول نوار پایین). قیمت‌های لحظه‌ای
 * قبلاً داخل کارت «دارایی ریالی و فلزات» بودند؛ طبق طرح تأییدشده جدا شدند:
 *
 *   ۱) طلا و فلزات — همان شبکهٔ چیپ‌های قبلی (انس، ۱۸/۲۴، نقره، سکه‌ها)
 *      با چشمک‌زن رشد/ریزش + کارت خرید/فروش طلایین طلاین (گزینهٔ ب: به این
 *      تب منتقل شد، نه حذف).
 *   ۲) ارز — دلار آزاد + تتر.
 *   ۳) ارزهای دیجیتال — بیت‌کوین و اتریوم، هر کدام در یک کادر با دو قیمت
 *      زیر هم/کنار هم: دلاری (بایننس) و تومانی (نوبیتکس) + ٪ تغییر ۲۴ ساعته.
 *
 * همه‌چیز مستقیم از گوشی بدون سرور (همان لایه‌های قبلی + cryptoPricesApi).
 * رفرش‌ها با همان queryKey های قبل؛ کوئری قیمت‌ها با صفحهٔ مدیریت دارایی
 * اشتراک کش دارد (react-query خودش دی‌دوپلیکس می‌کند).
 */

interface Props {
  /** نرخ زندهٔ تتر (همان منبع هدر کیف) — برای چیپ تتر */
  usdtToToman: number;
}

export default function PriceBoard({ usdtToToman }: Props) {
  const queryClient = useQueryClient();

  // v1.1.0 — باز/بسته بودن بازار جهانی طلا؛ هر ۶۰ ثانیه ارزیابی مجدد
  const [goldMarketTick, setGoldMarketTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setGoldMarketTick((t) => t + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  const goldMarketOpen = useMemo(() => isGlobalGoldMarketOpen(), [goldMarketTick]);
  const goldMarketText = useMemo(() => globalGoldMarketLabel(), [goldMarketTick]);

  const pricesQuery = useQuery({
    queryKey: ['iran-market-prices'],
    queryFn: fetchIranMarketPrices,
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60 * 1000,
  });
  const p = pricesQuery.data;

  // v1.3.6 — نرخ خرید/فروش طلایین طلاین (۵ لایهٔ موازی + کش stale)
  const talineQuery = useQuery({
    queryKey: ['taline-gold'],
    queryFn: fetchTalineGold,
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60 * 1000,
  });
  const taline = talineQuery.data;

  // v1.5.0 — بیت‌کوین/اتریوم: دلاری (بایننس) + تومانی (نوبیتکس)، بدون سرور.
  // کوین‌ها سریع‌تر از فلزات حرکت می‌کنند → هر ۶۰ ثانیه تازه‌سازی خودکار.
  const cryptoQuery = useQuery({
    queryKey: ['crypto-prices'],
    queryFn: fetchCryptoPrices,
    refetchInterval: 60 * 1000,
    staleTime: 30 * 1000,
  });
  const crypto = cryptoQuery.data;

  const refresh = makeRefresh(queryClient);
  const minutesOld = p ? Math.max(1, Math.round((Date.now() - p.updatedAt) / 60000)) : 0;
  const talineMinutes = taline ? Math.max(1, Math.round((Date.now() - taline.updatedAt) / 60000)) : 0;
  const cryptoMinutes = crypto
    ? Math.max(1, Math.round((Date.now() - crypto.updatedAt) / 60000))
    : 0;
  const anyFetching =
    pricesQuery.isFetching || talineQuery.isFetching || cryptoQuery.isFetching;

  return (
    <GroupBlinkFrame group="metals" style={styles.card} borderRadius={16}>
      {/* ── header ── */}
      <View style={styles.header}>
        <Landmark size={18} color={colors.dark.accent} />
        <Text style={styles.title}>قیمت‌های لحظه‌ای</Text>
        <Pressable style={styles.refreshBtn} onPress={refresh}>
          {anyFetching ? (
            <ActivityIndicator size="small" color={colors.dark.accent} />
          ) : (
            <RefreshCw size={14} color={colors.dark.accent} />
          )}
        </Pressable>
      </View>

      {/* ═══ ۱) طلا و فلزات — همان چیدمان قبلی ═══ */}
      <Text style={styles.sectionLabel}>طلا و فلزات</Text>
      <View style={styles.priceBlock}>
        <View style={styles.priceGrid}>
          <PriceChip
            label="انس جهانی طلا ($)"
            value={p?.goldOunceUsd}
            usd
            tone={goldMarketOpen ? 'open' : 'closed'}
          />
          <PriceChip label="طلای ۱۸ عیار (گرم)" value={p?.gold18} tone="open" blinkKey="metal:geram18" />
          <PriceChip label="طلای ۲۴ عیار (گرم)" value={p?.gold24} blinkKey="metal:geram24" />
          <PriceChip label="نقره ۹۹۹ (گرم)" value={p?.silver999} />
          <PriceChip label="نقره ۹۲۵ (گرم)" value={p?.silver925} />
          <PriceChip label="سکه امامی" value={p?.coinEmami} blinkKey="metal:sekee" />
          <PriceChip label="سکه بهار آزادی" value={p?.coinBahar} blinkKey="metal:sekee_bahar" />
          <PriceChip label="نیم سکه" value={p?.coinNim} />
          <PriceChip label="ربع سکه" value={p?.coinRob} />
        </View>
        <View style={styles.marketStatusRow}>
          <View
            style={[
              styles.marketStatusDot,
              { backgroundColor: goldMarketOpen ? colors.dark.green : colors.dark.red },
            ]}
          />
          <Text
            style={[
              styles.marketStatusText,
              { color: goldMarketOpen ? colors.dark.green : colors.dark.red },
            ]}
          >
            {goldMarketText.text}
          </Text>
          {!goldMarketOpen && (
            <Text style={styles.marketStatusHint}>— قیمت انس تا باز‌شدن بازار تغییر نمی‌کند</Text>
          )}
        </View>
        {p && <Text style={styles.priceNote}>منبع: TGJU • {minutesOld} دقیقه پیش</Text>}
        {!p && !pricesQuery.isFetching && (
          <Text style={styles.priceNote}>قیمت‌ها در دسترس نیست — بعداً تازه‌سازی کنید</Text>
        )}

        {/* v1.3.6 — خرید/فروش هر گرم طلای آب‌شده از طلاین (گزینهٔ ب → این تب) */}
        <View style={styles.talineCard}>
          <View style={styles.talineHeader}>
            <View style={styles.talineBadge}>
              <Text style={styles.talineBadgeText}>ط</Text>
            </View>
            <Text style={styles.talineTitle}>
              قیمت خرید و فروش هر گرم طلای آب‌شده از سایت taline.ir
            </Text>
          </View>
          <View style={styles.talineRow}>
            <View style={[styles.talineBox, styles.talineBoxBuy]}>
              <Text style={styles.talineBoxLabel}>قیمت خرید هر گرم</Text>
              <Text style={[styles.talineBoxValue, { color: colors.dark.green }]}>
                {taline?.buy ? formatFullToman(taline.buy) : '…'}
              </Text>
              <Text style={styles.talineBoxUnit}>تومان</Text>
            </View>
            <View style={[styles.talineBox, styles.talineBoxSell]}>
              <Text style={styles.talineBoxLabel}>قیمت فروش هر گرم</Text>
              <Text style={[styles.talineBoxValue, { color: colors.dark.red }]}>
                {taline?.sell ? formatFullToman(taline.sell) : '…'}
              </Text>
              <Text style={styles.talineBoxUnit}>تومان</Text>
            </View>
          </View>
          <Text style={styles.talineNote}>
            {taline
              ? `تازه‌سازی خودکار همراه با قیمت‌ها • ${
                  talineMinutes <= 3 ? 'لحظه‌ای' : `${talineMinutes} دقیقه پیش`
                }`
              : talineQuery.isFetching
                ? 'در حال دریافت قیمت طلایین…'
                : 'قیمت طلایین موقتاً در دسترس نیست — بعداً تازه‌سازی کنید'}
          </Text>
        </View>
      </View>

      {/* ═══ ۲) ارز ═══ */}
      <Text style={styles.sectionLabel}>ارز</Text>
      <View style={styles.priceBlock}>
        <View style={styles.priceGrid}>
          <PriceChip label="دلار آزاد" value={p?.dollar} tone="open" blinkKey="metal:price_dollar_rl" />
          <PriceChip label="تتر" value={usdtToToman > 0 ? usdtToToman : undefined} />
        </View>
        {p && <Text style={styles.priceNote}>منبع: TGJU • نوبیتکس/آرزینجا</Text>}
      </View>

      {/* ═══ ۳) ارزهای دیجیتال — بیت‌کوین و اتریوم (دلاری + تومانی در یک کادر) ═══ */}
      <Text style={styles.sectionLabel}>ارزهای دیجیتال</Text>
      <View style={styles.cryptoWrap}>
        <CryptoBox coin={crypto?.btc} loading={cryptoQuery.isLoading} />
        <CryptoBox coin={crypto?.eth} loading={cryptoQuery.isLoading} />
        {crypto && crypto.usdSource ? (
          <Text style={styles.priceNote}>
            منبع دلاری: {crypto.usdSource} • تومانی: نوبیتکس • {cryptoMinutes} دقیقه پیش
          </Text>
        ) : (
          <Text style={styles.priceNote}>در حال دریافت قیمت‌ها…</Text>
        )}
      </View>
    </GroupBlinkFrame>
  );
}

/** رفرش دستی: کش حافظه خالی + invalidate هر سه کوئری (درخواست تازه واقعی) */
function makeRefresh(queryClient: ReturnType<typeof useQueryClient>) {
  return () => {
    clearIranMarketMemoryCache();
    clearTalineGoldMemoryCache();
    clearCryptoPricesMemoryCache();
    queryClient.invalidateQueries({ queryKey: ['iran-market-prices'] });
    queryClient.invalidateQueries({ queryKey: ['taline-gold'] });
    queryClient.invalidateQueries({ queryKey: ['crypto-prices'] });
  };
}

// ── چیپ قیمت — کپیِ عینی از LocalAssetsSection (همان اندازه/رنگ/چشمک‌زن) ──

function PriceChip({
  label,
  value,
  usd,
  tone,
  blinkKey,
}: {
  label: string;
  value?: number;
  usd?: boolean;
  tone?: 'open' | 'closed';
  blinkKey?: string | null;
}) {
  const text =
    value && value > 0
      ? usd
        ? `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : formatFullToman(value)
      : '…';
  const { state: blinkState, strength: blinkStrength } = useGrowthBlink(
    blinkKey ?? null,
    value ?? 0,
    null,
    { group: 'metals' },
  );
  return (
    <View
      style={[
        styles.priceChip,
        tone === 'open' && styles.priceChipOpen,
        tone === 'closed' && styles.priceChipClosed,
        blinkKey ? styles.priceChipHost : null,
      ]}
    >
      <Text style={styles.priceChipLabel}>{label}</Text>
      <Text
        style={[
          styles.priceChipValue,
          !value && styles.priceChipEmpty,
          tone === 'open' && styles.priceChipValueOpen,
          tone === 'closed' && styles.priceChipValueClosed,
        ]}
      >
        {text}
      </Text>
      {blinkKey ? (
        <BlinkOverlay state={blinkState} strength={blinkStrength} borderRadius={8} />
      ) : null}
    </View>
  );
}

// ── v1.5.0 — کادر دوعملهٔ بیت‌کوین/اتریوم (دلاری + تومانی در یک کادر) ──
// v1.5.1 — آیکون باندل‌شدهٔ محلی (بدون سرور و بدون لود؛ مثل بقیهٔ بخش‌ها)

const COIN_META: Record<
  'BTC' | 'ETH',
  { name: string; sub: string; icon: number }
> = {
  BTC: {
    name: 'بیت‌کوین',
    sub: 'BTC / USDT',
    icon: require('@/assets/images/coin-btc.png'),
  },
  ETH: {
    name: 'اتریوم',
    sub: 'ETH / USDT',
    icon: require('@/assets/images/coin-eth.png'),
  },
};

function CryptoBox({ coin, loading }: { coin?: CryptoPrice; loading: boolean }) {
  if (!coin) {
    return (
      <View style={styles.cryptoBox}>
        <Text style={styles.cryptoBoxLoading}>{loading ? 'در حال دریافت…' : 'قیمت در دسترس نیست'}</Text>
      </View>
    );
  }
  const meta = COIN_META[coin.symbol];
  const hasUsd = coin.usd > 0;
  const hasToman = coin.toman > 0;
  return (
    <View style={styles.cryptoBox}>
      <View style={styles.cryptoHead}>
        <Image source={meta.icon} style={styles.cryptoBadgeImg} />
        <View style={styles.cryptoNames}>
          <Text style={styles.cryptoName}>{meta.name}</Text>
          <Text style={styles.cryptoSub}>{meta.sub}</Text>
        </View>
        {hasUsd && Math.abs(coin.usdChangePct) > 0.001 && (
          <PctChip pct={coin.usdChangePct} />
        )}
      </View>
      <View style={styles.cryptoPricesRow}>
        <CryptoCell
          label="قیمت دلاری"
          text={hasUsd ? `$${coin.usd.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '…'}
          color={colors.dark.text}
          blinkKey={`crypto:${coin.symbol.toLowerCase()}-usd`}
          value={coin.usd}
          pct={coin.usdChangePct}
        />
        <CryptoCell
          label="قیمت تومانی"
          text={hasToman ? `${formatFullToman(Math.round(coin.toman))} ت` : '…'}
          color={colors.dark.accent}
          blinkKey={`crypto:${coin.symbol.toLowerCase()}-toman`}
          value={coin.toman}
          pct={coin.tomanChangePct}
        />
      </View>
    </View>
  );
}

/** یک خانهٔ قیمت داخل کادر کوین — با overlay چشمک‌زن رشد/ریزش (٪ واقعی ۲۴س) */
function CryptoCell({
  label,
  text,
  color,
  blinkKey,
  value,
  pct,
}: {
  label: string;
  text: string;
  color: string;
  blinkKey: string;
  value: number;
  pct: number;
}) {
  const { state: blinkState, strength: blinkStrength } = useGrowthBlink(
    blinkKey,
    value,
    pct > 0 || pct < 0 ? pct : null,
  );
  return (
    <View style={[styles.cryptoCell, blinkKey ? styles.priceChipHost : null]}>
      <Text style={styles.cryptoCellLabel}>{label}</Text>
      <Text style={[styles.cryptoCellValue, { color }]}>{text}</Text>
      <BlinkOverlay state={blinkState} strength={blinkStrength} borderRadius={10} />
    </View>
  );
}

function PctChip({ pct }: { pct: number }) {
  const up = pct >= 0;
  return (
    <Text style={[styles.cryptoPct, { color: up ? colors.dark.green : colors.dark.red }]}>
      {up ? '▲' : '▼'} {Math.abs(pct).toLocaleString('fa-IR', { maximumFractionDigits: 2 })}٪
    </Text>
  );
}

// ── styles ── (چیپ‌ها/طلاین: کپی از LocalAssetsSection؛ کوین‌ها: جدید)

const styles = createThemedStyles(() =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.dark.surface,
      borderRadius: 16,
      padding: 16,
      marginBottom: 16,
      borderWidth: 1,
      borderColor: colors.dark.accent + '26',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 12,
    },
    title: {
      fontSize: 14,
      fontWeight: '600' as const,
      color: colors.dark.text,
      flex: 1,
      textAlign: 'right',
    },
    refreshBtn: {
      padding: 6,
      borderRadius: 8,
      backgroundColor: colors.dark.accentDim,
    },
    sectionLabel: {
      fontSize: 12,
      fontWeight: '800' as const,
      color: colors.dark.accent,
      marginBottom: 8,
      // v1.6.0 — سرتیتر بخش‌ها به سمت مخالف (چپ) منتقل شد به درخواست کاربر
      textAlign: 'left',
    },
    priceBlock: {
      backgroundColor: colors.dark.card,
      borderRadius: 10,
      padding: 10,
    },
    priceGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
    },
    priceChip: {
      flexBasis: '31%',
      flexGrow: 1,
      backgroundColor: colors.dark.surface,
      borderRadius: 8,
      paddingVertical: 8,
      paddingHorizontal: 6,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.dark.border,
    },
    priceChipOpen: {
      borderColor: colors.dark.green + '66',
      backgroundColor: colors.dark.greenDim,
    },
    priceChipClosed: {
      borderColor: colors.dark.red + '66',
      backgroundColor: colors.dark.redDim,
    },
    priceChipLabel: {
      fontSize: 10,
      color: colors.dark.textSecondary,
      textAlign: 'center',
    },
    priceChipValue: {
      fontSize: 14.5,
      fontWeight: '800' as const,
      color: colors.dark.text,
      marginTop: 2,
    },
    priceChipHost: {
      position: 'relative',
    },
    priceChipEmpty: {
      color: colors.dark.textSecondary,
      fontWeight: '400' as const,
    },
    priceChipValueOpen: {
      color: colors.dark.green,
    },
    priceChipValueClosed: {
      color: colors.dark.red,
    },
    marketStatusRow: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: 6,
      marginTop: 8,
      flexWrap: 'wrap',
    },
    marketStatusDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    marketStatusText: {
      fontSize: 11,
      fontWeight: '700' as const,
    },
    marketStatusHint: {
      fontSize: 10,
      color: colors.dark.textMuted,
    },
    priceNote: {
      fontSize: 9,
      color: colors.dark.textSecondary,
      marginTop: 6,
      textAlign: 'left',
    },
    talineCard: {
      marginTop: 10,
      backgroundColor: colors.dark.surface,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.dark.border,
      padding: 10,
    },
    talineHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 8,
    },
    talineBadge: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: colors.dark.accent + '26',
      borderWidth: 1,
      borderColor: colors.dark.accent + '66',
      alignItems: 'center',
      justifyContent: 'center',
    },
    talineBadgeText: {
      fontSize: 12,
      fontWeight: '800' as const,
      color: colors.dark.accent,
    },
    talineTitle: {
      flex: 1,
      fontSize: 11.5,
      fontWeight: '700' as const,
      color: colors.dark.textSecondary,
      textAlign: 'right',
    },
    talineRow: {
      flexDirection: 'row',
      gap: 8,
    },
    talineBox: {
      flex: 1,
      borderRadius: 10,
      borderWidth: 1,
      alignItems: 'center',
      paddingVertical: 10,
      paddingHorizontal: 6,
    },
    talineBoxBuy: {
      borderColor: colors.dark.green + '73',
      backgroundColor: colors.dark.green + '1A',
    },
    talineBoxSell: {
      borderColor: colors.dark.red + '73',
      backgroundColor: colors.dark.red + '1A',
    },
    talineBoxLabel: {
      fontSize: 10.5,
      color: colors.dark.textSecondary,
      textAlign: 'center',
    },
    talineBoxValue: {
      fontSize: 15.5,
      fontWeight: '800' as const,
      marginTop: 3,
    },
    talineBoxUnit: {
      fontSize: 9.5,
      color: colors.dark.textSecondary,
      marginTop: 2,
    },
    talineNote: {
      fontSize: 9,
      color: colors.dark.textMuted,
      marginTop: 8,
      textAlign: 'center',
    },
    /* v1.5.0 — کادرهای بیت‌کوین/اتریوم */
    cryptoWrap: {
      backgroundColor: colors.dark.card,
      borderRadius: 10,
      padding: 10,
      gap: 8,
    },
    cryptoBox: {
      backgroundColor: colors.dark.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.dark.border,
      padding: 10,
    },
    cryptoBoxLoading: {
      fontSize: 11.5,
      color: colors.dark.textSecondary,
      textAlign: 'center',
      paddingVertical: 8,
    },
    cryptoHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 8,
    },
    // v1.5.1 — آیکون محلی باندل‌شده (بدون سرور)
    cryptoBadgeImg: {
      width: 34,
      height: 34,
      borderRadius: 17,
    },
    cryptoNames: {
      flex: 1,
    },
    cryptoName: {
      fontSize: 13.5,
      fontWeight: '800' as const,
      color: colors.dark.text,
      textAlign: 'right',
    },
    cryptoSub: {
      fontSize: 10,
      color: colors.dark.textSecondary,
      textAlign: 'right',
      marginTop: 1,
    },
    cryptoPct: {
      fontSize: 12,
      fontWeight: '800' as const,
    },
    cryptoPricesRow: {
      flexDirection: 'row',
      gap: 8,
    },
    cryptoCell: {
      flex: 1,
      backgroundColor: colors.dark.card,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.dark.border,
      alignItems: 'center',
      paddingVertical: 8,
      paddingHorizontal: 6,
    },
    cryptoCellLabel: {
      fontSize: 10,
      color: colors.dark.textSecondary,
    },
    cryptoCellValue: {
      fontSize: 14,
      fontWeight: '800' as const,
      marginTop: 3,
    },
  })
);
