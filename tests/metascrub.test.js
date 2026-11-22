// Run with: npm test   (node --test, Node 18+)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const M = require('../src/metascrub.js');

const fx = (n) => new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', n)));
const enc = new TextEncoder();
const latin = (b) => Buffer.from(b).toString('latin1');
const cat = (...parts) => Buffer.concat(parts.map((p) => Buffer.from(p)));

// ---------------------------------------------------------------- independent TIFF writer (big-endian)
function tiff({ ifd0 = [], exif = [], gps = [] }) {
  // entries: [tag, type, value]; type 2 ASCII (string), 3 SHORT (number), 5 RATIONAL ([num,den][])
  const ifds = [ifd0.slice(), exif, gps];
  if (exif.length) ifds[0].push([0x8769, 4, 'EXIF']);
  if (gps.length) ifds[0].push([0x8825, 4, 'GPS']);
  const size = (e) => (e[1] === 2 ? e[2].length + 1 : e[1] === 5 ? e[2].length * 8 : 0);
  const ifdLen = (l) => 2 + l.length * 12 + 4;
  const offs = []; let o = 8;
  for (const l of ifds) { offs.push(o); o += ifdLen(l) + l.reduce((n, e) => n + (size(e) > 4 ? size(e) : 0), 0); }
  const buf = Buffer.alloc(o);
  buf.write('MM', 0, 'latin1'); buf.writeUInt16BE(42, 2); buf.writeUInt32BE(8, 4);
  ifds.forEach((l, k) => {
    if (!l.length && k) return;
    let p = offs[k]; let data = p + ifdLen(l);
    buf.writeUInt16BE(l.length, p);
    l.sort((a, b) => a[0] - b[0]).forEach((e, i) => {
      const at = p + 2 + i * 12; const [tag, type, v] = e;
      buf.writeUInt16BE(tag, at); buf.writeUInt16BE(type, at + 2);
      if (v === 'EXIF' || v === 'GPS') { buf.writeUInt32BE(1, at + 4); buf.writeUInt32BE(offs[v === 'EXIF' ? 1 : 2], at + 8); return; }
      if (type === 3) { buf.writeUInt32BE(1, at + 4); buf.writeUInt16BE(v, at + 8); return; }
      if (type === 2) {
        buf.writeUInt32BE(v.length + 1, at + 4);
        if (v.length + 1 <= 4) buf.write(v, at + 8, 'latin1'); else { buf.writeUInt32BE(data, at + 8); buf.write(v, data, 'latin1'); data += v.length + 1; }
        return;
      }
      if (type === 5) { buf.writeUInt32BE(v.length, at + 4); buf.writeUInt32BE(data, at + 8); for (const [n, d] of v) { buf.writeUInt32BE(n, data); buf.writeUInt32BE(d, data + 4); data += 8; } }
    });
    buf.writeUInt32BE(0, p + 2 + l.length * 12);
  });
  return buf;
}

const PERSONAL_TIFF = () => tiff({
  ifd0: [[0x010f, 2, 'Apple'], [0x0110, 2, 'iPhone 15 Pro'], [0x0112, 3, 6], [0x013b, 2, 'Jordan Avery'], [0x0131, 2, 'Lightroom 13'], [0x0132, 2, '2026:10:01 10:00:00']],
  exif: [[0x9003, 2, '2026:10:01 09:59:58'], [0xa431, 2, 'SN-ABC123456'], [0xa430, 2, 'Jordan Avery']],
  gps: [[1, 2, 'N'], [2, 5, [[40, 1], [44, 1], [5487, 100]]], [3, 2, 'W'], [4, 5, [[73, 1], [59, 1], [1080, 100]]]],
});
const XMP = (extra = '') => `<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description photoshop:City="Brooklyn" xmp:CreatorTool="Photoshop 26" ${extra}><dc:creator><rdf:Seq><rdf:li>Jordan Avery</rdf:li></rdf:Seq></dc:creator><xmpMM:History><rdf:Seq><rdf:li stEvt:action="saved"/><rdf:li stEvt:action="saved"/></rdf:Seq></xmpMM:History></rdf:Description></rdf:RDF></x:xmpmeta>`;
const AI = 'Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"';

