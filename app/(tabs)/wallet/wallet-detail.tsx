import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Animated,
  Platform,
  ActivityIndicator,
} from 'react-native';
import {
  Wallet,
  TrendingUp,
  TrendingDown,
  ArrowUpRight,
  ArrowDownRight,
  Copy,
  Bell,
  BarChart3,
  Coins,
  Activity,
  Info,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useQuery } from '@tanstack/react-query';
import colors from '@/constants/colors';
import { createThemedStyles } from '@/utils/themeStyles';
import {
  fetchFullWalletData,
  fetchWhalePnl,
  WhalePnl,
  ParsedPosition,
  ParsedSpotBalance,
  ParsedFill,
  getContractAddress,
} from '@/utils/hyperliquidApi';

import { ThemedAlert } from '@/components/ThemedAlert';
type SectionTab = 'positions' | 'spot' | 'activity';

// v1.5.3 — «pnl نهنگ‌ها را وقتی روش میزنم وارد اطلاعاتشون بشم نشون بده، نه
// در همون بخش» — PnL چیپ‌های چندبازه (۷/۳۰/۹۰/۱۸۰ روز + باز) از کارت لیست
// نهنگ‌ها به همین صفحه جزئیات منتقل شد.
function WhalePnlChips({ address }: { address: string }) {
  const q = useQuery({
    queryKey: ['whale-pnl', address],
    queryFn: () => fetchWhalePnl(address),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  if (q.isLoading) {
    return <Text style={whalePnlStyles.loading}>در حال دریافت سود/زیان نهنگ…</Text>;
  }
  if (q.isError || !q.data) {
    return <Text style={whalePnlStyles.err}>سود/زیان این نهنگ موقتاً در دسترس نیست (Hyperliquid)</Text>;
  }
  const d: WhalePnl = q.data;
  const rows: { label: string; v: number; t: number }[] = [
    // v1.5.12 — «تایم‌فریم امروز» به PnL نهنگ‌ها هم اضافه شد.
    { label: 'امروز', v: d.d1.realized, t: d.d1.trades },
    { label: '۷ روزه', v: d.d7.realized, t: d.d7.trades },
    { label: '۳۰ روزه', v: d.d30.realized, t: d.d30.trades },
    { label: '۹۰ روزه', v: d.d90.realized, t: d.d90.trades },
    { label: '۱۸۰ روزه', v: d.d180.realized, t: d.d180.trades },
    { label: 'باز', v: d.unrealized, t: d.openPositions },
  ];
  return (
    <View style={whalePnlStyles.box}>
      {rows.map((r) => (
        <View key={r.label} style={whalePnlStyles.chip}>
          <Text style={whalePnlStyles.chipLabel}>
            {r.label} {r.t > 0 ? `(${r.t.toLocaleString('fa-IR')})` : ''}
          </Text>
          <Text
            style={[whalePnlStyles.chipValue, { color: r.v >= 0 ? colors.dark.green : colors.dark.red }]}
          >
            {r.v >= 0 ? '+' : '−'} ${Math.abs(r.v).toLocaleString('en-US', { maximumFractionDigits: 0 })}
          </Text>
        </View>
      ))}
      <Text style={whalePnlStyles.note}>
        سود/زیان تحقق‌یافته پوزیشن‌های بسته‌شده در هر بازه + «باز» = سود شناور پوزیشن‌های فعلی
        ({d.openPositions.toLocaleString('fa-IR')} پوزیشن) — منبع: Hyperliquid
      </Text>
    </View>
  );
}

const whalePnlStyles = StyleSheet.create({
  box: {
    marginTop: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    alignItems: 'center',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: colors.dark.card,
    borderWidth: 1,
    borderColor: colors.dark.cardBorder,
  },
  chipLabel: {
    fontSize: 8.5,
    color: colors.dark.textMuted,
  },
  chipValue: {
    fontSize: 9.5,
    fontWeight: '700',
  },
  loading: {
    fontSize: 9,
    color: colors.dark.textMuted,
    marginTop: 4,
  },
  err: {
    fontSize: 9,
    color: colors.dark.textMuted,
    marginTop: 4,
  },
  note: {
    fontSize: 8,
    color: colors.dark.textMuted,
    width: '100%',
    marginTop: 2,
    lineHeight: 12,
  },
});

export default function WalletDetailScreen() {
  const router = useRouter();
  const { address, label } = useLocalSearchParams<{ address: string; label: string }>();
  const [activeSection, setActiveSection] = useState<SectionTab>('positions');
  const fadeAnim = useRef(new Animated.Value(0)).current;

  const walletQuery = useQuery({
    queryKey: ['whale-wallet', address],
    queryFn: () => fetchFullWalletData(address ?? ''),
    enabled: !!address && address.length > 10,
    refetchInterval: 30000,
    staleTime: 15000,
  });

  const data = walletQuery.data;
  const positions = data?.positions ?? [];
  const spotBalances = data?.spotBalances ?? [];
  const recentTrades = data?.recentTrades ?? [];
  const accountValue = data?.accountValue ?? 0;
  const totalPnl = data?.totalPnl ?? 0;
  const spotValue = data?.spotValue ?? 0;
  const totalValue = data?.totalValue ?? 0;
  const spotMeta = data?.spotMeta ?? null;

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 400,
      useNativeDriver: true,
    }).start();
  }, []);

  const handleCopyAddress = useCallback(async () => {
    if (address) {
      await Clipboard.setStringAsync(address);
      ThemedAlert.alert('کپی شد', 'آدرس کیف پول با موفقیت کپی شد');
    }
  }, [address]);

  const formatTime = (ts: number) => {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    if (mins < 60) return `${mins} دقیقه پیش`;
    if (hours < 24) return `${hours} ساعت پیش`;
    return `${Math.floor(hours / 24)} روز پیش`;
  };

  const formatNumber = (num: number) => {
    if (num >= 1000000000) return `${(num / 1000000000).toFixed(2)}B`;
    if (num >= 1000000) return `${(num / 1000000).toFixed(2)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(2)}K`;
    return num.toFixed(2);
  };

  const formatPrice = (num: number) => {
    if (num >= 1000) return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (num >= 1) return num.toFixed(4);
    return num.toFixed(6);
  };

  return (
    <Animated.ScrollView
      style={[styles.container, { opacity: fadeAnim }]}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.headerCard}>
        <View style={styles.headerTop}>
          <View style={styles.walletIconBig}>
            <Wallet size={24} color={colors.dark.accent} />
          </View>
          <View style={styles.headerInfo}>
            <Text style={styles.headerLabel}>{label || 'نهنگ'}</Text>
            <Pressable style={styles.addressRow} onPress={handleCopyAddress}>
              <Copy size={12} color={colors.dark.textMuted} />
              <Text style={styles.headerAddress}>
                {address?.slice(0, 12)}...{address?.slice(-8)}
              </Text>
            </Pressable>
          </View>
          <Pressable
            style={[styles.refreshBtn, walletQuery.isFetching && styles.refreshBtnActive]}
            onPress={() => walletQuery.refetch()}
            disabled={walletQuery.isFetching}
          >
            {walletQuery.isFetching ? (
              <ActivityIndicator size="small" color={colors.dark.accent} />
            ) : (
              <RefreshCw size={18} color={colors.dark.accent} />
            )}
          </Pressable>
        </View>

        <View style={styles.apiTag}>
          <View style={styles.apiDot} />
          <Text style={styles.apiTagText}>Hyperliquid API — داده‌های زنده</Text>
        </View>

        <View style={styles.summaryRow}>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryLabel}>ارزش کل</Text>
            <Text style={styles.summaryValue}>
              ${formatNumber(totalValue)}
            </Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}>
            <Text style={styles.summaryLabel}>سود پوزیشن‌ها</Text>
            <Text style={[styles.summaryValue, { color: totalPnl >= 0 ? colors.dark.green : colors.dark.red }]}>
              {totalPnl >= 0 ? '+' : ''}${formatNumber(totalPnl)}
            </Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}>
            <Text style={styles.summaryLabel}>اسپات</Text>
            <Text style={styles.summaryValue}>${formatNumber(spotValue)}</Text>
          </View>
        </View>

        {/* v1.5.3 — PnL چندبازه نهنگ (۷/۳۰/۹۰/۱۸۰ روز + باز) — از لیست به
            صفحه جزئیات منتقل شد؛ لمس کارت نهنگ در لیست به اینجا می‌آید */}
        {address && <WhalePnlChips address={address} />}
      </View>

      {walletQuery.isLoading && (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="large" color={colors.dark.accent} />
          <Text style={styles.loadingText}>در حال دریافت اطلاعات از Hyperliquid...</Text>
        </View>
      )}

      {walletQuery.error && (
        <View style={styles.errorBox}>
          <ShieldAlert size={18} color={colors.dark.red} />
          <Text style={styles.errorText}>خطا در دریافت اطلاعات. دوباره تلاش کنید.</Text>
          <Pressable style={styles.retryBtn} onPress={() => walletQuery.refetch()}>
            <Text style={styles.retryBtnText}>تلاش مجدد</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.memeAlert}>
        <Bell size={14} color={colors.dark.orange} />
        <Text style={styles.memeAlertText}>
          هشدار فعال — تغییرات پوزیشن‌ها و معاملات اطلاع‌رسانی می‌شود
        </Text>
      </View>

      <View style={styles.sectionTabs}>
        <Pressable
          style={[styles.sectionTab, activeSection === 'positions' && styles.sectionTabActive]}
          onPress={() => setActiveSection('positions')}
        >
          <BarChart3 size={14} color={activeSection === 'positions' ? colors.dark.accent : colors.dark.textMuted} />
          <Text style={[styles.sectionTabText, activeSection === 'positions' && styles.sectionTabTextActive]}>
            پوزیشن‌ها ({positions.length})
          </Text>
        </Pressable>
        <Pressable
          style={[styles.sectionTab, activeSection === 'spot' && styles.sectionTabActive]}
          onPress={() => setActiveSection('spot')}
        >
          <Coins size={14} color={activeSection === 'spot' ? colors.dark.accent : colors.dark.textMuted} />
          <Text style={[styles.sectionTabText, activeSection === 'spot' && styles.sectionTabTextActive]}>
            اسپات ({spotBalances.length})
          </Text>
        </Pressable>
        <Pressable
          style={[styles.sectionTab, activeSection === 'activity' && styles.sectionTabActive]}
          onPress={() => setActiveSection('activity')}
        >
          <Activity size={14} color={activeSection === 'activity' ? colors.dark.accent : colors.dark.textMuted} />
          <Text style={[styles.sectionTabText, activeSection === 'activity' && styles.sectionTabTextActive]}>
            معاملات ({recentTrades.length})
          </Text>
        </Pressable>
      </View>

      {activeSection === 'positions' && (
        <View style={styles.section}>
          {positions.length === 0 && !walletQuery.isLoading && (
            <View style={styles.emptySection}>
              <BarChart3 size={32} color={colors.dark.textMuted} />
              <Text style={styles.emptySectionText}>پوزیشن بازی وجود ندارد</Text>
            </View>
          )}
          {positions.map((pos) => (
            <View key={pos.id} style={styles.positionCard}>
              <View style={styles.posHeader}>
                <View style={styles.posLeft}>
                  <Text style={styles.posSymbol}>{pos.symbol}</Text>
                  <View style={[styles.sideBadge, pos.side === 'long' ? styles.sideLong : styles.sideShort]}>
                    <Text
                      style={[styles.sideText, { color: pos.side === 'long' ? colors.dark.green : colors.dark.red }]}
                    >
                      {pos.side === 'long' ? 'LONG' : 'SHORT'} {pos.leverage}x
                    </Text>
                  </View>
                </View>
                <View style={styles.posRight}>
                  <Text
                    style={[styles.posPnl, { color: pos.pnl >= 0 ? colors.dark.green : colors.dark.red }]}
                  >
                    {pos.pnl >= 0 ? '+' : ''}${formatNumber(pos.pnl)}
                  </Text>
                  <Text
                    style={[styles.posPnlPercent, { color: pos.pnl >= 0 ? colors.dark.green : colors.dark.red }]}
                  >
                    ({pos.pnlPercent >= 0 ? '+' : ''}{pos.pnlPercent.toFixed(2)}%)
                  </Text>
                </View>
              </View>
              <View style={styles.posDetails}>
                <View style={styles.posDetail}>
                  <Text style={styles.posDetailLabel}>ورود</Text>
                  <Text style={styles.posDetailValue}>${formatPrice(pos.entryPrice)}</Text>
                </View>
                <View style={styles.posDetail}>
                  <Text style={styles.posDetailLabel}>فعلی</Text>
                  <Text style={styles.posDetailValue}>${formatPrice(pos.currentPrice)}</Text>
                </View>
                <View style={styles.posDetail}>
                  <Text style={styles.posDetailLabel}>اندازه</Text>
                  <Text style={styles.posDetailValue}>{formatNumber(pos.size)}</Text>
                </View>
                <View style={styles.posDetail}>
                  <Text style={styles.posDetailLabel}>ارزش</Text>
                  <Text style={styles.posDetailValue}>${formatNumber(pos.positionValue)}</Text>
                </View>
              </View>
              {pos.liquidationPrice != null && pos.liquidationPrice !== 0 && (
                <View style={styles.liqRow}>
                  <ShieldAlert size={11} color={colors.dark.orange} />
                  <Text style={styles.liqText}>
                    قیمت لیکوئید: ${formatPrice(pos.liquidationPrice)}
                  </Text>
                </View>
              )}
            </View>
          ))}
        </View>
      )}

      {activeSection === 'spot' && (
        <View style={styles.section}>
          {spotBalances.length === 0 && !walletQuery.isLoading && (
            <View style={styles.emptySection}>
              <Coins size={32} color={colors.dark.textMuted} />
              <Text style={styles.emptySectionText}>دارایی اسپاتی وجود ندارد</Text>
            </View>
          )}
          {spotBalances.map((bal) => {
            const commonExchanges = [
              { name: 'Binance', type: 'cex' as const },
              { name: 'OKX', type: 'cex' as const },
              { name: 'Bybit', type: 'cex' as const },
            ];
            const dexExchanges = bal.coin !== 'USDC' && bal.coin !== 'USDT'
              ? [{ name: 'Uniswap', type: 'dex' as const }]
              : [];
            const allExchanges = [...commonExchanges, ...dexExchanges];
            const contractAddr = getContractAddress(spotMeta, bal.coin);
            const stableCoins = ['USDC', 'USDT', 'BUSD', 'DAI', 'FDUSD'];
            const isMemeOrSmall = !stableCoins.includes(bal.coin) && bal.coin !== 'ETH' && bal.coin !== 'BTC' && bal.coin !== 'SOL';

            return (
              <Pressable
                key={bal.coin}
                style={({ pressed }) => [styles.spotRow, pressed && { opacity: 0.7 }]}
                onPress={() => {
                  router.push({
                    pathname: '/whales/token-detail' as any,
                    params: {
                      symbol: bal.coin,
                      name: bal.coin,
                      contractAddress: contractAddr,
                      amount: bal.total.toString(),
                      valueUsd: bal.valueUsd.toString(),
                      priceChange: '0',
                      isMeme: isMemeOrSmall ? '1' : '0',
                      exchanges: JSON.stringify(allExchanges),
                    },
                  });
                }}
              >
                <View style={styles.spotLeft}>
                  <View style={styles.spotBadge}>
                    <Text style={styles.spotBadgeText}>{bal.coin.slice(0, 3)}</Text>
                  </View>
                  <View style={styles.spotInfo}>
                    <Text style={styles.spotCoin}>{bal.coin}</Text>
                    <Text style={styles.spotAmount}>{formatNumber(bal.total)}</Text>
                  </View>
                </View>
                <View style={styles.spotRight}>
                  <Text style={styles.spotValue}>
                    ${bal.valueUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                  </Text>
                  {bal.hold > 0 && (
                    <Text style={styles.spotHold}>قفل: {formatNumber(bal.hold)}</Text>
                  )}
                  <Text style={styles.spotDetailHint}>جزئیات بیشتر ←</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      )}

      {activeSection === 'activity' && (
        <View style={styles.section}>
          {recentTrades.length === 0 && !walletQuery.isLoading && (
            <View style={styles.emptySection}>
              <Activity size={32} color={colors.dark.textMuted} />
              <Text style={styles.emptySectionText}>معامله‌ای یافت نشد</Text>
            </View>
          )}
          {recentTrades.map((trade) => (
            <View key={trade.id} style={styles.tradeCard}>
              <View style={styles.tradeHeader}>
                <View style={[styles.tradeIcon, trade.side === 'buy' ? styles.tradeIconBuy : styles.tradeIconSell]}>
                  {trade.side === 'buy' ? (
                    <ArrowUpRight size={16} color={colors.dark.green} />
                  ) : (
                    <ArrowDownRight size={16} color={colors.dark.red} />
                  )}
                </View>
                <View style={styles.tradeInfo}>
                  <Text style={styles.tradeType}>
                    {trade.side === 'buy' ? 'خرید' : 'فروش'} {trade.coin}
                  </Text>
                  <Text style={styles.tradeTime}>{formatTime(trade.time)}</Text>
                </View>
                <View style={styles.tradeRight}>
                  <Text style={styles.tradeValue}>
                    ${trade.valueUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                  </Text>
                  <Text style={styles.tradeSize}>
                    {formatNumber(trade.size)} @ ${formatPrice(trade.price)}
                  </Text>
                  {trade.pnl !== 0 && (
                    <Text style={[styles.tradePnl, { color: trade.pnl >= 0 ? colors.dark.green : colors.dark.red }]}>
                      PnL: {trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}
                    </Text>
                  )}
                </View>
              </View>
            </View>
          ))}
        </View>
      )}
    </Animated.ScrollView>
  );
}

const styles = createThemedStyles(() => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.dark.background,
  },
  scrollContent: {
    paddingBottom: 30,
  },
  headerCard: {
    backgroundColor: colors.dark.surface,
    marginHorizontal: 16,
    marginTop: 12,
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.dark.border,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  walletIconBig: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: colors.dark.accentDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerInfo: {
    flex: 1,
  },
  headerLabel: {
    fontSize: 18,
    fontWeight: '700' as const,
    color: colors.dark.text,
    textAlign: 'right',
  },
  addressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  headerAddress: {
    fontSize: 11,
    color: colors.dark.textMuted,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  refreshBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.dark.accentDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  refreshBtnActive: {
    opacity: 0.6,
  },
  apiTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
    alignSelf: 'flex-start',
    backgroundColor: colors.dark.greenDim,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  apiDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.dark.green,
  },
  apiTagText: {
    fontSize: 10,
    fontWeight: '600' as const,
    color: colors.dark.green,
  },
  summaryRow: {
    flexDirection: 'row',
    marginTop: 14,
    backgroundColor: colors.dark.card,
    borderRadius: 12,
    padding: 12,
  },
  summaryItem: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
  },
  summaryDivider: {
    width: 1,
    backgroundColor: colors.dark.border,
  },
  summaryLabel: {
    fontSize: 10,
    color: colors.dark.textMuted,
  },
  summaryValue: {
    fontSize: 15,
    fontWeight: '700' as const,
    color: colors.dark.text,
  },
  loadingBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    gap: 12,
  },
  loadingText: {
    fontSize: 13,
    color: colors.dark.textSecondary,
  },
  errorBox: {
    alignItems: 'center',
    backgroundColor: colors.dark.redDim,
    marginHorizontal: 16,
    marginTop: 12,
    padding: 16,
    borderRadius: 12,
    gap: 8,
  },
  errorText: {
    fontSize: 13,
    color: colors.dark.red,
    textAlign: 'center',
  },
  retryBtn: {
    backgroundColor: colors.dark.red,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 8,
  },
  retryBtnText: {
    fontSize: 13,
    fontWeight: '700' as const,
    color: '#FFF',
  },
  memeAlert: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.dark.orangeDim,
    marginHorizontal: 16,
    marginTop: 12,
    padding: 10,
    borderRadius: 10,
    gap: 8,
    borderWidth: 1,
    borderColor: colors.dark.orange + '33',
  },
  memeAlertText: {
    fontSize: 11,
    color: colors.dark.orange,
    flex: 1,
    textAlign: 'right',
    lineHeight: 18,
  },
  sectionTabs: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    marginTop: 16,
    gap: 8,
  },
  sectionTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: colors.dark.surface,
    borderWidth: 1,
    borderColor: colors.dark.border,
    gap: 5,
  },
  sectionTabActive: {
    backgroundColor: colors.dark.accent + '18',
    borderColor: colors.dark.accent + '44',
  },
  sectionTabText: {
    fontSize: 12,
    fontWeight: '600' as const,
    color: colors.dark.textMuted,
  },
  sectionTabTextActive: {
    color: colors.dark.accent,
  },
  section: {
    marginTop: 12,
    paddingHorizontal: 16,
    gap: 8,
  },
  emptySection: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    gap: 10,
  },
  emptySectionText: {
    fontSize: 14,
    color: colors.dark.textMuted,
  },
  positionCard: {
    backgroundColor: colors.dark.surface,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.dark.border,
  },
  posHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  posLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  posSymbol: {
    fontSize: 15,
    fontWeight: '700' as const,
    color: colors.dark.text,
  },
  sideBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  sideLong: {
    backgroundColor: colors.dark.greenDim,
  },
  sideShort: {
    backgroundColor: colors.dark.redDim,
  },
  sideText: {
    fontSize: 10,
    fontWeight: '700' as const,
  },
  posRight: {
    alignItems: 'flex-end',
  },
  posPnl: {
    fontSize: 15,
    fontWeight: '700' as const,
  },
  posPnlPercent: {
    fontSize: 11,
    fontWeight: '600' as const,
  },
  posDetails: {
    flexDirection: 'row',
    marginTop: 12,
    backgroundColor: colors.dark.card,
    borderRadius: 8,
    padding: 10,
    gap: 4,
  },
  posDetail: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  posDetailLabel: {
    fontSize: 9,
    color: colors.dark.textMuted,
  },
  posDetailValue: {
    fontSize: 11,
    fontWeight: '600' as const,
    color: colors.dark.textSecondary,
  },
  liqRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.dark.border,
  },
  liqText: {
    fontSize: 11,
    color: colors.dark.orange,
    fontWeight: '600' as const,
  },
  spotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.dark.surface,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.dark.border,
  },
  spotLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 10,
  },
  spotBadge: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: colors.dark.blueDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  spotBadgeText: {
    fontSize: 12,
    fontWeight: '800' as const,
    color: colors.dark.text,
  },
  spotInfo: {
    flex: 1,
  },
  spotCoin: {
    fontSize: 14,
    fontWeight: '700' as const,
    color: colors.dark.text,
  },
  spotAmount: {
    fontSize: 11,
    color: colors.dark.textMuted,
    marginTop: 2,
  },
  spotRight: {
    alignItems: 'flex-end',
  },
  spotValue: {
    fontSize: 14,
    fontWeight: '700' as const,
    color: colors.dark.text,
  },
  spotHold: {
    fontSize: 10,
    color: colors.dark.orange,
    marginTop: 2,
  },
  spotDetailHint: {
    fontSize: 9,
    color: colors.dark.accent,
    marginTop: 3,
    fontWeight: '600' as const,
  },
  tradeCard: {
    backgroundColor: colors.dark.surface,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.dark.border,
  },
  tradeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  tradeIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tradeIconBuy: {
    backgroundColor: colors.dark.greenDim,
  },
  tradeIconSell: {
    backgroundColor: colors.dark.redDim,
  },
  tradeInfo: {
    flex: 1,
  },
  tradeType: {
    fontSize: 13,
    fontWeight: '700' as const,
    color: colors.dark.text,
    textAlign: 'right',
  },
  tradeTime: {
    fontSize: 10,
    color: colors.dark.textMuted,
    marginTop: 2,
    textAlign: 'right',
  },
  tradeRight: {
    alignItems: 'flex-end',
  },
  tradeValue: {
    fontSize: 14,
    fontWeight: '700' as const,
    color: colors.dark.text,
  },
  tradeSize: {
    fontSize: 10,
    color: colors.dark.textMuted,
    marginTop: 2,
  },
  tradePnl: {
    fontSize: 10,
    fontWeight: '600' as const,
    marginTop: 2,
  },
}));
