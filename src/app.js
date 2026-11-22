/* MetaScrub — browser UI. Copyright (c) 2026 zecongyu — MIT License */
(function () {
  'use strict';
  const M = window.MetaScrub;
  const $ = (id) => document.getElementById(id);
  const SAMPLES = ['samples/vacation-photo.jpg', 'samples/ai-landscape.png', 'samples/budget-review.docx'];
  const ORDER = ['location', 'device', 'identity', 'time', 'software', 'content', 'other'];
  const results = [];

  const h = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k === 'style') n.style.cssText = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
    return n;
  };
  const kb = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
  const cleanName = (name) => name.replace(/(\.[^.]+)?$/, (ext) => `-clean${ext || ''}`);

  // ------------------------------------------------------------ input
  const drop = $('drop');
  drop.addEventListener('click', (e) => { if (e.target.id !== 'sampleBtn') $('file').click(); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => handle([...e.dataTransfer.files]));
  $('file').addEventListener('change', (e) => { handle([...e.target.files]); e.target.value = ''; });

  $('sampleBtn').addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      const files = await Promise.all(SAMPLES.map(async (u) => {
        const r = await fetch(u);
        if (!r.ok) throw new Error(u);
        return new File([await r.blob()], u.split('/').pop());
      }));
      handle(files);
    } catch (_) {
      toast('Samples need the hosted page (or a local web server).');
    }
  });

  async function handle(files) {
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      let r;
      try { r = await M.scrub(bytes, f.name); } catch (err) {
        r = { supported: false, findings: [], kept: [], warnings: [`Could not read this file: ${err.message}`], before: bytes.length, typeLabel: 'File' };
      }
      const entry = { name: f.name, r, srcUrl: null, outUrl: null, open: results.length === 0 };
      if (r.supported) {
        entry.outUrl = URL.createObjectURL(new Blob([r.output], { type: r.mime }));
      }
      results.unshift(entry);
    }
    render();
    $('stats').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ------------------------------------------------------------ render
  function render() {
    $('stats').hidden = !results.length;
    const ok = results.filter((x) => x.r.supported);
    $('sFiles').textContent = ok.length;
    $('sItems').textContent = ok.reduce((n, x) => n + x.r.findings.length, 0);
    $('sLoc').textContent = ok.filter((x) => x.r.findings.some((f) => f.category === 'location')).length;
    $('sBytes').textContent = kb(ok.reduce((n, x) => n + Math.max(0, x.r.before - x.r.after), 0));
    $('allBtn').hidden = ok.length < 2;
    $('results').replaceChildren(...results.map(card));
  }

  function card(x) {
    const r = x.r;
    const isImg = /^(jpeg|png|webp)$/.test(r.type);
    const thumb = h('div', { class: 'thumb' }, isImg && x.outUrl ? h('img', { src: x.outUrl, alt: '' }) : (r.type || '?').toUpperCase());
    const chips = h('div', { class: 'chips' },
      ...(r.findings.length
        ? ORDER.filter((c) => r.summary && r.summary[c]).map((c) => h('span', { class: 'chip', style: `--c:var(--c-${c})` }, `${M.CATEGORY_LABEL[c]} · ${r.summary[c]}`))
        : [h('span', { class: 'chip clean' }, r.supported ? 'Nothing personal found' : 'Not supported yet')]));
    const meta = r.supported
      ? h('div', { class: 'fmeta' }, `${r.typeLabel} · ${kb(r.before)} → `, h('b', {}, kb(r.after)), ` · ${r.findings.length} item${r.findings.length === 1 ? '' : 's'} removed`)
      : h('div', { class: 'fmeta' }, `${kb(r.before)} · ${r.warnings[0] || 'unsupported'}`);
    const actions = h('div', { class: 'actions' },
      r.supported ? h('a', { class: 'btn accent small', href: x.outUrl, download: cleanName(x.name) }, '⬇ Download clean') : null,
      r.findings.length ? h('button', { class: 'toggle', type: 'button', 'aria-expanded': String(x.open), onclick: () => { x.open = !x.open; render(); } }, x.open ? 'Hide details' : 'Show details') : null);

    const gps = r.findings.find((f) => f.lat != null);
    const alert = gps ? h('div', { class: 'alert' },
      pinIcon(),
      h('span', {}, 'This file revealed where it was taken: ', h('code', {}, gps.value), '. Removed.'),
      h('a', { href: `https://www.openstreetmap.org/?mlat=${gps.lat}&mlon=${gps.lon}#map=15/${gps.lat}/${gps.lon}`, target: '_blank', rel: 'noopener' }, 'See it on a map ↗')) : null;

    const detail = x.open && r.findings.length ? h('div', { class: 'detail' },
      h('div', {},
        h('h4', {}, 'Removed'),
        h('ul', { class: 'removed' }, ...r.findings.slice().sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category)).map((f) =>
          h('li', {}, h('i', { style: `--c:var(--c-${f.category})` }), h('span', { class: 'lbl' }, f.label), h('span', { class: 'val' }, f.value || '—'))))),
      h('div', {},
        r.kept.length ? [h('h4', {}, 'Kept'), h('ul', { class: 'kept' }, ...r.kept.map((k) => h('li', {}, k)))] : null,
        r.warnings.length ? [h('h4', {}, 'Before you share'), h('ul', { class: 'warns' }, ...r.warnings.map((w) => h('li', {}, w)))] : null)) : null;

    return h('li', { class: 'card' },
      h('div', { class: 'card-head' }, thumb, h('div', {}, h('div', { class: 'fname' }, x.name), meta, chips), actions),
      alert, detail);
  }

  function pinIcon() {
    const span = h('span', { class: 'pin', 'aria-hidden': 'true' });
    span.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z" fill="#fff"/><circle cx="12" cy="10" r="2.6" fill="currentColor"/></svg>';
    return span;
  }

  $('allBtn').addEventListener('click', () => {
    results.filter((x) => x.r.supported).forEach((x, i) => setTimeout(() => {
      const a = h('a', { href: x.outUrl, download: cleanName(x.name) });
      document.body.append(a); a.click(); a.remove();
    }, i * 250));
  });

  let tt;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(tt);
    tt = setTimeout(() => t.classList.remove('show'), 2600);
  }

  if (location.hash === '#demo') $('sampleBtn').click();
})();
