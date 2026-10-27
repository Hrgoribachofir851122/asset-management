/**
 * app/(tabs)/settings/index.tsx — تنظیمات اپ مستقل «مدیریت دارایی»
 *
 * Rebuilt for the standalone app from the original Pampi settings extracts
 * (docs/settings-extract/): only the sections relevant to Asset Management:
 *
 *   ⏱️ «تنظیمات بروزرسانی»  — بازه بروزرسانی خودکار (extract 01 + 02)
 *   🌙 «ظاهر برنامه»        — تم روشن/تیره                       (extract 03)
 *   ❓ «راهنما»             — سه راهنمای بخش دارایی               (extract 04)
 *   ℹ️ «درباره»             — نام/نسخه/توضیح اپ مستقل
 *
 * Styling follows the same conventions as the wallet screens: live
 * colors.dark.* palette + createThemedStyles + right-aligned Persian text.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
} from 'react-native';
import {
  ChevronDown,
  ChevronUp,
  Clock,
  HelpCircle,
  Info,
  Moon,
  RefreshCw,
  Sun,
} from 'lucide-react-native';
import colors from '@/constants/colors';
import { createThemedStyles } from '@/utils/themeStyles';
import DropdownPicker from '@/components/DropdownPicker';
import { useApp } from '@/contexts/AppContext';
import { APP_VERSION } from '@/constants/appInfo';

/** گزینه‌های بازه بروزرسانی — عیناً از پامپی (settings-extract/02) */
const REFRESH_INTERVAL_OPTIONS = [
  { key: '0.05', label: '۳ ثانیه' },
  { key: '0.1', label: '۶ ثانیه' },
  { key: '0.17', label: '۱۰ ثانیه' },
  { key: '0.25', label: '۱۵ ثانیه' },
  { key: '0.5', label: '۳۰ ثانیه' },
  { key: '1', label: '۱ دقیقه' },
  { key: '2', label: '۲ دقیقه' },
  { key: '3', label: '۳ دقیقه' },
  { key: '5', label: '۵ دقیقه' },
  { key: '10', label: '۱۰ دقیقه' },
  { key: '15', label: '۱۵ دقیقه' },
  { key: '30', label: '۳۰ دقیقه' },
];

