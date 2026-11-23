/*
 * Break the QR — qr-core.js
 * --------------------------------------------------------------
 * A from-scratch QR Code encoder (ISO/IEC 18004, byte mode,
 * versions 1–10, levels L/M/Q/H) that also produces a MODULE ROLE
 * MAP and a CODEWORD MAP: for every square we know whether it is a
 * finder eye, timing ruler, format label, alignment target, version
 * label, or which bit of which data / backup (error-correction)
 * codeword it carries.
 *
 * Written by the team. Works in the browser (window.QRCore) and in
 * Node (module.exports) so it can be unit-tested against jsQR.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QRCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LEVELS = ['L', 'M', 'Q', 'H'];
  const FORMAT_EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };
  const LEVEL_NAMES = { L: 'Low (~7%)', M: 'Medium (~15%)', Q: 'Quartile (~25%)', H: 'High (~30%)' };
  const MAX_VERSION = 10;

  // [backup codewords per block, group1 blocks, group1 data cw, group2 blocks, group2 data cw]
  const EC_TABLE = {
    1:  { L: [7, 1, 19, 0, 0],   M: [10, 1, 16, 0, 0],  Q: [13, 1, 13, 0, 0],  H: [17, 1, 9, 0, 0] },
    2:  { L: [10, 1, 34, 0, 0],  M: [16, 1, 28, 0, 0],  Q: [22, 1, 22, 0, 0],  H: [28, 1, 16, 0, 0] },
    3:  { L: [15, 1, 55, 0, 0],  M: [26, 1, 44, 0, 0],  Q: [18, 2, 17, 0, 0],  H: [22, 2, 13, 0, 0] },
    4:  { L: [20, 1, 80, 0, 0],  M: [18, 2, 32, 0, 0],  Q: [26, 2, 24, 0, 0],  H: [16, 4, 9, 0, 0] },
    5:  { L: [26, 1, 108, 0, 0], M: [24, 2, 43, 0, 0],  Q: [18, 2, 15, 2, 16], H: [22, 2, 11, 2, 12] },
    6:  { L: [18, 2, 68, 0, 0],  M: [16, 4, 27, 0, 0],  Q: [24, 4, 19, 0, 0],  H: [28, 4, 15, 0, 0] },
    7:  { L: [20, 2, 78, 0, 0],  M: [18, 4, 31, 0, 0],  Q: [18, 2, 14, 4, 15], H: [26, 4, 13, 1, 14] },
    8:  { L: [24, 2, 97, 0, 0],  M: [22, 2, 38, 2, 39], Q: [22, 4, 18, 2, 19], H: [26, 4, 14, 2, 15] },
    9:  { L: [30, 2, 116, 0, 0], M: [22, 3, 36, 2, 37], Q: [20, 4, 16, 4, 17], H: [24, 4, 12, 4, 13] },
    10: { L: [18, 2, 68, 2, 69], M: [26, 4, 43, 1, 44], Q: [24, 6, 19, 2, 20], H: [28, 6, 15, 2, 16] },
  };

  const ALIGNMENT = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };

  /* ---------------- Galois field GF(256) + Reed–Solomon ---------------- */
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  const genCache = {};
  function rsGenerator(degree) {
    if (genCache[degree]) return genCache[degree];
    const r = new Array(degree).fill(0);
    r[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        r[j] = gmul(r[j], root);
        if (j + 1 < degree) r[j] ^= r[j + 1];
      }
      root = gmul(root, 2);
    }
    return (genCache[degree] = r);
  }
  function rsRemainder(data, gen) {
    const res = new Array(gen.length).fill(0);
    for (const b of data) {
      const f = b ^ res.shift();
      res.push(0);
      for (let i = 0; i < gen.length; i++) res[i] ^= gmul(gen[i], f);
    }
    return res;
  }

  /* ---------------- capacity helpers ---------------- */
  function blockSpec(version, level) {
    const [ec, g1n, g1d, g2n, g2d] = EC_TABLE[version][level];
    return { ecPerBlock: ec, g1n, g1d, g2n, g2d, numBlocks: g1n + g2n, dataCodewords: g1n * g1d + g2n * g2d };
  }
  const totalCodewords = (v) => { const s = blockSpec(v, 'L'); return s.dataCodewords + s.ecPerBlock * s.numBlocks; };
  const countBits = (v) => (v < 10 ? 8 : 16);
  const byteCapacity = (v, level) => Math.floor((blockSpec(v, level).dataCodewords * 8 - 4 - countBits(v)) / 8);
  const sizeOf = (v) => 17 + 4 * v;

  function utf8(text) {
    return Array.from(new TextEncoder().encode(text));
  }

  /* ---------------- encoder ---------------- */
  function encode(text, level, opts) {
    opts = opts || {};
    level = level || 'M';
    if (!EC_TABLE[1][level]) throw new Error('Unknown level ' + level);
    const bytes = utf8(text);
    let version = 0;
    for (let v = Math.max(1, opts.minVersion || 1); v <= MAX_VERSION; v++) {
      if (bytes.length <= byteCapacity(v, level)) { version = v; break; }
    }
    if (!version) {
      const err = new Error('Too long: level ' + level + ' holds at most ' + byteCapacity(MAX_VERSION, level) + ' bytes in this lab.');
      err.code = 'TOO_LONG';
      throw err;
    }

    const spec = blockSpec(version, level);
    const capBits = spec.dataCodewords * 8;

    /* --- bit stream with labelled segments (so we can say which letters live where) --- */
    const bits = [];
    const segments = [];
    const push = (val, len, seg) => {
      const start = bits.length;
      for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
      if (seg && len > 0) segments.push(Object.assign({ start, len }, seg));
    };
    push(0b0100, 4, { type: 'mode', label: 'Mode = byte' });
    push(bytes.length, countBits(version), { type: 'count', label: 'Length = ' + bytes.length });
    for (const ch of text) {
      const cb = utf8(ch);
      cb.forEach((b, i) => push(b, 8, { type: 'char', char: ch, value: b, part: cb.length > 1 ? i + 1 + '/' + cb.length : '' }));
    }
    push(0, Math.min(4, capBits - bits.length), { type: 'terminator', label: 'End marker' });
    push(0, (8 - (bits.length % 8)) % 8, { type: 'bitpad', label: 'Padding bits' });
    for (let p = 0xec; bits.length < capBits; p ^= 0xec ^ 0x11) push(p, 8, { type: 'padbyte', label: 'Filler byte 0x' + p.toString(16).toUpperCase() });

    const dataCw = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      dataCw.push(b);
    }

    /* --- split into blocks and add Reed–Solomon backup codewords --- */
    const gen = rsGenerator(spec.ecPerBlock);
    const blocks = [];
    let k = 0;
    const addBlocks = (n, len) => {
      for (let i = 0; i < n; i++) {
        const data = dataCw.slice(k, k + len);
        blocks.push({ data, dataStart: k, ec: rsRemainder(data, gen) });
        k += len;
      }
    };
    addBlocks(spec.g1n, spec.g1d);
    addBlocks(spec.g2n, spec.g2d);

    /* --- interleave; remember where every codeword came from --- */
    const codewords = [];
    const cwMeta = [];
    const maxData = Math.max(...blocks.map((b) => b.data.length));
    for (let i = 0; i < maxData; i++) {
      blocks.forEach((b, bi) => {
        if (i < b.data.length) {
          codewords.push(b.data[i]);
          cwMeta.push({ kind: 'data', block: bi, index: i, dataIndex: b.dataStart + i });
        }
      });
    }
    for (let i = 0; i < spec.ecPerBlock; i++) {
      blocks.forEach((b, bi) => {
        codewords.push(b.ec[i]);
        cwMeta.push({ kind: 'ec', block: bi, index: i });
      });
    }

    /* --- matrix --- */
    const size = sizeOf(version);
    const N = size * size;
    const modules = new Uint8Array(N);
    const isFunction = new Uint8Array(N);
    const roles = new Array(N).fill(null);
    const info = new Array(N).fill(null);
    const set = (x, y, dark, role, extra) => {
      const i = y * size + x;
      modules[i] = dark ? 1 : 0;
      isFunction[i] = 1;
      roles[i] = role;
      info[i] = extra || null;
    };

    // timing rulers
    for (let i = 0; i < size; i++) {
      set(6, i, i % 2 === 0, 'timing');
      set(i, 6, i % 2 === 0, 'timing');
    }
    // finder eyes (+ white separators)
    const finders = [[3, 3, 'top-left'], [size - 4, 3, 'top-right'], [3, size - 4, 'bottom-left']];
    finders.forEach(([cx, cy, name], fi) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          set(x, y, d !== 2 && d !== 4, d === 4 ? 'separator' : 'finder', { eye: fi, eyeName: name, ring: d });
        }
      }
    });
    // alignment targets
    const al = ALIGNMENT[version];
    for (let i = 0; i < al.length; i++) {
      for (let j = 0; j < al.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++)
            set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1, 'alignment');
      }
    }
    const drawFormat = (mask) => {
      const data = (FORMAT_EC_BITS[level] << 3) | mask;
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const fb = ((data << 10) | rem) ^ 0x5412;
      const bit = (i) => (fb >>> i) & 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i), 'format', { copy: 1, bit: i });
      set(8, 7, bit(6), 'format', { copy: 1, bit: 6 });
      set(8, 8, bit(7), 'format', { copy: 1, bit: 7 });
      set(7, 8, bit(8), 'format', { copy: 1, bit: 8 });
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i), 'format', { copy: 1, bit: i });
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i), 'format', { copy: 2, bit: i });
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i), 'format', { copy: 2, bit: i });
      set(8, size - 8, 1, 'darkmodule');
      return fb;
    };
    drawFormat(0);
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const vb = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = (vb >>> i) & 1;
        const a = size - 11 + (i % 3), b = Math.floor(i / 3);
        set(a, b, bit, 'version', { copy: 1, bit: i });
        set(b, a, bit, 'version', { copy: 2, bit: i });
      }
    }

    /* --- zig-zag placement of codeword bits --- */
    const placementOrder = [];
    const cwModules = codewords.map(() => []);
    let bi = 0;
    const totalBits = codewords.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      const upward = ((right + 1) & 2) === 0;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const y = upward ? size - 1 - vert : vert;
          const idx = y * size + x;
          if (isFunction[idx]) continue;
          placementOrder.push(idx);
          if (bi < totalBits) {
            const cw = bi >> 3, bp = bi & 7;
            modules[idx] = (codewords[cw] >>> (7 - bp)) & 1;
            roles[idx] = cwMeta[cw].kind;
            info[idx] = { cw, bit: bp };
            cwModules[cw].push(idx);
          } else {
            modules[idx] = 0;
            roles[idx] = 'remainder';
          }
          bi++;
        }
      }
    }

    /* --- masking: try all 8, keep the one scanners like best --- */
    const raw = modules.slice();
    const applyMask = (mask) => {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          if (isFunction[i]) continue;
          let inv;
          switch (mask) {
            case 0: inv = (x + y) % 2 === 0; break;
            case 1: inv = y % 2 === 0; break;
            case 2: inv = x % 3 === 0; break;
            case 3: inv = (x + y) % 3 === 0; break;
            case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
            case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
            case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
            default: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
          }
          modules[i] = raw[i] ^ (inv ? 1 : 0);
        }
      }
    };
    let mask = opts.mask;
    const penalties = [];
    if (mask === undefined || mask === null) {
      let best = Infinity;
      for (let m = 0; m < 8; m++) {
        applyMask(m); drawFormat(m);
        const p = penalty(modules, size);
        penalties.push(p);
        if (p < best) { best = p; mask = m; }
      }
    }
    applyMask(mask);
    const formatBits = drawFormat(mask);

    return {
      text, bytes, level, version, size, mask, formatBits,
      modules, isFunction, roles, info,
      codewords, cwMeta, cwModules, blocks, dataCodewords: dataCw,
      ecPerBlock: spec.ecPerBlock, numBlocks: spec.numBlocks,
      segments, placementOrder, penalties,
      capacityBytes: byteCapacity(version, level),
      repairPerBlock: Math.floor(spec.ecPerBlock / 2),
    };
  }

  /* ---------------- mask penalty (ISO/IEC 18004 §7.8.3) ---------------- */
  function penalty(m, size) {
    let score = 0, dark = 0;
    const at = (x, y) => m[y * size + x];
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < size; a++) {
        let run = 1;
        let prev = pass ? at(a, 0) : at(0, a);
        let window = 0;
        for (let b = 0; b < size; b++) {
          const v = pass ? at(a, b) : at(b, a);
          if (b > 0) {
            if (v === prev) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
            else { run = 1; prev = v; }
          }
          window = ((window << 1) | v) & 0x7ff;
          if (b >= 10 && (window === 0b10111010000 || window === 0b00001011101)) score += 40;
        }
      }
    }
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = at(x, y);
        dark += v;
        if (x < size - 1 && y < size - 1 && v === at(x + 1, y) && v === at(x, y + 1) && v === at(x + 1, y + 1)) score += 3;
      }
    }
    score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return score;
  }

  /* ---------------- describe a data codeword in human terms ---------------- */
  function describeDataCodeword(qr, dataIndex) {
    const s = dataIndex * 8, e = s + 8;
    const parts = [];
    for (const seg of qr.segments) {
      const a = Math.max(s, seg.start), b = Math.min(e, seg.start + seg.len);
      if (a < b) parts.push({ seg, bits: b - a, whole: a === seg.start && b === seg.start + seg.len });
    }
    return parts;
  }

  return {
    LEVELS, LEVEL_NAMES, MAX_VERSION, EC_TABLE, ALIGNMENT,
    encode, blockSpec, byteCapacity, totalCodewords, sizeOf, utf8,
    describeDataCodeword,
    _rs: { rsGenerator, rsRemainder, gmul },
  };
});
