/**
 * server-alerts.js — v1.4.2 افزوده‌های سرور برای «اعلان رشد و ریزش»
 *
 * این فایل با اسکریپت merge به server.js اضافه می‌شود:
 *   ۱) لایهٔ آینهٔ طلاین: اگر t.me/s/TalinePrice و taline.ir هر دو نشدند،
 *      دو آینهٔ کمکی (webcache + r.jina.ai) هم امتحان می‌شوند.
 *   ۲) GET /price-alert-check?coins=BTC,ETH — خوراک مشترک اعلان‌ها و
 *      چشمک‌زن‌های اپ:
 *        - کوین‌ها: تغییر٪ ۲۴ساعته مستقیم از Binance ticker/24h
 *        - طلا ۱۸/۲۴، سکه‌ها، نقره، دلار: TGJU ajax.json — فیلد dp
 *          (درصد تغییر روزانه خود TGJU)؛ اگر dp نبود از baseline روزانهٔ
 *          خودمان (اولین قیمت هر روز تهران) محاسبه می‌شود.
 *        - تتر/دلار مبادلاتی: نوبیتکس USDT-Tومان (تغییر نسبت به baseline).
 */

'use strict';

// از server.js تزریق می‌شوند (attach)
var http, fs, path, sendJson, fetchWithTimeout, persianToEnglish,
    getCached, setCached, fetchNobitexUsdtToman,
    talineFetchLive, parseTalineTelegram, TALINE_TG_URL;

const TGJU_ALERT_URLS = [
  'https://call1.tgju.org/ajax.json',
  'https://call2.tgju.org/ajax.json',
  'https://call.tgju.org/ajax.json',
];

const ALERT_BASELINE_FILE = '/tmp/price-alert-baseline.json';
const ALERT_MIRRORS = [
  (u) => `https://r.jina.ai/${u}`,
];

/** روزِ تهران (UTC+3:30) به‌صورت YYYY-MM-DD */
function alertTehranDay(ts = Date.now()) {
  return new Date(ts + 3.5 * 3600_000).toISOString().slice(0, 10);
}