/** سه راهنمای مدیریت دارایی — عیناً از پامپی (settings-extract/04) */
const HELP_SECTIONS = [
  {
    id: 'wallet',
    title: '👛 مدیریت دارایی',
    content:
      'این بخش چهار تب دارد و کل سرمایه شما را یکجا نشان می‌دهد (ترتیب تب‌ها از سمت راست: دارایی ریالی و فلزات، پیش‌بینی طلا، کیف پول بلاکچین، ارز دیجیتال):\n\n💠 تب «ارز دیجیتال»: صرافی‌های خود را اضافه کنید (بایننس، بیت‌پرپ با ورود ایمیل+کد یکبارمصرف، بای‌بیت، اوکی‌ایکس و…) و موجودی کامل (Overview) را ببینید: اسپات + ارن (سپرده‌گذاری) + فاندینگ + فیوچرز + آلفا — برای هر دارایی سود/زیان تقریبی (PnL) و برای کل صرافی یک PnL کلی. ردیف‌هایی که قیمتشان موقتاً در دسترس نیست حذف نمی‌شوند و با «قیمت نامشخص» نمایش داده می‌شوند؛ قیمت‌ها از بایننس اسپات و فیوچرز (کوین‌هایی مثل POPCAT فقط در فیوچرز معامله می‌شوند) خوانده می‌شوند. مجموع کل دارایی از همه صرافی‌ها (دلاری و تومانی) در کارت بالای همین صفحه است.\n\n🏦 تب «دارایی ریالی و فلزات»: قیمت‌های لحظه‌ای تومان (طلای ۱۸/۲۴ عیار، نقره، سکه‌های امامی/بهار/نیم/ربع، دلار آزاد و تتر) + ورود دارایی‌های فیزیکی خودتان (ریال نقدی، دلار کاغذی، طلا با عیار، نقره، سکه) + سه ردیف خلاصه ارز دیجیتال به همان الگو: «ارز دیجیتال — کیف‌های صرافی» (ارزش دلاری + معادل تومانی)، «کیف پول بلاکچین» و «تتر کل» (تعداد USDT صرافی + بلاکچین با معادل تومانی). کارت سود/زیان ۷/۳۰/۹۰/۱۸۰ روزه همه دارایی‌ها (طلا/دلار/سکه + کیف بلاکچین) و «مجموع کل» همه‌چیز در یک عدد.\n\n🥇 تب «پیش‌بینی طلا»: تحلیل و پیش‌بینی قیمت شمش خام ۹۹۵ در بورس کالا (IME) با فاصله اطمینان.\n\n⛓ تب «کیف پول بلاکچین (فقط خواندنی)»: آدرس عمومی کیف‌هایتان (تراست ولتم، تون‌کیپر، متامسک و…) را اضافه کنید — از منوی کشویی هر تعداد شبکه را تیک بزنید (۵۱ شبکه: همه شبکه‌های EVM با یک آدرس 0x + سولانا + تون + ترون + بیت‌کوین و…). یک آدرس روی چند شبکه همزمان خوانده می‌شود؛ سود/زیان کل در بالا با انتخاب تایم‌فریم و هر کیف در یک خط جدا + جزئیات هر ارز در همان خط. قیمت تتر به تومان به‌صورت خودکار و پنهان از منابع متعدد خوانده می‌شود و ارزش کل پورتفوی و سود/زیان هر ارز بر همین اساس محاسبه می‌گردد.',
  },
  {
    id: 'blockchain-wallet',
    title: '⛓ کیف پول بلاکچین (فقط خواندنی)',
    content:
      'مثل داشتن تراست ولتم داخل همین برنامه — بدون ریسک:\n\n• فقط آدرس عمومی وارد می‌کنید؛ نه کلید خصوصی نه عبارت بازیابی — برداشت از کیف شما غیرممکن است.\n• منوی کشویی شبکه‌ها: ۵۱ شبکه پشتیبانی می‌شود — همه شبکه‌های اتریومی (اتریوم، بایننس/اسمارت‌چین، پالیگان، آربیتروم، بیس، آوالانچ، فانتوم، zkSync، لینئا، منتل، opBNB، اسکرول، بلاست، گنوزیس، سیلُ، کرونوس، مون‌بیم/مون‌ریور، آرورا، هارمونی، KCC، فیوز، XDC، زورا، zkEVM پالیگان، Immutable، سونیک، فایل‌کوین) با یک آدرس 0x مشترک + شبکه‌های مستقل: سولانا، تون (آدرس UQ/EQ کیف Tonkeeper)، ترون، بیت‌کوین، لایت‌کوین، دوج‌کوین، بیت‌کوین کش، ریپل، کاردانو، پولکادات، کازموس، نیر، آپتوس، سویی، استلار، الگورند، تزوس، مالتی‌ورس‌ایکس، هدرا، زیلیکا، وی‌چین و کسپا.\n• همه ارزهای بایننس روی آن شبکه‌ها خوانده می‌شوند (قیمت‌ها از بایننس اسپات+فیوچرز و برای بقیه کوین‌ها CoinGecko)؛ اگر ارزی قیمت لحظه‌ای نداشت، ردیفش با «قیمت نامشخص» می‌ماند و حذف نمی‌شود.\n• سود/زیان سه‌سطحی: مجموع کل در کارت بالا با انتخاب تایم‌فریم (۷/۳۰/۹۰/۱۸۰ روز)، هر کیف در یک خط جداگانه و داخل هر کیف برای تک‌تک ارزها.\n• دکمه رفرش هر کیف موجودی همان کیف را از نو می‌خواند؛ دکمه ویرایش (مداد) نام و شبکه‌های کیف را تغییر می‌دهد.\n• دارایی این تب در تب «دارایی ریالی و فلزات» هم حساب می‌شود (ردیف کیف بلاکچین + ردیف تتر کل).',
  },
  {
    id: 'rial-assets',
    title: '🏦 دارایی ریالی و فلزات',
    content:
      'مدیریت دارایی‌های غیرکریپتوی شما:\n\n• قیمت‌های لحظه‌ای تومان از TGJU: طلای ۱۸ و ۲۴ عیار، نقره ۹۹۹/۹۲۵، سکه امامی/بهار/نیم/ربع، دلار آزاد و تتر — با دکمه رفرش.\n• ورودی‌های شما: ریال/تومان نقدی، دلار کاغذی (فیزیکی)، تتر USDT (دستی، مثل دلار کاغذی؛ جدا از تتر صرافی/کیف بلاکچین حساب می‌شود)، طلا بر حسب گرم با انتخاب عیار ۱۸ یا ۲۴، نقره با نوع ۹۹۹ یا ۹۲۵ و سکه‌ها بر حسب تعداد — همه در حافظه دستگاه ذخیره می‌شوند و هر ردیف ارزش تومانی خودش را کنارش نشان می‌دهد.\n• «مجموع کل دارایی» = ریال + دلار کاغذی + تتر + طلا + نقره + سکه + ارز دیجیتال + کیف بلاکچین؛ همیشه بالای بخش دیده می‌شود.\n• کارت سود/زیان ۷/۳۰/۹۰/۱۸۰ روزه بر اساس تاریخچه قیمت روزانه (TGJU برای فلزات/دلار و بایننس/CoinGecko برای کریپتو) — تغییر ارزش بازار دارایی‌های امروز شما.',
  },
];

