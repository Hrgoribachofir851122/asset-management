/**
 * server.js — سرور یکپارچهٔ «مدیریت دارایی» برای Railway
 *
 * این سرور دو کار همزمان انجام می‌دهد:
 *
 *   1) سرو کردن وب‌اپ (پوشهٔ dist/ که با `npx expo export --platform web`
 *      ساخته می‌شود) + fallback به index.html برای مسیرهای SPA.
 *
 *   2) پروکسی قیمت تتر/تومان با CORS باز — همان دو اندپوینتی که
 *      utils/nobitexApi.ts به‌عنوان fallback زنجیرهٔ قیمت صدا می‌زند:
 *
 *        GET /nobitex/usdt-toman   → { usdtToToman: <number> }
 *        GET /alanchand/usdt-toman → { usdtToToman: <number> }
 *
 *      این دو اندپوینت سمت سرور fetch می‌شوند تا محدودیت CORS مرورگر و
 *      مشکلات دسترسی از ایران دور بزند؛ قیمت‌ها ۶۰ ثانیه کش می‌شوند.
 *
 *   3) v1.1.0 — GET /ip-check → { ip, country, sanctioned, ts }
 *      اپ «مدیریت دارایی» در بخش تنظیمات هر ۳ ثانیه وضعیت IP کاربر را چک
 *      می‌کند؛ وقتی سه سرویس عمومی geo-IP در دسترس نبودند، این endpoint
 *      (روی سرور خودمان) کشورِ IP تماس‌گیرنده را از x-forwarded-for تشخیص
 *      می‌دهد. نتیجه ۶۰ ثانیه per-IP کش می‌شود.
 *
 * بدون هیچ وابستگی خارجی (فقط Node.js >= 18 با fetch داخلی).
 * Deploy روی Railway: build = `npx expo export --platform web`،
 * start = `node server.js` (تنظیم شده در railway.json).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DIST = path.join(__dirname, 'dist');

// ─── MIME types ─────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webmanifest': 'application/manifest+json',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store',
  });
}

// ─── Static files (dist/) ───────────────────────────────────────────────
function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    urlPath = '/';
  }
  urlPath = urlPath.split('?')[0].split('#')[0];

  // جلوگیری از path traversal
  const safePath = path
    .normalize(urlPath)
    .replace(/^(\.\.[/\\])+/, '')
    .replace(/^\/+/, '');

  const candidates = [];
  if (safePath === '') {
    candidates.push(path.join(DIST, 'index.html'));
  } else {
    candidates.push(path.join(DIST, safePath));
    candidates.push(path.join(DIST, safePath, 'index.html'));
    candidates.push(path.join(DIST, safePath + '.html'));
  }

  for (const file of candidates) {
    if (!file.startsWith(DIST)) continue; // امنیت: فقط داخل dist
    try {
      const stat = fs.statSync(file);
      if (stat.isFile()) {
        const ext = path.extname(file).toLowerCase();
        const isAsset = urlPath.startsWith('/_expo/') || urlPath.startsWith('/assets/');
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Content-Length': stat.size,
          // فایل‌های هش‌دار _expo/assets کش بلندمدت، html بدون کش
          'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
        });
        fs.createReadStream(file).pipe(res);
        return true;
      }
    } catch {
      /* فایل بعدی */
    }
  }

  // SPA fallback: مسیرهای ناشناختهٔ بدون پسوند → index.html
  const hasExt = Boolean(path.extname(urlPath));
  if (!hasExt) {
    try {
      const indexPath = path.join(DIST, 'index.html');
      const stat = fs.statSync(indexPath);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(indexPath).pipe(res);
      return true;
    } catch {
      send(
        res,
        503,
        'وب‌اپ ساخته نشده است. دستور زیر را اجرا کنید:\n  npx expo export --platform web\n',
        { 'Content-Type': 'text/plain; charset=utf-8' }
      );
      return true;
    }
  }
  return false; // 404
}

// ─── Price proxy (منطق تست‌شده) ─────────────────────────────────────────
/** Prices are in Toman; the app accepts 10,000 … 500,000 only. */
function validToman(price) {
  return typeof price === 'number' && price > 10000 && price < 500000;
}

/** Small response cache: { at, payload } per endpoint. */
const cache = new Map();
function getCached(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.payload;
  return null;
}
function setCached(key, payload) {
  cache.set(key, { at: Date.now(), payload });
}

