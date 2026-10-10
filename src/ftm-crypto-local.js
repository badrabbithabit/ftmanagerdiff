/* FTMCryptoLocal — FTManager 5.6 .ftm container decryption (owner maps,
 * no password). Published deliberately: this is an interoperability tool
 * for reading one's own tune files with a different program (see
 * research/ftm560/REVERSE.md for the full format writeup). The key is a
 * vendor-wide fixed constant; use it on your own maps.
 *
 * Layout (little-endian):
 *   [0 .. len-36-size)        AES-256-CBC/PKCS7 ciphertext (plaintext = gzip XML)
 *   [len-36 .. len-20)        ID1  = 2f6ec73a908cf6aa637b95f59bcbf34e
 *   [len-20 .. len-4)         TestBlock (all zero when no map password)
 *   [len-4  .. len)           int32 UserBlockedSize (optional AdjustCripto block
 *                             sits immediately before ID1; usually 0)
 *   key = SHA256(ID1), iv = "kE1(iH1#fD2@bB2+"
 *
 * UMD: window.FTMCryptoLocal (browser) / module.exports (node).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FTMCryptoLocal = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ID1 = '2f6ec73a908cf6aa637b95f59bcbf34e';
  const IV = 'kE1(iH1#fD2@bB2+';

  /* ---------------- SHA-256 ---------------- */
  const K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function sha256(bytes) {
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const len = bytes.length;
    const withPad = new Uint8Array((((len + 9 + 63) >> 6) << 6));
    withPad.set(bytes);
    withPad[len] = 0x80;
    const dv = new DataView(withPad.buffer);
    dv.setUint32(withPad.length - 4, (len * 8) >>> 0, false);
    dv.setUint32(withPad.length - 8, Math.floor(len / 536870912), false);
    const w = new Int32Array(64);
    for (let off = 0; off < withPad.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K256[i] + w[i]) | 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const mj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + mj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i], false);
    return out;
  }
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  /* ---------------- AES (128/192/256, decrypt) ---------------- */
  const SBOX = new Uint8Array([
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16]);
  const INV = new Uint8Array(256);
  for (let i = 0; i < 256; i++) INV[SBOX[i]] = i;

  function xtime(b) { return ((b << 1) ^ ((b & 0x80) ? 0x1b : 0)) & 0xff; }
  function gmul(a, b) { let r = 0; while (b) { if (b & 1) r ^= a; a = xtime(a); b >>= 1; } return r; }

  function expandKey(key) {
    const Nk = key.length / 4, Nr = Nk + 6;
    const w = new Uint8Array(16 * (Nr + 1));
    w.set(key);
    let rcon = 1;
    for (let i = Nk; i < 4 * (Nr + 1); i++) {
      let t0 = w[(i - 1) * 4], t1 = w[(i - 1) * 4 + 1], t2 = w[(i - 1) * 4 + 2], t3 = w[(i - 1) * 4 + 3];
      if (i % Nk === 0) {
        // rotword + subword + rcon
        const a = t0, b = t1, c = t2, d = t3;
        t0 = SBOX[b] ^ rcon; t1 = SBOX[c]; t2 = SBOX[d]; t3 = SBOX[a];
        rcon = xtime(rcon);
      } else if (Nk > 6 && i % Nk === 4) {
        t0 = SBOX[t0]; t1 = SBOX[t1]; t2 = SBOX[t2]; t3 = SBOX[t3];
      }
      w[i * 4] = w[(i - Nk) * 4] ^ t0;
      w[i * 4 + 1] = w[(i - Nk) * 4 + 1] ^ t1;
      w[i * 4 + 2] = w[(i - Nk) * 4 + 2] ^ t2;
      w[i * 4 + 3] = w[(i - Nk) * 4 + 3] ^ t3;
    }
    return { w, Nr };
  }

  function decryptBlock(s, w, Nr) {
    // state s: 16 bytes, column-major (AES order)
    addRoundKey(s, w, Nr * 16);
    for (let round = Nr - 1; round >= 0; round--) {
      invShiftRows(s);
      invSubBytes(s);
      addRoundKey(s, w, round * 16);
      if (round !== 0) invMixColumns(s);
    }
  }
  function addRoundKey(s, w, off) { for (let i = 0; i < 16; i++) s[i] ^= w[off + i]; }
  function invShiftRows(s) {
    // row r shifted right by r
    let t;
    t = s[1]; s[1] = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = t;
    t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
    t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t;
  }
  function invSubBytes(s) { for (let i = 0; i < 16; i++) s[i] = INV[s[i]]; }
  function invMixColumns(s) {
    for (let c = 0; c < 4; c++) {
      const i = c * 4, a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
      s[i]     = gmul(a0,0x0e) ^ gmul(a1,0x0b) ^ gmul(a2,0x0d) ^ gmul(a3,0x09);
      s[i + 1] = gmul(a0,0x09) ^ gmul(a1,0x0e) ^ gmul(a2,0x0b) ^ gmul(a3,0x0d);
      s[i + 2] = gmul(a0,0x0d) ^ gmul(a1,0x09) ^ gmul(a2,0x0e) ^ gmul(a3,0x0b);
      s[i + 3] = gmul(a0,0x0b) ^ gmul(a1,0x0d) ^ gmul(a2,0x09) ^ gmul(a3,0x0e);
    }
  }

  function aesCbcDecrypt(keyBytes, ivBytes, data) {
    const { w, Nr } = expandKey(keyBytes);
    const out = new Uint8Array(data.length);
    let prev = ivBytes;
    const s = new Uint8Array(16);
    for (let off = 0; off + 16 <= data.length; off += 16) {
      for (let i = 0; i < 16; i++) s[i] = data[off + i];
      decryptBlock(s, w, Nr);
      for (let i = 0; i < 16; i++) out[off + i] = s[i] ^ prev[i];
      prev = data.subarray(off, off + 16);
    }
    // strip PKCS#7
    const n = out[out.length - 1];
    if (n >= 1 && n <= 16) {
      let ok = true;
      for (let i = 0; i < n; i++) if (out[out.length - 1 - i] !== n) { ok = false; break; }
      if (ok) return out.subarray(0, out.length - n);
    }
    return out;
  }

  /* ---------------- container ---------------- */
  function asciiBytes(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }
  function hexBytes(h) { const b = new Uint8Array(h.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b; }

  function hasContainer(bytes) {
    if (bytes.length < 56) return false;
    const id = bytes.subarray(bytes.length - 36, bytes.length - 20);
    let expect = hexBytes(ID1), same = true;
    for (let i = 0; i < 16; i++) if (id[i] !== expect[i]) { same = false; break; }
    return same;
  }

  function decryptContainer(bytes) {
    if (!hasContainer(bytes)) { const e = new Error('bad-container'); e.code = 'bad-container'; throw e; }
    const size = new DataView(bytes.buffer, bytes.byteOffset).getInt32(bytes.length - 4, true);
    if (size < 0 || size > bytes.length - 56) { const e = new Error('bad-container'); e.code = 'bad-container'; throw e; }
    const testBlock = bytes.subarray(bytes.length - 20, bytes.length - 4);
    for (let i = 0; i < 16; i++) {
      if (testBlock[i] !== 0) { const e = new Error('password-protected'); e.code = 'password-protected'; throw e; }
    }
    const bodyEnd = bytes.length - 36 - size;
    const body = bytes.subarray(0, bodyEnd);
    if (body.length % 16 !== 0) { const e = new Error('bad-container'); e.code = 'bad-container'; throw e; }
    const key = sha256(hexBytes(ID1));
    const gz = aesCbcDecrypt(key, asciiBytes(IV), body);
    return gz; // gzip stream (1f 8b ...) — caller inflates
  }

  return { decryptContainer, hasContainer, sha256, aesCbcDecrypt };
});
