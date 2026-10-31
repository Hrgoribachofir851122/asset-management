import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Landmark,
  Banknote,
  DollarSign,
  Gem,
  Medal,
  Coins,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Lock,
} from 'lucide-react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import colors from '@/constants/colors';
import { createThemedStyles } from '@/utils/themeStyles';
import {
  fetchIranMarketPrices,
  parseTomanInput,
  formatFullToman,
  IranMarketPrices,
  clearIranMarketMemoryCache,
} from '@/utils/iranMarketApi';
import { formatToman } from '@/utils/nobitexApi';
import {
  isGlobalGoldMarketOpen,
  globalGoldMarketLabel,
} from '@/utils/globalMarketHours';
import {
  fetchTgjuCloses,
  closeAtOrBefore,
  latestClose,
  TgjuHistorySymbol,
  TgjuClosePoint,
} from '@/utils/tgjuHistoryApi';
import { fetchTalineGold, clearTalineGoldMemoryCache } from '@/utils/talineApi';

/**
 * LocalAssetsSection — v1.4.16
 *
 * «دارایی ریالی و فلزات» tab of the wallet:
 *  - Live Iranian prices (Toman): gold 18/24 per gram, silver 999/925 per
 *    gram, Emami/Bahar/half/quarter coins, the free-market USD rate and the
 *    tether price (passed in from the portfolio card — same source).
 *  - v1.4.16 NEW ORDER (user-requested): قیمت‌های لحظه‌ای → مجموع کل →
 *    کارت سود/زیان → «دارایی‌های من» (collapsible with its own arrow).
 *    The grand total is ALWAYS visible at the top (right under the prices)
 *    and now includes the read-only blockchain wallets (4th tab) — as does
 *    the PnL card (dedicated «کیف پول بلاکچین» row).
 *  - User inputs: Rial cash, paper-USD cash (v1.4.15), gold grams (+karat),
 *    silver grams (+type), coin counts — persisted in AsyncStorage.
 *  - EVERY asset row shows its own Toman value next to it.
 *  - Grand total = Rial + USD cash + gold + silver + coins + crypto (crypto
 *    USD value comes from the wallet's first header, converted at the live
 *    tether rate) + blockchain wallets (toman, v1.4.16).
 *  - v1.4.14 — PnL card with ۷/۳۰/۹۰/۱۸۰-day timeframes: the daily-close
 *    history of every HELD asset is fetched from TGJU's public history API
 *    and compared against the live price (realized market PnL of the metal
 *    holdings — independent of when the user actually bought them).
 */

const ASSETS_KEY = '@local_assets_v1';

interface LocalAssets {
  rialCash: string;
  /** v1.4.15 — paper (physical) USD the user holds, in dollars. */
  usdCash: string;
  /** v1.5.0 — manual tether balance (like paper dollar): counted SEPARATELY
   *  from exchange/blockchain USDT — for tether the user holds outside the
   *  connected wallets (P2P / cash / other). */
  usdtQty: string;
  goldGrams: string;
  goldKarat: '18' | '24';
  silverGrams: string;
  silverType: '999' | '925';
  coinEmami: string;
  coinBahar: string;
  coinNim: string;
  coinRob: string;
}

const EMPTY_ASSETS: LocalAssets = {
  rialCash: '',
  usdCash: '',
  usdtQty: '',
  goldGrams: '',
  goldKarat: '18',
  silverGrams: '',
  silverType: '999',
  coinEmami: '',
  coinBahar: '',
  coinNim: '',
  coinRob: '',
};

async function loadAssets(): Promise<LocalAssets> {
  try {
    const stored = await AsyncStorage.getItem(ASSETS_KEY);
    if (stored) return { ...EMPTY_ASSETS, ...(JSON.parse(stored) as Partial<LocalAssets>) };
  } catch {}
  return EMPTY_ASSETS;
}

async function saveAssets(a: LocalAssets): Promise<void> {
  try {
    await AsyncStorage.setItem(ASSETS_KEY, JSON.stringify(a));
  } catch {}
}

interface Props {
  /** Live USDT/Toman rate from the portfolio card's tether row. */
  usdtToToman: number;
  /** Dollar value of ALL crypto assets — read from the wallet's first header. */
  totalPortfolioUsd: number;
  /** v1.4.16 — TOMAN value of the read-only blockchain wallets (4th tab). */
  blockchainToman?: number;
  /** v1.4.16 — any read-only blockchain wallet connected? */
  hasBlockchainWallet?: boolean;
  /** v1.4.16 — per-period TOMAN PnL (+basis) of the blockchain holdings. */
  blockchainPnlTomanByPeriod?: Record<number, { pnlToman: number; basisToman: number } | null>;
  /** v1.5.7 — R1: مجموع دلاری کیف‌پول‌های بلاکچین (برای ردیف «دارایی‌های من»). */
  blockchainTotalUsd?: number;
}

const EXPANDED_KEY = '@local_assets_expanded_v1';

