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

import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Image,
  Linking,
  ActivityIndicator,
  Platform,
  Switch,
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
  BellRing,
  Zap,
  BatteryCharging,
  Pin,
} from 'lucide-react-native';
import colors from '@/constants/colors';
import { createThemedStyles } from '@/utils/themeStyles';
import DropdownPicker from '@/components/DropdownPicker';
import IpStatusCard from '@/components/IpStatusCard';
import { useApp } from '@/contexts/AppContext';
import { APP_VERSION, APP_VERSION_CODE, APP_DEVELOPER, DEFAULT_GITHUB_REPO } from '@/constants/appInfo';
import {
  checkForUpdate,
  notifyUpdateAvailable,
  type UpdateInfo,
} from '@/utils/updateChecker';
// v1.3.8 — سرویس «اعلان رشد/ریزش قیمت» حتی با برنامهٔ بسته
import {
  loadAlertConfig,
  saveAlertConfigLocal,
  syncPriceAlertConfig,
  DEFAULT_ALERT_CONFIG,
  requestNotificationPermission,
  testAlert,
  checkNow,
  getAlertStatus,
  isIgnoringBatteryOptimizations,
  requestIgnoreBatteryOptimizations,
  openBatterySettings,
  openAppDetailsSettings,
  type PriceAlertConfig,
  type PriceAlertStatus,
} from '@/utils/priceAlertApi';

/** آستانه‌های اعلان — گزینه‌ها به درصد */
const COIN_THRESHOLD_OPTIONS = [
  { key: '1', label: '۱ درصد' },
  { key: '2', label: '۲ درصد' },
  { key: '3', label: '۳ درصد' },
  { key: '5', label: '۵ درصد' },
  { key: '10', label: '۱۰ درصد' },
  { key: '15', label: '۱۵ درصد' },
  { key: '20', label: '۲۰ درصد' },
  { key: '30', label: '۳۰ درصد' },
  { key: '50', label: '۵۰ درصد' },
];

const METAL_THRESHOLD_OPTIONS = [
  { key: '0.3', label: 'سه‌دهم درصد' },
  { key: '0.5', label: 'نیم درصد' },
  { key: '1', label: '۱ درصد' },
  { key: '1.5', label: '۱.۵ درصد' },
  { key: '2', label: '۲ درصد' },
  { key: '3', label: '۳ درصد' },
  { key: '5', label: '۵ درصد' },
];

/**
 * v1.4.2 — تکرار اعلان: تا وقتی دارایی بالای آستانه مانده، هر چند ساعت دوباره
 * اعلان بدهد (برای وقتی که اعلان اول را ندیدی). ۰ = فقط بار اول (رفتار قدیمی).
 */
const REPEAT_HOURS_OPTIONS = [
  { key: '0', label: 'فقط بار اول' },
  { key: '1', label: 'هر ۱ ساعت' },
  { key: '3', label: 'هر ۳ ساعت' },
  { key: '6', label: 'هر ۶ ساعت (پیش‌فرض)' },
  { key: '12', label: 'هر ۱۲ ساعت' },
  { key: '24', label: 'هر ۲۴ ساعت' },
];

/** زمان فارس‌شده برای خط وضعیت */
function toFaTime(ts?: number): string | null {
  if (!ts) return null;
  try {
    return new Date(ts).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return null;
  }
}

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

