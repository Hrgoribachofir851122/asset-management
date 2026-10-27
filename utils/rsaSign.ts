/**
 * utils/rsaSign.ts — v1.5.4
 *
 * امضای RSA-SHA256 (PKCS#1 v1.5) برای کلیدهای API از نوع RSA — بدون هیچ
 * کتابخانه جدید (BigInt بومی + crypto-js برای SHA-256/Base64).
 *
 * چرا این فایل لازم شد؟
 *   کاربر: «مدیریت دارایی صرافی البانک (LBank) ارور 10203 می‌دهد».
 *   مستند رسمی LBank: 10203 = 签名方式错误 = «روش امضا اشتباه است».
 *   LBank دو نوع کلید می‌دهد:
 *     • HmacSHA256 — Secret کوتاه (۳۲ کاراکر) → امضا = HmacSHA256(md5Upper)
 *     • RSA        — Secret طولانی (کلید خصوصی PKCS#8 به base64) → امضا =
 *                    Base64(RSA-SHA256-Sign(md5Upper)) و signature_method=«RSA»
 *   کلیدهای جدید LBank به‌صورت پیش‌فرض RSA ساخته می‌شوند؛ برنامه تا v1.5.3
 *   همیشه HmacSHA256 می‌فرستاد → سرور 10203 برمی‌گرداند.
 *   (ccxt هم همین تفکیک را دارد: secret.length > 32 → RSA)
 *
 * فرمت خروجی: base64 — دقیقاً مثل مثال رسمی LBank:
 *   Signature.getInstance("SHA256WithRSA") روی preparedStr (رشته MD5 بزرگ)
 *   و خروجی Base64.
 *
 * تست شده در برابر openssl (scripts/test-rsa-sign.cjs):
 *   PKCS#8 PEM / PKCS#1 PEM / base64 خام بدون هدر — هر سه «Verified OK».
 */

import CryptoJS from 'crypto-js';

// ---------------------------------------------------------------------------
// Base64 / bytes helpers (بدون وابستگی به atob — در هر دو RN و Node کار می‌کند)
// ---------------------------------------------------------------------------

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64 → bytes (فاصله‌ها و خط جدید نادیده گرفته می‌شوند؛ padding اختیاری). */
function base64ToBytes(input: string): number[] {
  const clean = input.replace(/[^A-Za-z0-9+/=]/g, '');
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    if (ch === '=') break;
    const v = B64_ALPHABET.indexOf(ch);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return out;
}

/** bytes → base64 با padding. */
function bytesToBase64(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i];
    const b2 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b3 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b1 >> 2];
    out += B64_ALPHABET[((b1 & 0x03) << 4) | (b2 >> 4)];
    out += i + 1 < bytes.length ? B64_ALPHABET[((b2 & 0x0f) << 2) | (b3 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64_ALPHABET[b3 & 0x3f] : '=';
  }
  return out;
}

/** رشته hex → bytes. */
function hexToBytes(hex: string): number[] {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    out.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}

/** bytes → BigInt (مثبت؛ صفرهای ابتدایی بی‌اثرند). */
function bytesToBigInt(bytes: number[]): bigint {
  let acc = BigInt(0);
  for (const b of bytes) acc = (acc << BigInt(8)) | BigInt(b);
  return acc;
}

/** BigInt → bytes با طول ثابت (padding صفر از چپ). */
function bigIntToBytes(value: bigint, length: number): number[] {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  const raw = hexToBytes(hex);
  if (raw.length > length) {
    return raw.slice(raw.length - length);
  }
  while (raw.length < length) raw.unshift(0);
  return raw;
}

/** توان پیمایشی مربع‌وتکثیر — m^e mod n. */
function modPow(m: bigint, e: bigint, n: bigint): bigint {
  if (n === BigInt(0)) return BigInt(0);
  let result = BigInt(1);
  let base = m % n;
  let exp = e;
  while (exp > BigInt(0)) {
    if (exp & BigInt(1)) result = (result * base) % n;
    base = (base * base) % n;
    exp >>= BigInt(1);
  }
  return result;
}

// ---------------------------------------------------------------------------
// DER (ASN.1) — فقط به اندازه لازم: استخراج n و d از PKCS#8 یا PKCS#1
// ---------------------------------------------------------------------------

interface DerElement {
  tag: number;
  /** بایت‌های محتوا. */
  content: number[];
}

function readDer(bytes: number[], offset: number): { el: DerElement; next: number } | null {
  if (offset + 2 > bytes.length) return null;
  const tag = bytes[offset];
  let idx = offset + 1;
  let len = bytes[idx];
  idx += 1;
  if (len & 0x80) {
    const numLenBytes = len & 0x7f;
    if (numLenBytes === 0 || numLenBytes > 4 || idx + numLenBytes > bytes.length) return null;
    len = 0;
    for (let i = 0; i < numLenBytes; i++) len = len * 256 + bytes[idx + i];
    idx += numLenBytes;
  }
  if (len < 0 || idx + len > bytes.length) return null;
  return { el: { tag, content: bytes.slice(idx, idx + len) }, next: idx + len };
}

