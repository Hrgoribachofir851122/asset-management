/**
 * components/WhatsNewModal.tsx — v1.4.0 «تازه‌های نسخه»
 *
 * بعد از نصب/آپدیت، در **اولین ورود** پنجرهٔ تغییرات را با تم برنامه نشان
 * می‌دهد. با بستن، نسخهٔ دیده‌شده ذخیره می‌شود و دیگر هیچ‌وقت برای همان
 * نسخه نمایش داده نمی‌شود. اگر کاربر چند نسخه را یکجا رد کرده باشد،
 * تازه‌های همهٔ نسخه‌های میانی را یکجا می‌بیند.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Modal, View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Sparkles, X } from 'lucide-react-native';
import colors from '@/constants/colors';
import { APP_VERSION } from '@/constants/appInfo';
import { WHATS_NEW, compareVersions, type WhatsNewEntry } from '@/constants/whatsNew';

const SEEN_KEY = '@whats_new_seen_version';
/** کمی صبر تا اپ کامل بالا بیاید — مودال اول، آخرین تصویر است نه اولین */
const SHOW_DELAY_MS = 2_500;

export default function WhatsNewModal() {
  const [entries, setEntries] = useState<WhatsNewEntry[] | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const seen = await AsyncStorage.getItem(SEEN_KEY);
        // فقط وقتی نسخهٔ نصب‌شده با آخرین نسخهٔ دیده‌شده فرق دارد
        if (seen === APP_VERSION) return;
        const fresh = seen
          ? WHATS_NEW.filter((e) => compareVersions(e.version, seen) > 0)
          : WHATS_NEW.filter((e) => compareVersions(e.version, APP_VERSION) <= 0);
        if (fresh.length > 0) {
          setTimeout(() => {
            if (alive) setEntries(fresh);
          }, SHOW_DELAY_MS);
        } else if (!seen) {
          // بدون entry — فقط علامت بزن که دیگر باز نشود
          await AsyncStorage.setItem(SEEN_KEY, APP_VERSION);
        }
      } catch {
        /* AsyncStorage در دسترس نیست — بدون مودال ادامه بده */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const close = useCallback(async () => {
    setEntries(null);
    try {
      await AsyncStorage.setItem(SEEN_KEY, APP_VERSION);
    } catch {}
  }, []);

  if (!entries || entries.length === 0) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.headerRow}>
            <View style={styles.badge}>
              <Sparkles size={20} color={colors.dark.accent} />
            </View>
            <View style={styles.headerTextWrap}>
              <Text style={styles.title}>تازه‌های نسخه {toFaVersion(APP_VERSION)}</Text>
              <Text style={styles.subtitle}>مدیریت دارایی به‌روز شد 🎉</Text>
            </View>
            <Pressable onPress={close} hitSlop={8} style={styles.closeBtn} testID="whats-new-close">
              <X size={20} color={colors.dark.textSecondary} />
            </Pressable>
          </View>

          <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
            {entries.map((entry) => (
              <View key={entry.version} style={styles.entryWrap}>
                <Text style={styles.entryTitle}>
                  نسخه {toFaVersion(entry.version)} — {entry.title}
                </Text>
                {entry.items.map((item, i) => (
                  <View key={i} style={styles.itemRow}>
                    <View style={styles.bullet} />
                    <Text style={styles.itemText}>{item}</Text>
                  </View>
                ))}
              </View>
            ))}
          </ScrollView>

          <Pressable
            style={({ pressed }) => [styles.okBtn, pressed && { opacity: 0.85 }]}
            onPress={close}
            testID="whats-new-ok"
          >
            <Text style={styles.okBtnText}>فهمیدم، بریم سراغ برنامه</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

/** 1.4.0 → ۱.۴.۰ */
function toFaVersion(v: string): string {
  const fa = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
  return v.replace(/\d/g, (d) => fa[Number(d)]).replace(/\./g, '٫');
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '82%',
    backgroundColor: colors.dark.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.dark.cardBorder,
    padding: 18,
  },
  headerRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  badge: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: colors.dark.accentDim,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTextWrap: {
    flex: 1,
  },
  title: {
    fontSize: 16,
    fontWeight: '800' as const,
    color: colors.dark.text,
    textAlign: 'right',
  },
  subtitle: {
    fontSize: 12,
    color: colors.dark.textMuted,
    textAlign: 'right',
    marginTop: 2,
  },
  closeBtn: {
    padding: 4,
  },
  scroll: {
    maxHeight: 380,
  },
  entryWrap: {
    marginBottom: 10,
  },
  entryTitle: {
    fontSize: 13,
    fontWeight: '700' as const,
    color: colors.dark.accent,
    textAlign: 'right',
    marginBottom: 6,
  },
  itemRow: {
    flexDirection: 'row-reverse',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 7,
  },
  bullet: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.dark.accent,
    marginTop: 7,
  },
  itemText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 21,
    color: colors.dark.text,
    textAlign: 'right',
  },
  okBtn: {
    marginTop: 10,
    backgroundColor: colors.dark.accent,
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: 'center',
  },
  okBtnText: {
    fontSize: 14,
    fontWeight: '800' as const,
    color: '#131722',
  },
});
