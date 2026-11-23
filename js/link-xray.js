/*
 * Break the QR — link-xray.js
 * "Check before you tap": shows what a QR code really contains and
 * flags common quishing tricks. General safety advice, not a
 * security product. Runs entirely on the device.
 */
(function (root) {
  'use strict';

  const SHORTENERS = ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'ow.ly', 'cutt.ly', 'rebrand.ly', 'shorturl.at', 'qrco.de', 's.id', 'tiny.cc', 'rb.gy', 'buff.ly', 'lnkd.in', 'qr.codes', 'bl.ink', 'v.gd'];
  const RISKY_TLDS = ['zip', 'mov', 'xyz', 'top', 'click', 'link', 'country', 'gq', 'tk', 'ml', 'cf', 'ga', 'work', 'support', 'rest', 'cam'];
  const BRANDS = ['paypal', 'apple', 'icloud', 'google', 'microsoft', 'office365', 'outlook', 'amazon', 'netflix', 'facebook', 'instagram', 'whatsapp', 'bank', 'gcash', 'maya', 'bdo', 'bpi', 'visa', 'mastercard', 'dhl', 'fedex', 'ups', 'usps', 'lbc', 'shopee', 'lazada', 'steam', 'roblox', 'discord'];
  const TWO_PART_SUFFIXES = ['co.uk', 'com.ph', 'com.au', 'co.jp', 'com.sg', 'co.nz', 'com.br', 'co.in', 'org.uk', 'gov.ph', 'edu.ph', 'gov.uk', 'ac.uk', 'com.my', 'co.za'];

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function registrable(host) {
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    const last2 = parts.slice(-2).join('.');
    const n = TWO_PART_SUFFIXES.includes(last2) ? 3 : 2;
    return parts.slice(-n).join('.');
  }

  function analyse(raw) {
    const text = String(raw || '').trim();
    const flags = [];
    if (!text) return null;

    // non-web payloads
    const lower = text.toLowerCase();
    if (/^wifi:/i.test(text)) return { kind: 'wifi', text, flags: [{ level: 'info', text: 'This is a Wi-Fi login. Scanning it joins a network. Only join networks you expect, like the one on the official sign at a café.' }] };
    if (/^(tel:|sms:|smsto:|mailto:|geo:|begin:vcard|matmsg:)/i.test(text)) {
      const what = lower.startsWith('tel') ? 'starts a phone call' : lower.startsWith('sms') ? 'writes a text message (could be to a paid number)' : lower.startsWith('mailto') || lower.startsWith('matmsg') ? 'writes an email' : lower.startsWith('geo') ? 'opens a map location' : 'adds a contact';
      return { kind: 'action', text, flags: [{ level: 'info', text: `This code ${what}. Check the number or address before you confirm.` }] };
    }
    if (/^(javascript|data|vbscript|intent|file):/i.test(text)) {
      return { kind: 'danger', text, flags: [{ level: 'warn', text: 'This code contains a script or hidden file, not a normal web link. Don\'t open it.' }] };
    }

    let url;
    const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(text);
    if (!looksLikeUrl) {
      return { kind: 'text', text, flags: [{ level: 'good', text: 'This is plain text, not a link. Nothing opens when you scan it.' }] };
    }
    try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'https://' + text); }
    catch (e) { return { kind: 'text', text, flags: [{ level: 'info', text: 'This looks like a link but is malformed. Be careful.' }] }; }

    const host = url.hostname.toLowerCase();
    const domain = registrable(host);
    const labels = host.split('.');
    const tld = labels[labels.length - 1];

    if (url.protocol === 'http:') flags.push({ level: 'warn', text: 'No “https”. Anything you type on this page can be read by others on the network.' });
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) flags.push({ level: 'warn', text: 'The address is a raw IP number, not a name. Real shops and banks use names.' });
    if (host.includes('xn--')) flags.push({ level: 'warn', text: 'The name uses “punycode” (xn--). It can hide lookalike letters from other alphabets.' });
    if (/[^\x00-\x7F]/.test(text.split('/')[2] || '')) flags.push({ level: 'warn', text: 'The name contains non-English letters that may imitate a real brand (е vs e).' });
    if (url.username || /@/.test(text.split('/').slice(0, 3).join('/'))) flags.push({ level: 'warn', text: 'There is an “@” in the address. Everything before it is ignored, a classic trick to show a fake brand name.' });
    if (SHORTENERS.includes(host) || SHORTENERS.includes(domain)) flags.push({ level: 'info', text: `${domain} is a link shortener. It hides the real destination until you open it.` });
    const sub = labels.slice(0, labels.length - domain.split('.').length);
    const brandInSub = BRANDS.find((b) => sub.some((s) => s.includes(b)));
    const brandInDomain = BRANDS.find((b) => domain.includes(b));
    if (brandInSub && !brandInDomain) flags.push({ level: 'warn', text: `“${brandInSub}” appears, but the real owner of this site is ${domain}. Scammers put brand names on the left of a domain they own.` });
    if (sub.some((s) => ['com', 'net', 'org', 'login', 'secure', 'verify', 'account'].includes(s))) flags.push({ level: 'warn', text: 'Words like “com”, “login”, “secure” or “verify” in front of the real domain are a common disguise.' });
    if (/(login|verify|account|password|wallet|payment|update|unlock|suspend)/i.test(url.pathname + url.search)) flags.push({ level: 'info', text: 'The link asks about logging in or paying. Never enter passwords or card details on a page opened from a code.' });
    if (RISKY_TLDS.includes(tld)) flags.push({ level: 'info', text: `“.${tld}” endings are cheap and often abused. Not always bad, but be extra careful.` });
    if (/(.)\1{3,}/.test(domain) || /\d/.test(domain.replace(/\.\w+$/, '')) && BRANDS.some((b) => domain.replace(/0/g, 'o').replace(/1/g, 'l').includes(b)))
      flags.push({ level: 'warn', text: 'The name swaps letters for numbers (0 for o, 1 for l). Classic lookalike.' });
    if (labels.length > 4) flags.push({ level: 'info', text: 'Lots of dots in the name. The real owner is only the last part.' });
    if (text.length > 120) flags.push({ level: 'info', text: 'A very long link. Long links can hide where they really go.' });

    if (!flags.some((f) => f.level === 'warn')) flags.push({ level: 'good', text: `No common tricks found. The site belongs to ${domain}. Is that who you expected?` });

    return { kind: 'url', text, url, host, domain, flags };
  }

  function render(result) {
    if (!result) return '';
    let urlHtml;
    if (result.kind === 'url') {
      const { url, host, domain } = result;
      const hostHtml = host.endsWith(domain)
        ? `<span class="dim">${esc(host.slice(0, host.length - domain.length))}</span><span class="dom">${esc(domain)}</span>`
        : esc(host);
      const port = url.port ? ':' + esc(url.port) : '';
      urlHtml = `<span class="dim">${esc(url.protocol)}//</span>${url.username ? `<span class="dim">${esc(url.username)}@</span>` : ''}${hostHtml}${port}<span class="dim">${esc(url.pathname + url.search + url.hash)}</span>`;
    } else {
      urlHtml = esc(result.text);
    }
    const warn = result.flags.filter((f) => f.level === 'warn').length;
    const verdict = result.kind === 'url'
      ? warn ? `⚠️ ${warn} warning sign${warn > 1 ? 's' : ''}` : '✅ No obvious tricks'
      : result.kind === 'text' ? '📝 Plain text' : result.kind === 'danger' ? '⛔ Not a normal link' : '📲 An action, not a website';
    const owner = result.kind === 'url' ? `<p class="small muted" style="margin:6px 0 0">Real owner (highlighted): <b>${esc(result.domain)}</b></p>` : '';
    return `<div class="xr">
      <div class="xr-url">${urlHtml}</div>${owner}
      <div class="xr-verdict">${verdict}</div>
      <ul class="xr-list">${result.flags.map((f) => `<li class="${f.level}">${esc(f.text)}</li>`).join('')}</ul>
    </div>`;
  }

  root.LinkXray = { analyse, render, esc };
})(typeof self !== 'undefined' ? self : this);
