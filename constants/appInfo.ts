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
  (Constants.expoConfig?.version as string | undefined) ?? '1.2.0';

/** versionCode اندروید (برای نمایش «نسخه 1.2.0 (3)») */
export const APP_VERSION_CODE: number =
  (Constants.expoConfig?.android as { versionCode?: number } | undefined)?.versionCode ?? 3;

/** نام سازندهٔ برنامه (درخواست کاربر v1.2.0) */
export const APP_DEVELOPER = 'trade_master65';
