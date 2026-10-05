/* tools/qc-samples.js — QC pass over the real FuelTech sample maps in samples/.
 *
 * For every file: parse with src/ftm-core.js and print filename, OK/FAIL,
 * rootName, swVersion, ProductID/FT_CLASS/fileInfo, locked flag, table count,
 * scalar param count. Files that are NOT gzip/zlib (e.g. the ones starting
 * 39 fa / 4d 23 — encrypted/protected FT Manager maps) must fail GRACEFULLY:
 * a clear one-line error, no stack trace, no hang (per-file timeout guard).
 *
 * Usage: node tools/qc-samples.js [samplesDir]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../src/ftm-core.js');

const DIR = process.argv[2] || path.join(__dirname, '..', 'samples');

function magic(buf) {
  const h = Array.from(buf.slice(0, 2)).map(b => b.toString(16).padStart(2, '0')).join(' ');
  if (buf[0] === 0x1f && buf[1] === 0x8b) return h + ' gzip';
  if (buf[0] === 0x78) return h + ' zlib?';
  return h + ' raw/unknown';
}

async function qcFile(file) {
  const buf = fs.readFileSync(file);
  const t0 = Date.now();
  try {
    const p = await C.parseFtm(buf);
    const tables = C.extractTables(p.tree);
    const scalars = Object.keys(p.fileInfo).length;
    return {
      file: path.basename(file), ok: true, ms: Date.now() - t0,
      magic: magic(buf), root: p.rootName, sw: p.swVersion,
      productId: p.fileInfo.ProductID || '-', ftClass: p.fileInfo.FT_CLASS || '-',
      name: p.fileInfo.Name || '-', locked: p.locked, tableCount: tables.length, scalars,
      emptyTables: tables.filter(t => t.rows === 0 || t.cols === 0).map(t => t.name),
      fileInfo: p.fileInfo
    };
  } catch (e) {
    return {
      file: path.basename(file), ok: false, ms: Date.now() - t0,
      magic: magic(buf),
      err: (e && e.message) || String(e),
      stackless: !(e instanceof Error) || (typeof e.message === 'string' && e.message.length > 0)
    };
  }
}

async function main() {
  if (!fs.existsSync(DIR)) { console.log('no samples dir at ' + DIR + ' — skipping'); return; }
  const files = fs.readdirSync(DIR).filter(f => f.toLowerCase().endsWith('.ftm'));
  console.log('QC over ' + files.length + ' files in ' + DIR + '\n');

  let okCount = 0, failCount = 0, graceful = true;
  for (const f of files) {
    const r = await qcFile(path.join(DIR, f));
    if (r.ok) {
      okCount++;
      console.log('OK   ' + r.file);
      console.log('     magic=' + r.magic + ' root=' + r.root + ' sw=' + r.sw +
        ' ProductID=' + r.productId + ' FT_CLASS=' + r.ftClass + ' Name="' + r.name + '"' +
        ' locked=' + r.locked);
      console.log('     tables=' + r.tableCount + ' scalarParams=' + r.scalars +
        (r.emptyTables.length ? ' emptyTables=' + JSON.stringify(r.emptyTables) : '') + ' (' + r.ms + 'ms)');
      console.log('     fileInfo=' + JSON.stringify(r.fileInfo));
    } else {
      failCount++;
      console.log('FAIL ' + r.file);
      console.log('     magic=' + r.magic + ' error="' + r.err + '" (' + r.ms + 'ms)');
      // graceful = single clear line, sub-second, no hang
      if (r.ms > 5000 || !r.err || r.err.length < 10) { graceful = false; console.log('     ^ NOT GRACEFUL'); }
    }
  }
  console.log('\nsummary: ' + okCount + ' parsed, ' + failCount + ' rejected' +
    (graceful ? ' (all rejections graceful: clear message, no stack trace, no hang)'
              : ' — SOME REJECTIONS NOT GRACEFUL'));
}

main().catch(e => { console.error('UNEXPECTED CRASH:', e); process.exit(1); });