const app = (marker, body) => { const b = Buffer.from(body); const h = Buffer.alloc(4); h[0] = 0xff; h[1] = marker; h.writeUInt16BE(b.length + 2, 2); return cat(h, b); };
function dirtyJpeg({ ai = false, trailing = false } = {}) {
  const base = fx('base.jpg');
  return cat(base.subarray(0, 2),
    app(0xe1, cat('Exif\0\0', PERSONAL_TIFF())),
    app(0xe1, cat('http://ns.adobe.com/xap/1.0/\0', XMP(ai ? AI : ''))),
    app(0xeb, 'JP\0\0c2pa-jumbf-manifest'),
    app(0xfe, 'Shot by Jordan at home'),
    base.subarray(2),
    trailing ? 'SECRET-EXTRA-IMAGE' : '');
}
const pngChunk = (type, data) => { const td = cat(type, data); const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) : M.crc32(td)); const l = Buffer.alloc(4); l.writeUInt32BE(Buffer.from(data).length); return cat(l, td, c); };
function dirtyPng({ sd = false } = {}) {
  const base = Buffer.from(fx('base.png'));
  const ihdrEnd = 8 + 25;
  return cat(base.subarray(0, ihdrEnd),
    pngChunk('tEXt', 'Author\0Jordan Avery'),
    pngChunk('tEXt', 'Software\0GIMP 3.0'),
    sd ? pngChunk('tEXt', 'parameters\0portrait of Jordan Avery at 12 Elm St, Steps: 30, Sampler: Euler') : Buffer.alloc(0),
    pngChunk('eXIf', PERSONAL_TIFF()),
    pngChunk('tIME', Buffer.from([0x07, 0xea, 10, 1, 10, 0, 0])),
    pngChunk('caBX', 'c2pa'),
    base.subarray(ihdrEnd));
}
function dirtyWebp() {
  const vp8l = Buffer.from(fx('base.webp')).subarray(12); // "VP8L" chunk
  const vp8x = Buffer.alloc(18); vp8x.write('VP8X', 0); vp8x.writeUInt32LE(10, 4); vp8x[8] = 0x0c; // EXIF + XMP flags
  const chunk = (t, d) => { const b = Buffer.from(d); const h = Buffer.alloc(8); h.write(t, 0); h.writeUInt32LE(b.length, 4); return cat(h, b, b.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)); };
  const body = cat('WEBP', vp8x, vp8l, chunk('EXIF', PERSONAL_TIFF()), chunk('XMP ', XMP(AI)));
  const head = Buffer.alloc(8); head.write('RIFF', 0); head.writeUInt32LE(body.length, 4);
  return cat(head, body);
}
const labels = (r) => r.findings.map((f) => f.label);
const has = (bytes, s) => latin(bytes).includes(s);

// ---------------------------------------------------------------- tests
test('detects file types', () => {
  assert.equal(M.detect(fx('base.jpg')), 'jpeg');
  assert.equal(M.detect(fx('base.png')), 'png');
  assert.equal(M.detect(fx('base.webp')), 'webp');
  assert.equal(M.detect(fx('sample.docx')), 'docx');
  assert.equal(M.detect(fx('sample.xlsx')), 'xlsx');
  assert.equal(M.detect(fx('sample.pptx')), 'pptx');
  assert.equal(M.detect(enc.encode('%PDF-1.7')), 'pdf');
});