function persianToEnglish(str) {
  const persianDigits = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
  let result = str;
  for (let i = 0; i < 10; i++) {
    result = result.replace(new RegExp(persianDigits[i], 'g'), i.toString());
  }
  return result;
}

async function fetchWithTimeout(url, options = {}, ms = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Nobitex ────────────────────────────────────────────────────────────
// POST https://apiv2.nobitex.ir/market/stats {srcCurrency:'usdt',dstCurrency:'rls'}
// → stats['usdt-rls'].latest is in RIAL → divide by 10 for Toman.
const NOBITEX_STATS_API = 'https://apiv2.nobitex.ir/market/stats';

async function fetchNobitexUsdtToman() {
  const response = await fetchWithTimeout(NOBITEX_STATS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ srcCurrency: 'usdt', dstCurrency: 'rls' }),
  });
  if (!response.ok) throw new Error(`Nobitex HTTP ${response.status}`);
  const data = await response.json();
  const stats = data?.stats?.['usdt-rls'];
  let raw = stats?.latest ? parseFloat(stats.latest) : null;
  if (!raw && stats?.lastTradePrice) raw = parseFloat(stats.lastTradePrice);
  if (!raw || !Number.isFinite(raw)) throw new Error('Nobitex: no price field');
  const toman = raw / 10; // Rial → Toman
  if (!validToman(toman)) throw new Error(`Nobitex: implausible price ${toman}`);
  return toman;
}

async function handleNobitex(res) {
  const cached = getCached('nobitex');
  if (cached) return sendJson(res, 200, cached);
  try {
    const usdtToToman = await fetchNobitexUsdtToman();
    const payload = { usdtToToman };
    setCached('nobitex', payload);
    console.log('[nobitex] USDT/Toman:', usdtToToman);
    sendJson(res, 200, payload);
  } catch (e) {
    console.error('[nobitex] Error:', e.message);
    sendJson(res, 502, { error: e.message });
  }
}

// ─── Alan.Chand ─────────────────────────────────────────────────────────
// 1) JSON API (optional Bearer key via env ALANCHAND_API_KEY)
//    https://api.alanchand.com?type=currency&symbols=usd
// 2) Fallback: HTML scrape of https://alanchand.com/currencies-price/usd
const ALANCHAND_API_URL = 'https://api.alanchand.com?type=currency&symbols=usd';
const ALANCHAND_HTML_URL = 'https://alanchand.com/currencies-price/usd';