function readAllDer(bytes: number[]): DerElement[] {
  const out: DerElement[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const r = readDer(bytes, offset);
    if (!r) break;
    out.push(r.el);
    offset = r.next;
  }
  return out;
}

/** استخراج (n, d) از DER یک RSAPrivateKey (PKCS#1) یا PKCS#8 PrivateKeyInfo. */
function extractRsaKeyFromDer(der: number[]): { n: bigint; d: bigint } | null {
  const seq = readAllDer(der);
  if (seq.length === 0 || seq[0].tag !== 0x30) return null;
  const children = readAllDer(seq[0].content);

  // PKCS#1 RSAPrivateKey ::= SEQUENCE { INTEGER version, INTEGER n, INTEGER e, INTEGER d, ... }
  if (children.length >= 4 && children[0].tag === 0x02 && children[1].tag === 0x02 && children[3].tag === 0x02) {
    const n = bytesToBigInt(children[1].content);
    const d = bytesToBigInt(children[3].content);
    if (n > BigInt(0) && d > BigInt(0)) return { n, d };
  }

  // PKCS#8 PrivateKeyInfo ::= SEQUENCE { INTEGER version, SEQUENCE alg, OCTET STRING pkcs1Der }
  if (children.length >= 3 && children[0].tag === 0x02 && children[1].tag === 0x30 && children[2].tag === 0x04) {
    return extractRsaKeyFromDer(children[2].content);
  }
  return null;
}

// ---------------------------------------------------------------------------
// PEM / Secret نرمال‌سازی
// ---------------------------------------------------------------------------

/**
 * Secret کاربر را به bytes DER تبدیل می‌کند.
 * قابل قبول: PEM با هدر (PKCS#8 یا PKCS#1) یا base64 خام (بدون هدر).
 */
function secretToDer(secret: string): number[] | null {
  const trimmed = secret.trim();
  if (!trimmed) return null;
  if (/-----BEGIN[^-]*KEY-----/.test(trimmed)) {
    const body = trimmed.replace(/-----BEGIN[^-]*-----/, '').replace(/-----END[^-]*-----/, '');
    const bytes = base64ToBytes(body);
    if (bytes.length > 0) return bytes;
    return null;
  }
  const bytes = base64ToBytes(trimmed);
  return bytes.length > 0 ? bytes : null;
}

// ---------------------------------------------------------------------------
// امضا
// ---------------------------------------------------------------------------

/** پیشوند DER برای SHA-256 DigestInfo (RFC 8017, PKCS#1 v1.5). */
const SHA256_DIGEST_INFO_PREFIX = [0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20];

/**
 * آیا این Secret یک کلید RSA است؟
 *   • PEM با هدر BEGIN ... PRIVATE KEY → بله
 *   • base64 خیلی طولانی (کلید ۱۰۲۴ بیتی حداقل ~۴۵۰ کاراکتر) → بله
 *   • Secret کوتاه HmacSHA256 (≤ ۳۲) → خیر
 */
export function isRsaSecret(secret: string): boolean {
  const s = (secret ?? '').trim();
  if (!s) return false;
  if (/-----BEGIN[^-]*PRIVATE KEY-----/.test(s)) return true;
  const compact = s.replace(/\s+/g, '');
  // کلیدهای RSA واقعی (۱۰۲۴ بیت به بالا) base64 خیلی طولانی دارند؛
  // Secret های HMAC کوتاه‌اند — مرز امن با فاصله زیاد انتخاب شده.
  return compact.length > 128 && /^[A-Za-z0-9+/=\s]+$/.test(s);
}

/**
 * امضای RSA-SHA256 (PKCS#1 v1.5) روی `message` با `secret` (PEM یا base64).
 * خروجی base64 — مثل مثال رسمی LBank.
 * در صورت خطا (کلید نامعتبر) null برمی‌گرداند تا caller به HMAC برگردد.
 */
export function rsaSignSha256(message: string, secret: string): string | null {
  try {
    const der = secretToDer(secret);
    if (!der) return null;
    const key = extractRsaKeyFromDer(der);
    if (!key) return null;

    // SHA-256 روی پیام (crypto-js رشته را UTF-8 تفسیر می‌کند)
    const digest = hexToBytes(CryptoJS.SHA256(message).toString(CryptoJS.enc.Hex));

    // DigestInfo = پیشوند + digest
    const t = SHA256_DIGEST_INFO_PREFIX.concat(digest);
    const k = Math.ceil(key.n.toString(2).length / 8); // طول بایتی ماژولوس n
    if (k < t.length + 11) return null; // کلید خیلی کوچک است

    // EM = 0x00 || 0x01 || PS(0xFF..) || 0x00 || DigestInfo
    const em: number[] = [0x00, 0x01];
    for (let i = 0; i < k - t.length - 3; i++) em.push(0xff);
    em.push(0x00);
    for (const b of t) em.push(b);

    const sig = modPow(bytesToBigInt(em), key.d, key.n);
    return bytesToBase64(bigIntToBytes(sig, k));
  } catch {
    return null;
  }
}
