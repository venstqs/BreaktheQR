// Run: node tests/encoder.test.js
// Encodes many strings at every version 1–10, every level and every mask,
// renders them to pixels and checks that jsQR (an independent decoder)
// reads back exactly the original text. Also checks the damage meter
// against jsQR on randomly damaged codes.
const path = require('path');
const QR = require(path.join(__dirname, '..', 'js', 'qr-core.js'));
const Damage = require(path.join(__dirname, '..', 'js', 'qr-damage.js'));
const jsQR = require(path.join(__dirname, '..', 'vendor', 'jsQR.js'));

function render(qr, observed, scale = 4, quiet = 4) {
  const n = qr.size + quiet * 2;
  const w = n * scale;
  const px = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let y = 0; y < qr.size; y++)
    for (let x = 0; x < qr.size; x++) {
      const dark = observed ? observed[y * qr.size + x] : qr.modules[y * qr.size + x];
      if (!dark) continue;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const p = (((y + quiet) * scale + dy) * w + (x + quiet) * scale + dx) * 4;
          px[p] = px[p + 1] = px[p + 2] = 0;
        }
    }
  return { px, w };
}
const decode = (qr, obs) => {
  const { px, w } = render(qr, obs);
  const r = jsQR(px, w, w, { inversionAttempts: 'dontInvert' });
  return r ? r.data : null;
};

let pass = 0, fail = 0;
const rand = (() => { let s = 12345; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })();

// 1) clean round trips
for (let v = 1; v <= 10; v++) {
  for (const L of QR.LEVELS) {
    const cap = QR.byteCapacity(v, L);
    const text = ('https://ex.am/' + 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(10)).slice(0, cap);
    for (let mask = 0; mask < 8; mask++) {
      const qr = QR.encode(text, L, { mask, minVersion: v });
      if (qr.version !== v) { console.log('version mismatch', v, L, qr.version); fail++; continue; }
      const got = decode(qr);
      if (got === text) pass++;
      else { fail++; console.log(`FAIL clean v${v}-${L} mask ${mask}: got ${JSON.stringify(got)}`); }
    }
  }
}
// unicode
for (const t of ['héllo wörld ✨', 'QR 🙂 test', 'Λ λ ß']) {
  const qr = QR.encode(t, 'H');
  decode(qr) === t ? pass++ : (fail++, console.log('FAIL unicode', t));
}
console.log(`clean round-trips: ${pass} passed, ${fail} failed`);

// 2) codeword map sanity: every codeword has exactly 8 modules
let mapBad = 0;
for (let v = 1; v <= 10; v++) for (const L of QR.LEVELS) {
  const qr = QR.encode('x', L, { minVersion: v });
  if (qr.cwModules.some((m) => m.length !== 8)) mapBad++;
  if (qr.codewords.length !== QR.totalCodewords(v)) mapBad++;
}
console.log(`codeword map: ${mapBad ? mapBad + ' problems' : 'every codeword has 8 modules ✓'}`);

// 3) meter vs jsQR on random codeword damage (data area only)
let agree = 0, disagree = 0;
const confusion = { bothOk: 0, bothFail: 0, meterOkJsFail: 0, meterFailJsOk: 0 };
for (let trial = 0; trial < 600; trial++) {
  const v = 1 + Math.floor(rand() * 6);
  const L = QR.LEVELS[Math.floor(rand() * 4)];
  const text = 'https://gvh.example/' + trial;
  const qr = QR.encode(text, L, { minVersion: v });
  const obs = qr.modules.slice();
  const cap = qr.repairPerBlock;
  // damage between 0 and 2*capacity codewords in random blocks, by flipping one module each
  const nDamage = Math.floor(rand() * (cap * qr.numBlocks * 1.6 + 2));
  for (let i = 0; i < nDamage; i++) {
    const cw = Math.floor(rand() * qr.codewords.length);
    const mod = qr.cwModules[cw][Math.floor(rand() * 8)];
    obs[mod] = qr.modules[mod] ^ 1;
  }
  const rep = Damage.analyse(qr, obs);
  const js = decode(qr, obs) === text;
  if (rep.predictedOk && js) confusion.bothOk++;
  else if (!rep.predictedOk && !js) confusion.bothFail++;
  else if (rep.predictedOk) confusion.meterOkJsFail++;
  else confusion.meterFailJsOk++;
  rep.predictedOk === js ? agree++ : disagree++;
}
console.log(`meter vs jsQR on 600 random damage trials: ${agree} agree, ${disagree} disagree`, confusion);

process.exit(fail || mapBad ? 1 : 0);