/** راهنماهای مدیریت دارایی — v1.2.0 (تب‌ها + IP)؛ v1.5.0 (تب قیمت‌ها) */
const HELP_SECTIONS = [
  {
    id: 'prices-tab',
    title: '📈 تب قیمت‌ها (جدید) — همهٔ قیمت‌های لحظه‌ای یکجا',
    content:
      'از نسخهٔ ۱.۵.۰ همهٔ قیمت‌های لحظه‌ای به تب اول «قیمت‌ها» منتقل شدند (بدون نیاز به سرور، مستقیم از گوشی):\n\n• طلا و فلزات: همان کادرهای قبلی — انس جهانی، طلای ۱۸/۲۴ عیار، نقره ۹۹۹/۹۲۵، سکه‌ها + وضعیت بازار جهانی طلا + کارت خرید/فروش طلایین taline.ir.\n• ارز: دلار آزاد و تتر.\n• ارزهای دیجیتال: بیت‌کوین و اتریوم، هر کدام در یک کادر با دو قیمت — دلاری (بایننس) و تومانی (نوبیتکس) — به‌همراه ٪ تغییر ۲۴ ساعته. قیمت کریپتو هر ۶۰ ثانیه خودکار تازه می‌شود.\n• چشمک‌زن رشد/ریزش (v1.4.2) روی کادرهای همین تب هم فعال است.',
  },
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
      'مدیریت دارایی‌های غیرکریپتوی شما — بدون فیلترشکن کامل کار می‌کند. از نسخهٔ ۱.۵.۰ جدول قیمت‌های لحظه‌ای به تب «قیمت‌ها» منتقل شده و این کارت ساده‌تر شده است:\n\n• «مجموع کل دارایی» = ریال + دلار + تتر + طلا + نقره + سکه + ارز دیجیتال صرافی‌ها + کیف پول بلاکچین.\n• کارت سود/زیان (PnL) با تایم‌فریم‌های «امروز/۷/۳۰/۹۰/۱۸۰ روز» (پیش‌فرض: امروز) بر اساس تاریخچهٔ قیمت روزانهٔ TGJU؛ سهم کیف پول بلاکچین هم در همان کارت محاسبه می‌شود.\n• «دارایی‌های من»: ورودی‌های شما — ریال/تومان نقدی، دلار کاغذی، تتر دستی (جدا از تتر صرافی/کیف)، طلا بر حسب گرم با عیار ۱۸ یا ۲۴، نقره ۹۹۹/۹۲۵ و سکه‌ها — همه در حافظهٔ دستگاه و هر ردیف با ارزش تومانی زنده.',
  },
  {
    id: 'blockchain-wallet',
    title: '⛓ تب کیف پول بلاکچین (فقط خواندنی)',
    content:
      'مثل داشتن تراست ولتم داخل همین برنامه — بدون هیچ ریسکی:\n\n• فقط آدرس عمومی وارد می‌کنید؛ نه کلید خصوصی نه عبارت بازیابی — برداشت از کیف شما غیرممکن است.\n• منوی کشویی شبکه‌ها: ۵۱ شبکه — همهٔ شبکه‌های EVM (اتریوم، BSC، پالیگان، آربیتروم، بیس، آوالانچ و…) با یک آدرس 0x مشترک + شبکه‌های مستقل: تون (Tonkeeper)، ترون، سولانا، بیت‌کوین، ریپل، فایل‌کوین و… که آدرس اختصاصی خودشان را در کادر همان شبکه وارد می‌کنید.\n• لیست دارایی‌ها: هر ارز با آیکون واقعی خودش؛ نام ارز سمت راست و شبکهٔ آن داخل پرانتز جلوش (همچنین نشان کوچکِ رنگی شبکه روی گوشهٔ آیکون). وسط ردیف: تعداد دارایی و زیرش درصد رشد همان تایم‌فریم؛ سمت چپ: ارزش کل و زیرش فقط سود/زیان دلاری همان تایم‌فریم.\n• کپی آدرس: دکمهٔ کپی کنار آدرس کیف — همان 0x آدرسِ مشترک همهٔ شبکه‌های EVM (اتریوم، BSC و…) است؛ آدرس اختصاصی هر شبکهٔ مستقل هم داخل کارت بازشده ردیف کپی خودش را دارد.\n• Tonkeeper: آدرس UQ/EQ کیف تون را اضافه کنید — موجودی TON و همهٔ جتون‌ها (مثل USDT تون) خوانده می‌شود (سه منبع پشتیبان + زنجیرهٔ کامل روی سرور خودمان؛ اگر APIهای عمومی روی IP فیلترشکن محدود شده باشند، سرور جایگزین می‌کند و موجودی می‌آید).\n• سود/زیان سه‌سطحی با تایم‌فریم‌های امروز/۷/۳۰/۹۰/۱۸۰ روز: کل در بالا، هر کیف یک خط، و هر ارز داخل کیف. دارایی این تب در تب ریالی هم حساب می‌شود.\n• این تب فقط با IP غیرتحریمی کار می‌کند؛ با IP ایران هیچ درخواستی به سرورهای بلاکچین نمی‌رود.',
  },
  {
    id: 'ip-vpn',
    title: '🌐 IP و فیلترشکن — برنامه با هر IP چطور کار می‌کند؟',
    content:
      'برنامه هر چند ثانیه کشور IP خروجی شما را چک می‌کند (۴ سرویس مستقل + سرور خودمان) و بسته به نتیجه این‌طور رفتار می‌کند:\n\n🔴 IP ایران یا کشور تحریمی (فیلترشکن خاموش):\n• تب «ارز دیجیتال» و تب «کیف پول بلاکچین» کاملاً غیرفعال می‌شوند و به‌جای داده، کارت خطای IP با توضیح علت می‌بینید.\n• مهم: با این IP حتی یک بایت از گوشی شما به صرافی‌ها و سرورهای بلاکچین نمی‌رسد — این گیت هم در لایهٔ کوئری‌ها است و هم داخل خود توابع دریافت؛ پس دارایی شما هرگز در معرض اتصال خطرناک قرار نمی‌گیرد.\n• چرا؟ صرافی‌های خارجی با IP ایران حساب را ریسک‌فلگ/مسدود می‌کنند (خطای 451/418) و APIهای بلاکچین هم از ایران در دسترس نیستند.\n• تب‌های «دارایی ریالی و فلزات» و «پیش‌بینی طلا» عادی کار می‌کنند (منابع: TGJU و سایت‌های داخلی). قیمت تتر هم از منابع ایرانی خوانده می‌شود.\n\n🟢 فیلترشکن روشن و IP غیرتحریمی:\n• همهٔ تب‌ها فعال می‌شوند؛ صرافی‌ها و کیف‌های بلاکچین خودکار تازه می‌شوند (بدون نیاز به رفرش دستی).\n• اگر یک صرافی خاص کشورِ IP شما را تحریم کرده باشد، فقط همان صرافی پیام «این IP تحریم شده» می‌دهد و بقیه کار می‌کنند — IP دیگری در فیلترشکن انتخاب کنید.\n\n⚪ اگر هیچ سرویسی نتوانست کشور را تشخیص دهد، وضعیت «نامشخص» می‌شود و برنامه محتاطانه مانع هیچ بخشی نمی‌شود (فقط بنر هشدار در صورت اتصال صرافی خارجی).',
  },
];

