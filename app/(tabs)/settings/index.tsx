/**
 * app/(tabs)/settings/index.tsx — تنظیمات اپ مستقل «مدیریت دارایی»
 *
 * v1.2.0 — تغییرات:
 *   • نسخهٔ برنامه دیگر هاردکد نیست (expo-constants → نسخهٔ واقعی نصب‌شده)
 *   • کارت «بررسی بروزرسانی»: ریپوی GitHub + دکمهٔ چک + نمایش changelog
 *     و دانلود مستقیم APK از Releases (پروکسی سرور — از ایران هم کار می‌کند)
 *   • نام سازندهٔ برنامه: trade_master65
 *   • راهنما: توضیح تب ارز دیجیتال، پیش‌بینی طلا، دارایی ریالی/فلزات،
 *     کیف پول بلاکچین + بخش کامل «IP و فیلترشکن» (ایران / فیلترشکن روشن)
 */

import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Image,
  TextInput,
  Linking,
  ActivityIndicator,
} from 'react-native';
import {
  ChevronDown,
  ChevronUp,
  HelpCircle,
  Info,
  Moon,
  RefreshCw,
  Sun,
  Download,
  User,
  CheckCircle2,
  XCircle,
  Github,
} from 'lucide-react-native';
import colors from '@/constants/colors';
import { createThemedStyles } from '@/utils/themeStyles';
import DropdownPicker from '@/components/DropdownPicker';
import IpStatusCard from '@/components/IpStatusCard';
import { useApp } from '@/contexts/AppContext';
import { APP_VERSION, APP_VERSION_CODE, APP_DEVELOPER } from '@/constants/appInfo';
import { checkForUpdate, isValidRepoSlug, type UpdateInfo } from '@/utils/updateChecker';

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

