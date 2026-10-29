/**
 * UpdateBanner — v1.2.0
 *
 * «اگه نسخه بروزی اپلود شد تو گیتهاب با یه پیغام بالای صفحه به کاربر نشون
 * بده ورژن جدید با چه تغییراتی موجوده که با زدن دکمه دانلود همون مستقیما
 * بره برا دانلود»
 *
 * • روی ریپوی GitHub که کاربر در تنظیمات وارد می‌کند (owner/repo)، جدیدترین
 *   Release خوانده می‌شود (از طریق پروکسی سرور — از ایران هم جواب می‌دهد).
 * • اگر نسخهٔ Release از نسخهٔ نصب‌شده بزرگ‌تر باشد، این بنر بالای همهٔ صفحات
 *   ظاهر می‌شود؛ توضیحات Release (changelog) همان پیامِ بالای صفحه است.
 * • دکمهٔ «دانلود نسخه جدید» فایل APK پیوست همان Release را مستقیم باز می‌کند
 *   (fallback: صفحهٔ Release در گیتهاب).
 * • بستن بنر تا نسخهٔ بعدی دیگر نشان داده نمی‌شود (AsyncStorage per-version).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Download, RefreshCw, X, Sparkles } from 'lucide-react-native';
import colors from '@/constants/colors';
import { createThemedStyles } from '@/utils/themeStyles';
import { useApp } from '@/contexts/AppContext';
import { APP_VERSION } from '@/constants/appInfo';
import { checkForUpdate, type UpdateInfo } from '@/utils/updateChecker';

const DISMISS_KEY = '@update_banner_dismissed_version';
/** سکوت بین بررسی‌های خودکار (۶ ساعت) — دکمهٔ دستی همیشه فورس می‌کند. */
const AUTO_CHECK_INTERVAL = 6 * 60 * 60_000;

export default function UpdateBanner() {
  const { settings } = useApp();
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [checking, setChecking] = useState(false);
  const lastAutoCheckRef = useRef(0);

  const repo = (settings.githubRepo ?? '').trim();

  const runCheck = useCallback(
    async (force: boolean) => {
      if (!repo) return;
      if (!force && Date.now() - lastAutoCheckRef.current < AUTO_CHECK_INTERVAL) return;
      lastAutoCheckRef.current = Date.now();
      setChecking(true);
      try {
        const info = await checkForUpdate(repo, APP_VERSION);
        if (info.available) {
          // اگر کاربر همین نسخه را قبلاً بسته، دوباره نشان نده
          try {
            const d = await AsyncStorage.getItem(DISMISS_KEY);
            if (d === info.latestVersion) {
              setUpdate(info);
              setDismissed(true);
              return;
            }
          } catch {}
          setUpdate(info);
          setDismissed(false);
        } else {
          setUpdate(null);
        }
      } catch {
        setUpdate(null);
      } finally {
        setChecking(false);
      }
    },
    [repo]
  );

  // بررسی خودکار: هنگام باز شدن برنامه و هنگام برگشتن از پس‌زمینه
  useEffect(() => {
    void runCheck(false);
    const timer = setInterval(() => void runCheck(false), 30 * 60_000);
    return () => clearInterval(timer);
  }, [runCheck]);

  if (!update || !update.available || dismissed || !repo) return null;

  const download = () => {
    const url = update.apkUrl || update.releaseUrl;
    if (url) void Linking.openURL(url);
  };

  const dismiss = () => {
    setDismissed(true);
    AsyncStorage.setItem(DISMISS_KEY, update.latestVersion ?? '').catch(() => {});
  };

  // changelog: حداکثر ۶ خط اول توضیحات Release
  const notesLines = (update.notes ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 6);

  return (
    <View style={styles.banner}>
      <View style={styles.headRow}>
        <Sparkles size={16} color={colors.dark.green} />
        <Text style={styles.title} numberOfLines={1}>
          نسخه جدید {update.latestVersion} منتشر شد (نسخه فعلی: {update.currentVersion})
        </Text>
        <Pressable onPress={dismiss} hitSlop={8} style={styles.closeBtn}>
          <X size={15} color={colors.dark.textMuted} />
        </Pressable>
      </View>

      {notesLines.length > 0 && (
        <View style={styles.notesBox}>
          {notesLines.map((l, i) => (
            <Text key={i} style={styles.noteLine} numberOfLines={2}>
              • {l.replace(/^[-*•]\s*/, '')}
            </Text>
          ))}
        </View>
      )}

      <View style={styles.btnRow}>
        <Pressable style={styles.downloadBtn} onPress={download}>
          <Download size={14} color={colors.dark.background} />
          <Text style={styles.downloadText}>دانلود نسخه جدید</Text>
        </Pressable>
        {checking && <RefreshCw size={13} color={colors.dark.textMuted} />}
      </View>
    </View>
  );
}

const styles = createThemedStyles(() =>
  StyleSheet.create({
    banner: {
      backgroundColor: colors.dark.surface,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.dark.green + '66',
      padding: 12,
      marginHorizontal: 12,
      marginTop: 8,
      gap: 8,
    },
    headRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    title: {
      flex: 1,
      fontSize: 12.5,
      fontWeight: '800' as const,
      color: colors.dark.green,
      textAlign: 'right',
    },
    closeBtn: {
      padding: 2,
    },
    notesBox: {
      backgroundColor: colors.dark.card,
      borderRadius: 10,
      padding: 10,
      gap: 3,
    },
    noteLine: {
      fontSize: 11,
      lineHeight: 17,
      color: colors.dark.textSecondary,
      textAlign: 'right',
    },
    btnRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      justifyContent: 'flex-end',
    },
    downloadBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: colors.dark.accent,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    downloadText: {
      fontSize: 12,
      fontWeight: '800' as const,
      color: colors.dark.background,
    },
  })
);