function alertReadBaselines() {
  try {
    return JSON.parse(fs.readFileSync(ALERT_BASELINE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function alertWriteBaselines(b) {
  try {
    fs.writeFileSync(ALERT_BASELINE_FILE, JSON.stringify(b), 'utf8');
  } catch {}
}

/** درصد تغییر نسبت به baselineِ امروز (اولین قیمت دیده‌شده در روز تهران). */
function alertPctVsBaseline(key, price) {
  if (!Number.isFinite(price) || price <= 0) return null;
  const day = alertTehranDay();
  const all = alertReadBaselines();
  const cur = all[key];
  if (!cur || cur.day !== day) {
    all[key] = { day, base: price };
    // رکوردهای روزهای قبلی را دور بریز (فایل سبز بماند)
    for (const k of Object.keys(all)) {
      if (all[k].day !== day) delete all[k];
    }
    alertWriteBaselines(all);
    return 0; // اولین دادهٔ روز → تغییر صفر
  }
  return ((price - cur.base) / cur.base) * 100;
}

/** درصد تغییر روزانهٔ TGJU از فیلد dp (اگر معتبر بود). */
function alertTgjuDp(entry) {
  const dp = parseFloat(persianToEnglish(String(entry?.dp ?? '')).replace(/[^\d.\-+]/g, ''));
  return Number.isFinite(dp) && Math.abs(dp) <= 60 ? dp : null;
}

async function alertFetchTgju() {
  for (const u of TGJU_ALERT_URLS) {
    try {
      const r = await fetchWithTimeout(u, {
        headers: { Referer: 'https://www.tgju.org/', 'User-Agent': 'Mozilla/5.0' },
      }, 12000);
      if (r.ok) {
        const j = await r.json();
        if (j?.current?.geram18) return j;
      }
    } catch {}
  }
  return null;
}

// TGJU symbol → کلید خوراک اپ
const ALERT_TGJU_KEYS = {
  geram18: 'metal:gold18',
  geram24: 'metal:gold24',
  sekee: 'metal:coinEmami',
  sekeb: 'metal:coinBahar',
  nim: 'metal:coinNim',
  rob: 'metal:coinRob',
  silver_999: 'metal:silver999',
  silver_925: 'metal:silver925',
  price_dollar_rl: 'metal:dollar',
};

async function handlePriceAlertCheck(res, params) {
  const coinsParam = (params.get('coins') ?? '').toUpperCase();
  const coins = [...new Set(coinsParam.split(',')
    .map((s) => s.trim().replace(/[^A-Z0-9]/g, ''))
    .filter((s) => s && s !== 'USDT' && s !== 'IRT' && s !== 'IRR' && s.length <= 10))];

  const items = [];
  const jobs = [];

  // ── کوین‌ها: Binance 24h (سرور خارج از ایران — بدون محدودیت) ──
  // سه دامنهٔ جایگزین + fallback تک‌سمبلی تا همیشه جواب بیاید.
  if (coins.length > 0) {
    jobs.push((async () => {
      const BINANCE_HOSTS = [
        'https://data-api.binance.vision',
        'https://api.binance.com',
        'https://api1.binance.com',
      ];
      const pushTicker = (t) => {
        const sym = String(t.symbol ?? '').replace(/USDT$/, '');
        const pct = parseFloat(t.priceChangePercent);
        const px = parseFloat(t.lastPrice);
        if (!sym || !Number.isFinite(pct)) return;
        items.push({
          key: `coin:${sym}`,
          sym,
          priceUsd: Number.isFinite(px) ? px : null,
          pct24h: pct,
        });
      };
      for (let i = 0; i < coins.length; i += 40) {
        const chunk = coins.slice(i, i + 40);
        let got = false;
        for (const host of BINANCE_HOSTS) {
          try {
            const syms = JSON.stringify(chunk.map((c) => `${c}USDT`));
            const r = await fetchWithTimeout(
              `${host}/api/v3/ticker/24h?symbols=${encodeURIComponent(syms)}`,
              {}, 12000
            );
            if (!r.ok) continue;
            const arr = await r.json();
            if (Array.isArray(arr) && arr.length > 0) {
              for (const t of arr) pushTicker(t);
              got = true;
              break;
            }
          } catch {}
        }
        if (got) continue;
        // fallback تک‌سمبلی (بعضی شبکه‌ها آرایه را پاس نمی‌کنند)
        for (const c of chunk) {
          for (const host of BINANCE_HOSTS.slice(0, 2)) {
            try {
              const r = await fetchWithTimeout(
                `${host}/api/v3/ticker/24h?symbol=${c}USDT`, {}, 10000
              );
              if (!r.ok) continue;
              const t = await r.json();
              if (t?.symbol) { pushTicker(t); break; }
            } catch {}
          }
        }
      }
    })());
  }

  // ── فلزات/دلار: TGJU (dp) + تتر: نوبیتکس ──
  jobs.push((async () => {
    const j = await alertFetchTgju();
    const cur = j?.current ?? {};
    const tomanPerUsdTgju = (() => {
      const n = parseFloat(persianToEnglish(String(cur['price_dollar_rl']?.p ?? '')).replace(/,/g, ''));
      return Number.isFinite(n) && n > 10000 && n < 100_000_000 ? n / 10 : null;
    })();
    for (const [sym, key] of Object.entries(ALERT_TGJU_KEYS)) {
      const e = cur[sym];
      // TGJU اعداد را «ریال» می‌دهد (مثل خود اپ: ÷10 → تومان)
      const raw = parseFloat(persianToEnglish(String(e?.p ?? '')).replace(/,/g, ''));
      const p = Number.isFinite(raw) && raw > 0 ? raw / 10 : NaN;
      if (!Number.isFinite(p) || p <= 0) continue;
      const pct = alertTgjuDp(e) ?? alertPctVsBaseline(key, p);
      items.push({ key, price: p, pct: pct ?? null, unit: 'تومان' });
    }
    // انس جهانی: TGJU dp دارد (دلاری)
    try {
      const ons = cur['ons'];
      const px = parseFloat(persianToEnglish(String(ons?.p ?? '')).replace(/,/g, ''));
      if (Number.isFinite(px) && px > 100) {
        items.push({ key: 'metal:goldOunceUsd', price: px, pct: alertTgjuDp(ons), unit: 'دلار' });
      }
    } catch {}
    // تتر تومانی (نوبیتکس) — تغییر نسبت به baseline امروز
    try {
      const toman = await fetchNobitexUsdtToman();
      const pct = alertPctVsBaseline('metal:usdtToman', toman);
      items.push({ key: 'metal:usdtToman', price: toman, pct: pct ?? null, unit: 'تومان' });
      items.push({ key: 'meta', tomanPerUsd: toman, tgjuDollar: tomanPerUsdTgju });
    } catch {
      items.push({ key: 'meta', tomanPerUsd: null, tgjuDollar: tomanPerUsdTgju });
    }
  })());

  await Promise.all(jobs);
  return sendJson(res, 200, { ok: true, ts: Date.now(), items });
}

/** لایهٔ آینهٔ طلاین — جایگزین talineFetchLive (دو منبع اصلی + دو آینه) */
async function talineFetchLiveWithMirrors() {
  const primary = await talineFetchLive();
  if (primary) return primary;
  for (const mirror of ALERT_MIRRORS) {
    try {
      const r = await fetchWithTimeout(mirror(TALINE_TG_URL), {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
      }, 12000);
      if (r.ok) {
        const parsed = parseTalineTelegram(await r.text());
        if (parsed) return { ...parsed, source: parsed.source + ' (آینه)' };
      }
    } catch {}
  }
  return null;
}


// ─── اتصال به server.js ─────────────────────────────────────────────────
let ctx = null;
function attach(c) {
  ctx = c;
  // تبدیل آرگومان‌های خارجی به متغیرهای سطح ماژول (توابع server.js)
  ({ http, fs, path, sendJson, fetchWithTimeout, persianToEnglish,
     getCached, setCached, fetchNobitexUsdtToman,
     talineFetchLive, parseTalineTelegram, TALINE_TG_URL } = c);
}
function attachAlerts() { return module.exports; }

module.exports = { attach, handlePriceAlertCheck };
