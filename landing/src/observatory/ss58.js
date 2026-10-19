// SS58 address encoding, so a raw 32-byte account id read off the node can be
// shown, and linked to the explorer, in the same form the rest of the site
// uses. Needs blake2b-512 for the checksum; the implementation below is the
// standard 32-bit-halves construction (as in blakejs), kept here so the page
// does not ship a crypto library for one hash.

const IV32 = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a, 0xade682d1,
  0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

const SIGMA8 = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3, 11, 8, 12, 0,
  5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4, 7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8, 9, 0, 5, 7, 2, 4, 10,
  15, 14, 1, 11, 12, 6, 8, 3, 13, 2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9, 12, 5, 1, 15, 14, 13, 4, 10, 0,
  7, 6, 3, 9, 2, 8, 11, 13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10, 6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7,
  1, 4, 10, 5, 10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
  15, 14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
];
const SIGMA82 = new Uint8Array(SIGMA8.map((x) => x * 2));

const v = new Uint32Array(32);
const m = new Uint32Array(32);

function add64AA(a, b) {
  const o0 = v[a] + v[b];
  let o1 = v[a + 1] + v[b + 1];
  if (o0 >= 0x100000000) o1 += 1;
  v[a] = o0;
  v[a + 1] = o1;
}

function add64AC(a, b0, b1) {
  let o0 = v[a] + b0;
  if (b0 < 0) o0 += 0x100000000;
  let o1 = v[a + 1] + b1;
  if (o0 >= 0x100000000) o1 += 1;
  v[a] = o0;
  v[a + 1] = o1;
}

function get32(arr, i) {
  return arr[i] ^ (arr[i + 1] << 8) ^ (arr[i + 2] << 16) ^ (arr[i + 3] << 24);
}

function g(a, b, c, d, ix, iy) {
  const x0 = m[ix];
  const x1 = m[ix + 1];
  const y0 = m[iy];
  const y1 = m[iy + 1];
  add64AA(a, b);
  add64AC(a, x0, x1);
  let xor0 = v[d] ^ v[a];
  let xor1 = v[d + 1] ^ v[a + 1];
  v[d] = xor1;
  v[d + 1] = xor0;
  add64AA(c, d);
  xor0 = v[b] ^ v[c];
  xor1 = v[b + 1] ^ v[c + 1];
  v[b] = (xor0 >>> 24) ^ (xor1 << 8);
  v[b + 1] = (xor1 >>> 24) ^ (xor0 << 8);
  add64AA(a, b);
  add64AC(a, y0, y1);
  xor0 = v[d] ^ v[a];
  xor1 = v[d + 1] ^ v[a + 1];
  v[d] = (xor0 >>> 16) ^ (xor1 << 16);
  v[d + 1] = (xor1 >>> 16) ^ (xor0 << 16);
  add64AA(c, d);
  xor0 = v[b] ^ v[c];
  xor1 = v[b + 1] ^ v[c + 1];
  v[b] = (xor1 >>> 31) ^ (xor0 << 1);
  v[b + 1] = (xor0 >>> 31) ^ (xor1 << 1);
}

function compress(ctx, last) {
  for (let i = 0; i < 16; i += 1) {
    v[i] = ctx.h[i];
    v[i + 16] = IV32[i];
  }
  v[24] ^= ctx.t;
  v[25] ^= ctx.t / 0x100000000;
  if (last) {
    v[28] = ~v[28];
    v[29] = ~v[29];
  }
  for (let i = 0; i < 32; i += 1) m[i] = get32(ctx.b, 4 * i);
  for (let i = 0; i < 12; i += 1) {
    const s = i * 16;
    g(0, 8, 16, 24, SIGMA82[s], SIGMA82[s + 1]);
    g(2, 10, 18, 26, SIGMA82[s + 2], SIGMA82[s + 3]);
    g(4, 12, 20, 28, SIGMA82[s + 4], SIGMA82[s + 5]);
    g(6, 14, 22, 30, SIGMA82[s + 6], SIGMA82[s + 7]);
    g(0, 10, 20, 30, SIGMA82[s + 8], SIGMA82[s + 9]);
    g(2, 12, 22, 24, SIGMA82[s + 10], SIGMA82[s + 11]);
    g(4, 14, 16, 26, SIGMA82[s + 12], SIGMA82[s + 13]);
    g(6, 8, 18, 28, SIGMA82[s + 14], SIGMA82[s + 15]);
  }
  for (let i = 0; i < 16; i += 1) ctx.h[i] = ctx.h[i] ^ v[i] ^ v[i + 16];
}

/** Unkeyed blake2b of `input` (Uint8Array) with `outlen` bytes of output. */
export function blake2b(input, outlen = 64) {
  const ctx = { b: new Uint8Array(128), h: new Uint32Array(16), t: 0, c: 0 };
  ctx.h.set(IV32);
  ctx.h[0] ^= 0x01010000 ^ outlen;
  for (let i = 0; i < input.length; i += 1) {
    if (ctx.c === 128) {
      ctx.t += ctx.c;
      compress(ctx, false);
      ctx.c = 0;
    }
    ctx.b[ctx.c] = input[i];
    ctx.c += 1;
  }
  ctx.t += ctx.c;
  while (ctx.c < 128) {
    ctx.b[ctx.c] = 0;
    ctx.c += 1;
  }
  compress(ctx, true);
  const out = new Uint8Array(outlen);
  for (let i = 0; i < outlen; i += 1) out[i] = ctx.h[i >> 2] >> (8 * (i & 3));
  return out;
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const SS58_PREFIX = new TextEncoder().encode('SS58PRE');

/** SS58 encoding of a 32-byte public key. The chain's format is 42. */
export function encodeSs58(publicKey, format = 42) {
  if (publicKey.length !== 32) throw new Error(`expected a 32-byte key, got ${publicKey.length}`);
  if (format < 0 || format > 63) throw new Error('only single-byte SS58 prefixes are supported');
  const body = new Uint8Array(33);
  body[0] = format;
  body.set(publicKey, 1);
  const hashed = new Uint8Array(SS58_PREFIX.length + body.length);
  hashed.set(SS58_PREFIX);
  hashed.set(body, SS58_PREFIX.length);
  const checksum = blake2b(hashed, 64);
  const out = new Uint8Array(35);
  out.set(body);
  out[33] = checksum[0];
  out[34] = checksum[1];
  return base58Encode(out);
}
