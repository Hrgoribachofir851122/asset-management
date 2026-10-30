import { Stack } from 'expo-router';
import colors from '@/constants/colors';

/**
 * v1.8.0 — «کادر سفید بالا نباشه و قسمت بالای برنامه بره بالاتر تا اون
 * قسمتو پر کنه دقیقا یه برنامه با طراحی زیبا داشته باشیم»:
 *
 * ریشهٔ اپ (app/_layout.tsx) خودش کل محتوا را با insets.top زیر نوار وضعیت
 * می‌گذارد؛ هدرِ native-stack هم به‌طور پیش‌فرض همان inset را «دوباره» اضافه
 * می‌کرد → یک فضای مردهٔ بزرگ بالای عنوان «مدیریت دارایی» دیده می‌شد
 * (در react-navigation v7 گزینهٔ headerStatusBarHeight هم حذف شده است).
 *
 * راه‌حل: هدر native کلاً خاموش شد و عنوان به‌صورت هدر درون‌صفحه‌ای فشرده و
 * هم‌راستا با تب تنظیمات، بالای صفحه کشیده می‌شود — محتوا دقیقاً زیر نوار
 * وضعیت می‌چسبد و بالای صفحه پر و یکدست دیده می‌شود.
 * (صفحهٔ wallet-detail هرگز از هیچ‌جای اپ navigate نمی‌شود — فقط مسیر
 * رزروشده است؛ با هدر خاموش هم مشکلی ندارد.)
 */
export default function WalletLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.dark.background },
      }}
    >
      <Stack.Screen name="index" />
    </Stack>
  );
}
