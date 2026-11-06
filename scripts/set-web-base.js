/**
 * set-web-base.js — تنظیم خودکار baseUrl برای GitHub Pages
 *
 * GitHub Pages برای ریپوهای معمولی سایت را زیر /<repo-name>/ سرو می‌کند،
 * پس بیلد وب Expo باید همان baseUrl را داشته باشد وگرنه فایل‌ها ۴۰۴ می‌شوند.
 *
 * این اسکریپت در GitHub Actions (قبل از `expo export`) اجرا می‌شود:
 *   - اگر ریپو «username.github.io» باشد → baseUrl حذف می‌شود (سایت در ریشه است)
 *   - اگر متغیر ریپو BASE_URL_OVERRIDE مقدار '/' داشته باشد → ریشه (برای دامنه اختصاصی)
 *   - در بقیه حالت‌ها → baseUrl = /<repo-name>
 *
 * خارج از GitHub Actions (مثلاً بیلد محلی یا Railway) هیچ تغییری نمی‌دهد
 * تا برنامه در ریشهٔ دامنه سرو شود.
 */

const fs = require('fs');
const path = require('path');

const appJsonPath = path.join(process.cwd(), 'app.json');
const config = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));

const repoSlug = process.env.GITHUB_REPOSITORY || ''; // مثال: "my-user/asset-management"
const repoName = repoSlug.split('/')[1] || '';
const owner = (process.env.GITHUB_REPOSITORY_OWNER || '').toLowerCase();
const isUserSite = !!repoName && owner && repoName.toLowerCase() === `${owner}.github.io`;

let base = '';
if (repoName && !isUserSite) {
  base = '/' + repoName;
}

// اجازهٔ بازنویسی دستی از طریق متغیر ریپو (مثلاً '/' برای دامنهٔ اختصاصی)
const override = (process.env.BASE_URL_OVERRIDE || '').trim();
if (override) {
  base = override === '/' ? '' : override;
}

config.experiments = config.experiments || {};
if (base) {
  config.experiments.baseUrl = base;
} else {
  delete config.experiments.baseUrl;
}

fs.writeFileSync(appJsonPath, JSON.stringify(config, null, 2) + '\n');
console.log(`[set-web-base] GITHUB_REPOSITORY=${repoSlug || '-'} → baseUrl = ${base || '(root)'}`);