test('JPEG: finds GPS, device, identity, history; removes them', async () => {
  const r = await M.scrub(dirtyJpeg());
  const gps = r.findings.find((f) => f.label === 'GPS position');
  assert.ok(gps, 'GPS found');
  assert.ok(Math.abs(gps.lat - 40.74858) < 0.0001 && Math.abs(gps.lon + 73.98633) < 0.0001, gps.value); // 40°44'54.87"N 73°59'10.8"W
  for (const l of ['Camera make', 'Camera model', 'Artist', 'Body serial number', 'Camera owner', 'Taken', 'City', 'Creator (XMP)', 'Edit history', 'JPEG comment']) assert.ok(labels(r).includes(l), l);
  for (const s of ['Jordan Avery', 'iPhone', 'SN-ABC123456', 'Brooklyn', 'Lightroom', 'Photoshop', 'Shot by Jordan']) assert.ok(!has(r.output, s), `leaked ${s}`);
  assert.ok(r.after < r.before);
});

test('JPEG: keeps orientation, colour/C2PA, image data; decodes', async () => {
  const r = await M.scrub(dirtyJpeg());
  assert.ok(r.kept.includes('Orientation (6)'));
  assert.ok(r.kept.some((k) => /C2PA/.test(k)));
  assert.ok(has(r.output, 'c2pa-jumbf-manifest'));
  const again = await M.scrub(r.output);
  assert.deepEqual(again.findings, [], 'second pass finds nothing');
  // orientation survives as a real EXIF tag
  const t = M.parseTiff(r.output.subarray(findTiff(r.output)));
  assert.equal(t.orientation, 6);
  // the compressed image data is byte-identical
  const sos = (b) => latin(b).indexOf('\xff\xda');
  assert.equal(latin(r.output).slice(sos(r.output)), latin(fx('base.jpg')).slice(sos(fx('base.jpg'))));
});
function findTiff(b) { const s = latin(b); const i = s.indexOf('Exif\0\0'); return i + 6; }

test('JPEG: trailing data after EOI is cut', async () => {
  const r = await M.scrub(dirtyJpeg({ trailing: true }));
  assert.ok(labels(r).includes('Data after end of image'));
  assert.ok(!has(r.output, 'SECRET-EXTRA-IMAGE'));
  assert.equal(r.output[r.output.length - 2], 0xff);
  assert.equal(r.output[r.output.length - 1], 0xd9);
});

test('AI disclosure is preserved, everything else in XMP removed', async () => {
  const r = await M.scrub(dirtyJpeg({ ai: true }));
  assert.ok(has(r.output, 'trainedAlgorithmicMedia'));
  assert.ok(!has(r.output, 'Brooklyn') && !has(r.output, 'Jordan Avery'));
  assert.ok(r.kept.some((k) => /AI-generated/.test(k)));
});

test('PNG: text chunks, eXIf, tIME removed; CRCs valid; C2PA kept', async () => {
  const r = await M.scrub(dirtyPng());
  for (const l of ['Text: Author', 'Text: Software', 'GPS position', 'Last modified (tIME)']) assert.ok(labels(r).includes(l), l);
  for (const s of ['Jordan Avery', 'GIMP', 'SN-ABC123456', 'iPhone']) assert.ok(!has(r.output, s), s);
  assert.ok(has(r.output, 'caBX'));
  // every chunk CRC is valid
  const b = r.output; let p = 8;
  while (p < b.length) {
    const len = Buffer.from(b).readUInt32BE(p);
    const crc = Buffer.from(b).readUInt32BE(p + 8 + len);
    assert.equal(M.crc32(b.subarray(p + 4, p + 8 + len)), crc, latin(b.subarray(p + 4, p + 8)));
    p += 12 + len;
  }
  assert.deepEqual((await M.scrub(r.output)).findings, []);
});

test('PNG: AI prompt removed but AI-generated label kept', async () => {
  const r = await M.scrub(dirtyPng({ sd: true }));
  assert.ok(labels(r).includes('AI generation data (parameters)'));
  assert.ok(!has(r.output, '12 Elm St'));
  assert.ok(has(r.output, 'trainedAlgorithmicMedia'));
  assert.ok(r.kept.some((k) => /prompt removed, label kept/.test(k)));
});