/** راهنماهای مدیریت دارایی — v1.2.0 (تب‌ها + IP) */
const HELP_SECTIONS = [
  {
    id: 'wallet',
    title: '👛 مدیریت دارایی (نمای کلی)',
    content:
      'این بخش چهار تب دارد و کل سرمایه شما را یکجا نشان می‌دهد (ترتیب تب‌ها از سمت راست: دارایی ریالی و فلزات، پیش‌بینی طلا، کیف پول بلاکچین، ارز دیجیتال). تب «دارایی ریالی و فلزات» بدون فیلترشکن هم کامل کار می‌کند؛ دو تب «ارز دیجیتال» و «کیف پول بلاکچین» برای امنیت دارایی شما فقط با IP غیرتحریمی (فیلترشکن روشن) فعال می‌شوند — توضیح کامل در راهنمای «IP و فیلترشکن».',
  },
  {
    id: 'crypto-tab',
    title: '💠 تب ارز دیجیتال (صرافی‌ها) — چطور کار می‌کند؟',
    content:
      'صرافی‌هایتان را با API Key اضافه کنید (بایننس، بای‌بیت، اوکی‌ایکس، کوکوین و ۲۰ صرافی دیگر + بیت‌پرپ با ورود ایمیل و کد یکبارمصرف). فقط از دسترسی Read-Only استفاده کنید؛ کلیدها فقط روی حافظهٔ خود دستگاه ذخیره می‌شوند.\n\nچه چیزی نشان می‌دهد: موجودی کامل هر صرافی (اسپات + ارن/سپرده‌گذاری + فاندینگ + فیوچرز + آلفا)، ارزش دلاری و تومانی هر دارایی، سود/زیان تقریبی هر کوین نسبت به میانگین خرید (از تاریخچهٔ معاملات) و PnL کلی صرافی با تایم‌فریم‌های امروز/۳۰/۹۰/۱۸۰/۳۶۰ روز (پیش‌فرض: امروز). کارت بالای صفحه مجموع همهٔ صرافی‌ها را دلاری و تومانی نشان می‌دهد.\n\nقیمت‌ها: از بایننس اسپات و فیوچرز خوانده می‌شود (کوین‌هایی مثل POPCAT فقط در فیوچرز معامله می‌شوند)؛ برای بقیه CoinGecko. ردیف‌های بدون قیمت حذف نمی‌شوند و با «قیمت نامشخص» می‌مانند.\n\n⚠️ این تب فقط با IP غیرتحریمی کار می‌کند؛ با IP ایران پیام خطای IP می‌بینید و هیچ درخواستی به صرافی‌ها نمی‌رود.',
  },
  {
    id: 'gold-tab',
    title: '🥇 تب پیش‌بینی قیمت طلا — چطور کار می‌کند؟',
    content:
      'این تب قیمت طلای ۱۸ عیار فردا/سررسید بعدی را از بازار آتی بورس کالا (IME) تخمین می‌زند:\n\n• قیمت لحظه‌ای طلا از TGJU خوانده می‌شود (گرم ۱۸ و ۲۴ عیار).\n• قراردادهای «آتی شمش طلای خام ۹۹۵» بورس کالا را می‌خواند: آخرین سررسید، قیمت هر گرم شمش ۹۹۵ و جدول همهٔ سررسیدها.\n• تبدیل: طلای ۱۸ عیار = قیمت شمش ۹۹۵ × ضریب ۷۵۰÷۹۹۵ (همان فرمول رایج بازار). عدد بزرگ صفحه = پیش‌بینی گرم ۱۸ عیار بر اساس آخرین معاملهٔ آتی؛ اختلافش با قیمت روز را هم کنارش نشان می‌دهد.\n• اگر IME در دسترس نباشد، حالت «ورود دستی» باز می‌شود تا قیمت شمش ۹۹۵ را خودتان وارد کنید و محاسبه با همان انجام شود.\n• دکمهٔ رفرش، هم قیمت‌های TGJU و هم قراردادهای آتی را از نو می‌خواند. این تب با IP ایران هم کار می‌کند (منابع داخلی‌اند؛ فقط جدول IME ممکن است موقتاً در دسترس نباشد).',
  },
  {
    id: 'rial-assets',
    title: '🏦 تب دارایی ریالی و فلزات',
    content:
      'مدیریت دارایی‌های غیرکریپتوی شما — بدون فیلترشکن کامل کار می‌کند:\n\n• قیمت‌های لحظه‌ای تومان از TGJU: طلای ۱۸/۲۴ عیار، نقره ۹۹۹/۹۲۵، سکه امامی/بهار/نیم/ربع، دلار آزاد و تتر — با دکمهٔ رفرش که هر بار یک دریافت واقعی انجام می‌دهد.\n• وضعیت بازار جهانی طلا (باز/بسته) کنار قیمت انس جهانی: بازار باز → کادر سبز، بازار بسته → کادر قرمز.\n• ورودی‌های شما: ریال/تومان نقدی، دلار کاغذی، تتر دستی (جدا از تتر صرافی/کیف)، طلا بر حسب گرم با عیار ۱۸ یا ۲۴، نقره ۹۹۹/۹۲۵ و سکه‌ها — همه در حافظهٔ دستگاه و هر ردیف با ارزش تومانی زنده.\n• کارت سود/زیان با تایم‌فریم‌های «امروز/۷/۳۰/۹۰/۱۸۰ روز» (پیش‌فرض: امروز) بر اساس تاریخچهٔ قیمت روزانهٔ TGJU؛ سهم کیف پول بلاکچین هم در همان کارت محاسبه می‌شود.\n• «مجموع کل دارایی» = ریال + دلار + تتر + طلا + نقره + سکه + ارز دیجیتال صرافی‌ها + کیف پول بلاکچین.',
  },
  {
    id: 'blockchain-wallet',
    title: '⛓ تب کیف پول بلاکچین (فقط خواندنی)',
    content:
      'مثل داشتن تراست ولتم داخل همین برنامه — بدون هیچ ریسکی:\n\n• فقط آدرس عمومی وارد می‌کنید؛ نه کلید خصوصی نه عبارت بازیابی — برداشت از کیف شما غیرممکن است.\n• منوی کشویی شبکه‌ها: ۵۱ شبکه — همهٔ شبکه‌های EVM (اتریوم، BSC، پالیگان، آربیتروم، بیس، آوالانچ و…) با یک آدرس 0x مشترک + شبکه‌های مستقل: تون (Tonkeeper)، ترون، سولانا، بیت‌کوین، ریپل، فایل‌کوین و… که آدرس اختصاصی خودشان را در کادر همان شبکه وارد می‌کنید.\n• لیست دارایی‌ها: هر ارز با آیکون واقعی خودش؛ نام ارز سمت راست و شبکهٔ آن داخل پرانتز جلوش (همچنین نشان کوچکِ رنگی شبکه روی گوشهٔ آیکون). وسط ردیف: تعداد دارایی و زیرش درصد رشد همان تایم‌فریم؛ سمت چپ: ارزش کل و زیرش سود/زیان دلاری ($ و درصد).\n• Tonkeeper: آدرس UQ/EQ کیف تون را اضافه کنید — موجودی TON و همهٔ جتون‌ها (مثل USDT تون) خوانده می‌شود (سه منبع پشتیبان + تلاش مجدد خودکار).\n• سود/زیان سه‌سطحی با تایم‌فریم‌های امروز/۷/۳۰/۹۰/۱۸۰ روز: کل در بالا، هر کیف یک خط، و هر ارز داخل کیف. دارایی این تب در تب ریالی هم حساب می‌شود.\n• این تب فقط با IP غیرتحریمی کار می‌کند؛ با IP ایران هیچ درخواستی به سرورهای بلاکچین نمی‌رود.',
  },
  {
    id: 'ip-vpn',
    title: '🌐 IP و فیلترشکن — برنامه با هر IP چطور کار می‌کند؟',
    content:
      'برنامه هر چند ثانیه کشور IP خروجی شما را چک می‌کند (۴ سرویس مستقل + سرور خودمان) و بسته به نتیجه این‌طور رفتار می‌کند:\n\n🔴 IP ایران یا کشور تحریمی (فیلترشکن خاموش):\n• تب «ارز دیجیتال» و تب «کیف پول بلاکچین» کاملاً غیرفعال می‌شوند و به‌جای داده، کارت خطای IP با توضیح علت می‌بینید.\n• مهم: با این IP حتی یک بایت از گوشی شما به صرافی‌ها و سرورهای بلاکچین نمی‌رسد — این گیت هم در لایهٔ کوئری‌ها است و هم داخل خود توابع دریافت؛ پس دارایی شما هرگز در معرض اتصال خطرناک قرار نمی‌گیرد.\n• چرا؟ صرافی‌های خارجی با IP ایران حساب را ریسک‌فلگ/مسدود می‌کنند (خطای 451/418) و APIهای بلاکچین هم از ایران در دسترس نیستند.\n• تب‌های «دارایی ریالی و فلزات» و «پیش‌بینی طلا» عادی کار می‌کنند (منابع: TGJU و سایت‌های داخلی). قیمت تتر هم از منابع ایرانی خوانده می‌شود.\n\n🟢 فیلترشکن روشن و IP غیرتحریمی:\n• همهٔ تب‌ها فعال می‌شوند؛ صرافی‌ها و کیف‌های بلاکچین خودکار تازه می‌شوند (بدون نیاز به رفرش دستی).\n• اگر یک صرافی خاص کشورِ IP شما را تحریم کرده باشد، فقط همان صرافی پیام «این IP تحریم شده» می‌دهد و بقیه کار می‌کنند — IP دیگری در فیلترشکن انتخاب کنید.\n\n⚪ اگر هیچ سرویسی نتوانست کشور را تشخیص دهد، وضعیت «نامشخص» می‌شود و برنامه محتاطانه مانع هیچ بخشی نمی‌شود (فقط بنر هشدار در صورت اتصال صرافی خارجی).',
  },
];

