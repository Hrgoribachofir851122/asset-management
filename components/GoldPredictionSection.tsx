import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput, ActivityIndicator } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RefreshCw,
  Pencil,
  Landmark,
  Info,
  X,
  Check,
} from 'lucide-react-native';
import colors from '@/constants/colors';
import { createThemedStyles } from '@/utils/themeStyles';
import {
  fetchIranMarketPrices,
  formatFullToman,
  parseTomanInput,
} from '@/utils/iranMarketApi';
import {
  fetchImeFutures,
  setImeManualEntry,
  predict18From995,
  ImeFuturesResult,
} from '@/utils/imeFuturesApi';

import { ThemedAlert } from '@/components/ThemedAlert';
/**
 * GoldPredictionSection — v1.4.14
 *
 * «پیش‌بینی قیمت طلا» tab of the wallet screen, exactly per the approved
 * mockup (scripts/ime-prediction-mockup.html):
 *   • live spot card (18k / 24k / 995-equivalent) from TGJU
 *   • IME «آتی شمش طلای خام» card: latest expiry, 995 price, the formula
 *     chip (750 ÷ 995), the big predicted-18k result + delta vs today
 *   • contracts table (every expiry the source returns)
 *   • manual-entry mode when IME is unreachable (geo-blocked to Iranian IPs)
 */

const PERSIAN_MONTHS = [
  'فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور',
  'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند',
];
const PERSIAN_YEARS = ['۱۴۰۵', '۱۴۰۶', '۱۴۰۷'];