test('WebP: EXIF/XMP removed, flags and RIFF size correct', async () => {
  const r = await M.scrub(dirtyWebp());
  assert.ok(labels(r).includes('GPS position'));
  assert.ok(!has(r.output, 'Jordan Avery') && !has(r.output, 'Brooklyn'));
  const b = Buffer.from(r.output);
  assert.equal(b.toString('latin1', 0, 4), 'RIFF');
  assert.equal(b.readUInt32LE(4), b.length - 8);
  const flags = b[20];
  assert.equal(flags & 0x08, 0x08, 'EXIF flag set because orientation is kept');
  assert.equal(flags & 0x04, 0x04, 'XMP flag set because AI disclosure is kept');
  assert.ok(has(r.output, 'VP8L'));
});

test('Word: properties, company, authors, custom props scrubbed; content intact', async () => {
  const r = await M.scrub(fx('sample.docx'));
  for (const l of ['Author', 'Last modified by', 'Company', 'Manager', 'Last printed', 'Revision number', 'Total editing time (min)', 'Custom properties', 'Comment / revision authors', 'ZIP comment']) assert.ok(labels(r).includes(l), l);
  const z = M.readZip(r.output);
  const files = Object.fromEntries(await Promise.all(z.entries.map(async (e) => [e.name, e.method === 8 ? zlib.inflateRawSync(e.data).toString() : Buffer.from(e.data).toString()])));
  const all = Object.values(files).join('\n');
  for (const s of ['Jordan Avery', 'Sam Rivera', 'Northwind', 'Alex Kim', 'Contoso', 'JA"', '2026-09-30']) assert.ok(!all.includes(s), `leaked ${s}`);
  assert.ok(files['word/document.xml'].includes('Budget review for next quarter.'));
  assert.ok(files['word/comments.xml'].includes('Check with legal first.'), 'comment text untouched');
  assert.ok(r.warnings.some((w) => /1 comment/.test(w)) && r.warnings.some((w) => /2 tracked changes/.test(w)));
  // CRCs match content
  for (const e of z.entries) {
    const raw = e.method === 8 ? zlib.inflateRawSync(e.data) : Buffer.from(e.data);
    assert.equal(M.crc32(raw), e.crc, e.name);
  }
});

test('Excel and PowerPoint: comment authors and people anonymised', async () => {
  const x = await M.scrub(fx('sample.xlsx'));
  const p = await M.scrub(fx('sample.pptx'));
  const text = async (r) => M.readZip(r.output).entries.map((e) => (e.method === 8 ? zlib.inflateRawSync(e.data) : Buffer.from(e.data)).toString()).join('\n');
  const xt = await text(x); const pt = await text(p);
  assert.ok(!xt.includes('Priya') && !xt.includes('priya@example.com'));
  assert.ok(!pt.includes('Lee Morgan') && !pt.includes('Northwind'));
  assert.ok(labels(x).includes('Comment / revision authors'));
  assert.ok(labels(p).includes('Company'));
});

test('unsupported types are reported, not mangled', async () => {
  const r = await M.scrub(enc.encode('%PDF-1.7\n...'), 'report.pdf');
  assert.equal(r.supported, false);
  assert.equal(r.output, null);
  assert.ok(/PDF is not supported yet/.test(r.warnings[0]));
});

test('clean files stay clean and valid', async () => {
  for (const n of ['base.png', 'base.webp']) {
    const r = await M.scrub(fx(n));
    assert.deepEqual(r.findings, [], n);
  }
  const j = await M.scrub(fx('base.jpg')); // sips adds its own EXIF + Photoshop block
  assert.ok(j.findings.length > 0);
  assert.deepEqual((await M.scrub(j.output)).findings, []);
});
