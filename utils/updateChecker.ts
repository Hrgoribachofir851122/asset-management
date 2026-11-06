/**
 * updateChecker.ts — v1.2.0
 *
 * «چک کردن بروزرسانی» — جدیدترین نسخهٔ منتشرشده روی GitHub Releases را
 * می‌خواند و با نسخهٔ نصب‌شده مقایسه می‌کند.
 *
 * زنجیرهٔ دریافت (مثل قیمت تتر):
 *   1. پروکسی سرور خودمان  GET {server}/github-release?repo=owner/repo
 *      → سرور Railway (غیرتحریمی) api.github.com را می‌خواند؛ از ایران هم
 *        بدون فیلترشکن جواب می‌دهد (api.github.com از ایران ناپایدار است).
 *   2. فال‌بک مستقیم: api.github.com/repos/{repo}/releases/latest
 *
 * آپلود نسخهٔ جدید: در GitHub یک Release با tag به شکل v1.2.1 بسازید و فایل
 * APK را با پسوند .apk به همان Release پیوست کنید — برنامه خودش:
 *   • پیامِ «نسخه جدید» را بالای صفحه نشان می‌دهد (توضیحات Release = بنر)
 *   • دکمهٔ دانلود، مستقیم فایل APK همان Release را در مرورگر باز می‌کند.
 */

import { getServerUrl } from './scanServerApi';

export interface UpdateInfo {
  /** true = نسخهٔ جدیدتر از نسخهٔ نصب‌شده روی گیتهاب هست */
  available: boolean;
  /** نسخهٔ فعلی نصب‌شده روی دستگاه */
  currentVersion: string;
  /** نسخهٔ روی گیتهاب (بدون v) — وقتی Release وجود داشته باشد */
  latestVersion?: string;
  /** توضیحات Release (changelog فارسی که کاربر خودش در گیتهاب می‌نویسد) */
  notes?: string;
  /** لینک مستقیم فایل APK پیوست‌شده در Release (برای دکمهٔ دانلود) */
  apkUrl?: string;
  /** لینک صفحهٔ Release (fallback وقتی APK پیوست نشده باشد) */
  releaseUrl?: string;
  error?: string;
}

/** "v1.2.1" / "1.2.1" → [1,2,1] */
function parseSemver(v: string): [number, number, number] | null {
  const m = String(v ?? '')
    .trim()
    .replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** a > b ? 1 : a < b ? -1 : 0 — ناشناخته‌ها را «قدیمی‌تر» می‌گیریم تا crash نکند */
export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a) ?? [0, 0, 0];
  const pb = parseSemver(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

/** «owner/repo» معتبر است؟ (گیتهاب: حروف/عدد/-/_/.) */
export function isValidRepoSlug(slug: string): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(slug.trim());
}

interface GhRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  assets?: { name?: string; browser_download_url?: string }[];
}

/** از بین assetهای Release، فایل APK را پیدا می‌کنید (اولین .apk). */
function findApkAsset(rel: GhRelease): string | undefined {
  for (const a of rel?.assets ?? []) {
    if (typeof a?.browser_download_url === 'string' && /\.apk$/i.test(a.name ?? a.browser_download_url)) {
      return a.browser_download_url;
    }
  }
  return undefined;
}

function normalizeRelease(rel: GhRelease, currentVersion: string): UpdateInfo {
  const latestVersion = String(rel?.tag_name ?? rel?.name ?? '').trim() || undefined;
  const available = !!latestVersion && compareVersions(latestVersion, currentVersion) > 0;
  return {
    available,
    currentVersion,
    latestVersion: latestVersion?.replace(/^v/i, ''),
    notes: rel?.body?.trim() || undefined,
    apkUrl: findApkAsset(rel),
    releaseUrl: rel?.html_url,
  };
}

const TIMEOUT_MS = 15_000;

async function fetchJsonT<T>(url: string): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'asset-management-app' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * بررسی بروزرسانی. currentVersion را از فراخواننده می‌گیرد (appInfo.ts).
 * repo خالی/نامعتبر → { available: false, error: 'no-repo' }.
 *
 * v1.3.1 — «404 میزند درصورتی که باید بگه برنامه بروز است»:
 *   • ریپو Release ندارد (GitHub 404) → دیگر خطا نیست؛ یعنی «هیچ
 *     بروزرسانی‌ای منتشر نشده» → available: false بدون error تا رابط کاربری
 *     پیام «برنامه بروز است» نشان دهد.
 *   • فقط قطع‌بودن واقعی شبکه/GitHub جزو error باقی می‌ماند.
 */
export async function checkForUpdate(repo: string, currentVersion: string): Promise<UpdateInfo> {
  const slug = repo.trim().replace(/^@/, '').replace(/\.git$/, '');
  if (!isValidRepoSlug(slug)) {
    return { available: false, currentVersion, error: 'no-repo' };
  }

  const upToDate: UpdateInfo = { available: false, currentVersion };

  // 1) پروکسی سرور خودمان — از ایران هم بدون فیلترشکن در دسترس است
  try {
    const base = (await getServerUrl()).replace(/\/+$/, '');
    const viaServer = await fetchJsonT<GhRelease & { error?: string }>(
      `${base}/github-release?repo=${encodeURIComponent(slug)}`
    );
    if (!viaServer?.error && (viaServer?.tag_name || viaServer?.name || viaServer?.html_url)) {
      return normalizeRelease(viaServer, currentVersion);
    }
    // سرورِ خودمان می‌گوید ریپو Release ندارد (یا ریپو پیدا نشد) → «بروز است»
    if (viaServer?.error === 'no-release') return upToDate;
  } catch {}

  // 2) فال‌بک مستقیم (وقتی فیلترشکن روشن است کار می‌کند)
  try {
    const rel = await fetchJsonT<GhRelease>(
      `https://api.github.com/repos/${slug}/releases/latest`
    );
    return normalizeRelease(rel, currentVersion);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 404 یعنی «Release‌ای منتشر نشده» — خطا نیست، یعنی بروز است.
    if (msg.includes('404')) return upToDate;
    return {
      available: false,
      currentVersion,
      error: msg || 'github-unreachable',
    };
  }
}

// ---------------------------------------------------------------------------
// v1.3.0 — «با زدن دکمهٔ چک کردن بروزرسانی مطلع بشه + پیغام بالای صفحه»
// کانال کوچک pub/sub: هر جا (تنظیمات / چک خودکار) نسخهٔ جدیدی پیدا شد،
// UpdateBannerِ بالای صفحه همان لحظه آن را نشان می‌دهد — بدون انتظار برای
// تایمر ۳۰ دقیقه‌ای بعدی.
// ---------------------------------------------------------------------------

type UpdateListener = (info: UpdateInfo) => void;
const updateListeners = new Set<UpdateListener>();

/** وقتی نسخهٔ جدیدی پیدا شد صدا بزن — بنر بالای صفحه فوراً ظاهر می‌شود. */
export function notifyUpdateAvailable(info: UpdateInfo): void {
  for (const l of [...updateListeners]) {
    try {
      l(info);
    } catch {}
  }
}

/** UpdateBanner با این تابع گوش می‌دهد؛ returns unsubscribe. */
export function onUpdateAvailable(listener: UpdateListener): () => void {
  updateListeners.add(listener);
  return () => updateListeners.delete(listener);
}