export default function GoldPredictionSection() {
  const queryClient = useQueryClient();
  const [manualOpen, setManualOpen] = useState(false);

  const pricesQuery = useQuery({
    queryKey: ['iran-market-prices'],
    queryFn: fetchIranMarketPrices,
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60 * 1000,
  });

  const imeQuery = useQuery({
    queryKey: ['ime-futures'],
    queryFn: () => fetchImeFutures(),
    refetchInterval: 10 * 60 * 1000,
    staleTime: 60 * 1000,
    retry: 0,
  });

  const p = pricesQuery.data;
  const ime = imeQuery.data as ImeFuturesResult | undefined;

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['ime-futures'] });
    queryClient.invalidateQueries({ queryKey: ['iran-market-prices'] });
  }, [queryClient]);

  const gold18 = p?.gold18 ?? 0;
  const gold24 = p?.gold24 ?? 0;
  const gold995 = gold24 > 0 ? Math.round(gold24 * 0.995) : 0;

  const latest = ime?.latest;
  const predicted = latest?.predicted18Toman ?? (latest ? predict18From995(latest.price995Toman) : 0);
  const deltaPct =
    predicted > 0 && gold18 > 0 ? ((predicted - gold18) / gold18) * 100 : 0;

  return (
    <View style={styles.card}>
      {/* ── live spot card ── */}
      <View style={styles.spotCard}>
        <View style={styles.cardtitle}>
          <View style={styles.liveDot} />
          <Text style={styles.cardtitleText}>قیمت لحظه‌ای امروز (زنده)</Text>
        </View>
        <View style={styles.priceRow}>
          <Text style={styles.priceRowLabel}>
            طلای ۱۸ عیار <Text style={styles.liveTag}>● زنده</Text>
          </Text>
          <Text style={[styles.priceRowValue, { color: colors.dark.accent }]}>
            {gold18 > 0 ? formatFullToman(gold18) : '…'} ت
          </Text>
        </View>
        <View style={styles.priceRow}>
          <Text style={styles.priceRowLabel}>
            طلای ۲۴ عیار <Text style={styles.liveTag}>● زنده</Text>
          </Text>
          <Text style={styles.priceRowValue}>
            {gold24 > 0 ? formatFullToman(gold24) : '…'} ت
          </Text>
        </View>
        <View style={styles.priceRow}>
          <Text style={styles.priceRowLabel}>معادل خام ۹۹۵</Text>
          <Text style={styles.priceRowValue}>
            {gold995 > 0 ? formatFullToman(gold995) : '…'} ت
          </Text>
        </View>
      </View>

      {/* ── IME prediction card ── */}
      <View style={styles.imeCard}>
        <View style={styles.imeTop}>
          <Landmark size={16} color={colors.dark.accent} />
          <Text style={styles.imeTitle}>آتی شمش طلای خام</Text>
          <View style={styles.imeSourceChip}>
            <Text style={styles.imeSourceText}>
              {ime?.source === 'manual'
                ? 'ورودی دستی'
                : ime?.source === 'tgju'
                  ? 'TGJU'
                  : ime?.source === 'ime-trades'
                    ? 'IME نقدی'
                    : 'cdn.ime.co.ir'}
            </Text>
          </View>
          <Pressable style={styles.editBtn} onPress={() => setManualOpen(true)} hitSlop={6}>
            <Pencil size={12} color={colors.dark.accent} />
          </Pressable>
        </View>
        <Text style={styles.imeSub}>بازار آتی بورس کالای ایران — گروه شمش طلای خام</Text>

        {imeQuery.isLoading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="small" color={colors.dark.accent} />
            <Text style={styles.loadingText}>در حال دریافت از بورس کالا…</Text>
          </View>
        ) : imeQuery.isError || !latest ? (
          <View style={styles.errorBox}>
            <Info size={14} color={colors.dark.orange} />
            <Text style={styles.errorText}>
              IME فقط با IP ایران پاسخ می‌دهد — فیلترشکن را خاموش کنید و «بروزرسانی» را بزنید،
              یا قیمت آتی را از سربرگ cdn.ime.co.ir به‌صورت دستی وارد کنید.
            </Text>
            <Pressable style={styles.manualBtn} onPress={() => setManualOpen(true)}>
              <Text style={styles.manualBtnText}>ورود دستی قیمت آتی</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.expiryBox}>
              <Text style={styles.expiryLabel}>آخرین سررسید فعال در معامله</Text>
              <Text style={styles.expiryValue}>{latest.expiry}</Text>
            </View>
            <View style={styles.futPriceRow}>
              <Text style={styles.futPriceLabel}>قیمت معامله شمش خام (عیار ۹۹۵)</Text>
              <Text style={styles.futPriceValue}>
                {formatFullToman(latest.price995Toman)} ت / گرم
              </Text>
            </View>
            <View style={styles.formulaBox}>
              <Text style={styles.formulaText}>
                {formatFullToman(latest.price995Toman)} × (۷۵۰ ÷ ۹۹۵) ={' '}
                {formatFullToman(predicted)}
              </Text>
            </View>
            <View style={styles.resultBox}>
              <Text style={styles.resultLabel}>
                پیش‌بینی طلای ۱۸ عیار — {latest.expiry}
              </Text>
              <Text style={styles.resultValue}>{formatFullToman(predicted)} تومان</Text>
              <Text style={styles.resultUnit}>به‌ازای هر گرم</Text>
            </View>
            {gold18 > 0 && (
              <View style={styles.deltaRow}>
                <View
                  style={[
                    styles.deltaChip,
                    deltaPct < 0 && { backgroundColor: colors.dark.red + '1C' },
                  ]}
                >
                  <Text
                    style={[
                      styles.deltaChipText,
                      deltaPct < 0 && { color: colors.dark.red },
                    ]}
                  >
                    {deltaPct >= 0 ? '▲' : '▼'}{' '}
                    {Math.abs(deltaPct).toLocaleString('fa-IR', {
                      maximumFractionDigits: 1,
                    })}
                    ٪ {deltaPct >= 0 ? 'بالاتر' : 'پایین‌تر'} از قیمت امروز
                  </Text>
                </View>
              </View>
            )}
            {ime.staleNote ? (
              <Text style={styles.staleNote}>{ime.staleNote}</Text>
            ) : null}
          </>
        )}
      </View>

      {/* ── contracts table ── */}
      {ime && ime.contracts.length > 0 && (
        <View style={styles.spotCard}>
          <View style={styles.cardtitle}>
            <View style={[styles.liveDot, { backgroundColor: colors.dark.accent }]} />
            <Text style={styles.cardtitleText}>قراردادهای فعال بازار آتی شمش</Text>
          </View>
          <View style={styles.tableHeader}>
            <Text style={[styles.th, { flex: 1.1 }]}>سررسید</Text>
            <Text style={[styles.th, { flex: 1.4 }]}>آتی خام ۹۹۵</Text>
            <Text style={[styles.th, { flex: 1.4 }]}>پیش‌بینی ۱۸ عیار</Text>
            <Text style={[styles.th, { flex: 0.8, textAlign: 'left' }]}>اختلاف</Text>
          </View>
          {ime.contracts
            .slice()
            .reverse()
            .map((c, i, arr) => {
              const isLatest = c === arr.find((x) => x === ime.latest) || c === ime.latest;
              const diff =
                gold18 > 0 && c.predicted18Toman > 0
                  ? ((c.predicted18Toman - gold18) / gold18) * 100
                  : 0;
              return (
                <View
                  key={`${c.expiry}-${i}`}
                  style={[styles.tableRow, isLatest && styles.tableRowLast]}
                >
                  <Text style={[styles.td, { flex: 1.1 }, isLatest && { color: colors.dark.accent }]}>
                    {c.expiry}
                    {isLatest ? ' ★' : ''}
                  </Text>
                  <Text style={[styles.td, { flex: 1.4 }]}>
                    {formatFullToman(c.price995Toman)}
                  </Text>
                  <Text
                    style={[
                      styles.td,
                      { flex: 1.4 },
                      isLatest && { color: colors.dark.accent },
                    ]}
                  >
                    {formatFullToman(c.predicted18Toman)}
                  </Text>
                  <Text
                    style={[
                      styles.td,
                      {
                        flex: 0.8,
                        textAlign: 'left',
                        color: diff >= 0 ? colors.dark.green : colors.dark.red,
                      },
                    ]}
                  >
                    {diff >= 0 ? '+' : '−'}
                    {Math.abs(diff).toLocaleString('fa-IR', { maximumFractionDigits: 1 })}٪
                  </Text>
                </View>
              );
            })}
        </View>
      )}

      {/* ── refresh row ── */}
      <Pressable style={styles.refreshRow} onPress={refresh}>
        {imeQuery.isFetching || pricesQuery.isFetching ? (
          <ActivityIndicator size="small" color={colors.dark.accent} />
        ) : (
          <RefreshCw size={12} color={colors.dark.textSecondary} />
        )}
        <Text style={styles.refreshText}>بروزرسانی قیمت‌های آتی از بورس کالای ایران</Text>
      </Pressable>

      <Text style={styles.note}>
        منبع قیمت‌های آتی: IME / cdn.ime.co.ir — سربرگ بازار آتی، گروه شمش طلای خام؛
        تبدیل عیار ۹۹۵ به ۱۸ عیار با ضریب ۷۵۰÷۹۹۵. این محاسبه پیش‌بینی نیست بلکه قیمت
        ضمنی بازار آتی است — بازار می‌تواند اشتباه کند.
      </Text>

      {/* ── manual entry sheet ── */}
      {manualOpen && (
        <ManualEntrySheet
          onClose={() => setManualOpen(false)}
          onSaved={() => {
            setManualOpen(false);
            queryClient.invalidateQueries({ queryKey: ['ime-futures'] });
            queryClient.invalidateQueries({ queryKey: ['ime-futures'], exact: true });
            void fetchImeFutures(true);
          }}
        />
      )}
    </View>
  );
}