/** Mirrors the client-side extraction logic in utils/nobitexApi.ts. */
function extractAlanchandPrice(data) {
  const pickPrice = (obj) => {
    for (const key of ['sell_price', 'sellPrice', 'price', 'sell']) {
      const v = obj[key];
      if (typeof v === 'number' && v > 0) return v;
      if (typeof v === 'string') {
        const n = parseFloat(persianToEnglish(v).replace(/[^\d.]/g, ''));
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    return null;
  };
  const findObj = (node, depth = 0) => {
    if (depth > 5 || node === null || typeof node !== 'object') return null;
    if (pickPrice(node) !== null) return node;
    for (const v of Object.values(node)) {
      const found = findObj(v, depth + 1);
      if (found) return found;
    }
    return null;
  };
  const obj = findObj(data);
  const raw = obj ? pickPrice(obj) : null;
  if (!raw) return null;
  // Usually Rial (e.g. 1,040,500) → Toman; already-Toman values pass through.
  if (raw > 1000000 && raw < 5000000) return raw / 10;
  if (raw > 100000 && raw < 500000) return raw;
  return null;
}

async function fetchAlanchandUsdtToman() {
  // 1) JSON API (only works when ALANCHAND_API_KEY is set in the environment).
  const headers = { Accept: 'application/json' };
  if (process.env.ALANCHAND_API_KEY) {
    headers.Authorization = `Bearer ${process.env.ALANCHAND_API_KEY}`;
  }
  let alanchandPrice = null;
  if (process.env.ALANCHAND_API_KEY) {
    try {
      const response = await fetchWithTimeout(ALANCHAND_API_URL, { headers });
      if (response.ok) {
        const data = await response.json();
        alanchandPrice = extractAlanchandPrice(data);
      }
    } catch (e) {
      console.error('[alanchand] JSON API error:', e.message);
    }
  }

  // 2) HTML scrape fallback — ONLY the strict `class="price"` regex.
  try {
    const response = await fetchWithTimeout(ALANCHAND_HTML_URL, {
      headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0' },
    });
    if (response.ok) {
      const html = await response.text();
      const priceMatch = html.match(/class="price"[^>]*>([^<]+)</);
      if (priceMatch && priceMatch[1]) {
        const price = parseFloat(persianToEnglish(priceMatch[1].trim()).replace(/,/g, ''));
        if (validToman(price)) alanchandPrice = price;
      }
    }
  } catch (e) {
    console.error('[alanchand] HTML error:', e.message);
  }

  if (!validToman(alanchandPrice)) throw new Error('Alanchand: no price found');

  // 3) Cross-check against Nobitex: reject deviations > 30% (stale/wrong data).
  try {
    const nobitex = await fetchNobitexUsdtToman();
    if (Math.abs(alanchandPrice - nobitex) / nobitex > 0.3) {
      throw new Error(
        `Alanchand: implausible price ${alanchandPrice} vs market ${nobitex}`
      );
    }
  } catch (e) {
    if (String(e.message).startsWith('Alanchand: implausible')) throw e;
    // Nobitex itself failed — accept the alanchand price as-is
  }

  return alanchandPrice;
}

async function handleAlanchand(res) {
  const cached = getCached('alanchand');
  if (cached) return sendJson(res, 200, cached);
  try {
    const usdtToToman = await fetchAlanchandUsdtToman();
    const payload = { usdtToToman };
    setCached('alanchand', payload);
    console.log('[alanchand] USDT/Toman:', usdtToToman);
    sendJson(res, 200, payload);
  } catch (e) {
    console.error('[alanchand] Error:', e.message);
    sendJson(res, 502, { error: e.message });
  }
}

// ─── IP check (v1.1.0 — بررسی IP کاربر برای بخش تنظیمات اپ) ───────────
const SANCTIONED_COUNTRIES = new Set(['IR', 'CU', 'KP', 'SY']);
const ipCache = new Map(); // ip → { at, payload }

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length > 0) {
    return xf.split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || '';
}

async function lookupCountry(ip) {
  // ipwho.is — رایگان، بدون کلید؛ ۴ ثانیه مهلت
  const res = await fetchWithTimeout(`https://ipwho.is/${encodeURIComponent(ip)}`, {}, 4000);
  if (!res.ok) throw new Error(`ipwho HTTP ${res.status}`);
  const data = await res.json();
  if (data && data.success && typeof data.country_code === 'string') {
    return data.country_code;
  }
  throw new Error('ipwho: no country');
}

async function handleIpCheck(req, res) {
  const ip = clientIp(req);
  if (!ip) {
    return sendJson(res, 200, { ip: '', country: null, sanctioned: false, ts: Date.now() });
  }
  const hit = ipCache.get(ip);
  if (hit && Date.now() - hit.at < 60_000) return sendJson(res, 200, hit.payload);
  try {
    const country = await lookupCountry(ip);
    const payload = {
      ip,
      country,
      sanctioned: SANCTIONED_COUNTRIES.has(country.toUpperCase()),
      ts: Date.now(),
    };
    ipCache.set(ip, { at: Date.now(), payload });
    sendJson(res, 200, payload);
  } catch (e) {
    // تشخیص ناموفق ≠ بلاک — فقط IP برمی‌گردد؛ اپ خودش سراغ provider بعدی می‌رود
    console.error('[ip-check] lookup failed:', e.message);
    sendJson(res, 200, { ip, country: null, sanctioned: false, ts: Date.now() });
  }
}

// ─── v1.2.0 — پروکسی GitHub Releases (چک بروزرسانی) ─────────────────────
// GET /github-release?repo=owner/name → جدیدترین Release (tag/body/apk).
// api.github.com از ایران ناپایدار است؛ سرور ما (غیرتحریمی) می‌خواند و
// نتیجه را با CORS باز برمی‌گرداند. کش ۹۰ ثانیه per-repo.
const ghCache = new Map(); // repo → { at, payload }

async function handleGithubRelease(req, res, query) {
  const repo = String(query.get('repo') || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return sendJson(res, 200, { error: 'bad-repo', ts: Date.now() });
  }
  const hit = ghCache.get(repo);
  if (hit && Date.now() - hit.at < 90_000) return sendJson(res, 200, hit.payload);

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    let r;
    try {
      r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        signal: ctrl.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'asset-management-server',
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if (r.status === 404) {
      // ریپو هست ولی هیچ Release‌ای ندارد
      const payload = { error: 'no-release', ts: Date.now() };
      ghCache.set(repo, { at: Date.now(), payload });
      return sendJson(res, 200, payload);
    }
    if (!r.ok) throw new Error(`GitHub HTTP ${r.status}`);
    const rel = await r.json();
    const payload = {
      tag_name: rel.tag_name ?? '',
      name: rel.name ?? '',
      body: typeof rel.body === 'string' ? rel.body : '',
      html_url: rel.html_url ?? '',
      assets: (Array.isArray(rel.assets) ? rel.assets : []).map((a) => ({
        name: a.name ?? '',
        browser_download_url: a.browser_download_url ?? '',
      })),
      ts: Date.now(),
    };
    ghCache.set(repo, { at: Date.now(), payload });
    return sendJson(res, 200, payload);
  } catch (e) {
    // خطای موقت → آخرین کش موفق (تا ۱ ساعت) بهتر از هیچ است
    const stale = ghCache.get(repo);
    if (stale && Date.now() - stale.at < 3_600_000) return sendJson(res, 200, stale.payload);
    return sendJson(res, 200, { error: 'github-unreachable', message: e.message, ts: Date.now() });
  }
}

// ─── v1.2.0 — آیکون ارزها از CoinGecko (پروکسی) ─────────────────────────
// GET /cg-icons?ids=bitcoin,ethereum&symbols=btc,eth
// → { byId: { bitcoin: url, … }, bySymbol: { BTC: url, … } }
// اپ برای «آیکون واقعی هر ارز» در لیست دارایی کیف پول بلاکچین استفاده می‌کند.
// کش ۱ ساعته per-query؛ خطا → byId/bySymbol خالی (اپ آواتار حرفی نشان می‌دهد).
const cgIconCache = new Map(); // key → { at, payload, short }
const CG_ICON_TTL = 3_600_000; // جواب سالم: ۱ ساعت
const CG_ICON_MISS_TTL = 45_000; // v1.7.0 — جواب خالی/خطا فقط ۴۵ ثانیه (۴۲۹ نباید یک ساعت بچسبد!)

async function handleCgIcons(res, query) {
  const ids = String(query.get('ids') || '').toLowerCase();
  const symbols = String(query.get('symbols') || '').toUpperCase();
  const key = `${ids}|${symbols}`;
  if (!ids && !symbols) return sendJson(res, 200, { byId: {}, bySymbol: {} });
  const hit = cgIconCache.get(key);
  if (hit) {
    const ttl = hit.short ? CG_ICON_MISS_TTL : CG_ICON_TTL;
    if (Date.now() - hit.at < ttl) return sendJson(res, 200, hit.payload);
  }

  try {
    const parts = ['vs_currency=usd'];
    if (ids) parts.push(`ids=${encodeURIComponent(ids)}`);
    if (symbols) parts.push(`symbols=${encodeURIComponent(symbols.toLowerCase())}`);
    parts.push('per_page=250');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    let r;
    try {
      r = await fetch(`https://api.coingecko.com/api/v3/coins/markets?${parts.join('&')}`, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'asset-management-server' },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) throw new Error(`CG HTTP ${r.status}`);
    const rows = await r.json();
    const byId = {};
    const bySymbol = {};
    for (const c of Array.isArray(rows) ? rows : []) {
      if (typeof c?.id === 'string' && typeof c?.image === 'string') {
        byId[c.id] = c.image;
      }
      if (typeof c?.symbol === 'string' && typeof c?.image === 'string') {
        bySymbol[c.symbol.toUpperCase()] = c.image;
      }
    }
    const payload = { byId, bySymbol, ts: Date.now() };
    // v1.7.0 — جواب خالی (۴۲۹/سمبول ناشناخته) کوتاه‌مدت کش می‌شود تا تلاش بعدی زودتر برسد
    const isEmpty = Object.keys(byId).length === 0 && Object.keys(bySymbol).length === 0;
    cgIconCache.set(key, { at: Date.now(), payload, short: isEmpty });
    return sendJson(res, 200, payload);
  } catch (e) {
    // v1.7.0 — خطا هم دیگر یک ساعت کش نمی‌شود (فقط ۴۵ ثانیه)
    const payload = { byId: {}, bySymbol: {}, error: e.message, ts: Date.now() };
    cgIconCache.set(key, { at: Date.now(), payload, short: true });
    return sendJson(res, 200, payload);
  }
}

// ─── v1.7.0 — پروکسی بایت‌های آیکون (fallback وقتی CDN کویین‌گکو روی نتِ
// گوشی باز نمی‌شود) ─────────────────────────────────────────────────────
// GET /cg-icon?url=https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png
// فقط دو هُست مجاز؛ کش حافظه ۶ ساعته (بایت base64)؛ از ایران هم جواب می‌دهد.
const CG_ICON_HOSTS = new Set(['coin-images.coingecko.com', 'assets.coingecko.com', 'www.coingecko.com']);
const cgIconBytesCache = new Map(); // url → { at, b64, mime }
const CG_ICON_BYTES_TTL = 6 * 3_600_000;

async function handleCgIconBytes(res, query) {
  const target = String(query.get('url') || '');
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return sendJson(res, 400, { error: 'bad-url' });
  }
  if (parsed.protocol !== 'https:' || !CG_ICON_HOSTS.has(parsed.hostname)) {
    return sendJson(res, 403, { error: 'host-not-allowed' });
  }
  const hit = cgIconBytesCache.get(target);
  if (hit && Date.now() - hit.at < CG_ICON_BYTES_TTL) {
    const buf = Buffer.from(hit.b64, 'base64');
    res.writeHead(200, {
      'Content-Type': hit.mime,
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=21600',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(buf);
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    let r;
    try {
      r = await fetch(target, { signal: ctrl.signal, headers: { 'User-Agent': 'asset-management-server' } });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) throw new Error(`icon HTTP ${r.status}`);
    const mime = r.headers.get('content-type') || 'image/png';
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 512 * 1024) throw new Error('icon too large');
    cgIconBytesCache.set(target, { at: Date.now(), b64: buf.toString('base64'), mime });
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=21600',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(buf);
  } catch (e) {
    return sendJson(res, 502, { error: 'icon-fetch-failed', message: e.message });
  }
}


// ─── v1.3.0 — پروکسی خواندن بلاکچین: تون (Tonkeeper) و فایل‌کوین ─────────
// «در کیف پول وقتی آدرس کیف رو شبکه تون کوین میدم نمیتونه اطلاعات بخونه» +
// «آدرس فایل‌کوین رو نمیتونه بخونه» — tonapi.io/toncenter/glif روی IPهای
// اشتراکی (فیلترشکن‌ها) محدود می‌شوند. این دو endpoint سمت سرور (IP دیتاسنتر
// پایدار) زنجیرهٔ چندمنبعی را اجرا می‌کنند و جواب نرمال‌شده برمی‌گردانند.
// فقط خواندنی؛ آدرس عمومی است و هیچ کلیدی رد و بدل نمی‌شود. کش ۲۰ ثانیه.

const BC_TIMEOUT_MS = 9_000;
const BC_CACHE_MS = 20_000;
const bcCache = new Map(); // key → { at, payload }

async function bcFetchJson(url, opts = {}, ms = BC_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'asset-management-server', ...(opts.headers || {}) },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function bcPostRpc(rpcUrl, method, params, ms = BC_TIMEOUT_MS) {
  return bcFetchJson(
    rpcUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    },
    ms
  );
}