/** ── v1.2.0 — کارت بررسی بروزرسانی ── */
function UpdateCard() {
  const { settings, updateSettings } = useApp();
  const savedRepo = settings.githubRepo ?? '';
  const [repoInput, setRepoInput] = useState(savedRepo);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UpdateInfo | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const repoValid = isValidRepoSlug(repoInput);
  const repoChanged = repoInput.trim() !== savedRepo;

  const check = useCallback(async () => {
    const repo = repoChanged ? repoInput.trim() : savedRepo;
    if (!isValidRepoSlug(repo)) return;
    if (repoChanged) {
      updateSettings({ githubRepo: repo });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    }
    setBusy(true);
    setResult(null);
    try {
      setResult(await checkForUpdate(repo, APP_VERSION));
    } finally {
      setBusy(false);
    }
  }, [repoChanged, repoInput, savedRepo, updateSettings]);

  const download = (url?: string) => {
    if (url) void Linking.openURL(url);
  };

  return (
    <View style={styles.updateCard}>
      <View style={styles.updateHeadRow}>
        <Text style={styles.updateTitle}>بروزرسانی برنامه</Text>
        <Text style={styles.updateVersion}>
          نصب‌شده: {APP_VERSION} (کد {APP_VERSION_CODE.toLocaleString('fa-IR')})
        </Text>
      </View>

      <Text style={styles.updateHint}>
        ریپوی گیتهاب خود را وارد کنید (به شکل owner/repo) و دکمهٔ چک را بزنید. هر وقت در گیتهاب
        یک Release جدید با فایل APK منتشر کنید، پیام نسخهٔ جدید همراه توضیحات و دکمهٔ دانلود
        بالای صفحهٔ برنامه ظاهر می‌شود.
      </Text>

      <View style={styles.updateInputRow}>
        <TextInput
          style={[styles.updateInput, repoValid && repoInput.trim() ? styles.updateInputOk : null]}
          value={repoInput}
          onChangeText={setRepoInput}
          placeholder="مثلاً myuser/asset-management"
          placeholderTextColor={colors.dark.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          testID="update-repo-input"
        />
        <Pressable
          style={[styles.checkBtn, (!repoValid || busy) && styles.checkBtnDisabled]}
          disabled={!repoValid || busy}
          onPress={() => void check()}
          testID="check-update-btn"
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.dark.background} />
          ) : (
            <>
              <Github size={14} color={colors.dark.background} />
              <Text style={styles.checkBtnText}>
                {savedFlash ? 'ذخیره شد ✓' : 'چک بروزرسانی'}
              </Text>
            </>
          )}
        </Pressable>
      </View>

      {result && !result.error && !result.available && (
        <View style={styles.resultRow}>
          <CheckCircle2 size={15} color={colors.dark.green} />
          <Text style={styles.resultOk}>
            {result.latestVersion
              ? `به‌روز هستید — آخرین نسخه روی گیتهاب: ${result.latestVersion}`
              : 'به‌روز هستید'}
          </Text>
        </View>
      )}

      {result && result.available && (
        <View style={styles.updateFoundBox}>
          <Text style={styles.updateFoundTitle}>
            نسخه جدید {result.latestVersion} موجود است
          </Text>
          {(result.notes ?? '')
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(0, 5)
            .map((l, i) => (
              <Text key={i} style={styles.updateFoundNote} numberOfLines={3}>
                • {l.replace(/^[-*•]\s*/, '')}
              </Text>
            ))}
          <Pressable
            style={styles.downloadBtn}
            onPress={() => download(result.apkUrl || result.releaseUrl)}
          >
            <Download size={14} color={colors.dark.background} />
            <Text style={styles.downloadBtnText}>
              {result.apkUrl ? 'دانلود مستقیم APK' : 'رفتن به صفحهٔ دانلود'}
            </Text>
          </Pressable>
        </View>
      )}

      {result?.error && result.error !== 'no-repo' && (
        <View style={styles.resultRow}>
          <XCircle size={15} color={colors.dark.red} />
          <Text style={styles.resultErr}>
            {result.error === 'github-unreachable'
              ? 'دسترسی به گیتهاب برقرار نشد — بعداً تلاش کنید'
              : `خطا: ${result.error}`}
          </Text>
        </View>
      )}
      {result?.error === 'no-release' && (
        <View style={styles.resultRow}>
          <XCircle size={15} color={colors.dark.orange} />
          <Text style={styles.resultErr}>
            برای این ریپو هنوز Release نسخه‌سازی شده — در گیتهاب Releases → New release با تگ
            v1.2.1 بسازید و فایل APK را پیوست کنید
          </Text>
        </View>
      )}
    </View>
  );
}

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

      {/* ── بررسی IP و فیلترشکن (هر ۳ ثانیه اتوماتیک) ── */}
      <View style={styles.ipWrap}>
        <IpStatusCard />
      </View>

      {/* ── v1.2.0 — بررسی بروزرسانی ──────────────────────────── */}
      <UpdateCard />

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

      {/* ── راهنما ─────────────────────────────────────────────── */}
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
            <Image source={require('@/assets/images/icon.png')} style={styles.aboutLogo} />
          </View>
          <View style={styles.aboutTextWrap}>
            <Text style={styles.aboutName}>مدیریت دارایی</Text>
            <Text style={styles.aboutVersion}>
              نسخه {APP_VERSION} (کد {APP_VERSION_CODE.toLocaleString('fa-IR')})
            </Text>
            {/* v1.2.0 — نام سازندهٔ برنامه */}
            <View style={styles.devRow}>
              <User size={12} color={colors.dark.accent} />
              <Text style={styles.devText}>سازنده: {APP_DEVELOPER}</Text>
            </View>
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
    ipWrap: {
      marginBottom: 16,
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

    // ── v1.2.0 — کارت بروزرسانی ──
    updateCard: {
      backgroundColor: colors.dark.card,
      borderRadius: 16,
      padding: 16,
      marginBottom: 16,
      borderWidth: 1,
      borderColor: colors.dark.accent + '44',
      gap: 10,
    },
    updateHeadRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    },
    updateTitle: {
      fontSize: 15,
      fontWeight: '700' as const,
      color: colors.dark.text,
    },
    updateVersion: {
      fontSize: 11.5,
      fontWeight: '700' as const,
      color: colors.dark.accent,
    },
    updateHint: {
      fontSize: 11.5,
      lineHeight: 19,
      color: colors.dark.textMuted,
      textAlign: 'right',
    },
    updateInputRow: {
      flexDirection: 'row',
      gap: 8,
    },
    updateInput: {
      flex: 1,
      backgroundColor: colors.dark.inputBg,
      borderWidth: 1,
      borderColor: colors.dark.border,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 12.5,
      color: colors.dark.text,
      textAlign: 'left',
    },
    updateInputOk: {
      borderColor: colors.dark.green + '88',
    },
    checkBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: colors.dark.accent,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    checkBtnDisabled: {
      opacity: 0.5,
    },
    checkBtnText: {
      fontSize: 12,
      fontWeight: '800' as const,
      color: colors.dark.background,
    },
    resultRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    resultOk: {
      flex: 1,
      fontSize: 12,
      color: colors.dark.green,
      textAlign: 'right',
    },
    resultErr: {
      flex: 1,
      fontSize: 11.5,
      lineHeight: 18,
      color: colors.dark.red,
      textAlign: 'right',
    },
    updateFoundBox: {
      backgroundColor: colors.dark.greenDim,
      borderRadius: 12,
      padding: 12,
      gap: 6,
    },
    updateFoundTitle: {
      fontSize: 13,
      fontWeight: '800' as const,
      color: colors.dark.green,
      textAlign: 'right',
    },
    updateFoundNote: {
      fontSize: 11,
      lineHeight: 17,
      color: colors.dark.textSecondary,
      textAlign: 'right',
    },
    downloadBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: colors.dark.accent,
      borderRadius: 10,
      paddingVertical: 10,
      marginTop: 4,
    },
    downloadBtnText: {
      fontSize: 12.5,
      fontWeight: '800' as const,
      color: colors.dark.background,
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
      overflow: 'hidden',
    },
    aboutLogo: {
      width: 46,
      height: 46,
      borderRadius: 11,
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
    devRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      justifyContent: 'flex-end',
      marginTop: 4,
    },
    devText: {
      fontSize: 12,
      fontWeight: '700' as const,
      color: colors.dark.accent,
    },
  })
);
