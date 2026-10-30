import AsyncStorage from '@react-native-async-storage/async-storage';
import { getServerUrl } from './scanServerApi';

/**
 * talineApi.ts — v1.3.6 (درخواست کاربر)
 *
 * قیمت خرید و فروش هر گرم طلای آب‌شده از سایت طلاین (taline.ir) برای
 * بخش «دارایی ریالی و فلزات» — دو کادر سبز (خرید) و قرمز (فروش) با خط
 * «این قیمت از سایت طلاین است».
 *
 * چرا از سرور خود برنامه؟ طلاین برای بعضی درخواست‌ها به‌جای عدد «—» برمی‌گرداند
 * (کش لایت‌اسپید) و CORS مرورگر هم اجازهٔ خواندن مستقیم نمی‌دهد. سرور خودمان
 * (/taline-gold) HTML طلاین را می‌خواند، دو عدد را پارس می‌کند و JSON تمیز
 * برمی‌گرداند — همان الگوی بقیهٔ پروکسی‌ها (nobitex / alanchand).
 *
 * کش سه‌لایه مثل iranMarketApi:
 *   1) حافظه ۶۰ ثانیه
 *   2) AsyncStorage — آخرین قیمت معتبر (تا ۲۴ ساعت) برای وقتی سرور/طلاین
 *      موقتاً جواب نمی‌دهد؛ کادرها هیچ‌وقت خالی نمی‌مانند (stale:true)
 *   3) خطا → null (کادر «…» نشان می‌دهد)
 */

const CACHE_KEY = '@taline_gold_v1';
const MEMORY_TTL = 60 * 1000; // ۶۰ ثانیه — هماهنگ با کش سرور
const DISK_STALE_TTL = 24 * 60 * 60 * 1000; // آخرین قیمت معتبر: ۲۴ ساعت

export interface TalineGoldPrices {
  /** قیمت خرید هر گرم طلای آب‌شده — تومان */
  buy: number;
  /** قیمت فروش هر گرم طلای آب‌شده — تومان */
  sell: number;
  /** زمان دریافت موفق آخرین قیمت (ms) */
  updatedAt: number;
  /** true = از کش دیسک (سرور/طلاین موقتاً در دسترس نیست) */
  stale: boolean;
}

interface DiskShape {
  buy: number;
  sell: number;
  updatedAt: number;
}

let memory: { at: number; data: TalineGoldPrices } | null = null;
let inFlight: Promise<TalineGoldPrices | null> | null = null;

/** v1.2.0-style — برای «رفرش دفعهٔ دوم هم کار کند»؛ کش حافظه خالی می‌شود. */
export function clearTalineMemoryCache(): void {
  memory = null;
  inFlight = null;
}

async function readDisk(): Promise<TalineGoldPrices | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as DiskShape;
    if (
      typeof d?.buy === 'number' && d.buy > 0 &&
      typeof d?.sell === 'number' && d.sell > 0 &&
      typeof d?.updatedAt === 'number'
    ) {
      return { buy: d.buy, sell: d.sell, updatedAt: d.updatedAt, stale: true };
    }
  } catch {}
  return null;
}

async function writeDisk(data: DiskShape): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {}
}

/**
 * قیمت خرید/فروش طلای آب‌شده از طلاین — از سرور خود برنامه (پروکسی).
 * هیچ‌وقت throw نمی‌کند؛ در بدترین حالت null برمی‌گرداند.
 */
export async function fetchTalineGoldPrices(): Promise<TalineGoldPrices | null> {
  if (memory && Date.now() - memory.at < MEMORY_TTL) return memory.data;
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<TalineGoldPrices | null> => {
    try {
      const base = await getServerUrl();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      let r: Response;
      try {
        r = await fetch(`${base.replace(/\/+$/, '')}/taline-gold`, {
          signal: ctrl.signal,
          headers: { Accept: 'application/json' },
        });
      } finally {
        clearTimeout(timer);
      }
      if (!r.ok) throw new Error(`taline HTTP ${r.status}`);
      const j = (await r.json()) as {
        ok?: boolean;
        buy?: number;
        sell?: number;
        updatedAt?: number;
        stale?: boolean;
      };
      if (j?.ok && typeof j.buy === 'number' && j.buy > 0 && typeof j.sell === 'number' && j.sell > 0) {
        const data: TalineGoldPrices = {
          buy: j.buy,
          sell: j.sell,
          updatedAt: j.updatedAt ?? Date.now(),
          stale: !!j.stale,
        };
        memory = { at: Date.now(), data };
        void writeDisk({ buy: data.buy, sell: data.sell, updatedAt: data.updatedAt });
        return data;
      }
      throw new Error('taline payload not ok');
    } catch {
      // سرور/طلاین در دسترس نیست → آخرین قیمت معتبر از دیسک (تا ۲۴ ساعت)
      const disk = await readDisk();
      if (disk && Date.now() - disk.updatedAt < DISK_STALE_TTL) {
        memory = { at: Date.now(), data: disk }; // جلوگیری از ضربهٔ مجدد تا ۶۰ ثانیه
        return disk;
      }
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