/** ── v1.3.1 — کارت بررسی بروزرسانی (ساده‌شده به خواست کاربر) ──
 * «لینک ریپو و توضیحات را نشون نده — فقط دکمهٔ چک و توضیح اینکه اگه
 * بروزرسانی بیاد پیغام بالا برنامه نمایش داده میشه همین»
 * ریپو از قبل داخل برنامه است (DEFAULT_GITHUB_REPO) و هیچ ورودی از کاربر
 * نمی‌خواهد؛ نتیجهٔ چک هم همین‌جا و هم به شکل بنر بالای صفحه می‌آید.
 */
function UpdateCard() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UpdateInfo | null>(null);

  const check = useCallback(async () => {
    setBusy(true);
    setResult(null);
    try {
      const info = await checkForUpdate(DEFAULT_GITHUB_REPO, APP_VERSION);
      setResult(info);
      // پیدا شدن نسخهٔ جدید → بنر «نسخه جدید منتشر شد» همان لحظه بالای صفحهٔ
      // برنامه ظاهر می‌شود (بدون انتظار برای چک خودکار بعدی).
      if (info.available) notifyUpdateAvailable(info);
    } finally {
      setBusy(false);
    }
  }, []);

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
        اگر بروزرسانی جدیدی منتشر شود، پیام آن همراه توضیحات و دکمهٔ دانلود، خودکار بالای صفحهٔ
        برنامه نمایش داده می‌شود.
      </Text>

      <Pressable
        style={[styles.checkBtn, styles.checkBtnFull, busy && styles.checkBtnDisabled]}
        disabled={busy}
        onPress={() => void check()}
        testID="check-update-btn"
      >
        {busy ? (
          <ActivityIndicator size="small" color={colors.dark.background} />
        ) : (
          <>
            <Github size={14} color={colors.dark.background} />
            <Text style={styles.checkBtnText}>چک بروزرسانی</Text>
          </>
        )}
      </Pressable>

      {result && !result.error && !result.available && (
        <View style={styles.resultRow}>
          <CheckCircle2 size={15} color={colors.dark.green} />
          <Text style={styles.resultOk}>
            {result.latestVersion
              ? `برنامه بروز است — آخرین نسخه (${result.latestVersion}) نصب است`
              : 'برنامه بروز است — آخرین نسخه نصب است'}
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
    </View>
  );
}

