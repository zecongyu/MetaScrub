/*
 * MetaScrub — remove personal metadata from photos and documents.
 * Pure byte-level processing, no dependencies, no network.
 * Works in the browser (window.MetaScrub) and in Node 18+.
 *
 * Supported: JPEG, PNG, WebP, DOCX, XLSX, PPTX.
 * Always kept: image orientation, colour profiles, C2PA content credentials,
 * and IPTC "AI-generated" disclosure (re-written as a minimal XMP packet).
 *
 * Copyright (c) 2026 zecongyu — MIT License
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MetaScrub = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ================================================================ bytes
  const enc = new TextEncoder();
  const dec = new TextDecoder('utf-8', { fatal: false });
  const latin1 = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
  const ascii = (b, o, n) => latin1(b.subarray(o, o + n));
  const concat = (parts) => {
    const len = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  const u16be = (b, o) => (b[o] << 8) | b[o + 1];
  const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const u16le = (b, o) => b[o] | (b[o + 1] << 8);
  const be32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const le32 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
  const le16 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255]);

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf, start = 0xffffffff) {
    let c = start;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ================================================================ findings
  /*
   * category: location | device | identity | time | software | content | ai | other
   * Each finding: { category, label, value }
   */
  const CATEGORY_LABEL = {
    location: 'Location', device: 'Device', identity: 'Identity', time: 'Timestamps',
    software: 'Software & history', content: 'Hidden content', other: 'Other metadata',
  };
  const trimValue = (v) => {
    const s = String(v == null ? '' : v).replace(/\u0000+$/g, '').replace(/\s+/g, ' ').trim();
    return s.length > 140 ? s.slice(0, 137) + '…' : s;
  };

  // ================================================================ EXIF / TIFF
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

  const EXIF_TAGS = {
    ifd0: {
      0x010e: ['other', 'Image description'], 0x010f: ['device', 'Camera make'], 0x0110: ['device', 'Camera model'],
      0x0131: ['software', 'Software'], 0x0132: ['time', 'Modified'], 0x013b: ['identity', 'Artist'],
      0x8298: ['identity', 'Copyright'], 0x9c9b: ['other', 'Title (Windows)'], 0x9c9c: ['other', 'Comment (Windows)'],
      0x9c9d: ['identity', 'Author (Windows)'], 0x9c9e: ['other', 'Keywords (Windows)'], 0x9c9f: ['other', 'Subject (Windows)'],
      0x0112: ['keep', 'Orientation'],
    },
    exif: {
      0x9003: ['time', 'Taken'], 0x9004: ['time', 'Digitised'], 0x9010: ['time', 'Time zone'], 0x9011: ['time', 'Time zone (original)'],
      0xa430: ['identity', 'Camera owner'], 0xa431: ['device', 'Body serial number'], 0xa433: ['device', 'Lens make'],
      0xa434: ['device', 'Lens model'], 0xa435: ['device', 'Lens serial number'], 0x927c: ['device', 'Maker notes'],
      0x9286: ['other', 'User comment'], 0xa420: ['device', 'Image unique ID'],
    },
    gps: {},
  };

  function parseTiff(b) {
    // b starts at the TIFF header ("II*\0" / "MM\0*")
    if (b.length < 8) return null;
    const le = b[0] === 0x49 && b[1] === 0x49;
    if (!le && !(b[0] === 0x4d && b[1] === 0x4d)) return null;
    const r16 = (o) => (le ? u16le(b, o) : u16be(b, o));
    const r32 = (o) => (le ? u32le(b, o) : u32be(b, o));
    const out = { ifd0: {}, exif: {}, gps: {}, thumbnail: false, orientation: null };
    const seen = new Set();

    function readValue(type, count, off) {
      const size = (TYPE_SIZE[type] || 1) * count;
      const at = size <= 4 ? off : r32(off);
      if (at + size > b.length) return null;
      if (type === 2) return ascii(b, at, count).replace(/\u0000.*$/s, '');
      if (type === 3) return count === 1 ? r16(at) : Array.from({ length: Math.min(count, 64) }, (_, i) => r16(at + i * 2));
      if (type === 4 || type === 9) return count === 1 ? r32(at) : Array.from({ length: Math.min(count, 64) }, (_, i) => r32(at + i * 4));
      if (type === 5 || type === 10) return Array.from({ length: Math.min(count, 16) }, (_, i) => { const d = r32(at + i * 8 + 4); return d ? r32(at + i * 8) / d : 0; });
      return b.subarray(at, at + Math.min(size, 4096)); // BYTE / UNDEFINED
    }

    function readIfd(off, into) {
      if (!off || off + 2 > b.length || seen.has(off)) return 0;
      seen.add(off);
      const n = r16(off);
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12;
        if (e + 12 > b.length) break;
        const tag = r16(e), type = r16(e + 2), count = r32(e + 4);
        if (tag === 0x8769) { readIfd(r32(e + 8), out.exif); continue; }
        if (tag === 0x8825) { readIfd(r32(e + 8), out.gps); continue; }
        into[tag] = readValue(type, count, e + 8);
      }
      const next = off + 2 + n * 12;
      return next + 4 <= b.length ? r32(next) : 0;
    }

    const ifd1 = readIfd(r32(4), out.ifd0);
    if (ifd1) { const t = {}; readIfd(ifd1, t); out.thumbnail = Object.keys(t).length > 0; }
    out.orientation = typeof out.ifd0[0x0112] === 'number' ? out.ifd0[0x0112] : null;
    return out;
  }

  const ucs2 = (v) => (v instanceof Uint8Array ? dec.decode(v).replace(/\u0000/g, '') : v);
  const fmtExif = (v) => {
    if (v instanceof Uint8Array) {
      const printable = latin1(v).replace(/[^\x20-\x7e]/g, '');
      return printable.length >= 4 ? printable : `${v.length} bytes`;
    }
    return Array.isArray(v) ? v.map((x) => (typeof x === 'number' ? +x.toFixed(4) : x)).join(', ') : v;
  };

  function exifFindings(t, findings) {
    if (!t) return;
    for (const [group, tags] of Object.entries(EXIF_TAGS)) {
      for (const [tag, [cat, label]] of Object.entries(tags)) {
        const v = t[group][tag];
        if (v == null || cat === 'keep') continue;
        const val = /Windows/.test(label) ? ucs2(v) : tag == 0x927c ? `${v.length} bytes (vendor-specific, may include serial numbers)` : fmtExif(v);
        if (trimValue(val)) findings.push({ category: cat, label, value: trimValue(val) });
      }
    }
    const g = t.gps;
    const dms = (a) => (Array.isArray(a) && a.length >= 3 ? a[0] + a[1] / 60 + a[2] / 3600 : null);
    const lat = dms(g[2]);
    const lon = dms(g[4]);
    if (lat != null && lon != null) {
      const la = (g[1] === 'S' ? -1 : 1) * lat;
      const lo = (g[3] === 'W' ? -1 : 1) * lon;
      findings.push({ category: 'location', label: 'GPS position', value: `${la.toFixed(5)}, ${lo.toFixed(5)}`, lat: la, lon: lo });
    }
    if (Array.isArray(g[6])) findings.push({ category: 'location', label: 'GPS altitude', value: `${g[6][0].toFixed(1)} m` });
    if (g[0x1d]) findings.push({ category: 'time', label: 'GPS date', value: trimValue(g[0x1d]) });
    const otherGps = Object.keys(g).filter((k) => ![0, 1, 2, 3, 4, 5, 6, 0x1d].includes(+k)).length;
    if (otherGps) findings.push({ category: 'location', label: 'Other GPS fields', value: `${otherGps} (direction, speed, timestamp…)` });
    if (t.thumbnail) findings.push({ category: 'content', label: 'Embedded thumbnail', value: 'may show the original, uncropped image' });
  }

  /** Minimal TIFF holding only the Orientation tag (little-endian). */
  function orientationTiff(o) {
    return new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, o & 255, 0, 0, 0, 0, 0, 0, 0]);
  }

  // ================================================================ XMP
  const AI_SOURCE_RE = /(?:Iptc4xmpExt:DigitalSourceType|DigitalSourceType)\s*(?:=\s*["']|>)\s*([^"'<\s]*(?:trainedAlgorithmicMedia|compositeWithTrainedAlgorithmicMedia|algorithmicMedia|compositeSynthetic)[^"'<\s]*)/i;

  /** Value of an XMP property written either as attribute (name="v") or element (<name>v</name>). */
  function xmpField(xml, name) {
    const m = xml.match(new RegExp(name + '(?:="([^"]*)"|>([\\s\\S]*?)</' + name + '>)'));
    if (!m) return null;
    return (m[1] != null ? m[1] : m[2]).replace(/<[^>]+>/g, ' ');
  }

  const XMP_FIELDS = [
    ['dc:creator', 'identity', 'Creator (XMP)'], ['dc:rights', 'identity', 'Rights (XMP)'],
    ['xmp:CreatorTool', 'software', 'Creator tool'],
    ['photoshop:City', 'location', 'City'], ['photoshop:State', 'location', 'State / region'],
    ['photoshop:Country', 'location', 'Country'], ['Iptc4xmpCore:Location', 'location', 'Location'],
    ['exif:GPSLatitude', 'location', 'GPS latitude (XMP)'], ['exif:GPSLongitude', 'location', 'GPS longitude (XMP)'],
    ['xmp:CreateDate', 'time', 'Created (XMP)'], ['xmp:ModifyDate', 'time', 'Modified (XMP)'],
    ['aux:SerialNumber', 'device', 'Serial number (XMP)'], ['xmpMM:DocumentID', 'other', 'Document ID'],
  ];

  function xmpFindingsSafe(xml, findings) {
    for (const [name, cat, label] of XMP_FIELDS) {
      const v = trimValue(xmpField(xml, name) || '');
      if (v) findings.push({ category: cat, label, value: v });
    }
    const hist = (xml.match(/stEvt:action/g) || []).length;
    if (hist) findings.push({ category: 'software', label: 'Edit history', value: `${hist} recorded editing step${hist > 1 ? 's' : ''}` });
  }

  function aiSourceType(xml) {
    const m = xml.match(AI_SOURCE_RE);
    return m ? m[1] : null;
  }

  /** Minimal XMP packet that only declares the IPTC digital source type. */
  function aiXmp(sourceType) {
    const st = /^https?:/.test(sourceType) ? sourceType : 'http://cv.iptc.org/newscodes/digitalsourcetype/' + sourceType.replace(/^.*\//, '');
    return '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" ' +
      `Iptc4xmpExt:DigitalSourceType="${st}"/></rdf:RDF></x:xmpmeta><?xpacket end="r"?>`;
  }

  // ================================================================ JPEG
  const XMP_SIG = 'http://ns.adobe.com/xap/1.0/\u0000';
  const XMP_EXT_SIG = 'http://ns.adobe.com/xmp/extension/\u0000';

  function scrubJpeg(b) {
    const findings = [];
    const kept = [];
    const out = [b.subarray(0, 2)];
    let p = 2;
    let orientation = null;
    let ai = null;
    let trailing = 0;
    let jfif = null;

    const keep = (seg) => out.push(seg);
    while (p + 2 <= b.length) {
      if (b[p] !== 0xff) break; // corrupt
      const m = b[p + 1];
      if (m === 0xff) { p++; continue; }
      if (m === 0xd9) { out.push(b.subarray(p, p + 2)); p += 2; break; }
      if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { out.push(b.subarray(p, p + 2)); p += 2; continue; }
      if (p + 4 > b.length) break;
      const len = u16be(b, p + 2);
      const seg = b.subarray(p, p + 2 + len);
      const body = b.subarray(p + 4, p + 2 + len);

      if (m === 0xda) {
        // Start of scan: copy header + entropy-coded data up to the next real marker
        let q = p + 2 + len;
        while (q < b.length) {
          if (b[q] === 0xff && q + 1 < b.length && b[q + 1] !== 0 && !(b[q + 1] >= 0xd0 && b[q + 1] <= 0xd7)) break;
          q++;
        }
        out.push(b.subarray(p, q));
        p = q;
        continue;
      }

      if (m === 0xe1 && ascii(body, 0, 6) === 'Exif\u0000\u0000') {
        const t = parseTiff(body.subarray(6));
        exifFindings(t, findings);
        if (t && t.orientation && t.orientation !== 1) orientation = t.orientation;
      } else if (m === 0xe1 && ascii(body, 0, XMP_SIG.length) === XMP_SIG) {
        const xml = dec.decode(body.subarray(XMP_SIG.length));
        xmpFindingsSafe(xml, findings);
        ai = ai || aiSourceType(xml);
      } else if (m === 0xe1 && ascii(body, 0, XMP_EXT_SIG.length) === XMP_EXT_SIG) {
        findings.push({ category: 'other', label: 'Extended XMP', value: `${body.length} bytes` });
      } else if (m === 0xed) {
        findings.push({ category: 'identity', label: 'Photoshop / IPTC block', value: 'by-line, location, keywords, captions' });
      } else if (m === 0xfe) {
        const c = trimValue(latin1(body).replace(/[^\x20-\x7e]/g, ''));
        findings.push({ category: 'other', label: 'JPEG comment', value: c || `${body.length} bytes` });
      } else if (m === 0xe0 && !jfif && ascii(body, 0, 5) === 'JFIF\u0000') {
        jfif = seg; // always re-emitted directly after SOI
      } else if (m === 0xe0 || m === 0xee || (m === 0xe2 && ascii(body, 0, 12) === 'ICC_PROFILE\u0000') || m === 0xeb) {
        if (m === 0xe2) kept.push('Colour profile (ICC)');
        if (m === 0xeb) kept.push('C2PA content credentials (JUMBF)');
        keep(seg);
      } else if (m >= 0xe0 && m <= 0xef) {
        const sig = latin1(body.subarray(0, 16)).replace(/[^\x20-\x7e].*$/s, '');
        findings.push({ category: 'other', label: `APP${m - 0xe0} segment`, value: sig || `${body.length} bytes` });
      } else {
        keep(seg); // DQT, SOF, DHT, DRI, DNL, etc.
      }
      p += 2 + len;
    }
    if (p < b.length) {
      trailing = b.length - p;
      findings.push({ category: 'content', label: 'Data after end of image', value: `${trailing} bytes (extra images, depth or gain maps)` });
    }

    // re-insert what must stay, right after SOI / APP0
    const inserts = [];
    if (orientation) {
      const tiff = orientationTiff(orientation);
      const body = concat([enc.encode('Exif\u0000\u0000'), tiff]);
      inserts.push(concat([new Uint8Array([0xff, 0xe1]), new Uint8Array([(body.length + 2) >> 8, (body.length + 2) & 255]), body]));
      kept.push(`Orientation (${orientation})`);
    }
    if (ai) {
      const body = concat([enc.encode(XMP_SIG), enc.encode(aiXmp(ai))]);
      inserts.push(concat([new Uint8Array([0xff, 0xe1]), new Uint8Array([(body.length + 2) >> 8, (body.length + 2) & 255]), body]));
      kept.push('AI-generated disclosure (IPTC DigitalSourceType)');
    }
    out.splice(1, 0, ...(jfif ? [jfif] : []), ...inserts);
    return { output: concat(out), findings, kept };
  }

  // ================================================================ PNG
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'acTL', 'fcTL', 'fdAT', 'cICP', 'mDCv', 'cLLi', 'caBX']);
  const AI_TEXT_KEYS = /^(parameters|prompt|workflow|negative_prompt|sd-metadata|invokeai_metadata|dream|comment)$/i;

  function pngChunk(type, data) {
    const t = enc.encode(type);
    const crc = crc32(concat([t, data]));
    return concat([be32(data.length), t, data, be32(crc)]);
  }

  function scrubPng(b) {
    const findings = [];
    const kept = [];
    const out = [b.subarray(0, 8)];
    let p = 8;
    let orientation = null;
    let ai = null;
    let aiParams = false;
    let afterIhdr = 0;
    while (p + 12 <= b.length) {
      const len = u32be(b, p);
      const type = ascii(b, p + 4, 4);
      const data = b.subarray(p + 8, p + 8 + len);
      const whole = b.subarray(p, p + 12 + len);
      if (PNG_KEEP.has(type)) {
        out.push(whole);
        if (type === 'IHDR') afterIhdr = out.length;
        if (type === 'iCCP') kept.push('Colour profile (ICC)');
        if (type === 'caBX') kept.push('C2PA content credentials');
      } else if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
        const z = data.indexOf(0);
        const key = latin1(data.subarray(0, z));
        let text = '';
        if (type === 'tEXt') text = latin1(data.subarray(z + 1));
        else if (type === 'iTXt' && data[z + 1] === 0) {
          // uncompressed iTXt: key\0 flag method lang\0 transKey\0 text
          let q = z + 3;
          q = data.indexOf(0, q) + 1;
          q = data.indexOf(0, q) + 1;
          text = dec.decode(data.subarray(q));
        }
        if (key === 'XML:com.adobe.xmp') {
          xmpFindingsSafe(text, findings);
          ai = ai || aiSourceType(text);
        } else if (AI_TEXT_KEYS.test(key) && key.toLowerCase() !== 'comment') {
          aiParams = true;
          findings.push({ category: 'content', label: `AI generation data (${key})`, value: trimValue(text) || 'compressed' });
        } else {
          const cat = /author|artist|copyright|owner|creator/i.test(key) ? 'identity' : /software|source/i.test(key) ? 'software' : /time|date/i.test(key) ? 'time' : /gps|location/i.test(key) ? 'location' : 'other';
          findings.push({ category: cat, label: `Text: ${key}`, value: trimValue(text) || (type === 'zTXt' ? 'compressed text' : '') });
        }
      } else if (type === 'eXIf') {
        const t = parseTiff(data);
        exifFindings(t, findings);
        if (t && t.orientation && t.orientation !== 1) orientation = t.orientation;
      } else if (type === 'tIME') {
        findings.push({ category: 'time', label: 'Last modified (tIME)', value: `${u16be(data, 0)}-${String(data[2]).padStart(2, '0')}-${String(data[3]).padStart(2, '0')}` });
      } else {
        findings.push({ category: 'other', label: `Chunk ${type}`, value: `${len} bytes` });
      }
      p += 12 + len;
      if (type === 'IEND') break;
    }
    if (p < b.length) findings.push({ category: 'content', label: 'Data after end of image', value: `${b.length - p} bytes` });

    const inserts = [];
    if (orientation) { inserts.push(pngChunk('eXIf', orientationTiff(orientation))); kept.push(`Orientation (${orientation})`); }
    if (!ai && aiParams) ai = 'trainedAlgorithmicMedia';
    if (ai) {
      const xmp = enc.encode(aiXmp(ai));
      inserts.push(pngChunk('iTXt', concat([enc.encode('XML:com.adobe.xmp'), new Uint8Array([0, 0, 0, 0, 0]), xmp])));
      kept.push(aiParams && !/Iptc/.test(ai) ? 'AI-generated disclosure (prompt removed, label kept)' : 'AI-generated disclosure (IPTC DigitalSourceType)');
    }
    out.splice(afterIhdr || 2, 0, ...inserts);
    return { output: concat(out), findings, kept: [...new Set(kept)] };
  }

  // ================================================================ WebP
  function scrubWebp(b) {
    const findings = [];
    const kept = [];
    const chunks = [];
    let p = 12;
    let orientation = null;
    let ai = null;
    while (p + 8 <= b.length) {
      const type = ascii(b, p, 4);
      const len = u32le(b, p + 4);
      const data = b.subarray(p + 8, p + 8 + len);
      if (type === 'EXIF') {
        const body = ascii(data, 0, 6) === 'Exif\u0000\u0000' ? data.subarray(6) : data;
        const t = parseTiff(body);
        exifFindings(t, findings);
        if (t && t.orientation && t.orientation !== 1) orientation = t.orientation;
      } else if (type === 'XMP ') {
        const xml = dec.decode(data);
        xmpFindingsSafe(xml, findings);
        ai = ai || aiSourceType(xml);
      } else if (['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP', 'C2PA'].includes(type)) {
        chunks.push({ type, data: new Uint8Array(data) });
        if (type === 'ICCP') kept.push('Colour profile (ICC)');
        if (type === 'C2PA') kept.push('C2PA content credentials');
      } else {
        findings.push({ category: 'other', label: `Chunk ${type.trim()}`, value: `${len} bytes` });
      }
      p += 8 + len + (len & 1);
    }
    if (orientation) { chunks.push({ type: 'EXIF', data: orientationTiff(orientation) }); kept.push(`Orientation (${orientation})`); }
    if (ai) { chunks.push({ type: 'XMP ', data: enc.encode(aiXmp(ai)) }); kept.push('AI-generated disclosure (IPTC DigitalSourceType)'); }
    // VP8X flags must match the chunks that remain
    const vp8x = chunks.find((c) => c.type === 'VP8X');
    if (vp8x) {
      let f = vp8x.data[0] & ~0x0c;
      if (chunks.some((c) => c.type === 'EXIF')) f |= 0x08;
      if (chunks.some((c) => c.type === 'XMP ')) f |= 0x04;
      vp8x.data[0] = f;
      // spec order: VP8X, ICCP, ANIM, image data…, EXIF, XMP
    }
    const order = (t) => ({ VP8X: 0, ICCP: 1, ANIM: 2, EXIF: 8, 'XMP ': 9 }[t] ?? 5);
    chunks.sort((a, c) => order(a.type) - order(c.type));
    const parts = [];
    for (const c of chunks) {
      parts.push(enc.encode(c.type), le32(c.data.length), c.data);
      if (c.data.length & 1) parts.push(new Uint8Array([0]));
    }
    const body = concat(parts);
    return { output: concat([enc.encode('RIFF'), le32(body.length + 4), enc.encode('WEBP'), body]), findings, kept };
  }

  // ================================================================ ZIP (Office)
  async function inflateRaw(data) {
    const ds = new DecompressionStream('deflate-raw');
    const buf = await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(buf);
  }
  async function deflateRaw(data) {
    const cs = new CompressionStream('deflate-raw');
    const buf = await new Response(new Blob([data]).stream().pipeThrough(cs)).arrayBuffer();
    return new Uint8Array(buf);
  }

  function readZip(b) {
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (u32le(b, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('Not a valid ZIP archive');
    const count = u16le(b, eocd + 10);
    let cd = u32le(b, eocd + 16);
    const entries = [];
    for (let i = 0; i < count; i++) {
      if (u32le(b, cd) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
      const method = u16le(b, cd + 10);
      const crc = u32le(b, cd + 16);
      const csize = u32le(b, cd + 20);
      const usize = u32le(b, cd + 24);
      const nlen = u16le(b, cd + 28), xlen = u16le(b, cd + 30), clen = u16le(b, cd + 32);
      const local = u32le(b, cd + 42);
      const name = dec.decode(b.subarray(cd + 46, cd + 46 + nlen));
      const lnlen = u16le(b, local + 26), lxlen = u16le(b, local + 28);
      const start = local + 30 + lnlen + lxlen;
      entries.push({ name, method, crc, csize, usize, data: b.subarray(start, start + csize) });
      cd += 46 + nlen + xlen + clen;
    }
    return { entries, commentLength: u16le(b, eocd + 20) };
  }

  function writeZip(files) {
    // files: [{ name, method, crc, csize, usize, data }] — data already compressed per method
    const locals = [];
    const central = [];
    let offset = 0;
    const DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01 00:00
    for (const f of files) {
      const name = enc.encode(f.name);
      const head = concat([le32(0x04034b50), le16(20), le16(0x0800), le16(f.method), le16(DOS_TIME), le16(DOS_DATE),
        le32(f.crc), le32(f.csize), le32(f.usize), le16(name.length), le16(0), name]);
      locals.push(head, f.data);
      central.push(concat([le32(0x02014b50), le16(20), le16(20), le16(0x0800), le16(f.method), le16(DOS_TIME), le16(DOS_DATE),
        le32(f.crc), le32(f.csize), le32(f.usize), le16(name.length), le16(0), le16(0), le16(0), le16(0), le32(0), le32(offset), name]));
      offset += head.length + f.data.length;
    }
    const cd = concat(central);
    const end = concat([le32(0x06054b50), le16(0), le16(0), le16(files.length), le16(files.length), le32(cd.length), le32(offset), le16(0)]);
    return concat([...locals, cd, end]);
  }

  // ---- Office XML scrubbing
  const xmlText = (xml, tag) => { const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`)); return m ? m[1] : null; };
  const blankElement = (xml, tag) => xml.replace(new RegExp(`(<${tag}(?:\\s[^>]*)?>)[^<]*(</${tag}>)`, 'g'), '$1$2');
  const dropElement = (xml, tag) => xml.replace(new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>[^<]*</${tag}>)`, 'g'), '');
  const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

  const CORE_FIELDS = [
    ['dc:creator', 'identity', 'Author'], ['cp:lastModifiedBy', 'identity', 'Last modified by'],
    ['dcterms:created', 'time', 'Created'], ['dcterms:modified', 'time', 'Modified'], ['cp:lastPrinted', 'time', 'Last printed'],
    ['cp:revision', 'software', 'Revision number'], ['dc:title', 'other', 'Title'], ['dc:subject', 'other', 'Subject'],
    ['cp:keywords', 'other', 'Keywords'], ['dc:description', 'other', 'Comments / description'], ['cp:category', 'other', 'Category'],
    ['cp:contentStatus', 'other', 'Status'],
  ];
  const APP_FIELDS = [
    ['Company', 'identity', 'Company'], ['Manager', 'identity', 'Manager'], ['Template', 'software', 'Template'],
    ['TotalTime', 'software', 'Total editing time (min)'], ['HyperlinkBase', 'other', 'Hyperlink base'],
    ['Application', 'software', 'Application'], ['AppVersion', 'software', 'Application version'],
  ];

  function scrubOfficeXml(name, xml, findings, counters, authors) {
    let x = xml;
    if (name === 'docProps/core.xml') {
      for (const [tag, cat, label] of CORE_FIELDS) {
        const v = xmlText(x, tag);
        if (v && v.trim()) findings.push({ category: cat, label, value: trimValue(unescapeXml(v)) });
      }
      for (const [tag] of CORE_FIELDS) x = /^(cp:lastPrinted|cp:revision|dcterms:created|dcterms:modified)$/.test(tag) ? dropElement(x, tag) : blankElement(x, tag);
      return x;
    }
    if (name === 'docProps/app.xml') {
      for (const [tag, cat, label] of APP_FIELDS) {
        const v = xmlText(x, tag);
        if (v && v.trim()) findings.push({ category: cat, label, value: trimValue(unescapeXml(v)) });
      }
      for (const [tag] of APP_FIELDS) x = blankElement(x, tag);
      return x;
    }
    if (name === 'docProps/custom.xml') {
      const names = [...x.matchAll(/<property\b[^>]*\bname="([^"]*)"/g)].map((m) => m[1]);
      if (names.length) findings.push({ category: 'other', label: 'Custom properties', value: trimValue(names.join(', ')) });
      return x.replace(/<property\b[\s\S]*?<\/property>/g, '');
    }
    // authors on comments, tracked changes, people lists
    const anon = (attr) => {
      x = x.replace(new RegExp(`(\\s${attr}=")([^"]*)(")`, 'g'), (m, a, v, c) => {
        if (v && v !== 'Author' && v !== 'A') authors.add(unescapeXml(v));
        return a + (attr.endsWith('initials') ? 'A' : 'Author') + c;
      });
    };
    if (/^word\//.test(name)) {
      counters.comments += (x.match(/<w:comment\b/g) || []).length;
      counters.changes += (x.match(/<w:(?:ins|del)\b/g) || []).length;
      ['w:author', 'w:initials', 'w15:author', 'w15:userId', 'w15:providerId'].forEach(anon);
    } else if (/^ppt\//.test(name)) {
      if (/commentAuthors\.xml$|authors\.xml$/.test(name)) ['name', 'initials', 'userId', 'providerId'].forEach(anon);
      counters.comments += (x.match(/<p:cm\b|<p188:cm\b/g) || []).length;
    } else if (/^xl\//.test(name)) {
      if (/comments\d*\.xml$/.test(name)) {
        counters.comments += (x.match(/<comment\b/g) || []).length;
        x = x.replace(/<author>([^<]*)<\/author>/g, (m, v) => { if (v) authors.add(unescapeXml(v)); return '<author>Author</author>'; });
      }
      if (/persons\/person\.xml$/.test(name)) ['displayName', 'userId', 'providerId'].forEach(anon);
      if (/threadedComments/.test(name)) counters.comments += (x.match(/<threadedComment\b/g) || []).length;
    }
    return x;
  }

  async function scrubOffice(b, kind) {
    const findings = [];
    const kept = [];
    const warnings = [];
    const { entries, commentLength } = readZip(b);
    const counters = { comments: 0, changes: 0 };
    const authors = new Set();
    const files = [];
    for (const e of entries) {
      const isXml = /\.(xml|rels)$/i.test(e.name) && (/^(docProps|word|ppt|xl)\//.test(e.name));
      if (!isXml) {
        files.push(e);
        continue;
      }
      const raw = e.method === 8 ? await inflateRaw(e.data) : e.method === 0 ? e.data : null;
      if (!raw) { files.push(e); continue; }
      const xml = dec.decode(raw);
      const out = scrubOfficeXml(e.name, xml, findings, counters, authors);
      if (out === xml) { files.push(e); continue; }
      const bytes = enc.encode(out);
      const data = await deflateRaw(bytes);
      files.push({ name: e.name, method: 8, crc: crc32(bytes), csize: data.length, usize: bytes.length, data });
    }
    if (authors.size) findings.push({ category: 'identity', label: 'Comment / revision authors', value: trimValue([...authors].join(', ')) });
    if (commentLength) findings.push({ category: 'other', label: 'ZIP comment', value: `${commentLength} bytes` });
    findings.push({ category: 'time', label: 'File timestamps inside the archive', value: 'reset to 1980-01-01' });
    if (counters.comments) warnings.push(`${counters.comments} comment${counters.comments > 1 ? 's' : ''} remain in the document (authors anonymised). Delete them in ${kind === 'docx' ? 'Word' : kind === 'xlsx' ? 'Excel' : 'PowerPoint'} if the text is sensitive.`);
    if (counters.changes) warnings.push(`${counters.changes} tracked change${counters.changes > 1 ? 's' : ''} remain (authors anonymised). Accept or reject all changes before sharing.`);
    kept.push('Document content, formatting and embedded images');
    return { output: writeZip(files), findings, kept, warnings };
  }

  // ================================================================ public API
  function detect(b, name) {
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
    if (PNG_SIG.every((v, i) => b[i] === v)) return 'png';
    if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
    if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4) {
      try {
        const names = readZip(b).entries.map((e) => e.name);
        if (names.some((n) => n.startsWith('word/'))) return 'docx';
        if (names.some((n) => n.startsWith('xl/'))) return 'xlsx';
        if (names.some((n) => n.startsWith('ppt/'))) return 'pptx';
      } catch (_) { /* fallthrough */ }
      return 'zip';
    }
    if (ascii(b, 0, 5) === '%PDF-') return 'pdf';
    const ext = (name || '').split('.').pop().toLowerCase();
    if (/^(heic|heif|avif|tif|tiff|gif|mp4|mov)$/.test(ext)) return ext;
    return 'unknown';
  }

  const TYPE_LABEL = { jpeg: 'JPEG image', png: 'PNG image', webp: 'WebP image', docx: 'Word document', xlsx: 'Excel workbook', pptx: 'PowerPoint deck' };
  const MIME = {
    jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };

  /**
   * Scrub one file.
   * @param {Uint8Array|ArrayBuffer} input
   * @param {string} [name]
   * @returns {Promise<{type, typeLabel, supported, output, findings, kept, warnings, before, after, mime, summary}>}
   */
  async function scrub(input, name) {
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    const type = detect(b, name);
    let r;
    if (type === 'jpeg') r = scrubJpeg(b);
    else if (type === 'png') r = scrubPng(b);
    else if (type === 'webp') r = scrubWebp(b);
    else if (type === 'docx' || type === 'xlsx' || type === 'pptx') r = await scrubOffice(b, type);
    else {
      return { type, typeLabel: type.toUpperCase(), supported: false, output: null, findings: [], kept: [], warnings: [
        type === 'pdf' ? 'PDF is not supported yet: its metadata often lives in compressed object streams. Use "Print to PDF" or your PDF editor\'s "Remove hidden information".' :
        `This file type (${type}) is not supported yet.`], before: b.length, after: null };
    }
    const summary = {};
    for (const f of r.findings) summary[f.category] = (summary[f.category] || 0) + 1;
    return Object.assign({ type, typeLabel: TYPE_LABEL[type], supported: true, warnings: [], before: b.length, after: r.output.length, mime: MIME[type], summary }, r);
  }

  /** Read-only: what would be removed. */
  async function inspect(input, name) {
    const r = await scrub(input, name);
    return { type: r.type, typeLabel: r.typeLabel, supported: r.supported, findings: r.findings, kept: r.kept, warnings: r.warnings, summary: r.summary };
  }

  return { scrub, inspect, detect, parseTiff, crc32, readZip, writeZip, CATEGORY_LABEL, _internal: { orientationTiff, aiXmp, pngChunk } };
});
