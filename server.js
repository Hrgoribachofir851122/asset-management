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

// ─── HTTP server ────────────────────────────────────────────────────────
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

  if (urlPath === '/health' || urlPath === '/api/health') {
    const hasDist = fs.existsSync(path.join(DIST, 'index.html'));
    return sendJson(res, 200, {
      status: 'ok',
      service: 'asset-management web + price proxy',
      web: hasDist ? 'ready' : 'dist missing (run: npx expo export --platform web)',
      endpoints: ['/nobitex/usdt-toman', '/alanchand/usdt-toman', '/ip-check'],
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
