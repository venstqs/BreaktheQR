/*
 * Break the QR — qr-damage.js
 * --------------------------------------------------------------
 * The DAMAGE METER. Given the code we generated and what the canvas
 * looks like now (after scribbles, stickers, paint), work out:
 *   - which modules flipped colour
 *   - which codewords they belong to (a codeword with ANY wrong
 *     module counts as damaged)
 *   - per Reed–Solomon block: damaged codewords vs repair limit
 *     (backup codewords ÷ 2, rounded down)
 *   - whether the finder eyes, format label and version label
 *     survived
 * and give plain-language reasons when the code breaks.
 *
 * This is a teaching model; every result is double-checked by jsQR.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QRDamage = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EYE_CORE_LIMIT = 2;   // wrong modules allowed in the 3×3 pupil
  const EYE_TOTAL_LIMIT = 12; // wrong modules allowed in the 7×7 eye (~25%)
  const BCH_LIMIT = 3;        // format & version labels can fix 3 bad bits per copy

  /**
   * Sample a rendered image: for every module, average the luminance of
   * its central area and call it dark if below 50% grey. This mimics the
   * "binarisation" step every real scanner performs.
   */
  function sample(qr, imageData, originX, originY, moduleSize) {
    const { data, width, height } = imageData;
    const obs = new Uint8Array(qr.size * qr.size);
    const half = Math.max(0.5, moduleSize * 0.22);
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        const cx = originX + (x + 0.5) * moduleSize;
        const cy = originY + (y + 0.5) * moduleSize;
        const x0 = Math.max(0, Math.floor(cx - half)), x1 = Math.min(width - 1, Math.ceil(cx + half));
        const y0 = Math.max(0, Math.floor(cy - half)), y1 = Math.min(height - 1, Math.ceil(cy + half));
        let sum = 0, n = 0;
        for (let py = y0; py <= y1; py++) {
          for (let px = x0; px <= x1; px++) {
            const p = (py * width + px) * 4;
            sum += 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
            n++;
          }
        }
        obs[y * qr.size + x] = n && sum / n < 128 ? 1 : 0;
      }
    }
    return obs;
  }

  function analyse(qr, observed) {
    const N = qr.size * qr.size;
    const wrong = new Uint8Array(N);
    let wrongCount = 0;
    for (let i = 0; i < N; i++) {
      if (observed[i] !== qr.modules[i]) { wrong[i] = 1; wrongCount++; }
    }

    /* codewords */
    const cw = qr.cwModules.map((mods, i) => {
      const w = mods.reduce((a, m) => a + wrong[m], 0);
      return { index: i, wrongModules: w, damaged: w > 0, meta: qr.cwMeta[i] };
    });

    /* blocks */
    const blocks = qr.blocks.map((b, bi) => ({
      index: bi, dataLen: b.data.length, ecLen: b.ec.length,
      capacity: qr.repairPerBlock, damaged: 0, damagedData: 0, damagedEc: 0, cws: [],
    }));
    cw.forEach((c) => {
      const b = blocks[c.meta.block];
      b.cws.push(c.index);
      if (c.damaged) {
        b.damaged++;
        c.meta.kind === 'data' ? b.damagedData++ : b.damagedEc++;
      }
    });
    blocks.forEach((b) => { b.ok = b.damaged <= b.capacity; b.ratio = b.damaged / b.capacity; });
    const worst = blocks.reduce((a, b) => (b.ratio > a.ratio ? b : a), blocks[0]);
    const totalDamaged = blocks.reduce((a, b) => a + b.damaged, 0);
    const totalCapacity = blocks.reduce((a, b) => a + b.capacity, 0);

    /* function patterns */
    const eyes = [0, 1, 2].map((e) => ({ eye: e, name: '', core: 0, total: 0, modules: 0 }));
    let formatErr = [0, 0], versionErr = [0, 0], timingWrong = 0, alignmentWrong = 0, darkModuleWrong = 0;
    for (let i = 0; i < N; i++) {
      const role = qr.roles[i], inf = qr.info[i];
      if (role === 'finder') {
        const e = eyes[inf.eye];
        e.name = inf.eyeName; e.modules++;
        if (wrong[i]) { e.total++; if (inf.ring <= 1) e.core++; }
      } else if (wrong[i]) {
        if (role === 'format') formatErr[inf.copy - 1]++;
        else if (role === 'version') versionErr[inf.copy - 1]++;
        else if (role === 'timing') timingWrong++;
        else if (role === 'alignment') alignmentWrong++;
        else if (role === 'darkmodule') darkModuleWrong++;
      }
    }
    eyes.forEach((e) => { e.ok = e.core <= EYE_CORE_LIMIT && e.total <= EYE_TOTAL_LIMIT; });
    const format = { copy1: formatErr[0], copy2: formatErr[1], ok: formatErr[0] <= BCH_LIMIT || formatErr[1] <= BCH_LIMIT };
    const versionInfo = qr.version >= 7
      ? { copy1: versionErr[0], copy2: versionErr[1], ok: versionErr[0] <= BCH_LIMIT || versionErr[1] <= BCH_LIMIT }
      : null;

    const blocksOk = blocks.every((b) => b.ok);
    const eyesOk = eyes.every((e) => e.ok);
    const predictedOk = blocksOk && eyesOk && format.ok && (!versionInfo || versionInfo.ok);

    /* lost data: damaged data codewords inside blocks that could not be repaired */
    const lostCodewords = [];
    const lostChars = new Map();
    blocks.forEach((b) => {
      if (b.ok) return;
      b.cws.forEach((ci) => {
        if (!cw[ci].damaged) return;
        lostCodewords.push(ci);
        const m = qr.cwMeta[ci];
        if (m.kind === 'data') charsOf(qr, m.dataIndex).forEach((c) => lostChars.set(c.pos, c.char));
      });
    });

    /* plain-language reasons */
    const reasons = [];
    eyes.forEach((e) => {
      if (!e.ok) reasons.push({ kind: 'eye', text: `The ${e.name} eye is covered (${e.total} of ${e.modules} squares changed). Scanners hunt for all three eyes first. Without them they can't even tell there's a code here.` });
    });
    if (!format.ok) reasons.push({ kind: 'format', text: `Both copies of the format label are damaged (${format.copy1} and ${format.copy2} bad bits; each copy can only fix 3). The scanner can't tell which mask and error-correction level were used, so it can't read anything else.` });
    if (versionInfo && !versionInfo.ok) reasons.push({ kind: 'version', text: `Both version labels are damaged (${versionInfo.copy1} and ${versionInfo.copy2} bad bits). The scanner doesn't know how big the grid is.` });
    blocks.forEach((b) => {
      if (!b.ok) {
        const where = blocks.length > 1 ? `Block ${b.index + 1} has` : 'The code has';
        reasons.push({ kind: 'block', block: b.index, text: `${where} ${b.damaged} damaged codewords, but its ${b.ecLen} backup codewords can only repair ${b.capacity}. Reed–Solomon needs 2 backup codewords to locate and fix each broken one.` });
      }
    });

    const warnings = [];
    if (timingWrong) warnings.push(`${timingWrong} timing-ruler squares changed. Phone scanners mostly cope, but cheap scanners use the ruler to count columns.`);
    if (alignmentWrong) warnings.push(`${alignmentWrong} alignment-target squares changed. That makes it harder to correct for a tilted camera.`);
    if (darkModuleWrong) warnings.push('The "dark module" (always black) was erased. It carries no data but is required by the standard.');
    eyes.forEach((e) => { if (e.ok && e.total > 0) warnings.push(`The ${e.name} eye is scratched (${e.total} squares) but still recognisable.`); });
    if (format.ok && (format.copy1 > 0 || format.copy2 > 0)) warnings.push(`Format label hit (${format.copy1} / ${format.copy2} bad bits) but a copy is still readable.`);

    return {
      wrong, wrongCount, wrongPct: (wrongCount / N) * 100,
      cw, blocks, worst, totalDamaged, totalCapacity,
      eyes, format, versionInfo, timingWrong, alignmentWrong,
      blocksOk, eyesOk, predictedOk,
      lostCodewords, lostChars: [...lostChars.entries()].sort((a, b) => a[0] - b[0]).map(([pos, char]) => ({ pos, char })),
      reasons, warnings,
    };
  }

  /* characters (by position in the text) that touch a data codeword */
  function charsOf(qr, dataIndex) {
    const s = dataIndex * 8, e = s + 8;
    const out = [];
    let pos = -1;
    for (const seg of qr.segments) {
      if (seg.type !== 'char') continue;
      if (seg.part === '' || seg.part.startsWith('1/')) pos++;
      if (seg.start < e && seg.start + seg.len > s && !out.some((o) => o.pos === pos)) out.push({ pos, char: seg.char });
    }
    return out;
  }

  return { sample, analyse, charsOf, EYE_CORE_LIMIT, EYE_TOTAL_LIMIT, BCH_LIMIT };
});