function bcCached(key, fn) {
  return (async () => {
    const hit = bcCache.get(key);
    if (hit && Date.now() - hit.at < BC_CACHE_MS) return hit.payload;
    try {
      const payload = await fn();
      bcCache.set(key, { at: Date.now(), payload });
      return payload;
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  })();
}

/** TON: tonapi → toncenter v3 → toncenter v2 (موجودی native + جتون‌ها). */
async function tonResolve(address) {
  const addr = String(address || '').trim();
  if (!addr) return { ok: false, error: 'no-address' };

  let balance = null; // nanoTON (string)
  const jettons = []; // { walletBalance, master, symbol?, name?, decimals? }
  const sources = [];

  // 1) tonapi.io — balance + jettons با متادیتا کامل
  try {
    const a = await bcFetchJson(`https://tonapi.io/v2/accounts/${encodeURIComponent(addr)}`);
    if (a && a.balance != null) {
      balance = String(a.balance);
      sources.push('tonapi');
    }
    for (const j of a?.jettons?.balances || []) {
      const wb = String(j.balance ?? '0');
      if (wb === '0') continue;
      jettons.push({
        walletBalance: wb,
        master: j.jetton?.address || '',
        symbol: j.jetton?.symbol || undefined,
        name: j.jetton?.name || undefined,
        decimals: j.jetton?.decimals != null ? String(j.jetton.decimals) : undefined,
      });
    }
  } catch {}

  // 2) toncenter v3 — addressInformation + jetton/wallets
  if (balance == null) {
    try {
      const d = await bcFetchJson(
        `https://toncenter.com/api/v3/addressInformation?address=${encodeURIComponent(addr)}`
      );
      if (d && d.balance != null) {
        balance = String(d.balance);
        sources.push('toncenter-v3');
      }
    } catch {}
  }
  if (jettons.length === 0) {
    try {
      const w = await bcFetchJson(
        `https://toncenter.com/api/v3/jetton/wallets?owner_address=${encodeURIComponent(addr)}`
      );
      const rows = w?.jetton_wallets || [];
      // متادیتا (نماد/اعشار) هر جتون — موازی، حداکثر ۸ تا
      const metas = await Promise.all(
        rows.slice(0, 8).map(async (row) => {
          if (!row?.jetton) return null;
          try {
            const m = await bcFetchJson(
              `https://toncenter.com/api/v3/jetton/masters?addresses=${encodeURIComponent(row.jetton)}`
            );
            const c = m?.jetton_masters?.[0]?.jetton_content;
            const uri = typeof c?.uri === 'string' ? c.uri : '';
            // نشانی IPFS → اپ کلاینت خودش نماد را کامل می‌کند؛ اینجا فقط
            // symbol/decimals مستقیم (بعضی masterها داخل content می‌دهند)
            return {
              master: row.jetton,
              walletBalance: String(row.balance ?? '0'),
              symbol: c?.symbol || undefined,
              decimals: c?.decimals != null ? String(c.decimals) : undefined,
              name: c?.name || undefined,
              uri,
            };
          } catch {
            return { master: row.jetton, walletBalance: String(row.balance ?? '0') };
          }
        })
      );
      for (const m of metas) if (m && m.walletBalance !== '0') jettons.push(m);
      if (jettons.length > 0 && balance == null) sources.push('toncenter-v3-jettons');
    } catch {}
  }

  // 3) toncenter v2 — آخرین فال‌بک native balance
  if (balance == null) {
    try {
      const d = await bcFetchJson(
        `https://toncenter.com/api/v2/getExtendedAddressInformation?address=${encodeURIComponent(addr)}`
      );
      if (d && d.result?.balance != null) {
        balance = String(d.result.balance);
        sources.push('toncenter-v2');
      }
    } catch {}
  }

  if (balance == null && jettons.length === 0) {
    throw new Error('ton-unavailable');
  }
  return { ok: true, balance, jettons, sources };
}

const FIL_RPCS = ['https://api.node.glif.io/rpc/v1', 'https://filecoin.chainup.net/rpc/v1'];

/** Filecoin: StateGetActor (f1/f0/f3) یا eth_getBalance (0x/FEVM) + تبدیل به فرم EVM. */
async function filResolve(address) {
  const addr = String(address || '').trim();
  if (!addr) return { ok: false, error: 'no-address' };

  let atto = null;
  let evmAddress = null;
  const sources = [];

  const isEvmForm = /^0x[0-9a-fA-F]{40}$/.test(addr);

  for (const rpc of FIL_RPCS) {
    try {
      if (isEvmForm) {
        const d = await bcPostRpc(rpc, 'eth_getBalance', [addr, 'latest']);
        if (d?.result != null) {
          atto = String(BigInt(d.result));
          sources.push(`eth_getBalance@${new URL(rpc).host}`);
          evmAddress = addr.toLowerCase();
          break;
        }
      } else {
        const d = await bcPostRpc(rpc, 'Filecoin.StateGetActor', [addr, null]);
        if (d?.result?.Balance != null) {
          atto = String(d.result.Balance);
          sources.push(`StateGetActor@${new URL(rpc).host}`);
          break;
        }
      }
    } catch {}
  }

  // تبدیل f1/f3 → ID → فرم FEVM (برای خواندن توکن‌های ERC-20 سمت اپ)
  if (!isEvmForm && /^f[134]/.test(addr)) {
    for (const rpc of FIL_RPCS) {
      try {
        const d = await bcPostRpc(rpc, 'Filecoin.StateLookupID', [addr, null]);
        const id = /^f0(\d+)$/.exec(String(d?.result || ''));
        if (id) {
          evmAddress = '0x' + BigInt(id[1]).toString(16).padStart(40, '0');
          break;
        }
      } catch {}
    }
  } else if (isEvmForm) {
    try {
      const d = await bcPostRpc(FIL_RPCS[0], 'Filecoin.StateLookupID', [addr, null]);
      const id = /^f0(\d+)$/.exec(String(d?.result || ''));
      if (id) evmAddress = addr.toLowerCase();
    } catch {}
  }

  if (atto == null) throw new Error('filecoin-unavailable');
  return { ok: true, atto, evmAddress, sources };
}

async function handleBcTon(res, query) {
  const address = String(query.get('address') || '').trim();
  if (!address) return sendJson(res, 400, { ok: false, error: 'address required' });
  const payload = await bcCached(`ton|${address.toLowerCase()}`, () => tonResolve(address));
  return sendJson(res, 200, payload);
}

async function handleBcFil(res, query) {
  const address = String(query.get('address') || '').trim();
  if (!address) return sendJson(res, 400, { ok: false, error: 'address required' });
  const payload = await bcCached(`fil|${address.toLowerCase()}`, () => filResolve(address));
  return sendJson(res, 200, payload);
}


// ─── v1.3.6 — قیمت خرید/فروش طلای آب‌شده از سایت طلاین (taline.ir) ──────
// GET /taline-gold → { ok, buy, sell, updatedAt, stale }
//
// طلاین قیمت خرید/فروش هر گرم طلای آب‌شده را با shortcode سرور-ساید داخل
// HTML صفحه می‌گذارد (LiteSpeed ESI). بعضی بازدیدها به‌جای عدد «—» می‌گیرند
// (بکتِ کش کهنه)، پس زنجیرهٔ خوانش:
//   1) دسکتاپ-UA → پارس مقدار ESI کنار برچسب‌های «قیمت خرید/فروش هر گرم»
//   2) موبایل-UA + کش‌شکن (باکت کش متفاوت لایت‌اسپید)
//   3) هر دو خالی → آخرین جواب سالم (تا ۲۴ ساعت) با stale:true
// جواب سالم ۶۰ ثانیه کش می‌شود تا اپ هر چند دقیقه بدون فشار بیاید.
const talineCache = new Map(); // 'last-good' → { at, payload }
const TALINE_TTL = 60_000; // کش جواب سالم
const TALINE_STALE_TTL = 24 * 3_600_000; // نگه‌داشتن آخرین قیمت معتبر

function talineNormalizeNum(raw) {
  if (!raw) return NaN;
  let s = String(raw);
  const fa = '۰۱۲۳۴۵۶۷۸۹';
  const ar = '٠١٢٣٤٥٦٧٨٩';
  for (let i = 0; i < 10; i++) {
    s = s.split(fa[i]).join(String(i));
    s = s.split(ar[i]).join(String(i));
  }
  s = s.replace(/[,،٬\s]/g, '');
  // «—» یا هر متن دیگر → نامعتبر
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
  const n = parseFloat(s);
  // محدودهٔ منطقی برای قیمت گرم طلا به تومان
  if (!Number.isFinite(n) || n < 100_000 || n > 1e12) return NaN;
  return n;
}

function talineExtractAfter(html, label) {
  const i = html.indexOf(label);
  if (i < 0) return NaN;
  const seg = html.slice(i, i + 2500);
  // اولین مقدار ESI بعد از برچسب: <!-- lscwp esi-shortcode -->VALUE<!-- …
  const m = seg.match(/esi-shortcode\s*-->([^<]{0,80})</);
  return m ? talineNormalizeNum(m[1]) : NaN;
}

async function talineFetchOnce(url, ua) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': ua,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.6',
        Referer: 'https://taline.ir/',
      },
    });
    if (!r.ok) throw new Error(`taline HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * زنجیرهٔ خوانش صفحهٔ طلاین: مستقیم (دسکتاپ → موبایل + کش‌شکن) و بعد دو
 * رلهٔ عمومی برای وقتی IP سرور موقتاً توسط لایت‌اسپید/کلودفلر پرچم شود.
 * هر کدام که عدد خرید و فروش معتبر برگرداند برنده است.
 */
async function talineFetchHtml() {
  const desktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
  const mobile = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36';
  const attempts = [
    () => talineFetchOnce('https://taline.ir/', desktop),
    () => talineFetchOnce(`https://taline.ir/?t=${Date.now()}`, mobile),
    () => talineFetchOnce(`https://corsproxy.io/?url=${encodeURIComponent('https://taline.ir/')}`, desktop),
    () => talineFetchOnce(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent('https://taline.ir/')}`, desktop),
  ];
  let lastErr;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('taline-unreachable');
}

async function handleTalineGold(res) {
  const hit = talineCache.get('last-good');
  if (hit && Date.now() - hit.at < TALINE_TTL) return sendJson(res, 200, hit.payload);
  try {
    const html = await talineFetchHtml();
    const buy = talineExtractAfter(html, 'قیمت خرید هر گرم');
    const sell = talineExtractAfter(html, 'قیمت فروش هر گرم');
    if (!(buy > 0 && sell > 0)) throw new Error('taline-empty');
    // کنترل عقلانی: خرید و فروش باید نزدیک هم باشند
    if (Math.max(buy, sell) / Math.min(buy, sell) > 1.3) throw new Error('taline-inconsistent');
    const payload = { ok: true, buy, sell, updatedAt: Date.now(), stale: false };
    talineCache.set('last-good', { at: Date.now(), payload });
    return sendJson(res, 200, payload);
  } catch (e) {
    if (hit && Date.now() - hit.at < TALINE_STALE_TTL) {
      return sendJson(res, 200, { ...hit.payload, stale: true, error: e.message });
    }
    return sendJson(res, 200, { ok: false, error: e.message, ts: Date.now() });
  }
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0].split('#')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  if (urlPath === '/nobitex/usdt-toman') return handleNobitex(res);
  if (urlPath === '/alanchand/usdt-toman') return handleAlanchand(res);
  if (urlPath === '/ip-check') return handleIpCheck(req, res);
  if (urlPath === '/github-release') return handleGithubRelease(req, res, new URL(req.url, 'http://x').searchParams);
  if (urlPath === '/cg-icons') return handleCgIcons(res, new URL(req.url, 'http://x').searchParams);
  // v1.7.0 — پروکسی بایت آیکون (fallback تصویر وقتی CDN روی نت گوشی باز نیست)
  if (urlPath === '/cg-icon') return handleCgIconBytes(res, new URL(req.url, 'http://x').searchParams);
  // v1.3.0 — پروکسی خواندن بلاکچین (تون / فایل‌کوین)
  if (urlPath === '/bc/ton') return handleBcTon(res, new URL(req.url, 'http://x').searchParams);
  if (urlPath === '/bc/filecoin') return handleBcFil(res, new URL(req.url, 'http://x').searchParams);
  // v1.3.6 — قیمت خرید/فروش طلای آب‌شده از طلاین (بخش دارایی ریالی)
  if (urlPath === '/taline-gold') return handleTalineGold(res);

  if (urlPath === '/health' || urlPath === '/api/health') {
    const hasDist = fs.existsSync(path.join(DIST, 'index.html'));
    return sendJson(res, 200, {
      status: 'ok',
      service: 'asset-management web + price proxy',
      web: hasDist ? 'ready' : 'dist missing (run: npx expo export --platform web)',
      endpoints: ['/nobitex/usdt-toman', '/alanchand/usdt-toman', '/ip-check', '/github-release', '/cg-icons', '/cg-icon', '/bc/ton', '/bc/filecoin', '/taline-gold'],
    });
  }

  if (!serveStatic(req, res)) {
    sendJson(res, 404, { error: 'Not found' });
  }
});

server.keepAliveTimeout = 65_000; // جلوگیری از قطع‌های 502 در پشت پروکسی Railway
server.headersTimeout = 66_000;

server.listen(PORT, () => {
  console.log(`Asset-Management server (web + price proxy) listening on port ${PORT}`);
});