export default function SettingsScreen() {
  const { settings, updateSettings, setAppThemeMode, themeMode } = useApp();
  const [openHelpId, setOpenHelpId] = useState<string | null>(null);

  const refreshInterval = String(settings.refreshInterval ?? 5);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      testID="settings-scroll"
    >
      {/* ── Header ─────────────────────────────────────────────── */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>تنظیمات</Text>
      </View>

      {/* ── تنظیمات بروزرسانی (extract 01+02) ──────────────────── */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <RefreshCw size={18} color={colors.dark.accent} />
          <Text style={styles.sectionTitle}>تنظیمات بروزرسانی</Text>
        </View>
        <DropdownPicker
          label="بازه بروزرسانی"
          value={refreshInterval}
          options={REFRESH_INTERVAL_OPTIONS}
          onSelect={(key) => updateSettings({ refreshInterval: Number(key) })}
          testID="refresh-interval-dropdown"
        />
        <Text style={styles.hintText}>
          تمام بخش‌ها (قیمت تتر، صرافی‌ها، کیف پول بلاکچین و فلزات) با بازه انتخابی بروزرسانی می‌شوند
        </Text>
      </View>

      {/* ── ظاهر برنامه (extract 03) ───────────────────────────── */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          {themeMode === 'light' ? (
            <Sun size={18} color={colors.dark.accent} />
          ) : (
            <Moon size={18} color={colors.dark.accent} />
          )}
          <Text style={styles.sectionTitle}>ظاهر برنامه</Text>
        </View>
        <View style={styles.themeRow}>
          <Pressable
            style={({ pressed }) => [
              styles.themeOption,
              themeMode === 'light' && styles.themeOptionActive,
              pressed && { opacity: 0.85 },
            ]}
            onPress={() => setAppThemeMode('light')}
            testID="theme-light-btn"
          >
            <Sun
              size={18}
              color={themeMode === 'light' ? colors.dark.background : colors.dark.textSecondary}
            />
            <Text
              style={[
                styles.themeOptionText,
                themeMode === 'light' && styles.themeOptionTextActive,
              ]}
            >
              روشن
            </Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.themeOption,
              themeMode === 'dark' && styles.themeOptionActive,
              pressed && { opacity: 0.85 },
            ]}
            onPress={() => setAppThemeMode('dark')}
            testID="theme-dark-btn"
          >
            <Moon
              size={18}
              color={themeMode === 'dark' ? colors.dark.background : colors.dark.textSecondary}
            />
            <Text
              style={[
                styles.themeOptionText,
                themeMode === 'dark' && styles.themeOptionTextActive,
              ]}
            >
              تیره
            </Text>
          </Pressable>
        </View>
        <Text style={styles.hintText}>
          تم انتخابی بلافاصله روی کل برنامه اعمال و ذخیره می‌شود.
        </Text>
      </View>

      {/* ── راهنما (extract 04) ────────────────────────────────── */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <HelpCircle size={18} color={colors.dark.accent} />
          <Text style={styles.sectionTitle}>راهنما</Text>
        </View>
        {HELP_SECTIONS.map((h) => {
          const open = openHelpId === h.id;
          return (
            <View key={h.id} style={styles.helpItem}>
              <Pressable
                style={({ pressed }) => [
                  styles.helpHeader,
                  pressed && { opacity: 0.85 },
                ]}
                onPress={() => setOpenHelpId(open ? null : h.id)}
                testID={`help-${h.id}`}
              >
                <Text style={styles.helpTitle}>{h.title}</Text>
                {open ? (
                  <ChevronUp size={16} color={colors.dark.textSecondary} />
                ) : (
                  <ChevronDown size={16} color={colors.dark.textSecondary} />
                )}
              </Pressable>
              {open && <Text style={styles.helpContent}>{h.content}</Text>}
            </View>
          );
        })}
      </View>

      {/* ── درباره ─────────────────────────────────────────────── */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Info size={18} color={colors.dark.accent} />
          <Text style={styles.sectionTitle}>درباره برنامه</Text>
        </View>
        <View style={styles.aboutRow}>
          <View style={styles.aboutBadge}>
            <Clock size={26} color={colors.dark.accent} />
          </View>
          <View style={styles.aboutTextWrap}>
            <Text style={styles.aboutName}>مدیریت دارایی</Text>
            <Text style={styles.aboutVersion}>نسخه {APP_VERSION}</Text>
          </View>
        </View>
        <Text style={styles.hintText}>
          اپ مستقل مدیریت دارایی (بخش «مدیریت دارایی» اپ پامپی نسخه 1.5.12) — ارز دیجیتال،
          دارایی ریالی و فلزات، پیش‌بینی طلا و کیف پول بلاکچین در یک برنامه. کلیدهای API و
          دارایی‌های ثبت‌شده فقط روی حافظه همین دستگاه ذخیره می‌شوند و هیچ‌جا ارسال نمی‌شوند.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = createThemedStyles(() =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: colors.dark.background,
    },
    content: {
      padding: 16,
      paddingBottom: 40,
    },
    header: {
      alignItems: 'center',
      paddingVertical: 12,
      marginBottom: 8,
    },
    headerTitle: {
      fontSize: 20,
      fontWeight: '700' as const,
      color: colors.dark.text,
    },
    section: {
      backgroundColor: colors.dark.card,
      borderRadius: 16,
      padding: 16,
      marginBottom: 16,
      borderWidth: 1,
      borderColor: colors.dark.cardBorder,
    },
    sectionHeader: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: 8,
      marginBottom: 14,
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '700' as const,
      color: colors.dark.text,
      flex: 1,
      textAlign: 'right',
    },
    hintText: {
      fontSize: 12,
      color: colors.dark.textMuted,
      textAlign: 'right',
      marginTop: 10,
      lineHeight: 20,
    },
    themeRow: {
      flexDirection: 'row',
      gap: 10,
    },
    themeOption: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingVertical: 12,
      borderRadius: 12,
      backgroundColor: colors.dark.inputBg,
      borderWidth: 1,
      borderColor: colors.dark.border,
    },
    themeOptionActive: {
      backgroundColor: colors.dark.accent,
      borderColor: colors.dark.accent,
    },
    themeOptionText: {
      fontSize: 14,
      color: colors.dark.textSecondary,
      fontWeight: '600' as const,
    },
    themeOptionTextActive: {
      color: colors.dark.background,
    },
    helpItem: {
      borderRadius: 12,
      backgroundColor: colors.dark.surfaceLight,
      marginBottom: 10,
      overflow: 'hidden',
    },
    helpHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 12,
      paddingVertical: 12,
    },
    helpTitle: {
      fontSize: 14,
      fontWeight: '600' as const,
      color: colors.dark.text,
      flex: 1,
      textAlign: 'right',
    },
    helpContent: {
      fontSize: 13,
      color: colors.dark.textSecondary,
      lineHeight: 22,
      textAlign: 'right',
      paddingHorizontal: 12,
      paddingBottom: 14,
    },
    aboutRow: {
      flexDirection: 'row-reverse',
      alignItems: 'center',
      gap: 12,
      marginBottom: 4,
    },
    aboutBadge: {
      width: 52,
      height: 52,
      borderRadius: 14,
      backgroundColor: colors.dark.accentDim,
      alignItems: 'center',
      justifyContent: 'center',
    },
    aboutTextWrap: {
      flex: 1,
    },
    aboutName: {
      fontSize: 16,
      fontWeight: '700' as const,
      color: colors.dark.text,
      textAlign: 'right',
    },
    aboutVersion: {
      fontSize: 12,
      color: colors.dark.textMuted,
      textAlign: 'right',
      marginTop: 2,
    },
  })
);