/** ── v1.3.8 — کارت «اعلان رشد قیمت» (v1.4.0: + ریزش) ──
 * سرویس پس‌زمینهٔ اندروید: هر ~۱۵ دقیقه و بلافاصله بعد از وصل‌شدن اینترنت
 * قیمت‌ها را چک می‌کند؛ کوین‌ها از آستانهٔ کوین، طلا/سکه/دلار از آستانهٔ
 * فلز/دلار رشد یا ریزش کنند، همان لحظه نوتیفیکیشن می‌آید — حتی با برنامهٔ
 * کاملاً بسته. دکمه‌ها: اعلان آزمایشی، بررسی همین حالا، بهینه‌سازی باتری.
 * خط وضعیت: آخرین بررسی/آخرین خطا/تعداد اعلان.
 */
function PriceAlertCard() {
  const [cfg, setCfg] = useState<PriceAlertConfig>(DEFAULT_ALERT_CONFIG);
  const [status, setStatus] = useState<PriceAlertStatus>({});
  const [batteryOk, setBatteryOk] = useState(true);
  const [busy, setBusy] = useState<'test' | 'check' | 'battery' | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const saved = await loadAlertConfig();
      if (alive) setCfg(saved);
      if (Platform.OS === 'android') {
        const st = await getAlertStatus();
        const bat = await isIgnoringBatteryOptimizations();
        if (alive) {
          setStatus(st);
          setBatteryOk(bat);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // خط وضعیت هر ۱۵ ثانیه تازه می‌شود («بررسی همین حالا» هم سریع جواب ببیند)
  useEffect(() => {
    if (Platform.OS !== 'android' || !cfg.enabled) return;
    const t = setInterval(() => {
      void getAlertStatus().then((st) => setStatus(st));
    }, 15_000);
    return () => clearInterval(t);
  }, [cfg.enabled]);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const handleToggle = useCallback(
    async (on: boolean) => {
      const next = { ...cfg, enabled: on };
      setCfg(next);
      await saveAlertConfigLocal(next);
      // v1.4.2 — روی اندروید ۱۳+ اول مجوز نوتیفیکیشن را بگیر؛ بدون آن سرویس
      // سالم کار می‌کند ولی هیچ اعلانی نشان داده نمی‌شود
      if (on && Platform.OS === 'android') {
        await requestNotificationPermission();
      }
      await syncPriceAlertConfig();
      if (on && Platform.OS === 'android') {
        const bat = await isIgnoringBatteryOptimizations();
        setBatteryOk(bat);
      }
    },
    [cfg],
  );

  const handleThreshold = useCallback(
    async (patch: Partial<PriceAlertConfig>) => {
      const next = { ...cfg, ...patch };
      setCfg(next);
      await saveAlertConfigLocal(next);
      await syncPriceAlertConfig();
    },
    [cfg],
  );

  const handleTest = useCallback(async () => {
    setBusy('test');
    try {
      const ok = await testAlert();
      flash(ok ? 'اعلان آزمایشی فرستاده شد — نوار وضعیت گوشی را ببینید' : 'اعلان آزمایشی فقط روی اندروید کار می‌کند');
    } finally {
      setBusy(null);
    }
  }, []);

  const handleCheckNow = useCallback(async () => {
    setBusy('check');
    try {
      await checkNow();
      setTimeout(() => void getAlertStatus().then((st) => setStatus(st)), 6000);
      flash('بررسی فوری انجام شد — نتیجه تا چند لحظه دیگر در خط وضعیت می‌آید');
    } finally {
      setBusy(null);
    }
  }, []);

  /**
   * v1.4.2 — زنجیرهٔ مطمئن باتری: دیالوگ رسمی سیستم → ۱.۸ ثانیه صبر و چک
   * مجدد → اگر مجوز نیامده بود (شیائومی گاهی پنجره را قورت می‌دهد و هیچ
   * پنجره‌ای باز نمی‌شود) خودکار «لیست بهینه‌سازی باتری» باز می‌شود → اگر
   * آن هم نشد، خودکار صفحهٔ «تنظیمات برنامه» باز می‌شود. کاربر در هر حالت
   * یک پنجرهٔ واقعی از گوشی می‌بیند و پیام کوتاهِ روشن می‌گیرد.
   */
  const handleBattery = useCallback(async () => {
    setBusy('battery');
    try {
      const already = await isIgnoringBatteryOptimizations();
      if (already) {
        setBatteryOk(true);
        flash('از قبل مجاز است — کاری لازم نیست ✓');
        return;
      }
      const result = await requestIgnoreBatteryOptimizations();
      if (result === 'already') {
        setBatteryOk(true);
        flash('از قبل مجاز است — کاری لازم نیست ✓');
        return;
      }
      if (result === 'failed') {
        // پنجرهٔ مستقیم روی این گوشی باز نشد → لیست سیستمی
        await openBatterySettings();
        flash('پنجرهٔ مستقیم باز نشد — لیست «بهینه‌سازی باتری» باز شد: برنامه را پیدا و Allow کنید');
        return;
      }
      // پنجرهٔ رسمی فرستاده شد — بگذار کاربر جواب دهد، بعد چک کن
      flash('پنجرهٔ مجوز اندروید باز شد — گزینهٔ Allow را بزنید');
      const check = setTimeout(() => {
        void (async () => {
          const ok = await isIgnoringBatteryOptimizations();
          setBatteryOk(ok);
          if (!ok) {
            // پنجره باز شد ولی تأیید نشد یا گوشی پنجره را نشان نداد → لیست
            await openBatterySettings().catch(() => {});
          }
        })();
      }, 1800);
      void check;
    } finally {
      setBusy(null);
    }
  }, []);

  const handleBatterySettings = useCallback(async () => {
    setBusy('battery');
    try {
      await openBatterySettings();
      flash('لیست «بهینه‌سازی باتری» باز شد — برنامه را از لیست انتخاب و Allow کنید');
    } finally {
      setBusy(null);
    }
  }, []);

  // v1.4.1 — صفحهٔ اطلاعات برنامه (مسیر مطمئن شیائومی/هوآوی: Battery → No restrictions)
  const handleAppDetails = useCallback(async () => {
    setBusy('battery');
    try {
      await openAppDetailsSettings();
      flash('صفحهٔ برنامه در تنظیمات باز شد — Battery → No restrictions (شیائومی/هوآوی)');
    } finally {
      setBusy(null);
    }
  }, []);

  // v1.4.1 — کارت روی وب هم دیده می‌شود (تنظیمات آستانه‌ها مشترک است)؛
  // فقط دکمه‌های مخصوص سرویس پس‌زمینهٔ اندروید آنجا مخفی می‌شوند.
  const isAndroid = Platform.OS === 'android';

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <BellRing size={18} color={colors.dark.accent} />
        <Text style={styles.sectionTitle}>اعلان رشد و ریزش قیمت</Text>
      </View>

      <View style={styles.alertSwitchRow}>
        <View style={styles.alertRowText}>
          <Text style={styles.alertRowTitle}>اعلان رشد و ریزش، حتی وقتی برنامه بسته است</Text>
          <Text style={styles.hintText}>
            سرویس پس‌زمینه (هر ~۱۵ دقیقه و بلافاصله بعد از وصل‌شدن اینترنت) قیمت‌ها را چک
            می‌کند: کوین‌های کیف پول و صرافی از آستانهٔ کوین، طلای ۱۸ عیار/سکه/دلار از آستانهٔ
            طلا و دلار بالاتر بروند یا پایین‌تر بیایند، همان لحظه نوتیفیکیشن می‌آید — با لوگوی
            برنامه و قیمت درست به تومان.
          </Text>
        </View>
        <Switch
          value={cfg.enabled}
          onValueChange={(v) => void handleToggle(v)}
          trackColor={{ false: colors.dark.border, true: colors.dark.accent }}
          thumbColor="#fff"
          testID="price-alert-switch"
        />
      </View>

      {cfg.enabled && (
        <>
          <DropdownPicker
            label="🔔 کوین‌ها (کیف پول و صرافی — ۲۴ ساعت):"
            value={String(cfg.coinPct)}
            options={COIN_THRESHOLD_OPTIONS}
            onSelect={(key) => void handleThreshold({ coinPct: Number(key) })}
            showLabelOnBar
            triggerBackgroundColor={colors.dark.background}
            testID="price-alert-coin-threshold"
          />
          <DropdownPicker
            label="🥇 طلا و دلار (روزانه):"
            value={String(cfg.metalPct)}
            options={METAL_THRESHOLD_OPTIONS}
            onSelect={(key) => void handleThreshold({ metalPct: Number(key) })}
            showLabelOnBar
            triggerBackgroundColor={colors.dark.background}
            testID="price-alert-metal-threshold"
          />
          {/* v1.4.2 — تکرار اعلان: برای وقتی که اعلان اول را ندیدی */}
          <DropdownPicker
            label="🔁 تکرار اعلان تا دیدن (تا وقتی سیگنال برقرار است):"
            value={String(cfg.repeatHours)}
            options={REPEAT_HOURS_OPTIONS}
            onSelect={(key) => void handleThreshold({ repeatHours: Number(key) })}
            showLabelOnBar
            triggerBackgroundColor={colors.dark.background}
            testID="price-alert-repeat"
          />
          <Text style={styles.hintText}>
            با «تکرار»، تا وقتی دارایی بالای آستانه مانده، همان اعلان هر چند ساعت دوباره
            می‌آید — مثل یادآور. «فقط بار اول» رفتار قدیمی است (اعلان فقط یک‌بار).
          </Text>

          {isAndroid && (
          <>
          <View style={styles.alertBtnRow}>
            <Pressable style={({ pressed }) => [styles.alertBtn, pressed && { opacity: 0.85 }]} onPress={() => void handleTest()} testID="price-alert-test">
              <BellRing size={14} color={colors.dark.accent} />
              <Text style={styles.alertBtnText}>{busy === 'test' ? 'در حال ارسال…' : 'اعلان آزمایشی'}</Text>
            </Pressable>
            <Pressable style={({ pressed }) => [styles.alertBtn, pressed && { opacity: 0.85 }]} onPress={() => void handleCheckNow()} testID="price-alert-check-now">
              <Zap size={14} color={colors.dark.accent} />
              <Text style={styles.alertBtnText}>{busy === 'check' ? 'در حال بررسی…' : 'بررسی همین حالا'}</Text>
            </Pressable>
          </View>

          {/* وضعیت — همین‌جا، بدون رفتن به جای دیگر */}
          <View style={styles.alertStatusBox}>
            <Text style={styles.alertStatusText}>
              {status.lastRun
                ? `آخرین بررسی: ${toFaTime(status.lastRun) ?? '—'}`
                : 'هنوز بررسی‌ای انجام نشده — «بررسی همین حالا» را بزنید'}
              {status.runCount ? ` — ${Number(status.runCount).toLocaleString('fa-IR')} اجرا` : ''}
              {status.okCount ? ` — ${Number(status.okCount).toLocaleString('fa-IR')} اعلان` : ''}
            </Text>
            {status.lastError && (
              <Text style={styles.alertStatusErr}>آخرین خطا: {status.lastError}</Text>
            )}
          </View>

          {/* بهینه‌سازی باتری — مهم‌ترین علت «اعلان با برنامهٔ بسته نمی‌آید» */}
          <Pressable
            style={({ pressed }) => [styles.alertBatteryBtn, !batteryOk && styles.alertBatteryWarn, pressed && { opacity: 0.85 }]}
            onPress={() => void handleBattery()}
            testID="price-alert-battery"
          >
            <BatteryCharging size={14} color={batteryOk ? colors.dark.green : colors.dark.red} />
            <Text style={[styles.alertBtnText, !batteryOk && { color: colors.dark.red }]}>
              {batteryOk ? '✓ بهینه‌سازی باتری غیرفعال است' : 'بهینه‌سازی باتری خاموش است — بزن تا پنجرهٔ مجوز باز شود'}
            </Text>
          </Pressable>
          {/* v1.4.2 — دو راهِ دستی همیشه دیده می‌شوند (نه فقط بعد از خطا) */}
          <View style={styles.alertBtnRow}>
            <Pressable style={({ pressed }) => [styles.alertBtn, pressed && { opacity: 0.85 }]} onPress={() => void handleBatterySettings()} testID="price-alert-battery-list">
              <BatteryCharging size={14} color={colors.dark.accent} />
              <Text style={styles.alertBtnText}>لیست بهینه‌سازی باتری</Text>
            </Pressable>
            <Pressable style={({ pressed }) => [styles.alertBtn, pressed && { opacity: 0.85 }]} onPress={() => void handleAppDetails()} testID="price-alert-app-details">
              <Pin size={14} color={colors.dark.accent} />
              <Text style={styles.alertBtnText}>تنظیمات برنامه (شیائومی/هوآوی)</Text>
            </Pressable>
          </View>

          <View style={styles.alertNoteBox}>
            <Pin size={13} color={colors.dark.red} />
            <Text style={styles.alertNoteText}>
              نکتهٔ مهم اندروید: اعلان با برنامهٔ بسته به زبان گوشی (فارسی/انگلیسی) ربطی ندارد.
              اگر برنامه را با «Force Stop» ببندید، اندروید همهٔ سرویس‌هایش را تا بازکردن دوباره
              متوقف می‌کند (برای همهٔ اپلیکیشن‌ها همین است). از «Home» یا «recents» برای خروج
              استفاده کنید. روی شیائومی/هوآوی هم اگر اعلان نمی‌آید: تنظیمات → Permissions →
              Autostart را برای برنامه روشن و «Battery saver» را روی «No restrictions» بگذارید.
            </Text>
          </View>
          </>
          )}

          {!isAndroid && (
            <View style={styles.alertNoteBox}>
              <Pin size={13} color={colors.dark.accent} />
              <Text style={[styles.alertNoteText, { color: colors.dark.accent }]}>
                نسخهٔ وب: آستانه‌ها و چشمک‌زن رشد/ریزش روی صفحه همین‌جا تنظیم می‌شود، اما
                اعلان پس‌زمینهٔ گوشی (نوتیفیکیشن با برنامهٔ بسته) فقط در اپ اندروید کار می‌کند —
                APK را از کارت «بروزرسانی برنامه» نصب کنید.
              </Text>
            </View>
          )}
        </>
      )}

      {toast && <Text style={styles.alertToast}>{toast}</Text>}
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
        {/* v1.8.0 — خط تأکید هم‌خانواده با صفحهٔ مدیریت دارایی */}
        <View style={styles.headerAccent} />
      </View>

      {/* ── بررسی IP و فیلترشکن (هر ۳ ثانیه اتوماتیک) ── */}
      <View style={styles.ipWrap}>
        <IpStatusCard />
      </View>

      {/* ── v1.2.0 — بررسی بروزرسانی ──────────────────────────── */}
      <UpdateCard />

      {/* ── v1.3.8 — اعلان رشد/ریزش قیمت (سرویس پس‌زمینه) ─────── */}
      <PriceAlertCard />

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
    // v1.8.0 — خط تأکید زیر عنوان (هم‌خانواده با صفحهٔ مدیریت دارایی)
    headerAccent: {
      width: 44,
      height: 3,
      borderRadius: 2,
      marginTop: 7,
      backgroundColor: colors.dark.accent,
    },
    headerTitle: {
      fontSize: 20,
      fontWeight: '800' as const,
      color: colors.dark.text,
      letterSpacing: 0.2,
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

    // ── v1.3.8/1.4.0 — کارت اعلان رشد/ریزش قیمت ──
    alertSwitchRow: {
      flexDirection: 'row-reverse',
      alignItems: 'flex-start',
      gap: 10,
    },
    alertRowText: {
      flex: 1,
    },
    alertRowTitle: {
      fontSize: 13,
      fontWeight: '700' as const,
      color: colors.dark.text,
      textAlign: 'right',
      marginBottom: 4,
    },
    alertBtnRow: {
      flexDirection: 'row-reverse',
      gap: 8,
      marginTop: 12,
    },
    alertBtn: {
      flex: 1,
      flexDirection: 'row-reverse',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      backgroundColor: colors.dark.accentDim,
      borderWidth: 1,
      borderColor: colors.dark.accent + '55',
      borderRadius: 12,
      paddingVertical: 11,
    },
    alertBtnText: {
      fontSize: 12,
      fontWeight: '700' as const,
      color: colors.dark.accent,
      textAlign: 'center',
      flexShrink: 1,
    },
    alertStatusBox: {
      marginTop: 10,
      backgroundColor: colors.dark.background,
      borderRadius: 10,
      padding: 10,
      borderWidth: 1,
      borderColor: colors.dark.border,
    },
    alertStatusText: {
      fontSize: 11,
      color: colors.dark.textSecondary,
      textAlign: 'right',
    },
    alertStatusErr: {
      marginTop: 4,
      fontSize: 11,
      color: colors.dark.red,
      textAlign: 'right',
    },
    alertBatteryBtn: {
      marginTop: 10,
      flexDirection: 'row-reverse',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      backgroundColor: colors.dark.greenDim,
      borderWidth: 1,
      borderColor: colors.dark.green + '44',
      borderRadius: 12,
      paddingVertical: 11,
    },
    alertBatteryWarn: {
      backgroundColor: colors.dark.redDim,
      borderColor: colors.dark.red + '55',
    },
    alertWhyLink: {
      marginTop: 6,
      fontSize: 11,
      fontWeight: '700' as const,
      color: colors.dark.accent,
      textAlign: 'right',
    },
    alertNoteBox: {
      marginTop: 10,
      backgroundColor: colors.dark.redDim,
      borderRadius: 10,
      padding: 10,
      borderWidth: 1,
      borderColor: colors.dark.red + '33',
      gap: 4,
    },
    alertNoteText: {
      fontSize: 11,
      lineHeight: 18,
      color: colors.dark.red,
      textAlign: 'right',
    },
    alertToast: {
      marginTop: 8,
      fontSize: 12,
      fontWeight: '700' as const,
      color: colors.dark.green,
      textAlign: 'right',
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
    checkBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      backgroundColor: colors.dark.accent,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    // v1.3.1 — دکمهٔ چک تمام‌عرض (ورودی ریپو حذف شد)
    checkBtnFull: {
      alignSelf: 'stretch',
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
