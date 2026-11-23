/*
 * Break the QR — app.js
 * Stage rendering, layer view, read-order animation, vandal tools,
 * live damage meter + jsQR double-check, break point, level
 * comparison, graffiti mode, camera / photo scanning.
 */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = LinkXray.esc;

  const S = 720;        // internal canvas resolution
  const QUIET = 4;      // quiet zone in modules (spec minimum)
  const JS_SIZE = 480;  // resolution fed to jsQR

  /* ---------------- role catalogue ---------------- */
  const ROLES = {
    finder:     { name: 'Finder eyes',      dark: '#6D28D9', light: '#E9DFFD' },
    separator:  { name: 'Separators',       dark: '#6D28D9', light: '#F3EEFF' },
    timing:     { name: 'Timing rulers',    dark: '#EA580C', light: '#FFE3D1' },
    alignment:  { name: 'Alignment target', dark: '#DB2777', light: '#FCE0EE' },
    format:     { name: 'Format label',     dark: '#0891B2', light: '#D3F2F8' },
    version:    { name: 'Version label',    dark: '#A16207', light: '#F6E8C8' },
    darkmodule: { name: 'Dark module',      dark: '#334155', light: '#E2E8F0' },
    data:       { name: 'Data codewords',   dark: '#2563EB', light: '#DBE7FE', dark2: '#1E3A8A', light2: '#C2D4FA' },
    ec:         { name: 'Backup codewords', dark: '#16A34A', light: '#D9F7E3', dark2: '#14532D', light2: '#B5EBC8' },
    remainder:  { name: 'Remainder bits',   dark: '#6B7280', light: '#EEF0F2' },
  };
  const ROLE_ORDER = ['finder', 'separator', 'timing', 'alignment', 'format', 'version', 'darkmodule', 'data', 'ec', 'remainder'];

  const COLORS = [
    { c: '#141414', n: 'Ink' }, { c: '#FFFFFF', n: 'White-out' }, { c: '#FF3D5A', n: 'Pink' }, { c: '#FFD23F', n: 'Yellow' },
    { c: '#19B97F', n: 'Mint' }, { c: '#2F6BFF', n: 'Blue' }, { c: '#7C3AED', n: 'Violet' }, { c: '#FF8A00', n: 'Orange' },
    { c: '#1E2A78', n: 'Navy' }, { c: '#8EC5FF', n: 'Sky' },
  ];
  const STICKERS = ['😎', '⭐', '🍕', '💥', '🐱', '❤️', '🔥', '👾', '🌈', 'LOGO'];

  /* ---------------- state ---------------- */
  const state = {
    text: $('#txtInput').value,
    level: 'H', minVersion: 1, qr: null,
    view: 'plain', tab: 'make',
    tool: 'brush', color: '#141414', brush: 22, sticker: '😎', stickerSize: 120,
    hidden: new Set(), selected: null,
    report: null, jsOk: true, jsData: null, broken: false, flashUntil: 0,
    order: { pos: 0, playing: false },
    undo: [], drawing: false, last: null,
    records: loadRecords(),
  };

  /* ---------------- canvases ---------------- */
  const stage = $('#stage');
  const cvBase = $('#cvBase'), cvVandal = $('#cvVandal'), cvOverlay = $('#cvOverlay');
  const ctxBase = cvBase.getContext('2d');
  const ctxV = cvVandal.getContext('2d', { willReadFrequently: true });
  const ctxO = cvOverlay.getContext('2d');
  const cvComp = document.createElement('canvas'); cvComp.width = cvComp.height = S;
  const ctxComp = cvComp.getContext('2d', { willReadFrequently: true });
  const cvJs = document.createElement('canvas'); cvJs.width = cvJs.height = JS_SIZE;
  const ctxJs = cvJs.getContext('2d', { willReadFrequently: true });

  const geom = (qr) => { const m = S / (qr.size + QUIET * 2); return { m, o: QUIET * m }; };
  const modRect = (qr, i) => {
    const { m, o } = geom(qr);
    const x = i % qr.size, y = Math.floor(i / qr.size);
    return [o + x * m, o + y * m, m];
  };

  /* ---------------- drawing the code ---------------- */
  function drawCode(ctx, qr, mode, size = S) {
    const m = size / (qr.size + QUIET * 2), o = QUIET * m;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    const inset = mode === 'layers' ? Math.max(0.6, m * 0.06) : 0;
    for (let i = 0; i < qr.size * qr.size; i++) {
      const dark = qr.modules[i];
      let fill;
      if (mode === 'layers') {
        const role = qr.roles[i];
        const R = ROLES[role];
        if (state.hidden.has(role)) fill = dark ? '#D6D3CE' : '#F7F5F1';
        else {
          const alt = (role === 'data' || role === 'ec') && qr.info[i] && qr.info[i].cw % 2 === 1;
          fill = dark ? (alt ? R.dark2 : R.dark) : (alt ? R.light2 : R.light);
        }
      } else {
        if (!dark) continue;
        fill = '#000';
      }
      const x = i % qr.size, y = Math.floor(i / qr.size);
      const x0 = Math.floor(o + x * m), y0 = Math.floor(o + y * m);
      const x1 = Math.floor(o + (x + 1) * m), y1 = Math.floor(o + (y + 1) * m);
      ctx.fillStyle = fill;
      ctx.fillRect(x0 + inset, y0 + inset, x1 - x0 - inset * 2, y1 - y0 - inset * 2);
    }
  }

  function composite(ctx, qr, size = S) {
    drawCode(ctx, qr, 'plain', size);
    ctx.drawImage(cvVandal, 0, 0, size, size);
  }

  function drawBase() {
    if (!state.qr) return;
    drawCode(ctxBase, state.qr, state.view === 'layers' ? 'layers' : 'plain');
    cvVandal.style.opacity = state.view === 'layers' ? '0.55' : '1';
    overlayDirty = true;
  }

  /* ---------------- overlay (selection, x-ray, read order, break flash) ---------------- */
  let overlayDirty = true;
  function drawOverlay(now) {
    const qr = state.qr;
    ctxO.clearRect(0, 0, S, S);
    if (!qr) return;
    const { m } = geom(qr);
    const rep = state.report;

    // read order
    if (state.tab === 'order') {
      const k = Math.floor(state.order.pos);
      const visited = new Uint8Array(qr.size * qr.size);
      for (let j = 0; j < Math.min(k, qr.placementOrder.length); j++) visited[qr.placementOrder[j]] = 1;
      ctxO.fillStyle = 'rgba(255,255,255,.72)';
      qr.placementOrder.forEach((idx) => {
        if (!visited[idx]) { const [x, y] = modRect(qr, idx); ctxO.fillRect(x, y, m + 0.5, m + 0.5); }
      });
      if (k > 0) {
        ctxO.strokeStyle = 'rgba(255,61,90,.9)';
        ctxO.lineWidth = Math.max(1.5, m * 0.14);
        ctxO.lineJoin = 'round';
        ctxO.beginPath();
        for (let j = 0; j < Math.min(k, qr.placementOrder.length); j++) {
          const [x, y] = modRect(qr, qr.placementOrder[j]);
          j ? ctxO.lineTo(x + m / 2, y + m / 2) : ctxO.moveTo(x + m / 2, y + m / 2);
        }
        ctxO.stroke();
        const [hx, hy] = modRect(qr, qr.placementOrder[Math.min(k, qr.placementOrder.length) - 1]);
        ctxO.fillStyle = '#FF3D5A';
        ctxO.beginPath(); ctxO.arc(hx + m / 2, hy + m / 2, Math.max(4, m * 0.38), 0, Math.PI * 2); ctxO.fill();
        ctxO.lineWidth = 2; ctxO.strokeStyle = '#141414'; ctxO.stroke();
        const cw = currentOrderCw();
        if (cw !== null) outlineModules(qr.cwModules[cw], '#141414', Math.max(2, m * 0.16));
      }
    }

    // x-ray damage
    if (rep && (state.view === 'xray' || state.broken)) {
      rep.cw.forEach((c) => {
        if (!c.damaged) return;
        const blockOk = rep.blocks[c.meta.block].ok;
        if (state.view !== 'xray' && blockOk) return;
        ctxO.fillStyle = blockOk ? 'rgba(255,170,0,.38)' : 'rgba(255,61,90,.45)';
        qr.cwModules[c.index].forEach((idx) => { const [x, y] = modRect(qr, idx); ctxO.fillRect(x, y, m, m); });
      });
      if (state.view === 'xray') {
        ctxO.strokeStyle = '#141414';
        ctxO.lineWidth = Math.max(1, m * 0.1);
        for (let i = 0; i < rep.wrong.length; i++) {
          if (!rep.wrong[i]) continue;
          const [x, y] = modRect(qr, i);
          const p = m * 0.28;
          ctxO.beginPath();
          ctxO.moveTo(x + p, y + p); ctxO.lineTo(x + m - p, y + m - p);
          ctxO.moveTo(x + m - p, y + p); ctxO.lineTo(x + p, y + m - p);
          ctxO.stroke();
        }
        rep.eyes.forEach((e) => {
          if (e.ok) return;
          const [cx, cy] = [[3, 3], [qr.size - 4, 3], [3, qr.size - 4]][e.eye];
          const [x, y] = modRect(qr, (cy - 3) * qr.size + (cx - 3));
          ctxO.strokeStyle = '#FF3D5A'; ctxO.lineWidth = Math.max(3, m * 0.3);
          ctxO.strokeRect(x, y, m * 7, m * 7);
        });
      }
    }

    // break flash
    if (rep && now < state.flashUntil) {
      const a = 0.35 + 0.45 * Math.abs(Math.sin(now / 110));
      ctxO.fillStyle = `rgba(255,61,90,${a})`;
      rep.lostCodewords.forEach((ci) => qr.cwModules[ci].forEach((idx) => { const [x, y] = modRect(qr, idx); ctxO.fillRect(x, y, m, m); }));
      rep.eyes.forEach((e) => {
        if (e.ok) return;
        const [cx, cy] = [[3, 3], [qr.size - 4, 3], [3, qr.size - 4]][e.eye];
        const [x, y] = modRect(qr, (cy - 3) * qr.size + (cx - 3));
        ctxO.fillRect(x, y, m * 7, m * 7);
      });
      if (!rep.format.ok) for (let i = 0; i < qr.roles.length; i++) if (qr.roles[i] === 'format') { const [x, y] = modRect(qr, i); ctxO.fillRect(x, y, m, m); }
    }

    // selection
    if (state.selected !== null && (state.tab === 'layers' || state.tab === 'make')) {
      const i = state.selected, role = qr.roles[i], inf = qr.info[i];
      if ((role === 'data' || role === 'ec') && inf) outlineModules(qr.cwModules[inf.cw], '#FFD23F', Math.max(2, m * 0.2), true);
      if (role === 'format' || role === 'version') {
        const same = [];
        for (let j = 0; j < qr.roles.length; j++) if (qr.roles[j] === role && qr.info[j].bit === inf.bit) same.push(j);
        outlineModules(same, '#FFD23F', Math.max(2, m * 0.2), true);
      }
      if (role === 'finder' || role === 'separator') {
        const [cx, cy] = [[3, 3], [qr.size - 4, 3], [3, qr.size - 4]][inf.eye];
        const [x, y] = modRect(qr, (cy - 3) * qr.size + (cx - 3));
        ctxO.strokeStyle = '#FFD23F'; ctxO.lineWidth = Math.max(3, m * 0.25); ctxO.strokeRect(x, y, m * 7, m * 7);
      }
      const [x, y] = modRect(qr, i);
      ctxO.strokeStyle = '#FF3D5A'; ctxO.lineWidth = Math.max(2.5, m * 0.22);
      ctxO.strokeRect(x + 1, y + 1, m - 2, m - 2);
    }
  }
  function outlineModules(list, color, lw, halo) {
    const qr = state.qr; const { m } = geom(qr);
    if (halo) { ctxO.strokeStyle = '#141414'; ctxO.lineWidth = lw + 3; list.forEach((idx) => { const [x, y] = modRect(qr, idx); ctxO.strokeRect(x + 1, y + 1, m - 2, m - 2); }); }
    ctxO.strokeStyle = color; ctxO.lineWidth = lw;
    list.forEach((idx) => { const [x, y] = modRect(qr, idx); ctxO.strokeRect(x + 1, y + 1, m - 2, m - 2); });
  }

  function loop(now) {
    const animating = now < state.flashUntil + 50 || state.order.playing;
    if (state.order.playing) stepOrder();
    if (overlayDirty || animating) { drawOverlay(now); overlayDirty = false; }
    requestAnimationFrame(loop);
  }

  /* ---------------- generate ---------------- */
  function generate() {
    const txtInfo = $('#txtInfo');
    let qr;
    try {
      qr = QRCore.encode(state.text, state.level, { minVersion: state.minVersion });
    } catch (e) {
      txtInfo.innerHTML = `<span class="err">${esc(e.message)}</span> Try a lower level or a shorter message.`;
      return false;
    }
    state.qr = qr;
    state.selected = null;
    state.order.pos = 0; state.order.playing = false;
    const ecTotal = qr.ecPerBlock * qr.numBlocks;
    txtInfo.textContent = `${qr.bytes.length} byte${qr.bytes.length === 1 ? '' : 's'} · fits Version ${qr.version} at level ${qr.level} (room for ${qr.capacityBytes})`;
    $('#codeChips').innerHTML = [
      `<span class="chip hot">V${qr.version} · ${qr.size}×${qr.size}</span>`,
      `<span class="chip">Level ${qr.level}</span>`,
      `<span class="chip">${qr.dataCodewords.length} data + ${ecTotal} backup</span>`,
      `<span class="chip">Mask ${qr.mask}</span>`,
    ].join('');
    $('#orderRange').max = qr.codewords.length;
    buildLegend(); buildBytes(); updateOrderUI();
    $('#interleaveNote').innerHTML = qr.numBlocks > 1
      ? `🃏 This code has <b>${qr.numBlocks} blocks</b>. Their codewords are dealt out like cards (block 1, block 2, block 3…), so one scratch hurts a little of every block instead of a lot of one.`
      : `This small code has a single block. Try a longer message or a bigger grid to see codewords from several blocks <b>interleaved</b>.`;
    $('#moduleInfo').innerHTML = '<p class="muted">👆 Tap a square on the code.</p>';
    drawBase();
    state.wasEvaluated = false;
    evaluate(true, true);
    if (state.tab === 'levels') renderLevels();
    return true;
  }

  /* ---------------- evaluation: meter + jsQR ---------------- */
  let lastJs = 0;
  function evaluate(runJs, silent) {
    const qr = state.qr;
    if (!qr) return;
    composite(ctxComp, qr);
    const img = ctxComp.getImageData(0, 0, S, S);
    const { m, o } = geom(qr);
    const obs = QRDamage.sample(qr, img, o, o, m);
    state.report = QRDamage.analyse(qr, obs);
    if (runJs) {
      lastJs = performance.now();
      const r = runJsQR(cvComp);
      state.jsData = r ? r.data : null;
      state.jsOk = !!r && r.data === qr.text;
    }
    const nowBroken = !state.jsOk || !state.report.predictedOk;
    const realBreak = !state.jsOk;
    if (realBreak && !state.broken && !silent) triggerBreak();
    state.broken = nowBroken;
    $('#breakBanner').hidden = state.jsOk;
    if (state.jsOk && state.report.wrongCount > 0) saveRecord();
    updateMeter();
    updateBreakCard();
    overlayDirty = true;
  }

  function runJsQR(src) {
    ctxJs.drawImage(src, 0, 0, JS_SIZE, JS_SIZE);
    const d = ctxJs.getImageData(0, 0, JS_SIZE, JS_SIZE);
    try { return jsQR(d.data, JS_SIZE, JS_SIZE, { inversionAttempts: 'dontInvert' }); } catch (e) { return null; }
  }

  function triggerBreak() {
    state.flashUntil = performance.now() + 1800;
    stage.classList.remove('shake'); void stage.offsetWidth; stage.classList.add('shake');
    if (navigator.vibrate) try { navigator.vibrate(120); } catch (e) { /* ignore */ }
  }

  function updateMeter() {
    const rep = state.report, qr = state.qr;
    const w = rep.worst, cap = w.capacity;
    const over = Math.max(0, w.damaged - cap);
    const cells = cap + Math.min(over, 6);
    let html = '';
    for (let i = 0; i < cells; i++) {
      const used = i < w.damaged;
      const cls = i >= cap ? 'over' : used ? (i >= cap * 0.75 ? 'used hi' : 'used') : '';
      html += `<span class="seg-cell ${cls}"></span>`;
    }
    const bar = $('#meterBar');
    bar.innerHTML = html;
    bar.setAttribute('aria-valuemax', cap); bar.setAttribute('aria-valuenow', w.damaged);

    const multi = qr.numBlocks > 1;
    $('#meterText').innerHTML = `${w.damaged} of ${cap} repairable codewords used` +
      (multi ? ` <small>· worst of ${qr.numBlocks} blocks · ${rep.totalDamaged} damaged in total</small>` : '') +
      `<br/><small>${rep.wrongCount} of ${qr.size * qr.size} squares changed (${rep.wrongPct.toFixed(1)}%)</small>`;
    $('#meterBlocks').innerHTML = multi ? rep.blocks.map((b) =>
      `<div class="mb ${b.ok ? '' : 'over'}">Block ${b.index + 1}: ${b.damaged}/${b.capacity}<div class="mb-bar"><i style="width:${Math.min(100, b.ratio * 100)}%"></i></div></div>`).join('') : '';

    const st = $('#meterStatus');
    let label, cls = '';
    if (!state.jsOk) { label = 'Broken'; cls = 'bad'; }
    else if (!rep.predictedOk) { label = 'Lucky!'; cls = 'warn'; }
    else if (w.damaged === 0 && rep.wrongCount === 0) label = 'Healthy';
    else if (w.ratio <= 0.5) label = 'Scratched';
    else if (w.ratio < 1) { label = 'Struggling'; cls = 'warn'; }
    else { label = 'At the limit!'; cls = 'warn'; }
    st.textContent = label; st.className = 'meter-status ' + cls;

    const cm = $('#checkMeter');
    cm.className = 'check ' + (rep.predictedOk ? 'ok' : 'bad');
    const why = !rep.eyesOk ? 'an eye is gone' : !rep.format.ok ? 'format label lost' : rep.versionInfo && !rep.versionInfo.ok ? 'version label lost' : 'too many damaged codewords';
    cm.querySelector('em').textContent = rep.predictedOk ? 'data can be repaired' : `breaks (${why})`;
    const cj = $('#checkJs');
    cj.className = 'check ' + (state.jsOk ? 'ok' : 'bad');
    cj.querySelector('em').textContent = state.jsOk
      ? `reads “${truncate(state.jsData, 38)}”`
      : state.jsData !== null ? `misread it as “${truncate(state.jsData, 30)}”` : "can't read it";
  }
  const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  function updateBreakCard() {
    const card = $('#breakCard');
    const rep = state.report, qr = state.qr;
    if (!rep || rep.wrongCount === 0) { card.hidden = true; return; }
    card.hidden = false;
    if (state.jsOk && rep.predictedOk) {
      card.className = 'break-card saved';
      const fixed = rep.totalDamaged;
      card.innerHTML = `<h3>🛟 Still alive!</h3>
        <p>${fixed ? `The backup system is rebuilding <b>${fixed} damaged codeword${fixed > 1 ? 's' : ''}</b>` : 'None of the data codewords are damaged yet'}. The real decoder still reads the full message.</p>
        ${rep.warnings.length ? `<ul>${rep.warnings.slice(0, 3).map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        <p class="small muted">Keep going. Switch the view to <b>X-ray</b> to see which codewords you've hit.</p>`;
      return;
    }
    card.className = 'break-card';
    const reasons = rep.reasons.map((r) => `<li>${esc(r.text)}</li>`).join('');
    let mismatch = '';
    if (rep.predictedOk && !state.jsOk) mismatch = `<li>Our meter says the data could still be repaired, but the real decoder failed. Usually the scanner couldn't lock onto the grid: messy eyes, a smudged alignment target, or scribbles that confuse its black/white decision. Our eye rule is simpler than a real scanner.</li>`;
    if (!rep.predictedOk && state.jsOk) mismatch = `<li>Our meter predicts failure, but jsQR still read it! A real decoder samples pixels slightly differently, so borderline squares can go either way. This is exactly why every result is double-checked.</li>`;
    let lost = '';
    if (rep.lostChars.length) {
      const lostSet = new Set(rep.lostChars.map((c) => c.pos));
      let pos = 0, out = '';
      for (const ch of qr.text) { out += lostSet.has(pos) ? `<s>${esc(ch === ' ' ? '␣' : ch)}</s>` : esc(ch); pos++; }
      lost = `<p class="small"><b>Letters sitting in codewords that couldn't be rebuilt</b> (in red):</p><div class="lost-text">${out}</div>`;
    }
    const title = state.jsOk ? '😮 Our meter says it should break…' : '💥 It broke! Here\'s why';
    card.innerHTML = `<h3>${title}</h3><ul>${reasons}${mismatch}</ul>${lost}
      <div class="row wrap"><button type="button" class="btn btn-icon" data-act="undo">↶ Undo</button><button type="button" class="btn" data-act="xray">🩻 X-ray view</button></div>`;
  }

  /* ---------------- records ---------------- */
  function loadRecords() { try { return JSON.parse(localStorage.getItem('btqr-records') || '{}'); } catch (e) { return {}; } }
  function saveRecord() {
    const key = state.level;
    const pct = state.report.wrongPct;
    if (!state.records[key] || pct > state.records[key]) {
      state.records[key] = +pct.toFixed(1);
      try { localStorage.setItem('btqr-records', JSON.stringify(state.records)); } catch (e) { /* storage off */ }
    }
    renderRecord();
  }
  function renderRecord() {
    const r = state.records;
    const parts = ['L', 'M', 'Q', 'H'].filter((k) => r[k]).map((k) => `<b>${k}</b> ${r[k]}%`);
    $('#record').innerHTML = parts.length ? `🏆 <b>Survival record</b>: most squares wrecked while it still scanned. ${parts.join(' · ')}` : '';
  }

  /* ---------------- vandal tools ---------------- */
  const tools = document.createElement('div');
  tools.className = 'tools-inner';
  const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255); };
  tools.innerHTML = `
    <div class="tool-row" role="group" aria-label="Tool">
      <button type="button" class="tool-btn on" data-tool="brush">✏️ Brush</button>
      <button type="button" class="tool-btn" data-tool="spray">🎨 Spray</button>
      <button type="button" class="tool-btn" data-tool="sticker">⭐ Sticker</button>
      <button type="button" class="tool-btn" data-tool="eraser">🧽 Clean</button>
    </div>
    <div class="swatches" data-for="paint">${COLORS.map((c) => `<button type="button" class="swatch ${c.c === '#141414' ? 'on' : ''}" data-color="${c.c}" title="${c.n}: a scanner reads it as ${lum(c.c) < 128 ? 'dark' : 'light'}"><i style="background:${c.c}"></i><small>${lum(c.c) < 128 ? '■ dark' : '□ light'}</small></button>`).join('')}</div>
    <div class="stickers" data-for="sticker" hidden>${STICKERS.map((s) => `<button type="button" class="sticker ${s === 'LOGO' ? 'logo' : ''} ${s === '😎' ? 'on' : ''}" data-sticker="${s}">${s}</button>`).join('')}</div>
    <label class="size-row"><span>Size</span><input type="range" id="sizeRange" min="4" max="90" value="22" /><span class="mono" id="sizeVal">22</span></label>
    <div class="tool-row">
      <button type="button" class="btn btn-icon" data-act="undo" title="Undo (Ctrl+Z)">↶ Undo</button>
      <button type="button" class="btn btn-icon" data-act="clear">🧼 Clean all</button>
      <button type="button" class="btn btn-icon" data-act="xray">🩻 X-ray</button>
    </div>`;
  $('#toolsHost').appendChild(tools);

  function setTool(t) {
    state.tool = t;
    $$('.tool-btn', tools).forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    $('[data-for=paint]', tools).hidden = t === 'sticker' || t === 'eraser';
    $('[data-for=sticker]', tools).hidden = t !== 'sticker';
    const range = $('#sizeRange', tools);
    if (t === 'sticker') { range.min = 40; range.max = 300; range.value = state.stickerSize; }
    else { range.min = 4; range.max = 90; range.value = state.brush; }
    $('#sizeVal', tools).textContent = range.value;
  }
  tools.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) setTool(b.dataset.tool);
    if (b.dataset.color) { state.color = b.dataset.color; $$('.swatch', tools).forEach((s) => s.classList.toggle('on', s === b)); if (state.tool === 'eraser') setTool('brush'); }
    if (b.dataset.sticker) { state.sticker = b.dataset.sticker; $$('.sticker', tools).forEach((s) => s.classList.toggle('on', s === b)); }
  });
  $('#sizeRange', tools).addEventListener('input', (e) => {
    const v = +e.target.value;
    state.tool === 'sticker' ? (state.stickerSize = v) : (state.brush = v);
    $('#sizeVal', tools).textContent = v;
  });

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'undo') undo();
    if (act === 'clear') { pushUndo(); ctxV.clearRect(0, 0, S, S); afterEdit(); }
    if (act === 'xray') setView(state.view === 'xray' ? 'plain' : 'xray');
    if (act === 'load') { const t = b.dataset.text; loadText(decodeURIComponent(t)); }
  });

  function pushUndo() {
    state.undo.push(ctxV.getImageData(0, 0, S, S));
    if (state.undo.length > 15) state.undo.shift();
  }
  function undo() {
    const img = state.undo.pop();
    if (!img) return;
    ctxV.putImageData(img, 0, 0);
    afterEdit();
  }
  function afterEdit() {
    evaluate(true);
    if (state.tab === 'levels') renderLevels();
  }

  const canvasPoint = (e) => {
    const r = cvVandal.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * S) / r.width, y: ((e.clientY - r.top) * S) / r.height };
  };

  function stroke(a, b) {
    ctxV.save();
    if (state.tool === 'eraser') {
      ctxV.globalCompositeOperation = 'destination-out';
      ctxV.strokeStyle = '#000';
    } else ctxV.strokeStyle = state.color;
    ctxV.lineCap = ctxV.lineJoin = 'round';
    ctxV.lineWidth = state.brush;
    ctxV.beginPath(); ctxV.moveTo(a.x, a.y); ctxV.lineTo(b.x + 0.01, b.y); ctxV.stroke();
    ctxV.restore();
  }
  function spray(p) {
    const r = state.brush * 1.2;
    ctxV.fillStyle = state.color;
    const n = Math.round(r * 1.4);
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r;
      const s = Math.random() * 2.2 + 0.8;
      ctxV.fillRect(p.x + Math.cos(ang) * d, p.y + Math.sin(ang) * d, s, s);
    }
  }
  function stamp(p, sticker, size) {
    ctxV.save();
    if (sticker === 'LOGO') {
      const w = size, h = size;
      roundRect(ctxV, p.x - w / 2, p.y - h / 2, w, h, size * 0.18);
      ctxV.fillStyle = '#fff'; ctxV.fill();
      ctxV.lineWidth = Math.max(3, size * 0.05); ctxV.strokeStyle = '#141414'; ctxV.stroke();
      roundRect(ctxV, p.x - w * 0.34, p.y - h * 0.34, w * 0.68, h * 0.68, size * 0.14);
      ctxV.fillStyle = '#FF3D5A'; ctxV.fill();
      ctxV.fillStyle = '#fff'; ctxV.font = `800 ${size * 0.2}px Archivo, sans-serif`;
      ctxV.textAlign = 'center'; ctxV.textBaseline = 'middle';
      ctxV.fillText('LOGO', p.x, p.y + size * 0.01);
    } else {
      ctxV.font = `${size}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
      ctxV.textAlign = 'center'; ctxV.textBaseline = 'middle';
      ctxV.fillText(sticker, p.x, p.y + size * 0.05);
    }
    ctxV.restore();
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  const isDrawTab = () => state.tab === 'vandal' || state.tab === 'graffiti';
  let rafEval = 0;
  function scheduleEval() {
    if (rafEval) return;
    rafEval = requestAnimationFrame(() => {
      rafEval = 0;
      evaluate(performance.now() - lastJs > 280);
    });
  }

  stage.addEventListener('pointerdown', (e) => {
    if (!state.qr) return;
    const p = canvasPoint(e);
    if (!isDrawTab()) { pickModule(p); return; }
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    pushUndo();
    if (state.tool === 'sticker') { stamp(p, state.sticker, state.stickerSize); afterEdit(); return; }
    state.drawing = true; state.last = p;
    state.tool === 'spray' ? spray(p) : stroke(p, p);
    scheduleEval();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!state.drawing) return;
    const p = canvasPoint(e);
    if (state.tool === 'spray') spray(p); else stroke(state.last, p);
    state.last = p;
    scheduleEval();
  });
  const endDraw = () => { if (!state.drawing) return; state.drawing = false; afterEdit(); };
  stage.addEventListener('pointerup', endDraw);
  stage.addEventListener('pointercancel', endDraw);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !/textarea|input/i.test(e.target.tagName)) { e.preventDefault(); undo(); }
  });

  /* ---------------- presets (real-world accidents) ---------------- */
  function preset(name) {
    const qr = state.qr; if (!qr) return;
    const { m, o } = geom(qr);
    const span = qr.size * m;
    pushUndo();
    const rnd = (a, b) => a + Math.random() * (b - a);
    ctxV.save();
    if (name === 'logo') stamp({ x: S / 2, y: S / 2 }, 'LOGO', span * 0.28);
    if (name === 'coffee') {
      const cx = o + span * rnd(0.45, 0.75), cy = o + span * rnd(0.45, 0.75), r = span * rnd(0.14, 0.2);
      ctxV.fillStyle = 'rgba(150,95,40,.28)'; ctxV.beginPath(); ctxV.arc(cx, cy, r, 0, Math.PI * 2); ctxV.fill();
      ctxV.strokeStyle = 'rgba(85,45,15,.85)'; ctxV.lineWidth = m * 0.9;
      ctxV.beginPath(); ctxV.arc(cx, cy, r, 0.2, Math.PI * 1.85); ctxV.stroke();
      ctxV.lineWidth = m * 0.4; ctxV.beginPath(); ctxV.arc(cx + m, cy - m * 0.5, r * 0.92, 2, 5.2); ctxV.stroke();
    }
    if (name === 'tear') {
      ctxV.fillStyle = '#fff';
      ctxV.beginPath();
      ctxV.moveTo(S, S - span * 0.42 - o);
      let x = S, y = S - span * 0.42 - o;
      while (x > S - span * 0.42 - o) { x -= rnd(8, 22); y += rnd(-2, 22); ctxV.lineTo(x, Math.min(S, y)); }
      ctxV.lineTo(x, S); ctxV.lineTo(S, S); ctxV.closePath(); ctxV.fill();
      ctxV.strokeStyle = '#bdb6aa'; ctxV.lineWidth = 2; ctxV.stroke();
    }
    if (name === 'scratch') {
      ctxV.strokeStyle = '#fff'; ctxV.lineCap = 'round';
      for (let i = 0; i < 5; i++) {
        ctxV.lineWidth = rnd(m * 0.4, m * 0.9);
        ctxV.beginPath();
        const y0 = o + rnd(0.2, 0.9) * span;
        ctxV.moveTo(o + rnd(0.05, 0.3) * span, y0);
        ctxV.quadraticCurveTo(S / 2, y0 + rnd(-80, 80), o + rnd(0.7, 0.98) * span, y0 + rnd(-120, 120));
        ctxV.stroke();
      }
    }
    if (name === 'eye') {
      ctxV.fillStyle = '#fff';
      ctxV.beginPath(); ctxV.arc(o + 3.5 * m, o + 3.5 * m, m * 3.1, 0, Math.PI * 2); ctxV.fill();
      ctxV.font = `${m * 5}px "Segoe UI Emoji","Apple Color Emoji",sans-serif`; ctxV.textAlign = 'center'; ctxV.textBaseline = 'middle';
      ctxV.fillText('🙈', o + 3.5 * m, o + 3.7 * m);
    }
    if (name === 'random') {
      for (let i = 0; i < 7; i++) {
        ctxV.fillStyle = Math.random() < 0.5 ? '#141414' : '#fff';
        const cx = o + rnd(0.1, 0.95) * span, cy = o + rnd(0.1, 0.95) * span;
        ctxV.beginPath();
        for (let a = 0; a < Math.PI * 2; a += 0.5) { const r = m * rnd(1, 2.4); ctxV.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
        ctxV.fill();
      }
    }
    ctxV.restore();
    afterEdit();
  }
  $$('[data-preset]').forEach((b) => b.addEventListener('click', () => preset(b.dataset.preset)));

  /* ---------------- layers: legend + module info ---------------- */
  function buildLegend() {
    const qr = state.qr;
    const counts = {};
    qr.roles.forEach((r) => (counts[r] = (counts[r] || 0) + 1));
    const total = qr.size * qr.size;
    $('#legend').innerHTML = ROLE_ORDER.filter((r) => counts[r]).map((r) =>
      `<label class="${state.hidden.has(r) ? 'off' : ''}" title="${counts[r]} squares (${((counts[r] / total) * 100).toFixed(1)}%)"><input type="checkbox" data-role="${r}" ${state.hidden.has(r) ? '' : 'checked'}/><span class="sw" style="background:${ROLES[r].dark}"></span>${ROLES[r].name}<span class="cnt">${((counts[r] / total) * 100).toFixed(1)}%</span></label>`).join('');
  }
  $('#legend').addEventListener('change', (e) => {
    const r = e.target.dataset.role;
    if (!r) return;
    e.target.checked ? state.hidden.delete(r) : state.hidden.add(r);
    e.target.closest('label').classList.toggle('off', !e.target.checked);
    if (state.view !== 'layers') setView('layers'); else drawBase();
  });

  function pickModule(p) {
    const qr = state.qr; const { m, o } = geom(qr);
    const x = Math.floor((p.x - o) / m), y = Math.floor((p.y - o) / m);
    if (x < 0 || y < 0 || x >= qr.size || y >= qr.size) return;
    if (state.tab === 'order') {
      const idx = y * qr.size + x, inf = qr.info[idx];
      if (inf && inf.cw !== undefined && (qr.roles[idx] === 'data' || qr.roles[idx] === 'ec')) {
        state.order.playing = false;
        state.order.pos = qr.placementOrder.indexOf(qr.cwModules[inf.cw][7]) + 1;
        updateOrderUI();
      }
      return;
    }
    if (state.tab !== 'layers') switchTab('layers');
    state.selected = y * qr.size + x;
    $('#moduleInfo').innerHTML = describeModule(state.selected);
    overlayDirty = true;
  }

  function bitsHtml(value, n, cur) {
    let s = '<span class="bits">';
    for (let i = 0; i < n; i++) { const b = (value >>> (n - 1 - i)) & 1; s += `<i class="${b ? 'd' : ''} ${i === cur ? 'cur' : ''}">${b}</i>`; }
    return s + '</span>';
  }
  function partsText(qr, dataIndex) {
    return QRCore.describeDataCodeword(qr, dataIndex).map(({ seg, bits, whole }) => {
      const amt = whole ? '' : ` <span class="muted">(${bits} of ${seg.len} bits)</span>`;
      if (seg.type === 'char') return `letter <b>“${esc(seg.char === ' ' ? '␣' : seg.char)}”</b>${seg.part ? ` byte ${seg.part}` : ''}${amt}`;
      return `<b>${esc(seg.label)}</b>${amt}`;
    }).join(' + ');
  }

  function describeModule(i) {
    const qr = state.qr;
    const x = i % qr.size, y = Math.floor(i / qr.size);
    const role = qr.roles[i], inf = qr.info[i], dark = qr.modules[i];
    const R = ROLES[role];
    const head = (t) => `<h3><span class="sw" style="background:${R.dark}"></span>${t} <span class="chip">(${x}, ${y})</span></h3>`;
    const eyesPct = ((147 / (qr.size * qr.size)) * 100).toFixed(1);
    switch (role) {
      case 'finder':
        return head(`Finder eye · ${inf.eyeName}`) +
          `<p>One of the three <b>eyes</b>. Its rings run dark–light–dark–light–dark in a <b>1 : 1 : 3 : 1 : 1</b> ratio, which looks identical from every direction, so a scanner can spot the code and tell which way up it is.</p>
           <p class="muted">3 eyes × 49 squares = 147 squares, which is <b>${eyesPct}%</b> of this ${qr.size}×${qr.size} grid. They carry no data at all.</p>`;
      case 'separator':
        return head('Separator') + `<p>A white moat around an eye, so the eye's edge never blends into nearby data squares.</p>`;
      case 'timing':
        return head('Timing ruler') + `<p>Squares alternate dark, light, dark… between two eyes, like the marks on a ruler. Scanners count them to know how many columns and rows there are. This one is <b>${dark ? 'dark' : 'light'}</b> because it sits at an ${(x === 6 ? y : x) % 2 ? 'odd' : 'even'} position.</p>`;
      case 'alignment':
        return head('Alignment target') + `<p>A small bullseye that helps the scanner straighten out a code photographed at an angle or printed on a curved cup.</p><p class="muted">Version 1 has none; bigger versions add more.</p>`;
      case 'format':
        return head(`Format label · bit ${inf.bit}, copy ${inf.copy}`) +
          `<p>15 bits that tell the scanner <b>level ${qr.level}</b> and <b>mask ${qr.mask}</b>, plus 10 bits of their own error correction. Without them the scanner can't undo the mask.</p>
           <p>${bitsHtml(qr.formatBits, 15, 14 - inf.bit)}</p>
           <p class="muted">Stored <b>twice</b>: once around the top-left eye, once split between the other two. Each copy survives up to 3 wrong bits.</p>`;
      case 'version':
        return head(`Version label · bit ${inf.bit}, copy ${inf.copy}`) + `<p>18 bits spelling “Version ${qr.version}” with error correction, so the scanner knows the grid size. Codes from Version 7 up carry two copies.</p>`;
      case 'darkmodule':
        return head('Dark module') + `<p>A single square that is <b>always dark</b>, required by the standard next to the bottom-left eye. It carries no information.</p>`;
      case 'remainder':
        return head('Remainder bit') + `<p>Leftover space after the last codeword. It holds nothing; the colour you see comes from the mask.</p>`;
      case 'data':
      case 'ec': {
        const meta = qr.cwMeta[inf.cw], value = qr.codewords[inf.cw];
        const raw = (value >>> (7 - inf.bit)) & 1;
        const flipped = raw !== dark;
        const blk = qr.blocks[meta.block];
        const common = `<dl class="kv">
            <dt>Read order</dt><dd>codeword ${inf.cw + 1} of ${qr.codewords.length}</dd>
            <dt>Block</dt><dd>${meta.block + 1} of ${qr.numBlocks} · ${meta.kind === 'data' ? `data byte ${meta.index + 1} of ${blk.data.length}` : `backup byte ${meta.index + 1} of ${blk.ec.length}`}</dd>
            <dt>Value</dt><dd>${bitsHtml(value, 8, inf.bit)} = ${value} (0x${value.toString(16).toUpperCase().padStart(2, '0')})</dd>
          </dl>
          <p class="small muted">This square shows <b>${dark ? 'dark' : 'light'}</b>; its real bit is <b>${raw}</b>. ${flipped ? 'The mask <b>flipped</b> it.' : 'The mask left it alone.'}</p>`;
        if (role === 'data') {
          return head('Data codeword') + `<p>One of 8 squares in a <b>data codeword</b>. This byte carries: ${partsText(qr, meta.dataIndex)}.</p>` + common;
        }
        return head('Backup codeword') + `<p>One of 8 squares in a <b>backup (error-correction) codeword</b>. It holds no letters. It's a Reed–Solomon check value calculated from all ${blk.data.length} data codewords in block ${meta.block + 1}. Together the ${blk.ec.length} backups can rebuild <b>any ${qr.repairPerBlock}</b> broken codewords in that block.</p>` + common;
      }
    }
    return '';
  }

  /* ---------------- read order ---------------- */
  function currentOrderCw() {
    const qr = state.qr;
    const k = Math.min(Math.floor(state.order.pos), qr.codewords.length * 8);
    if (k <= 0) return null;
    const idx = qr.placementOrder[k - 1];
    const inf = qr.info[idx];
    return inf && inf.cw !== undefined && (qr.roles[idx] === 'data' || qr.roles[idx] === 'ec') ? inf.cw : null;
  }
  function stepOrder() {
    const qr = state.qr;
    const speed = +$('#speedRange').value;
    state.order.pos += speed * 0.18;
    if (state.order.pos >= qr.codewords.length * 8) { state.order.pos = qr.codewords.length * 8; state.order.playing = false; }
    updateOrderUI();
  }
  let lastOrderCw = -2;
  function updateOrderUI() {
    const qr = state.qr; if (!qr) return;
    const cw = currentOrderCw();
    const doneCw = Math.floor(state.order.pos / 8);
    $('#orderRange').value = doneCw;
    $('#orderCount').textContent = `${doneCw} / ${qr.codewords.length}`;
    $('#btnPlay').textContent = state.order.playing ? '❚❚' : '▶';
    overlayDirty = true;
    if (cw === lastOrderCw) return;
    lastOrderCw = cw;
    const info = $('#orderInfo');
    $$('#bytesStrip span').forEach((s) => s.classList.remove('hit'));
    if (cw === null) { info.innerHTML = '<p class="muted">Press ▶ to watch the scanner\'s path, or tap any codeword on the code.</p>'; return; }
    const meta = qr.cwMeta[cw], value = qr.codewords[cw];
    if (meta.kind === 'data') {
      const s = meta.dataIndex * 8, e = s + 8;
      $$('#bytesStrip span').forEach((sp) => { const a = +sp.dataset.s, b = a + +sp.dataset.l; if (a < e && b > s) sp.classList.add('hit'); });
      info.innerHTML = `<h3><span class="sw" style="background:${ROLES.data.dark}"></span>Codeword ${cw + 1}: data</h3>
        <p>${bitsHtml(value, 8, -1)} &nbsp;Block ${meta.block + 1}, byte ${meta.index + 1}</p>
        <p class="small">Carries ${partsText(qr, meta.dataIndex)}.</p>`;
    } else {
      info.innerHTML = `<h3><span class="sw" style="background:${ROLES.ec.dark}"></span>Codeword ${cw + 1}: backup</h3>
        <p>${bitsHtml(value, 8, -1)} &nbsp;Block ${meta.block + 1}, backup ${meta.index + 1} of ${qr.ecPerBlock}</p>
        <p class="small">After all the data comes the backup. These bytes are calculated from the data, so lost bytes can be <b>recalculated</b>.</p>`;
    }
  }
  function buildBytes() {
    const qr = state.qr;
    const out = [];
    let i = 0;
    const segs = qr.segments;
    while (i < segs.length) {
      const seg = segs[i];
      if (seg.type === 'char') {
        let len = seg.len, j = i + 1;
        while (j < segs.length && segs[j].type === 'char' && segs[j].part && !segs[j].part.startsWith('1/')) { len += segs[j].len; j++; }
        out.push(`<span data-s="${seg.start}" data-l="${len}" title="${esc(seg.char)}">${esc(seg.char === ' ' ? '␣' : seg.char)}</span>`);
        i = j; continue;
      }
      const label = { mode: 'MODE', count: 'LEN', terminator: 'END', bitpad: 'PAD', padbyte: 'FILL' }[seg.type];
      out.push(`<span class="meta" data-s="${seg.start}" data-l="${seg.len}" title="${esc(seg.label || '')}">${label}</span>`);
      i++;
    }
    $('#bytesStrip').innerHTML = out.join('');
    lastOrderCw = -2;
  }
  $('#btnPlay').addEventListener('click', () => {
    const qr = state.qr;
    if (state.order.pos >= qr.codewords.length * 8) state.order.pos = 0;
    state.order.playing = !state.order.playing;
    updateOrderUI();
  });
  $('#orderRange').addEventListener('input', (e) => {
    state.order.playing = false;
    state.order.pos = +e.target.value * 8;
    updateOrderUI();
  });

  /* ---------------- levels comparison ---------------- */
  function renderLevels() {
    const grid = $('#levelsGrid');
    const results = [];
    const tmp = document.createElement('canvas'); tmp.width = tmp.height = S;
    const tctx = tmp.getContext('2d', { willReadFrequently: true });
    const cards = QRCore.LEVELS.map((L) => {
      let qr;
      try { qr = QRCore.encode(state.text, L, { minVersion: state.minVersion }); }
      catch (e) { return `<div class="lvl"><div class="lvl-head"><b>${L}</b></div><p class="small err">Message too long for level ${L}.</p></div>`; }
      composite(tctx, qr);
      const { m, o } = geom(qr);
      const rep = QRDamage.analyse(qr, QRDamage.sample(qr, tctx.getImageData(0, 0, S, S), o, o, m));
      const r = runJsQR(tmp);
      const ok = !!r && r.data === qr.text;
      results.push({ L, ok });
      const ec = qr.ecPerBlock * qr.numBlocks, data = qr.dataCodewords.length;
      const url = tmp.toDataURL();
      return `<div class="lvl ${L === state.level ? 'current' : ''}">
        <div class="lvl-head"><b>${L}</b><span class="verdict ${ok ? 'ok' : 'bad'}">${ok ? '✓ scans' : '✗ broken'}</span></div>
        <img src="${url}" alt="Level ${L} code with your damage" style="width:100%;aspect-ratio:1;border:1.5px solid #141414;border-radius:6px;display:block" />
        <div class="ratio" title="data vs backup codewords"><i style="width:${(data / (data + ec)) * 100}%;background:${ROLES.data.dark}"></i><i style="width:${(ec / (data + ec)) * 100}%;background:${ROLES.ec.dark}"></i></div>
        <dl>
          <dt>Grid</dt><dd>V${qr.version} · ${qr.size}×${qr.size}</dd>
          <dt>Data / backup</dt><dd>${data} / ${ec}</dd>
          <dt>Repairs per block</dt><dd>${qr.repairPerBlock} of ${qr.blocks[0].data.length + qr.ecPerBlock}</dd>
          <dt>Worst block hit</dt><dd>${rep.worst.damaged} / ${rep.worst.capacity}</dd>
        </dl>
        ${L !== state.level ? `<button type="button" class="btn btn-icon" data-uselevel="${L}">Use level ${L}</button>` : '<span class="small muted">← current</span>'}
      </div>`;
    });
    grid.innerHTML = cards.join('');
    const hasDamage = state.report && state.report.wrongCount > 0;
    const surv = results.filter((r) => r.ok).map((r) => r.L), dead = results.filter((r) => !r.ok).map((r) => r.L);
    $('#levelsInsight').textContent = !hasDamage
      ? '👉 Go back to step 4, scribble on the code, and come back. Your damage will be applied to all four levels.'
      : dead.length === 0 ? `All four levels survived your damage. Be more destructive! 😈`
      : surv.length === 0 ? `Your damage destroyed all four levels. Even 30% backup has a limit.`
      : `Same scribble, different fate: ${surv.join(', ')} survived; ${dead.join(', ')} broke. More backup = tougher code.`;
  }
  $('#levelsGrid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-uselevel]');
    if (b) setLevel(b.dataset.uselevel);
  });

  /* ---------------- tabs, views, controls ---------------- */
  const HINTS = { make: '', layers: 'Tap any square', order: 'Tap a codeword or press ▶', vandal: 'Draw on the code!', levels: '', graffiti: 'Make art. Keep it scannable!' };
  function switchTab(t) {
    state.tab = t;
    $$('.tabs button').forEach((b) => { b.classList.toggle('on', b.dataset.tab === t); b.setAttribute('aria-selected', b.dataset.tab === t); });
    $$('.panel').forEach((p) => (p.hidden = p.dataset.panel !== t));
    if (t === 'vandal') $('#toolsHost').appendChild(tools);
    if (t === 'graffiti') $('#toolsHost2').appendChild(tools);
    if (t === 'layers' || t === 'order') setView('layers');
    else if (t === 'vandal' || t === 'graffiti') { if (state.view === 'layers') setView('plain'); }
    if (t !== 'order') state.order.playing = false;
    if (t === 'order') updateOrderUI();
    if (t === 'levels') renderLevels();
    stage.classList.toggle('drawing', isDrawTab());
    stage.classList.toggle('picking', !isDrawTab());
    $('#lab').classList.toggle('compact', isDrawTab());
    const h = $('#stageHint');
    h.textContent = HINTS[t]; h.classList.toggle('show', !!HINTS[t]);
    clearTimeout(switchTab.tm); switchTab.tm = setTimeout(() => h.classList.remove('show'), 2600);
    overlayDirty = true;
  }
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('.tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const btns = $$('.tabs button');
    const i = btns.findIndex((b) => b.dataset.tab === state.tab);
    const next = btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length];
    switchTab(next.dataset.tab);
    next.focus();
  });
  $$('[data-goto]').forEach((b) => b.addEventListener('click', () => {
    switchTab(b.dataset.goto);
    if (window.innerWidth < 920) $('#lab').scrollIntoView({ behavior: 'smooth' });
  }));

  function setView(v) {
    state.view = v;
    $$('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    drawBase();
  }
  $$('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  function setLevel(L) {
    const prev = state.level;
    state.level = L;
    const ok = generate();
    if (!ok) {
      state.level = prev;
      generate();
      showHint(`Message too long for level ${L}. Shorten it first.`);
    }
    $$('#levelSeg button').forEach((b) => b.classList.toggle('on', b.dataset.level === state.level));
    return ok;
  }
  function showHint(msg) {
    const h = $('#stageHint');
    h.textContent = msg; h.classList.add('show');
    clearTimeout(switchTab.tm); switchTab.tm = setTimeout(() => h.classList.remove('show'), 3200);
  }
  $$('#levelSeg button').forEach((b) => b.addEventListener('click', () => setLevel(b.dataset.level)));

  let genTimer;
  $('#txtInput').addEventListener('input', (e) => {
    clearTimeout(genTimer);
    genTimer = setTimeout(() => {
      if (!e.target.value.length) { $('#txtInfo').textContent = '✏️ Type something to make a code.'; return; }
      state.text = e.target.value;
      generate();
    }, 160);
  });
  $$('[data-ex]').forEach((b) => b.addEventListener('click', () => loadText(b.dataset.ex)));
  function loadText(t) {
    $('#txtInput').value = t;
    state.text = t;
    if (!generate() && state.level !== 'L') setLevel('L');
  }
  $('#verRange').addEventListener('input', (e) => {
    state.minVersion = +e.target.value;
    $('#verLabel').textContent = state.minVersion === 1 ? 'auto' : `Version ${state.minVersion}+ (${QRCore.sizeOf(state.minVersion)}×${QRCore.sizeOf(state.minVersion)})`;
    generate();
  });

  /* ---------------- graffiti ---------------- */
  $('#btnGraffitiStart').addEventListener('click', () => {
    pushUndo();
    ctxV.clearRect(0, 0, S, S);
    setLevel('H');
    setTool('spray');
    const pink = $('.swatch[data-color="#FF3D5A"]', tools);
    if (pink) pink.click();
    setView('plain');
  });
  $('#btnBig').addEventListener('click', () => {
    const c = $('#bigCanvas');
    composite(c.getContext('2d'), state.qr);
    $('#bigDialog').showModal();
  });
  $('#btnDownload').addEventListener('click', () => {
    composite(ctxComp, state.qr);
    const a = document.createElement('a');
    a.download = `break-the-qr-${state.level}.png`;
    a.href = cvComp.toDataURL('image/png');
    a.click();
  });
  $$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  /* ---------------- scanning: camera + photo ---------------- */
  let camStream = null, camTimer = null;
  const camCanvas = document.createElement('canvas');
  const camCtx = camCanvas.getContext('2d', { willReadFrequently: true });
  $('#btnCamera').addEventListener('click', async () => {
    const dlg = $('#camDialog');
    const status = $('#camStatus');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showScan(null, 'Your browser can\'t open the camera here. Camera access needs a secure (https) page. Try “Upload a photo” instead.');
      return;
    }
    dlg.showModal();
    status.textContent = 'Starting camera…';
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
      const v = $('#camVideo');
      v.srcObject = camStream;
      await v.play();
      status.textContent = 'Looking for a QR code… (frames never leave your device)';
      camTimer = setInterval(() => {
        if (!v.videoWidth) return;
        const scale = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));
        camCanvas.width = Math.round(v.videoWidth * scale); camCanvas.height = Math.round(v.videoHeight * scale);
        camCtx.drawImage(v, 0, 0, camCanvas.width, camCanvas.height);
        const d = camCtx.getImageData(0, 0, camCanvas.width, camCanvas.height);
        const r = jsQR(d.data, d.width, d.height, { inversionAttempts: 'attemptBoth' });
        if (r && r.data) { stopCamera(); dlg.close(); showScan(r); }
      }, 140);
    } catch (e) {
      status.textContent = 'Could not open the camera: ' + (e.name === 'NotAllowedError' ? 'permission was denied.' : e.message);
    }
  });
  function stopCamera() {
    clearInterval(camTimer); camTimer = null;
    if (camStream) camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
  }
  $('#camDialog').addEventListener('close', stopCamera);

  $('#fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1200 / Math.max(img.width, img.height));
      camCanvas.width = Math.round(img.width * scale); camCanvas.height = Math.round(img.height * scale);
      camCtx.drawImage(img, 0, 0, camCanvas.width, camCanvas.height);
      const d = camCtx.getImageData(0, 0, camCanvas.width, camCanvas.height);
      const r = jsQR(d.data, d.width, d.height, { inversionAttempts: 'attemptBoth' });
      showScan(r, r ? null : 'No QR code found in that photo. Try a sharper, closer, evenly lit picture. Blur, glare and uneven light are the top reasons real scans fail.');
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(f);
    e.target.value = '';
  });

  function showScan(r, err) {
    const box = $('#scanResult');
    if (!r) { box.innerHTML = `<div class="scan-card"><p class="err">${esc(err)}</p></div>`; return; }
    const res = LinkXray.analyse(r.data);
    box.innerHTML = `<div class="scan-card">
      <b>Found a Version ${r.version} code.</b> Here's what's inside, <i>before</i> you open anything:
      ${LinkXray.render(res)}
      <div class="row wrap">
        <button type="button" class="btn btn-primary" data-act="load" data-text="${encodeURIComponent(r.data)}">Rebuild it in the lab →</button>
      </div>
      <p class="small muted">We re-create the code with our own encoder so we can map every square. The squares may look different from the original if it used another level or mask.</p>
    </div>`;
  }

  /* ---------------- safety: link x-ray ---------------- */
  const runXray = () => { $('#xrayOut').innerHTML = LinkXray.render(LinkXray.analyse($('#xrayInput').value)); };
  $('#xrayBtn').addEventListener('click', runXray);
  $('#xrayInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') runXray(); });
  $$('[data-xray]').forEach((b) => b.addEventListener('click', () => { $('#xrayInput').value = b.dataset.xray; runXray(); }));

  /* ---------------- version explorer ---------------- */
  function renderExplorer() {
    const v = +$('#exVer').value;
    $('#exVerLabel').textContent = v;
    const qr = QRCore.encode('GVH', 'M', { minVersion: v });
    const size = qr.size, total = size * size;
    const c = document.createElement('canvas'); c.width = c.height = 400;
    const saveHidden = state.hidden; state.hidden = new Set();
    drawCode(c.getContext('2d'), qr, 'layers', 400);
    state.hidden = saveHidden;
    const lv = QRCore.LEVELS.map((L) => {
      const s = QRCore.blockSpec(v, L);
      const ec = s.ecPerBlock * s.numBlocks;
      return `<div class="ex-stat"><b>${L}</b><span>${s.dataCodewords} data + ${ec} backup codewords · ${s.numBlocks} block${s.numBlocks > 1 ? 's' : ''} · repairs ${Math.floor(s.ecPerBlock / 2)} per block · holds ${QRCore.byteCapacity(v, L)} bytes</span></div>`;
    }).join('');
    $('#explorerGrid').innerHTML = `
      <img src="${c.toDataURL()}" alt="Version ${v} layer map" style="width:100%;aspect-ratio:1;border:2px solid #141414;border-radius:8px;background:#fff" />
      <div>
        <div class="ex-stats">
          <div class="ex-stat"><b>${size}×${size}</b><span>17 + 4×${v} = ${size} squares per side</span></div>
          <div class="ex-stat"><b>${total}</b><span>modules in total</span></div>
          <div class="ex-stat"><b>${((147 / total) * 100).toFixed(1)}%</b><span>is just the three eyes (147 ÷ ${total})</span></div>
          <div class="ex-stat"><b>${QRCore.totalCodewords(v)}</b><span>codewords of 8 bits</span></div>
          <div class="ex-stat"><b>${QRCore.ALIGNMENT[v].length ? QRCore.ALIGNMENT[v].length ** 2 - 3 : 0}</b><span>alignment targets</span></div>
          <div class="ex-stat"><b>${v >= 7 ? 'Yes' : 'No'}</b><span>version label (from V7)</span></div>
        </div>
        <div class="ex-levels" style="margin-top:10px">${lv}</div>
      </div>`;
  }
  $('#exVer').addEventListener('input', renderExplorer);

  /* ---------------- boot ---------------- */
  generate();
  renderRecord();
  renderExplorer();
  switchTab('make');
  requestAnimationFrame(loop);

  // expose for debugging / demo scripts
  window.BTQR = { state, evaluate, generate, preset, switchTab };
})();
