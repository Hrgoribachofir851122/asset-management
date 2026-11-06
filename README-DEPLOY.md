# راهنمای دیپلوی — وب روی GitHub Pages + همان ریپو روی Railway

این پکیج فقط فایل‌های لازم برای دیپلوی را دارد. **یک ریپو، دو دیپلوی:**

| مقصد | چه چیزی اجرا می‌شود | نتیجه |
|------|---------------------|--------|
| GitHub Pages | workflow خودکار → `expo export -p web` | وب‌اپ قیمت‌های لحظه‌ای روی `https://USER.github.io/REPO/` |
| Railway | Nixpacks → `expo export -p web` + `node server.js` | همان وب‌اپ + پروکسی قیمت تتر/تومان روی `https://…up.railway.app` |

وب‌اپ همان اپ «مدیریت دارایی» است (نسخه وب) — قیمت‌های لحظه‌ای طلا، ارز، رمزارز و محاسبه ارزش دارایی. صفحه تنظیمات (بازهٔ بروزرسانی و تم) هم در نسخه وب کار می‌کند.

---

## گام ۱ — ساخت ریپو روی GitHub و push فایل‌ها

1. در GitHub یک ریپوی جدید بسازید (مثلاً `asset-management`) — Public یا Private (برای Pages رایگان باید Public باشد).
2. محتویات این پکیج را در ریپو بگذارید. دو راه:

   **راه A — خط فرمان (پیشنهادی):**
   ```bash
   cd asset-management        # پوشهٔ بازشدهٔ زیپ
   git init
   git add .
   git commit -m "Asset management web deploy"
   git branch -M main
   git remote add origin https://github.com/USERNAME/asset-management.git
   git push -u origin main
   ```

   **راه B — بدون خط فرمان:** در صفحهٔ ریپو، «uploading an existing file» را بزنید و کل محتویات پوشه (شامل `.github`) را بکشید و رها کنید → Commit.

> نام ریپو مهم نیست؛ workflow خودش baseUrl را بر اساس نام ریپو تنظیم می‌کند.

## گام ۲ — فعال‌سازی GitHub Pages

1. ریپو → **Settings → Pages**
2. در قسمت **Build and deployment**، مقدار **Source** را روی **GitHub Actions** بگذارید.
3. تمام! تب **Actions** را باز کنید — workflow «Deploy Web to GitHub Pages» با هر push به `main` اجرا می‌شود (یا دکمهٔ Run workflow را بزنید).
4. بعد از سبز شدن، آدرس سایت: `https://USERNAME.github.io/asset-management/`

**دومین workflow** («Build Android APK») هم به‌صورت خودکار با هر push یک APK تازه می‌سازد — از تب Actions → آخرین اجرا → Artifacts قابل دانلود است.

## گام ۳ — دیپلوی همان ریپو روی Railway

1. وارد [railway.app](https://railway.app) شوید → **New Project → Deploy from GitHub repo**
2. همین ریپو (`asset-management`) را انتخاب کنید. Railway با خواندن `railway.json` و `nixpacks.toml` خودش:
   - Node 20 را آماده می‌کند،
   - `npm ci` + `expo export -p web` را اجرا می‌کند (بیلد وب)،
   - `node server.js` را استارت می‌کند.
3. بعد از Deploy، از تب **Settings → Networking → Generate Domain** یک دامنهٔ عمومی بسازید (مثلاً `asset-management-production.up.railway.app`).
4. آدرس Railway حالا **هم وب‌اپ را می‌دهد هم پروکسی قیمت**:
   - `https://…up.railway.app/` → وب‌اپ کامل
   - `https://…up.railway.app/health` → وضعیت سرویس
   - `https://…up.railway.app/nobitex/usdt-toman` → قیمت تتر/تومان (JSON، CORS باز)

## گام ۴ — اتصال دو بخش به هم (پیشنهادی)

در نسخهٔ وبِ Pages، منبع قیمت تتر/تومان بهتر است پروکسی Railway خودتان باشد تا از فیلترینگ/CORS مستقل شوید:

1. آدرس Railway خود را کپی کنید.
2. ریپو → **Settings → Secrets and variables → Actions → Variables → New repository variable**
   - Name: `PRICE_SERVER_URL`
   - Value: `https://asset-management-production.up.railway.app`
3. تب Actions → «Deploy Web to GitHub Pages» → **Re-run all jobs**.

> اگر این متغیر را نسازید، برنامه از سرور پیش‌فرض (pompay) استفاده می‌کند و بقیهٔ منابع قیمت هم مستقیم تست می‌شوند — اپ بدون این مرحله هم کار می‌کند.

## نکات مهم

- **CORS:** نسخهٔ وب از مرورگر اجرا می‌شود؛ بعضی APIها (مثل Binance و Nobitex) سرورهایشان CORS را باز گذاشته‌اند و مستقیم کار می‌کنند، ولی بعضی منابع ایرانی فقط از طریق پروکسی (سرور Railway شما) قابل دسترس‌اند. زنجیرهٔ منابع قیمت در اپ به‌صورت خودکار fallback می‌کند.
- **دامنهٔ اختصاصی Pages:** اگر دامنهٔ شخصی روی Pages ست کردید، در Variables ریپو متغیر `BASE_URL_OVERRIDE` را با مقدار `/` بسازید و workflow را دوباره اجرا کنید.
- **بیلد Railway:** اولین بیلد ۵ تا ۱۰ دقیقه طول می‌کشد (نصب وابستگی‌ها + باندل Metro). اگر مجدد دیپلوی کردید، از کش استفاده می‌شود.
- **سرور Railway هیچ وابستگی اضافه‌ای ندارد** (فقط Node 18+) و علاوه بر وب، اندپوینت‌های پروکسی `/nobitex/usdt-toman` و `/alanchand/usdt-toman` را با کش ۶۰ ثانیه و CORS باز سرو می‌کند.
- **تست محلی وب:**
  ```bash
  npm ci
  npm run build:web   # → پوشهٔ dist
  npm run serve:web   # → http://localhost:3000
  ```

## ساختار فایل‌ها

```
├── .github/workflows/
│   ├── deploy-pages.yml      ← دیپلوی خودکار وب روی GitHub Pages
│   └── build-apk.yml         ← ساخت خودکار APK در تب Actions
├── scripts/set-web-base.js   ← تنظیم خودکار baseUrl متناسب با نام ریپو
├── server.js                 ← سرور Railway: وب‌اپ + پروکسی قیمت (بدون وابستگی)
├── railway.json              ← تنظیمات بیلد/استارت Railway
├── nixpacks.toml             ← نسخهٔ Node بیلد Railway
├── app.json                  ← تنظیمات Expo (web.output = export)
├── package.json / package-lock.json
├── app/ components/ constants/ contexts/ types/ utils/ assets/
├── babel.config.js metro.config.js tsconfig.json eslint.config.js
├── README.md                 ← مستندات پروژه
└── README-DEPLOY.md          ← همین راهنما
```
