/**
 * blake2b.ts — minimal pure-TS BLAKE2b (RFC 7693), unkeyed, digest 8..64 bytes.
 *
 * v1.4.17 — needed for Polkadot balance reading (Substrate storage keys use
 * blake2_256(accountId) for System.Account, and ss58 addresses carry a
 * blake2b-8 checksum). Verified against hashlib.blake2b in the build sandbox.
 * No tree hashing, no key — exactly the two modes the chain uses.
 */

const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];

/** Round offsets (sigma) for 12 rounds. */
const SIGMA: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];

function rotr(x: bigint, n: number): bigint {
  const mask = (1n << BigInt(n)) - 1n;
  return ((x >> BigInt(n)) | ((x & mask) << BigInt(64 - n))) & 0xffffffffffffffffn;
}

function g(
  v: bigint[],
  a: number,
  b: number,
  c: number,
  d: number,
  x: bigint,
  y: bigint
): void {
  v[a] = (v[a] + v[b] + x) & 0xffffffffffffffffn;
  v[d] = rotr(v[d] ^ v[a], 32);
  v[c] = (v[c] + v[d]) & 0xffffffffffffffffn;
  v[b] = rotr(v[b] ^ v[c], 24);
  v[a] = (v[a] + v[b] + y) & 0xffffffffffffffffn;
  v[d] = rotr(v[d] ^ v[a], 16);
  v[c] = (v[c] + v[d]) & 0xffffffffffffffffn;
  v[b] = rotr(v[b] ^ v[c], 63);
}

function compress(
  h: bigint[],
  block: bigint[],
  t: bigint,
  last: boolean
): void {
  const v = [...h, IV[0], IV[1], IV[2], IV[3], IV[4], IV[5], IV[6], IV[7]];
  // counter (t is the total bytes hashed incl. this block)
  v[12] = (v[12] ^ (t & 0xffffffffffffffffn)) & 0xffffffffffffffffn;
  v[13] = (v[13] ^ ((t >> 64n) & 0xffffffffffffffffn)) & 0xffffffffffffffffn;
  // RFC 7693: the last-block flag XORs v[14]
  if (last) v[14] = (v[14] ^ 0xffffffffffffffffn) & 0xffffffffffffffffn;

  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r];
    g(v, 0, 4, 8, 12, block[s[0]], block[s[1]]);
    g(v, 1, 5, 9, 13, block[s[2]], block[s[3]]);
    g(v, 2, 6, 10, 14, block[s[4]], block[s[5]]);
    g(v, 3, 7, 11, 15, block[s[6]], block[s[7]]);
    g(v, 0, 5, 10, 15, block[s[8]], block[s[9]]);
    g(v, 1, 6, 11, 12, block[s[10]], block[s[11]]);
    g(v, 2, 7, 8, 13, block[s[12]], block[s[13]]);
    g(v, 3, 4, 9, 14, block[s[14]], block[s[15]]);
  }

  for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
}

/** Unkeyed BLAKE2b with the requested digest length (8..64). */
export function blake2b(input: Uint8Array, digestBytes: number): Uint8Array {
  const len = Math.max(8, Math.min(64, digestBytes | 0));
  const h = [...IV];
  h[0] ^= 0x01010000n ^ BigInt(len); // key length 0, digest length

  // process 128-byte blocks; the last (possibly partial) block is final
  const total = input.length;
  let offset = 0;
  if (total === 0) {
    compress(h, new Array(16).fill(0n), 0n, true);
  } else {
    while (offset < total) {
      const remaining = total - offset;
      const isLast = remaining <= 128;
      const take = Math.min(remaining, 128);
      const block: bigint[] = new Array(16).fill(0n);
      for (let i = 0; i < take; i++) {
        const idx = offset + i;
        const word = i >> 3;
        block[word] |= BigInt(input[idx]) << BigInt((i & 7) * 8);
      }
      compress(h, block, BigInt(offset + take), isLast);
      offset += take;
    }
  }

  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = Number((h[i >> 3] >> BigInt((i & 7) * 8)) & 0xffn);
  }
  return out;
}

/** BLAKE2b-256 hex string (no 0x prefix) — Substrate storage hash. */
export function blake2b256Hex(input: Uint8Array): string {
  return [...blake2b(input, 32)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** BLAKE2b-8 checksum hex (4 bytes) — ss58 address checksum. */
export function blake2b8Hex(input: Uint8Array): string {
  return [...blake2b(input, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
