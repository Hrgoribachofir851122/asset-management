/**
 * constants/appInfo.ts — metadata of the standalone «مدیریت دارایی» app.
 *
 * v1.2.0 — «نسخه‌ای که نصب کردم 1.1.0 بود ولی برنامه 1.0.0 نشون می‌داد»:
 *   APP_VERSION دیگر هاردکد نیست — از پیکربندی Native خود اپ (expo-constants)
 *   خوانده می‌شود، پس همیشه دقیقاً همان نسخه‌ای است که در APK نصب شده است.
 *   (expo-constants در بیلد Native مقدار expoConfig را از metadata باندل
 *   می‌خواند؛ روی وب همان app.json برمی‌گردد.)
 */
import Constants from 'expo-constants';

export const APP_NAME = 'مدیریت دارایی';
export const APP_SOURCE = 'استخراج‌شده از اپ پامپی (pampay-coin-alert) نسخه 1.5.12';

/** نسخه دقیق نصب‌شده — از پیکربندی Native (app.json هنگام بیلد) */
export const APP_VERSION: string =
  (Constants.expoConfig?.version as string | undefined) ?? '1.3.7';

/** versionCode اندروید (برای نمایش «نسخه 1.3.1 (5)») */
export const APP_VERSION_CODE: number =
  (Constants.expoConfig?.android as { versionCode?: number } | undefined)?.versionCode ?? 11;

/** نام سازندهٔ برنامه (درخواست کاربر v1.2.0) */
export const APP_DEVELOPER = 'trade_master65';

/**
 * v1.3.1 — ریپوی رسمی بروزرسانی (خودِ کاربر آن را ساخته و آدرسش را داده):
 * https://github.com/Hrgoribachofir851122/asset-management
 * کاربر چیزی در تنظیمات وارد نمی‌کند؛ با انتشار یک Release جدید روی همین ریپو
 * (تگ مثل v1.3.2 و پیوست‌کردن فایل APK)، پیام «نسخه جدید» خودکار بالای صفحه
 * ظاهر می‌شود. چک از طریق پروکسی سرور خودمان انجام می‌شود (از ایران هم جواب می‌دهد).
 */
export const DEFAULT_GITHUB_REPO = 'Hrgoribachofir851122/asset-management';