// ── manual entry sheet ──

function ManualEntrySheet({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [priceText, setPriceText] = useState('');
  const [month, setMonth] = useState(PERSIAN_MONTHS[11]); // اسفند
  const [year, setYear] = useState(PERSIAN_YEARS[0]);

  const save = useCallback(async () => {
    const price = parseTomanInput(priceText);
    if (!Number.isFinite(price) || price <= 0) {
      ThemedAlert.alert('خطا', 'قیمت آتی شمش خام را به تومان وارد کنید (مثلاً 38460000)');
      return;
    }
    await setImeManualEntry({ priceToman: price, expiry: `${month} ${year}`, setAt: Date.now() });
    ThemedAlert.alert('ذخیره شد', `پیش‌بینی بر اساس ${formatFullToman(predict18From995(price))} تومان محاسبه می‌شود`);
    onSaved();
  }, [priceText, month, year, onSaved]);

  return (
    <View style={styles.sheet}>
      <View style={styles.sheetHead}>
        <Text style={styles.sheetTitle}>ورود دستی قیمت آتی شمش خام ۹۹۵</Text>
        <Pressable onPress={onClose} hitSlop={6}>
          <X size={16} color={colors.dark.textSecondary} />
        </Pressable>
      </View>
      <Text style={styles.sheetHint}>
        عدد سربرگ «آتی» در cdn.ime.co.ir (گروه شمش طلای خام، ریال به‌ازای هر گرم) را به
        تومان تبدیل کنید و اینجا وارد نمایید (ریال ÷ ۱۰).
      </Text>
      <TextInput
        style={styles.sheetInput}
        value={priceText}
        onChangeText={setPriceText}
        placeholder="مثلاً 38460000"
        placeholderTextColor={colors.dark.textSecondary}
        keyboardType="decimal-pad"
        inputMode="decimal"
        textAlign="left"
      />
      <Text style={styles.sheetLabel}>ماه سررسید</Text>
      <View style={styles.chipRow}>
        {PERSIAN_MONTHS.map((m) => (
          <Pressable
            key={m}
            style={[styles.chip, month === m && styles.chipActive]}
            onPress={() => setMonth(m)}
          >
            <Text style={[styles.chipText, month === m && styles.chipTextActive]}>{m}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.sheetLabel}>سال سررسید</Text>
      <View style={styles.chipRow}>
        {PERSIAN_YEARS.map((y) => (
          <Pressable
            key={y}
            style={[styles.chip, year === y && styles.chipActive]}
            onPress={() => setYear(y)}
          >
            <Text style={[styles.chipText, year === y && styles.chipTextActive]}>{y}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.sheetBtnRow}>
        <Pressable style={styles.sheetClearBtn} onPress={async () => {
          await setImeManualEntry(null);
          onSaved();
        }}>
          <Text style={styles.sheetClearText}>پاک‌کردن (حالت خودکار)</Text>
        </Pressable>
        <Pressable style={styles.sheetSaveBtn} onPress={() => void save()}>
          <Check size={12} color="#241c04" />
          <Text style={styles.sheetSaveText}>ذخیره</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ── styles ──

const styles = createThemedStyles(() =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.dark.surface,
      borderRadius: 16,
      padding: 14,
      marginBottom: 16,
      borderWidth: 1,
      borderColor: colors.dark.accent + '26',
      gap: 12,
    },
    // spot card
    spotCard: {
      backgroundColor: colors.dark.card,
      borderRadius: 12,
      padding: 12,
      borderWidth: 1,
      borderColor: colors.dark.border,
    },
    cardtitle: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      marginBottom: 8,
    },
    liveDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.dark.green,
    },
    cardtitleText: {
      fontSize: 13,
      fontWeight: '800' as const,
      color: colors.dark.text,
      flex: 1,
      textAlign: 'right',
    },
    priceRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 6,
      borderBottomWidth: 1,
      borderBottomColor: colors.dark.border + '44',
      borderStyle: 'dashed',
    },
    priceRowLabel: {
      fontSize: 12.5,
      fontWeight: '600' as const,
      color: colors.dark.textSecondary,
    },
    liveTag: {
      color: colors.dark.green,
      fontSize: 10,
    },
    priceRowValue: {
      fontSize: 14.5,
      fontWeight: '800' as const,
      color: colors.dark.text,
    },
    // ime card
    imeCard: {
      backgroundColor: colors.dark.card,
      borderRadius: 16,
      padding: 14,
      borderWidth: 1,
      borderColor: colors.dark.accent + '44',
    },
    imeTop: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginBottom: 2,
    },
    imeTitle: {
      fontSize: 14,
      fontWeight: '900' as const,
      color: colors.dark.text,
    },
    imeSourceChip: {
      backgroundColor: colors.dark.surface,
      borderRadius: 7,
      paddingHorizontal: 8,
      paddingVertical: 3,
      marginStart: 'auto',
    },
    imeSourceText: {
      fontSize: 10,
      color: colors.dark.textSecondary,
      fontWeight: '600' as const,
    },
    editBtn: {
      padding: 5,
      borderRadius: 7,
      backgroundColor: colors.dark.accentDim,
    },
    imeSub: {
      fontSize: 10.5,
      fontWeight: '600' as const,
      color: colors.dark.textMuted,
      marginBottom: 6,
      textAlign: 'right',
    },
    loadingBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      padding: 12,
      justifyContent: 'center',
    },
    loadingText: {
      fontSize: 11,
      color: colors.dark.textSecondary,
    },
    errorBox: {
      backgroundColor: colors.dark.card,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.dark.orange + '55',
      padding: 12,
      gap: 8,
    },
    errorText: {
      fontSize: 11,
      lineHeight: 18,
      color: colors.dark.text,
      textAlign: 'right',
      flex: 1,
    },
    manualBtn: {
      alignSelf: 'flex-start',
      backgroundColor: colors.dark.accent,
      borderRadius: 8,
      paddingVertical: 6,
      paddingHorizontal: 12,
    },
    manualBtnText: {
      fontSize: 11,
      fontWeight: '700' as const,
      color: '#241c04',
    },
    expiryBox: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: colors.dark.accent + '12',
      borderWidth: 1,
      borderColor: colors.dark.accent + '44',
      borderStyle: 'dashed',
      borderRadius: 10,
      paddingHorizontal: 11,
      paddingVertical: 8,
      marginVertical: 8,
    },
    expiryLabel: {
      fontSize: 11.5,
      fontWeight: '600' as const,
      color: colors.dark.textSecondary,
    },
    expiryValue: {
      fontSize: 14,
      fontWeight: '900' as const,
      color: colors.dark.accent,
    },
    futPriceRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingVertical: 4,
    },
    futPriceLabel: {
      fontSize: 12,
      fontWeight: '600' as const,
      color: colors.dark.textSecondary,
      flex: 1,
    },
    futPriceValue: {
      fontSize: 13,
      fontWeight: '700' as const,
      color: colors.dark.text,
    },
    formulaBox: {
      backgroundColor: '#0B0E11',
      borderWidth: 1,
      borderColor: colors.dark.border,
      borderRadius: 10,
      paddingVertical: 7,
      paddingHorizontal: 11,
      marginVertical: 8,
    },
    formulaText: {
      fontSize: 11.5,
      fontWeight: '600' as const,
      color: colors.dark.textSecondary,
      textAlign: 'center',
    },
    resultBox: {
      backgroundColor: colors.dark.accent,
      borderRadius: 12,
      paddingVertical: 11,
      paddingHorizontal: 13,
      alignItems: 'center',
    },
    resultLabel: {
      fontSize: 11.5,
      fontWeight: '800' as const,
      color: '#241c04',
    },
    resultValue: {
      fontSize: 22,
      fontWeight: '900' as const,
      color: '#1a1402',
      marginTop: 2,
    },
    resultUnit: {
      fontSize: 10.5,
      fontWeight: '700' as const,
      color: '#4a3a06',
    },
    deltaRow: {
      flexDirection: 'row',
      justifyContent: 'center',
      marginTop: 8,
    },
    deltaChip: {
      backgroundColor: colors.dark.green + '18',
      borderRadius: 9,
      paddingHorizontal: 12,
      paddingVertical: 4,
    },
    deltaChipText: {
      fontSize: 11.5,
      fontWeight: '800' as const,
      color: colors.dark.green,
    },
    staleNote: {
      fontSize: 10,
      lineHeight: 16,
      color: colors.dark.orange,
      marginTop: 8,
      textAlign: 'right',
    },
    // contracts table
    tableHeader: {
      flexDirection: 'row',
      paddingVertical: 5,
      borderBottomWidth: 1,
      borderBottomColor: colors.dark.border,
    },
    th: {
      fontSize: 10.5,
      fontWeight: '700' as const,
      color: colors.dark.textMuted,
      textAlign: 'right',
    },
    tableRow: {
      flexDirection: 'row',
      paddingVertical: 7,
      borderBottomWidth: 1,
      borderBottomColor: colors.dark.border + '55',
      alignItems: 'center',
    },
    tableRowLast: {
      backgroundColor: colors.dark.accent + '0A',
      borderRadius: 6,
    },
    td: {
      fontSize: 12,
      fontWeight: '600' as const,
      color: colors.dark.text,
      textAlign: 'right',
    },
    // refresh + note
    refreshRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      backgroundColor: colors.dark.card,
      borderWidth: 1,
      borderColor: colors.dark.border,
      borderRadius: 10,
      paddingVertical: 9,
    },
    refreshText: {
      fontSize: 11.5,
      fontWeight: '700' as const,
      color: colors.dark.textSecondary,
    },
    note: {
      fontSize: 10,
      lineHeight: 17,
      color: colors.dark.textMuted,
      textAlign: 'center',
      paddingHorizontal: 6,
    },
    // manual sheet
    sheet: {
      backgroundColor: colors.dark.card,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.dark.accent + '44',
      padding: 12,
      gap: 8,
    },
    sheetHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    sheetTitle: {
      fontSize: 12.5,
      fontWeight: '800' as const,
      color: colors.dark.text,
    },
    sheetHint: {
      fontSize: 10,
      lineHeight: 16,
      color: colors.dark.textSecondary,
      textAlign: 'right',
    },
    sheetInput: {
      backgroundColor: colors.dark.surface,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.dark.border,
      color: colors.dark.text,
      fontSize: 14,
      fontWeight: '700' as const,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    sheetLabel: {
      fontSize: 10.5,
      fontWeight: '600' as const,
      color: colors.dark.textSecondary,
      textAlign: 'right',
    },
    chipRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 5,
    },
    chip: {
      backgroundColor: colors.dark.surface,
      borderWidth: 1,
      borderColor: colors.dark.border,
      borderRadius: 8,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    chipActive: {
      backgroundColor: colors.dark.accentDim,
      borderColor: colors.dark.accent,
    },
    chipText: {
      fontSize: 10,
      fontWeight: '600' as const,
      color: colors.dark.textSecondary,
    },
    chipTextActive: {
      color: colors.dark.accent,
      fontWeight: '700' as const,
    },
    sheetBtnRow: {
      flexDirection: 'row',
      gap: 8,
      marginTop: 4,
    },
    sheetClearBtn: {
      flex: 1,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.dark.border,
      paddingVertical: 8,
      alignItems: 'center',
    },
    sheetClearText: {
      fontSize: 11,
      fontWeight: '700' as const,
      color: colors.dark.textSecondary,
    },
    sheetSaveBtn: {
      flex: 1,
      flexDirection: 'row',
      gap: 5,
      borderRadius: 8,
      backgroundColor: colors.dark.accent,
      paddingVertical: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sheetSaveText: {
      fontSize: 11,
      fontWeight: '800' as const,
      color: '#241c04',
    },
  })
);