export default function LocalAssetsSection({
  usdtToToman,
  totalPortfolioUsd,
  blockchainToman = 0,
  hasBlockchainWallet = false,
  blockchainPnlTomanByPeriod,
  blockchainTotalUsd = 0,
}: Props) {
  const [assets, setAssets] = useState<LocalAssets>(EMPTY_ASSETS);
  // v1.4.16 — «دارایی‌های من» collapsible with its own arrow; persisted.
  const [expanded, setExpanded] = useState(true);
  // v1.1.0 — باز/بسته بودن بازار جهانی طلا (برای رنگ انس/دلار/طلای ۱۸)؛
  // هر ۶۰ ثانیه دوباره ارزیابی می‌شود تا گذر از مرز باز/بسته دیده شود.
  const [goldMarketTick, setGoldMarketTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setGoldMarketTick((t) => t + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  const goldMarketOpen = useMemo(() => isGlobalGoldMarketOpen(), [goldMarketTick]);
  const goldMarketText = useMemo(() => globalGoldMarketLabel(), [goldMarketTick]);
  const queryClient = useQueryClient();

  useEffect(() => {
    let mounted = true;
    loadAssets().then((a) => {
      if (mounted) setAssets(a);
    });
    AsyncStorage.getItem(EXPANDED_KEY).then((v) => {
      if (mounted && v === '0') setExpanded(false);
    }).catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  const toggleExpanded = useCallback(() => {
    setExpanded((v) => {
      const next = !v;
      AsyncStorage.setItem(EXPANDED_KEY, next ? '1' : '0').catch(() => {});
      return next;
    });
  }, []);

  const pricesQuery = useQuery({
    queryKey: ['iran-market-prices'],
    queryFn: fetchIranMarketPrices,
    refetchInterval: 5 * 60 * 1000, // same cadence as the tether price row
    staleTime: 60 * 1000,
  });
  const p = pricesQuery.data;

  // v1.3.7 — «قیمت خرید و فروش هر گرم طلای آب‌شده از طلاین» — نرخ لحظه‌ایِ
  // taline.ir بدون نیاز به سرور: ۵ لایهٔ موازی (کانال رسمی طلاین مستقیم +
  // سه آینهٔ عمومی + سرور/سایت) و کش stale — مثل بقیهٔ قیمت‌های لحظه‌ای.
  // با همان ریتم ۵ دقیقه‌ای قیمت‌ها خودکار تازه می‌شود.
  const talineQuery = useQuery({
    queryKey: ['taline-gold'],
    queryFn: fetchTalineGold,
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60 * 1000,
  });
  const taline = talineQuery.data;

  const update = useCallback((patch: Partial<LocalAssets>) => {
    setAssets((prev) => {
      const next = { ...prev, ...patch };
      void saveAssets(next);
      return next;
    });
  }, []);

  const refresh = useCallback(() => {
    // v1.2.0 — «رفرش یک‌بار کار می‌کند دفعهٔ دوم نه»: اول کشِ ۶۰ ثانیه‌ای حافظه
    // خالی می‌شود تا invalidate واقعاً یک درخواست تازه بزند، نه برگرداندن همان کش.
    clearIranMarketMemoryCache();
    clearTalineGoldMemoryCache();
    queryClient.invalidateQueries({ queryKey: ['iran-market-prices'] });
    queryClient.invalidateQueries({ queryKey: ['taline-gold'] });
  }, [queryClient]);

  // ── computed Toman values (each asset separately) ──
  const rialValue = parseTomanInput(assets.rialCash) || 0;
  // v1.4.15 — paper-USD: value at the FREE-MARKET dollar rate (TGJU
  // «price_dollar_rl»); falls back to the tether rate when that quote is
  // missing (some VPN exits / stale caches only ship the metal symbols).
  const usdRate = p && p.dollar > 0 ? p.dollar : usdtToToman;
  const usdQty = parseTomanInput(assets.usdCash) || 0;
  const usdValue = usdQty > 0 && usdRate > 0 ? usdQty * usdRate : 0;
  const goldUnit = assets.goldKarat === '24' ? p?.gold24 ?? 0 : p?.gold18 ?? 0;
  const goldValue = (parseTomanInput(assets.goldGrams) || 0) * goldUnit;
  const silverUnit = assets.silverType === '925' ? p?.silver925 ?? 0 : p?.silver999 ?? 0;
  const silverValue = (parseTomanInput(assets.silverGrams) || 0) * silverUnit;
  const coinValues = {
    emami: (parseTomanInput(assets.coinEmami) || 0) * (p?.coinEmami ?? 0),
    bahar: (parseTomanInput(assets.coinBahar) || 0) * (p?.coinBahar ?? 0),
    nim: (parseTomanInput(assets.coinNim) || 0) * (p?.coinNim ?? 0),
    rob: (parseTomanInput(assets.coinRob) || 0) * (p?.coinRob ?? 0),
  };
  const coinsValue =
    coinValues.emami + coinValues.bahar + coinValues.nim + coinValues.rob;
  const cryptoToman = usdtToToman > 0 ? totalPortfolioUsd * usdtToToman : 0;
  // v1.5.0 — MANUAL tether (like paper dollar): valued at the live tether rate,
  // separate from exchange/blockchain balances.
  const usdtQtyVal = parseTomanInput(assets.usdtQty) || 0;
  const usdtManualToman = usdtQtyVal > 0 && usdtToToman > 0 ? usdtQtyVal * usdtToToman : 0;
  // v1.4.16 — read-only blockchain wallets count toward the grand total.
  const blockchainValue = hasBlockchainWallet ? blockchainToman : 0;
  // v1.4.17 — summary values for the crypto rows («همان الگوی طلا/دلار کاغذی»)
  const grandTotal =
    rialValue + usdValue + usdtManualToman + goldValue + silverValue + coinsValue + cryptoToman + blockchainValue;
  const hasAnyInput =
    rialValue > 0 ||
    usdValue > 0 ||
    usdtManualToman > 0 ||
    goldValue > 0 ||
    silverValue > 0 ||
    coinsValue > 0 ||
    totalPortfolioUsd > 0 ||
    (hasBlockchainWallet && blockchainToman > 0);

  const minutesOld = p ? Math.max(1, Math.round((Date.now() - p.updatedAt) / 60000)) : 0;
  // v1.3.6 — عمر نرخ طلاین (برای پانویس کارت خرید/فروش)
  const talineMinutes = taline ? Math.max(1, Math.round((Date.now() - taline.updatedAt) / 60000)) : 0;

  return (
    <View style={styles.card}>
      {/* ── header ── */}
      <View style={styles.header}>
        <Landmark size={18} color={colors.dark.accent} />
        <Text style={styles.title}>دارایی ریالی و فلزات</Text>
        <Pressable style={styles.refreshBtn} onPress={refresh}>
          {pricesQuery.isFetching ? (
            <ActivityIndicator size="small" color={colors.dark.accent} />
          ) : (
            <RefreshCw size={14} color={colors.dark.accent} />
          )}
        </Pressable>
        <Pressable style={styles.chevronBtn} onPress={toggleExpanded}>
          {expanded ? (
            <ChevronUp size={14} color={colors.dark.textSecondary} />
          ) : (
            <ChevronDown size={14} color={colors.dark.textSecondary} />
          )}
        </Pressable>
      </View>

      {/* ── live price list ── */}
      <View style={styles.priceBlock}>
        <Text style={styles.blockLabel}>قیمت‌های لحظه‌ای</Text>
        <View style={styles.priceGrid}>
          {/* v1.1.0 — انس: بازار باز → سبز، بازار بسته → قرمز (درخواست کاربر) */}
          <PriceChip
            label="انس جهانی طلا ($)"
            value={p?.goldOunceUsd}
            usd
            tone={goldMarketOpen ? 'open' : 'closed'}
          />
          {/* با بازارِ باز این کادرها با رنگ متمایز (سبز) بهتر دیده می‌شوند */}
          <PriceChip label="طلای ۱۸ عیار (گرم)" value={p?.gold18} tone="open" />
          <PriceChip label="طلای ۲۴ عیار (گرم)" value={p?.gold24} />
          <PriceChip label="نقره ۹۹۹ (گرم)" value={p?.silver999} />
          <PriceChip label="نقره ۹۲۵ (گرم)" value={p?.silver925} />
          <PriceChip label="سکه امامی" value={p?.coinEmami} />
          <PriceChip label="سکه بهار آزادی" value={p?.coinBahar} />
          <PriceChip label="نیم سکه" value={p?.coinNim} />
          <PriceChip label="ربع سکه" value={p?.coinRob} />
          <PriceChip label="دلار آزاد" value={p?.dollar} tone="open" />
          <PriceChip
            label="تتر"
            value={usdtToToman > 0 ? usdtToToman : undefined}
          />
        </View>
        {/* v1.1.0 — وضعیت بازار جهانی طلا، کنار همین قیمت‌ها */}
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
        {p && (
          <Text style={styles.priceNote}>منبع: TGJU • {minutesOld} دقیقه پیش</Text>
        )}
        {!p && !pricesQuery.isFetching && (
          <Text style={styles.priceNote}>قیمت‌ها در دسترس نیست — بعداً تازه‌سازی کنید</Text>
        )}

        {/* v1.3.6 — خرید/فروش هر گرم طلای آب‌شده از طلاین (طرح تأییدشده:
            کادر سبز خرید، کادر قرمز فروش، زیر قیمت‌های لحظه‌ای) */}
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

      {/* ── v1.4.16: مجموع کل — بالا، درست زیر قیمت‌های لحظه‌ای (همیشه نمایان) ── */}
      <View style={styles.totalBox}>
        <View style={styles.totalRow}>
          <TrendingUp size={16} color={colors.dark.green} />
          <Text style={styles.totalLabel}>
            مجموع کل دارایی (ریال + دلار + تتر + طلا + نقره + سکه + ارز
            {hasBlockchainWallet ? ' + کیف بلاکچین' : ''})
          </Text>
        </View>
        <Text style={styles.totalAmount}>
          {hasAnyInput ? `${formatToman(grandTotal)} تومان` : '—'}
        </Text>
        {hasAnyInput && grandTotal >= 1000 && (
          <Text style={styles.totalExact}>{formatFullToman(Math.round(grandTotal))} تومان</Text>
        )}
        <View style={styles.totalBreakdown}>
          <Text style={styles.breakdownText}>
            ریال {formatToman(rialValue)} • دلار {formatToman(usdValue)} • تتر{' '}
            {formatToman(usdtManualToman)} • طلا {formatToman(goldValue)} • نقره{' '}
            {formatToman(silverValue)} • سکه {formatToman(coinsValue)} • ارز {formatToman(cryptoToman)}
            {hasBlockchainWallet ? ` • کیف بلاکچین ${formatToman(blockchainValue)}` : ''}
          </Text>
        </View>
      </View>

      {/* ── v1.4.14: کارت سود/زیان (زیر مجموع کل) ── */}
      <View style={{ height: 12 }} />
      <LocalAssetsPnl
        assets={assets}
        prices={p ?? undefined}
        usdtToToman={usdtToToman}
        blockchainPnlTomanByPeriod={blockchainPnlTomanByPeriod}
        hasBlockchainWallet={hasBlockchainWallet}
      />

      {/* ── v1.4.16: «دارایی‌های من» — با فلش باز/بسته می‌شود ── */}
      <Pressable style={styles.myAssetsHeader} onPress={toggleExpanded}>
        <Text style={styles.blockLabel}>دارایی‌های من</Text>
        <View style={styles.chevronBtn}>
          {expanded ? (
            <ChevronUp size={14} color={colors.dark.textSecondary} />
          ) : (
            <ChevronDown size={14} color={colors.dark.textSecondary} />
          )}
        </View>
      </Pressable>

      {expanded && (
        <>
          <View style={styles.divider} />

          <AssetRow
            icon={<Banknote size={14} color={colors.dark.green} />}
            label="ریال / تومان نقدی"
            value={assets.rialCash}
            onChangeText={(t) => update({ rialCash: t })}
            placeholder="مثلاً 50000000"
            keyboardType="number-pad"
            unitLabel="تومان"
            tomanValue={rialValue}
            valueHint="مقدار را به تومان وارد کنید"
          />

          {/* ── v1.4.15 — paper (physical) dollar row ── */}
          <AssetRow
            icon={<DollarSign size={14} color={'#4CAF50'} />}
            label="دلار کاغذی (فیزیکی)"
            value={assets.usdCash}
            onChangeText={(t) => update({ usdCash: t })}
            placeholder="مثلاً 500"
            keyboardType="decimal-pad"
            unitLabel="دلار"
            tomanValue={usdValue}
            valueHint={
              usdRate > 0
                ? `نرخ هر دلار: ${formatFullToman(usdRate)} تومان${
                    p && p.dollar > 0 ? '' : ' (تتر)'
                  }`
                : 'نرخ دلار در حال دریافت'
            }
          />

          {/* ── v1.5.0 — MANUAL tether row (like paper dollar): «بجای تتر که از
              قسمت‌های دیگه نشون میده، موجودی تتر دستی وارد کنم مثل دلار کاغذی».
              The old auto «تتر کل» row (exchange + blockchain USDT) removed. ── */}
          <AssetRow
            icon={<Coins size={14} color={'#26A17B'} />}
            label="تتر (USDT)"
            value={assets.usdtQty}
            onChangeText={(t) => update({ usdtQty: t })}
            placeholder="مثلاً 1000"
            keyboardType="decimal-pad"
            unitLabel="تتر"
            tomanValue={usdtManualToman}
            valueHint={
              usdtToToman > 0
                ? `قیمت هر تتر: ${formatFullToman(usdtToToman)} تومان — جدا از تتر صرافی/کیف بلاکچین`
                : 'قیمت تتر در حال دریافت'
            }
          />

          <AssetRow
            icon={<Gem size={14} color="#FFD54F" />}
            label="طلا (گرم)"
            value={assets.goldGrams}
            onChangeText={(t) => update({ goldGrams: t })}
            placeholder="مثلاً 12.5"
            keyboardType="decimal-pad"
            unitLabel="گرم"
            tomanValue={goldValue}
            valueHint={
              goldUnit > 0 ? `قیمت هر گرم: ${formatFullToman(goldUnit)}` : 'قیمت در حال دریافت'
            }
          >
            <Selector
              options={[
                { key: '18', label: 'عیار ۱۸' },
                { key: '24', label: 'عیار ۲۴' },
              ]}
              active={assets.goldKarat}
              onSelect={(k) => update({ goldKarat: k as '18' | '24' })}
            />
          </AssetRow>

          <AssetRow
            icon={<Medal size={14} color="#B0BEC5" />}
            label="نقره (گرم)"
            value={assets.silverGrams}
            onChangeText={(t) => update({ silverGrams: t })}
            placeholder="مثلاً 100"
            keyboardType="decimal-pad"
            unitLabel="گرم"
            tomanValue={silverValue}
            valueHint={
              silverUnit > 0
                ? `قیمت هر گرم: ${formatFullToman(silverUnit)}`
                : 'قیمت در حال دریافت'
            }
          >
            <Selector
              options={[
                { key: '999', label: 'عیار ۹۹۹' },
                { key: '925', label: 'عیار ۹۲۵' },
              ]}
              active={assets.silverType}
              onSelect={(k) => update({ silverType: k as '999' | '925' })}
            />
          </AssetRow>

          <AssetRow
            icon={<Coins size={14} color={'#FFC107'} />}
            label="سکه امامی (تعداد)"
            value={assets.coinEmami}
            onChangeText={(t) => update({ coinEmami: t })}
            placeholder="مثلاً 2"
            keyboardType="number-pad"
            unitLabel="عدد"
            tomanValue={coinValues.emami}
            valueHint={
              p?.coinEmami ? `قیمت هر عدد: ${formatFullToman(p.coinEmami)}` : 'قیمت در حال دریافت'
            }
          />

          <AssetRow
            icon={<Coins size={14} color={'#FFC107'} />}
            label="سکه بهار آزادی (تعداد)"
            value={assets.coinBahar}
            onChangeText={(t) => update({ coinBahar: t })}
            placeholder="مثلاً 1"
            keyboardType="number-pad"
            unitLabel="عدد"
            tomanValue={coinValues.bahar}
            valueHint={
              p?.coinBahar ? `قیمت هر عدد: ${formatFullToman(p.coinBahar)}` : 'قیمت در حال دریافت'
            }
          />

          <AssetRow
            icon={<Coins size={14} color={'#FFC107'} />}
            label="نیم سکه (تعداد)"
            value={assets.coinNim}
            onChangeText={(t) => update({ coinNim: t })}
            placeholder="مثلاً 3"
            keyboardType="number-pad"
            unitLabel="عدد"
            tomanValue={coinValues.nim}
            valueHint={p?.coinNim ? `قیمت هر عدد: ${formatFullToman(p.coinNim)}` : 'قیمت در حال دریافت'}
          />

          <AssetRow
            icon={<Coins size={14} color={'#FFC107'} />}
            label="ربع سکه (تعداد)"
            value={assets.coinRob}
            onChangeText={(t) => update({ coinRob: t })}
            placeholder="مثلاً 5"
            keyboardType="number-pad"
            unitLabel="عدد"
            tomanValue={coinValues.rob}
            valueHint={p?.coinRob ? `قیمت هر عدد: ${formatFullToman(p.coinRob)}` : 'قیمت در حال دریافت'}
          />

          {/* ── v1.5.8 — R1: «ردیف کیف بلاکچین فقط موجودی دلاری و ریالیش را
              نشان بدهد مانند بقیه گزینه‌ها + ردیف ارز دیجیتال جدا» —
              ردیف‌های فقط‌خواندنی دیگر باز/بسته نمی‌شوند؛ هر دو مثل بقیه
              ردیف‌ها فقط موجودی دلاری و ریالی (تومان) را نشان می‌دهند. ── */}
          {hasBlockchainWallet && (
            <View style={styles.roRow}>
              <View style={styles.roTexts}>
                <Text style={styles.roLabel}>
                  <Lock size={10} color={colors.dark.accent} /> کیف پول بلاکچین (فقط خواندنی)
                </Text>
                <Text style={styles.roSub}>
                  {blockchainTotalUsd > 0
                    ? `≈ $${blockchainTotalUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })} — موجودی ریالی لحظه‌ای`
                    : 'در حال دریافت موجودی…'}
                </Text>
              </View>
              <Text style={[styles.roValue, !(blockchainValue > 0) && styles.roValueEmpty]}>
                {blockchainValue > 0 ? `${formatFullToman(Math.round(blockchainValue))} ت` : '—'}
              </Text>
            </View>
          )}

          {/* ── v1.5.8 — R1: ردیف «ارز دیجیتال» — دارایی بخش ارز دیجیتال
              (صرافی‌های متصل، تب اول مدیریت دارایی) مثل بقیه ردیف‌ها فقط
              موجودی دلاری و ریالیش را نشان می‌دهد. ── */}
          {totalPortfolioUsd > 0 && (
            <View style={styles.roRow}>
              <View style={styles.roTexts}>
                <Text style={styles.roLabel}>
                  <Coins size={10} color={'#F0B90B'} /> ارز دیجیتال (صرافی‌ها)
                </Text>
                <Text style={styles.roSub}>
                  ≈ ${totalPortfolioUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })} — موجودی ریالی لحظه‌ای
                </Text>
              </View>
              <Text style={[styles.roValue, !(cryptoToman > 0) && styles.roValueEmpty]}>
                {cryptoToman > 0 ? `${formatFullToman(Math.round(cryptoToman))} ت` : '—'}
              </Text>
            </View>
          )}
        </>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// v1.4.14 — PnL card: market change of every HELD asset over the window
// (v1.4.15 — moved to the top of the section + paper-USD row included)
// ---------------------------------------------------------------------------

// v1.2.0 — «تایم‌فریم امروز هم اضافه کن و پیش‌فرض روی امروز باشه»:
// امروز (۱) = تغییر قیمت از پایان روز گذشته (کلوزِ at-or-before نیمه‌شب محلی)
// تا الان. بقیه همان بازه‌های N روزه قبلی.
const PNL_PERIODS = [1, 7, 30, 90, 180] as const;
type LocalPnlPeriod = (typeof PNL_PERIODS)[number];
const PNL_PERIOD_LABEL: Record<LocalPnlPeriod, string> = {
  1: 'امروز',
  7: '۷ روز',
  30: '۳۰ روز',
  90: '۹۰ روز',
  180: '۱۸۰ روز',
};

/** شروع بازه PnL: «امروز» = ابتدای روز محلی (۰۰:۰۰)؛ بقیه N روز به عقب. */
function localPnlTarget(period: LocalPnlPeriod): number {
  if (period === 1) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return Date.now() - period * 86_400_000;
}

interface HeldAssetSpec {
  key: string;
  label: string;
  qty: number;
  symbol: string;
  liveUnit: number;
}

function LocalAssetsPnl({
  assets,
  prices,
  usdtToToman,
  blockchainPnlTomanByPeriod,
  hasBlockchainWallet,
}: {
  assets: LocalAssets;
  prices?: IranMarketPrices;
  /** v1.5.0 — live tether rate for the manual tether row. */
  usdtToToman: number;
  /** v1.4.16 — per-period TOMAN PnL of the read-only blockchain wallets. */
  blockchainPnlTomanByPeriod?: Record<
    number,
    { pnlToman: number; basisToman: number } | null
  >;
  hasBlockchainWallet?: boolean;
}) {
  const [period, setPeriod] = useState<LocalPnlPeriod>(1);

  const goldQty = parseTomanInput(assets.goldGrams) || 0;
  const silverQty = parseTomanInput(assets.silverGrams) || 0;
  const usdQty = parseTomanInput(assets.usdCash) || 0;
  const usdtQty = parseTomanInput(assets.usdtQty) || 0;

  const held: HeldAssetSpec[] = useMemo(() => {
    const list: HeldAssetSpec[] = [];
    // v1.4.15 — paper dollars: their TOMAN value changes with the USD rate,
    // so the free-market dollar series (price_dollar_rl) is a held asset too.
    if (usdQty > 0) {
      list.push({
        key: 'usd',
        label: 'دلار کاغذی',
        qty: usdQty,
        symbol: TgjuHistorySymbol.dollar,
        liveUnit: prices?.dollar ?? 0,
      });
    }
    // v1.5.0 — manual tether: valued at the live TETHER rate; TGJU has no
    // tether history, so the free-market dollar series is the FX basis
    // (same approximation the blockchain toman PnL uses).
    if (usdtQty > 0) {
      list.push({
        key: 'usdt',
        label: 'تتر (دستی)',
        qty: usdtQty,
        symbol: TgjuHistorySymbol.dollar,
        liveUnit: usdtToToman,
      });
    }
    if (goldQty > 0) {
      const is24 = assets.goldKarat === '24';
      list.push({
        key: 'gold',
        label: is24 ? 'طلای ۲۴ عیار' : 'طلای ۱۸ عیار',
        qty: goldQty,
        symbol: is24 ? TgjuHistorySymbol.gold24 : TgjuHistorySymbol.gold18,
        liveUnit: (is24 ? prices?.gold24 : prices?.gold18) ?? 0,
      });
    }
    if (silverQty > 0) {
      const is925 = assets.silverType === '925';
      list.push({
        key: 'silver',
        label: is925 ? 'نقره ۹۲۵' : 'نقره ۹۹۹',
        qty: silverQty,
        symbol: is925 ? TgjuHistorySymbol.silver925 : TgjuHistorySymbol.silver999,
        liveUnit: (is925 ? prices?.silver925 : prices?.silver999) ?? 0,
      });
    }
    const coins: Array<[string, string, string, number]> = [
      ['emami', 'سکه امامی', 'sekee', parseTomanInput(assets.coinEmami) || 0],
      ['bahar', 'سکه بهار آزادی', 'sekeb', parseTomanInput(assets.coinBahar) || 0],
      ['nim', 'نیم سکه', 'nim', parseTomanInput(assets.coinNim) || 0],
      ['rob', 'ربع سکه', 'rob', parseTomanInput(assets.coinRob) || 0],
    ];
    const coinLive: Record<string, number> = {
      emami: prices?.coinEmami ?? 0,
      bahar: prices?.coinBahar ?? 0,
      nim: prices?.coinNim ?? 0,
      rob: prices?.coinRob ?? 0,
    };
    for (const [key, label, symbol, qty] of coins) {
      if (qty > 0) list.push({ key, label, qty, symbol, liveUnit: coinLive[key] ?? 0 });
    }
    return list;
  }, [goldQty, silverQty, usdQty, usdtQty, usdtToToman, assets, prices]);

  const symbols = useMemo(() => [...new Set(held.map((h) => h.symbol))], [held]);

  // One query for every needed symbol's daily-close series (10-min cache).
  const historyQuery = useQuery({
    queryKey: ['tgju-history', symbols],
    queryFn: async (): Promise<Record<string, TgjuClosePoint[]>> => {
      const entries = await Promise.all(
        symbols.map(async (s) => [s, await fetchTgjuCloses(s)] as const)
      );
      return Object.fromEntries(entries);
    },
    enabled: symbols.length > 0,
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });

  const seriesMap = historyQuery.data;

  const rows = useMemo(() => {
    if (!seriesMap) return [] as Array<{ label: string; pnl: number; basis: number }>;
    // v1.2.0 — «امروز» = از ابتدای روز محلی؛ بقیه N روز به عقب
    const target = localPnlTarget(period);
    const out: Array<{ label: string; pnl: number; basis: number }> = [];
    for (const h of held) {
      const series = seriesMap[h.symbol];
      if (!series || series.length === 0) continue;
      const nowUnit = h.liveUnit > 0 ? h.liveUnit : latestClose(series) ?? 0;
      const thenUnit = closeAtOrBefore(series, target);
      if (nowUnit <= 0 || thenUnit === null || thenUnit <= 0) continue;
      out.push({
        label: h.label,
        pnl: h.qty * (nowUnit - thenUnit),
        basis: h.qty * thenUnit,
      });
    }
    return out;
  }, [seriesMap, held, period]);

  const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);
  const totalBasis = rows.reduce((s, r) => s + r.basis, 0);
  // v1.4.16 — the blockchain wallet row joins the card's total (USD price
  // change × FX change, basis = usdThen × dollar-then).
  const bcEntry = blockchainPnlTomanByPeriod?.[period] ?? null;
  const grandPnl = totalPnl + (bcEntry?.pnlToman ?? 0);
  const grandBasis = totalBasis + (bcEntry?.basisToman ?? 0);
  const totalPct = grandBasis > 0 ? (grandPnl / grandBasis) * 100 : 0;

  if (held.length === 0 && !hasBlockchainWallet) return null;

  const positive = grandPnl >= 0;

  return (
    <View style={styles.pnlBox}>
      <View style={styles.pnlHeadRow}>
        {positive ? (
          <TrendingUp size={14} color={colors.dark.green} />
        ) : (
          <TrendingDown size={14} color={colors.dark.red} />
        )}
        <Text style={styles.pnlTitle}>سود / زیان دارایی‌ها (تغییر قیمت بازار)</Text>
      </View>

      {/* period selector */}
      <View style={styles.pnlPeriodRow}>
        {PNL_PERIODS.map((d) => (
          <Pressable
            key={d}
            style={[styles.pnlPeriodChip, period === d && styles.pnlPeriodChipActive]}
            onPress={() => setPeriod(d)}
          >
            <Text style={[styles.pnlPeriodText, period === d && styles.pnlPeriodTextActive]}>
              {PNL_PERIOD_LABEL[d]}
            </Text>
          </Pressable>
        ))}
      </View>

      {historyQuery.isLoading && held.length > 0 ? (
        <View style={styles.pnlLoading}>
          <ActivityIndicator size="small" color={colors.dark.accent} />
          <Text style={styles.pnlLoadingText}>دریافت تاریخچه قیمت‌ها…</Text>
        </View>
      ) : (historyQuery.isError || rows.length === 0) && !bcEntry ? (
        <Text style={styles.pnlEmpty}>
          تاریخچه قیمت برای این بازه در دسترس نیست — بعداً دوباره تلاش کنید
        </Text>
      ) : (
        <>
          <Text style={[styles.pnlTotal, { color: positive ? colors.dark.green : colors.dark.red }]}>
            {positive ? '+' : '−'} {formatFullToman(Math.abs(Math.round(grandPnl)))} تومان
          </Text>
          <View style={styles.pnlPctRow}>
            <View
              style={[
                styles.pnlPctChip,
                !positive && { backgroundColor: colors.dark.red + '1C' },
              ]}
            >
              <Text style={[styles.pnlPctText, !positive && { color: colors.dark.red }]}>
                {positive ? '▲' : '▼'} {Math.abs(totalPct).toLocaleString('fa-IR', {
                  maximumFractionDigits: 1,
                })}٪ در {PNL_PERIOD_LABEL[period]}
              </Text>
            </View>
          </View>

          {rows.map((r) => (
            <View key={r.label} style={styles.pnlRow}>
              <Text style={styles.pnlRowLabel}>{r.label}</Text>
              <Text
                style={[
                  styles.pnlRowValue,
                  { color: r.pnl >= 0 ? colors.dark.green : colors.dark.red },
                ]}
              >
                {r.pnl >= 0 ? '+' : '−'} {formatFullToman(Math.abs(Math.round(r.pnl)))} ت
              </Text>
            </View>
          ))}

          {/* ── v1.4.16 — ردیف کیف پول بلاکچین (فقط خواندنی) ── */}
          {hasBlockchainWallet && (
            <View style={[styles.pnlRow, styles.pnlRowBc]}>
              <Text style={styles.pnlRowLabel}>
                <Lock size={10} color={colors.dark.accent} /> کیف پول بلاکچین
              </Text>
              <Text
                style={[
                  styles.pnlRowValue,
                  {
                    color: !bcEntry
                      ? colors.dark.textSecondary
                      : bcEntry.pnlToman >= 0
                        ? colors.dark.green
                        : colors.dark.red,
                  },
                ]}
              >
                {!bcEntry
                  ? 'در حال محاسبه…'
                  : `${bcEntry.pnlToman >= 0 ? '+' : '−'} ${formatFullToman(
                      Math.abs(Math.round(bcEntry.pnlToman))
                    )} ت`}
              </Text>
            </View>
          )}

          <Text style={styles.pnlNote}>
            {period === 1
              ? 'مبنا: قیمت پایان روزِ گذشته تا همین الان (منبع: TGJU؛ کیف بلاکچین: قیمت بایننس × نرخ تتر). تغییر ارزش بر اساس نوسان بازار است، نه زمان خرید واقعی شما.'
              : `مبنا: قیمت پایان روزِ ${PNL_PERIOD_LABEL[period]} پیش تا امروز (منبع: TGJU؛ کیف بلاکچین: قیمت بایننس × نرخ تتر). تغییر ارزش بر اساس نوسان بازار است، نه زمان خرید واقعی شما.`}
          </Text>
        </>
      )}
    </View>
  );
}

// ── sub-components ──

function PriceChip({
  label,
  value,
  usd,
  tone,
}: {
  label: string;
  value?: number;
  usd?: boolean;
  /** v1.1.0 — 'open' سبز (بازار باز)، 'closed' قرمز (بازار بسته — فقط انس) */
  tone?: 'open' | 'closed';
}) {
  // v1.5.12 — «قیمت انس جهانی طلا» دلاری است؛ بقیه تومانی.
  const text =
    value && value > 0
      ? usd
        ? `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : formatFullToman(value)
      : '…';
  return (
    <View
      style={[
        styles.priceChip,
        tone === 'open' && styles.priceChipOpen,
        tone === 'closed' && styles.priceChipClosed,
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
    </View>
  );
}

interface AssetRowProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder: string;
  keyboardType: 'number-pad' | 'decimal-pad';
  unitLabel: string;
  tomanValue: number;
  valueHint: string;
  children?: React.ReactNode;
}

function AssetRow({
  icon,
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  unitLabel,
  tomanValue,
  valueHint,
  children,
}: AssetRowProps) {
  return (
    <View style={styles.assetRow}>
      {icon}
      <View style={styles.assetMain}>
        <Text style={styles.assetLabel}>{label}</Text>
        <View style={styles.assetInputRow}>
          <TextInput
            style={styles.assetInput}
            value={value}
            onChangeText={onChangeText}
            onEndEditing={(e) => {
              // Normalize what the user typed (commas/Persian digits) once focus leaves.
              const n = parseTomanInput(e.nativeEvent.text);
              onChangeText(Number.isFinite(n) && n > 0 ? String(n) : '');
            }}
            placeholder={placeholder}
            placeholderTextColor={colors.dark.textSecondary}
            keyboardType={keyboardType}
            inputMode={keyboardType === 'decimal-pad' ? 'decimal' : 'numeric'}
            returnKeyType="done"
            maxLength={14}
            textAlign="left"
          />
          <Text style={styles.assetUnit}>{unitLabel}</Text>
        </View>
        <Text style={styles.assetHint}>{valueHint}</Text>
        {children}
      </View>
      <View style={styles.assetValueCol}>
        <Text style={[styles.assetValue, !(tomanValue > 0) && styles.assetValueEmpty]}>
          {tomanValue > 0 ? `${formatFullToman(Math.round(tomanValue))} ت` : '—'}
        </Text>
      </View>
    </View>
  );
}

function Selector({
  options,
  active,
  onSelect,
}: {
  options: { key: string; label: string }[];
  active: string;
  onSelect: (key: string) => void;
}) {
  return (
    <View style={styles.selector}>
      {options.map((o) => (
        <Pressable
          key={o.key}
          style={[styles.selectorChip, active === o.key && styles.selectorChipActive]}
          onPress={() => onSelect(o.key)}
        >
          <Text
            style={[
              styles.selectorChipText,
              active === o.key && styles.selectorChipTextActive,
            ]}
          >
            {o.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

// ── styles ──

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
    chevronBtn: {
      padding: 6,
      borderRadius: 8,
    },
    // v1.4.16 — «دارایی‌های من» header row with its own collapse arrow
    myAssetsHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 12,
    },
    blockLabel: {
      fontSize: 11,
      fontWeight: '600' as const,
      color: colors.dark.textSecondary,
      marginBottom: 8,
      textAlign: 'right',
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
    // v1.1.0 — کادرهای متمایز (بازار باز → سبز / بسته → قرمز)
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
    // v1.5.12 — «فونت متن و اعداد قیمت‌های لحظه‌ای را برای خوانایی بیشتر
    // بزرگتر کن» — ۱۱ → ۱۴.۵ (ضخیم‌تر) + لیبل ۹ → ۱۰.
    priceChipValue: {
      fontSize: 14.5,
      fontWeight: '800' as const,
      color: colors.dark.text,
      marginTop: 2,
    },
    priceChipEmpty: {
      color: colors.dark.textSecondary,
      fontWeight: '400' as const,
    },
    // v1.1.0 — رنگ مقدار: باز → سبز، بسته → قرمز
    priceChipValueOpen: {
      color: colors.dark.green,
    },
    priceChipValueClosed: {
      color: colors.dark.red,
    },
    // v1.1.0 — خط وضعیت بازار جهانی طلا زیر قیمت‌های لحظه‌ای
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
    // v1.3.6 — کارت خرید/فروش هر گرم طلای آب‌شده از طلاین (تأییدشده در پیش‌نمایش)
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
      borderColor: colors.dark.green + '73', // rgba(14,203,129,.45)
      backgroundColor: colors.dark.green + '1A', // rgba(14,203,129,.10)
    },
    talineBoxSell: {
      borderColor: colors.dark.red + '73', // rgba(246,70,93,.45)
      backgroundColor: colors.dark.red + '1A', // rgba(246,70,93,.10)
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
    divider: {
      height: 1,
      backgroundColor: colors.dark.border,
      marginVertical: 12,
    },
    summaryQtyBox: {
      backgroundColor: colors.dark.surfaceLight,
      borderWidth: 1,
      borderColor: colors.dark.accent + '44',
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 9,
      alignItems: 'flex-end',
    },
    summaryQtyText: {
      fontSize: 13,
      fontWeight: '800' as const,
      color: colors.dark.text,
    },
    assetRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 8,
    },
    assetMain: {
      flex: 1,
      gap: 4,
    },
    assetLabel: {
      fontSize: 12,
      fontWeight: '600' as const,
      color: colors.dark.text,
      textAlign: 'right',
    },
    assetInputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    assetInput: {
      flex: 1,
      backgroundColor: colors.dark.card,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.dark.border,
      color: colors.dark.text,
      fontSize: 13,
      fontWeight: '600' as const,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    assetUnit: {
      fontSize: 11,
      color: colors.dark.textSecondary,
      minWidth: 30,
    },
    assetHint: {
      fontSize: 9,
      color: colors.dark.textSecondary,
      textAlign: 'right',
    },
    assetValueCol: {
      minWidth: 92,
      alignItems: 'flex-start',
    },
    assetValue: {
      fontSize: 12,
      fontWeight: '700' as const,
      color: colors.dark.green,
    },
    assetValueEmpty: {
      color: colors.dark.textSecondary,
      fontWeight: '400' as const,
    },
    assetRate: {
      fontSize: 9,
      color: colors.dark.textSecondary,
      marginTop: 2,
    },
    selector: {
      flexDirection: 'row',
      gap: 6,
      marginTop: 2,
    },
    selectorChip: {
      backgroundColor: colors.dark.card,
      borderWidth: 1,
      borderColor: colors.dark.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    selectorChipActive: {
      backgroundColor: colors.dark.accentDim,
      borderColor: colors.dark.accent,
    },
    selectorChipText: {
      fontSize: 10,
      fontWeight: '600' as const,
      color: colors.dark.textSecondary,
    },
    selectorChipTextActive: {
      color: colors.dark.accent,
      fontWeight: '700' as const,
    },
    totalBox: {
      marginTop: 10,
      backgroundColor: colors.dark.card,
      borderRadius: 12,
      padding: 14,
      borderWidth: 1,
      borderColor: colors.dark.green + '33',
    },
    totalRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginBottom: 6,
    },
    totalLabel: {
      fontSize: 11,
      fontWeight: '600' as const,
      color: colors.dark.textSecondary,
      flex: 1,
      textAlign: 'right',
    },
    totalAmount: {
      fontSize: 22,
      fontWeight: '800' as const,
      color: colors.dark.green,
      textAlign: 'right',
    },
    totalExact: {
      fontSize: 10,
      color: colors.dark.textSecondary,
      textAlign: 'right',
      marginTop: 2,
    },
    totalBreakdown: {
      marginTop: 8,
      paddingTop: 8,
      borderTopWidth: 1,
      borderTopColor: colors.dark.border,
    },
    breakdownText: {
      fontSize: 9,
      color: colors.dark.textSecondary,
      textAlign: 'right',
      lineHeight: 16,
    },
    // v1.4.14 — PnL card styles
    pnlBox: {
      marginTop: 10,
      backgroundColor: colors.dark.card,
      borderRadius: 12,
      padding: 14,
      borderWidth: 1,
      borderColor: colors.dark.border,
    },
    pnlHeadRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginBottom: 8,
    },
    pnlTitle: {
      fontSize: 12,
      fontWeight: '700' as const,
      color: colors.dark.text,
      flex: 1,
      textAlign: 'right',
    },
    pnlPeriodRow: {
      flexDirection: 'row',
      gap: 6,
      marginBottom: 10,
    },
    pnlPeriodChip: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 5,
      borderRadius: 8,
      backgroundColor: colors.dark.surface,
      borderWidth: 1,
      borderColor: colors.dark.border,
    },
    pnlPeriodChipActive: {
      backgroundColor: colors.dark.accentDim,
      borderColor: colors.dark.accent,
    },
    pnlPeriodText: {
      fontSize: 10.5,
      fontWeight: '600' as const,
      color: colors.dark.textSecondary,
    },
    pnlPeriodTextActive: {
      color: colors.dark.accent,
      fontWeight: '700' as const,
    },
    pnlLoading: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      justifyContent: 'center',
      paddingVertical: 10,
    },
    pnlLoadingText: {
      fontSize: 11,
      color: colors.dark.textSecondary,
    },
    pnlEmpty: {
      fontSize: 10.5,
      lineHeight: 17,
      color: colors.dark.textSecondary,
      textAlign: 'center',
      paddingVertical: 8,
    },
    pnlTotal: {
      fontSize: 20,
      fontWeight: '800' as const,
      textAlign: 'right',
    },
    pnlPctRow: {
      flexDirection: 'row',
      justifyContent: 'flex-start',
      marginVertical: 6,
    },
    pnlPctChip: {
      backgroundColor: colors.dark.green + '18',
      borderRadius: 9,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    pnlPctText: {
      fontSize: 11,
      fontWeight: '800' as const,
      color: colors.dark.green,
    },
    pnlRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 5,
      borderTopWidth: 1,
      borderTopColor: colors.dark.border + '33',
    },
    // v1.4.16 — highlighted blockchain row inside the PnL card
    pnlRowBc: {
      backgroundColor: colors.dark.accentDim,
      borderRadius: 8,
      paddingHorizontal: 8,
      marginTop: 4,
      paddingVertical: 7,
      borderTopWidth: 0,
    },
    pnlRowLabel: {
      fontSize: 11,
      fontWeight: '600' as const,
      color: colors.dark.textSecondary,
    },
    pnlRowValue: {
      fontSize: 12,
      fontWeight: '700' as const,
    },
    pnlNote: {
      fontSize: 9,
      lineHeight: 15,
      color: colors.dark.textMuted,
      textAlign: 'right',
      marginTop: 8,
    },
    /* v1.5.8 — R1: ردیف‌های فقط‌خواندنی «دارایی‌های من» (کیف بلاکچین +
       ارز دیجیتال) — همان الگوی بقیه ردیف‌ها: فقط موجودی دلاری و ریالی. */
    roRow: {
      backgroundColor: colors.dark.accent + '0A',
      borderWidth: 1,
      borderColor: colors.dark.accent + '2E',
      borderRadius: 10,
      padding: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginTop: 6,
      marginBottom: 2,
    },
    roTexts: {
      flex: 1,
    },
    roLabel: {
      fontSize: 11,
      fontWeight: '800' as const,
      color: colors.dark.text,
    },
    roSub: {
      fontSize: 9.5,
      color: colors.dark.textSecondary,
      marginTop: 3,
      lineHeight: 14,
    },
    roValue: {
      fontSize: 12,
      fontWeight: '700' as const,
      color: colors.dark.text,
    },
    roValueEmpty: {
      color: colors.dark.textMuted,
    },
  })
);

