/* tools/qc-diffs.js — diff sanity QC over real sample pairs.
 *
 *  (c) self-diff of every sample must report ZERO changes (critical invariant)
 *  (a) BMW M3 1999_USA (FT550LITE, ProductID 551) vs M3_S54_final (FT550, 550)
 *  (b) LS2_turbo vs LS3_VVT (both FT5_CLASS / ProductID 500, different SW ver)
 *  - hand-checks a handful of reported cell deltas against the raw inflated
 *    XML (independent scanner in tools/qc-groundtruth.js): base - comp
 *  - verifies dim-mismatch handling fires where table sizes differ
 *
 * Usage: node tools/qc-diffs.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../src/ftm-core.js');
const GT = require('./qc-groundtruth.js');

const DIR = path.join(__dirname, '..', 'samples');

function parse(name) {
  return C.parseFtm(fs.readFileSync(path.join(DIR, name)));
}

/** Independent dense matrix of a table from the RAW XML (no ftm-core parser). */
function rawMatrices(name) {
  const { root } = GT.scan(GT.inflate(fs.readFileSync(path.join(DIR, name))));
  const map = new Map();
  (function w(el, p) {
    if (GT.isTable(el)) {
      const col = el.children.find(c => c.name === 'Colunas');
      const lin = el.children.find(c => c.name === 'Linhas');
      const tab = el.children.find(c => c.name === 'Tabela');
      const xs = (col ? col.children : []).map(c => parseFloat(c.text));
      const ys = (lin ? lin.children : []).map(c => parseFloat(c.text));
      const items = tab ? tab.children.filter(c => c.name === 'Item') : [];
      const m = items.map(it => {
        const dict = it.children.find(c => c.name === 'Value');
        const sd = dict ? dict.children.find(c => c.name === 'SerializableDictionaryOfDoubleDouble') : null;
        const cells = sd ? sd.children.filter(c => c.name === 'Item') : [];
        const row = new Array(Math.max(xs.length, cells.length)).fill(NaN);
        cells.forEach((cell, idx) => {
          const kEl = cell.children.find(c => c.name === 'Key');
          const vEl = cell.children.find(c => c.name === 'Value');
          const k = parseFloat((kEl.children[0] || {}).text), v = parseFloat((vEl.children[0] || {}).text);
          let c2 = xs.findIndex(x => Math.abs(x - k) < 1e-9);
          if (c2 < 0) c2 = idx;
          if (c2 < row.length) row[c2] = v;
        });
        return row;
      });
      map.set(p.slice(2).concat(el.name).join('/'), { rows: m.length, cols: Math.max(xs.length, ...m.map(r => r.length), 0), matrix: m, yAxes: ys, xAxes: xs }); // p[0]='#document', p[1]='Adjust'
    }
    el.children.forEach(c => w(c, p.concat(el.name)));
  })(root, []);
  // (paths keyed below the <Adjust> root, matching the lib's path space)
  return map;
}

function tablesByPath(tree) {
  const m = new Map();
  C.extractTables(tree).forEach(t => m.set(t.path.join('/'), t));
  return m;
}

function countStatuses(diff) {
  const acc = { changed: 0, 'missing-left': 0, 'missing-right': 0, equal: 0 };
  (function w(d) {
    if (!d) return;
    if (d.status === 'nested') { Object.values(d.children).forEach(w); return; }
    acc[d.status] = (acc[d.status] || 0) + 1;
    if (d.anyDiff && d.status !== 'equal') acc.changed += 0; // counted per status
  })(diff);
  return acc;
}

async function selfDiff(name) {
  const p = await parse(name);
  const d = C.diffTrees(p.tree, p.tree);
  const n = C.countChanges(d);
  const tables = C.extractTables(p.tree);
  let cellDiffs = 0, dimMismatch = 0;
  tables.forEach(t => {
    const dt = C.diffTable(t, t);
    if (!dt.sameSize) dimMismatch++;
    else cellDiffs += dt.changedCells;
  });
  console.log('self-diff ' + name + ': countChanges=' + n + ' tableCellDiffs=' + cellDiffs +
    ' dimMismatch=' + dimMismatch + ' -> ' + (n === 0 && cellDiffs === 0 && dimMismatch === 0 ? 'PASS' : 'FAIL'));
  return n === 0 && cellDiffs === 0 && dimMismatch === 0;
}

async function pairDiff(nameA, nameB, handChecks) {
  const [a, b] = [await parse(nameA), await parse(nameB)];
  const d = C.diffTrees(a.tree, b.tree);
  const total = C.countChanges(d);
  const st = countStatuses(d);
  const ta = tablesByPath(a.tree), tb = tablesByPath(b.tree);
  let common = 0, dimMismatch = 0, changedTables = 0, totalCellDiffs = 0;
  const dimMismatchNames = [];
  for (const [p, tA] of ta) {
    const tB = tb.get(p);
    if (!tB) continue;
    common++;
    const dt = C.diffTable(tA, tB);
    if (!dt.sameSize) { dimMismatch++; if (dimMismatchNames.length < 5) dimMismatchNames.push(p + ' ' + JSON.stringify(dt.baseSize) + ' vs ' + JSON.stringify(dt.compSize)); continue; }
    if (dt.changedCells) { changedTables++; totalCellDiffs += dt.changedCells; }
  }
  console.log('\npair ' + nameA + ' vs ' + nameB);
  console.log('  tree: totalChanges=' + total + ' changed=' + st.changed +
    ' missing-left=' + st['missing-left'] + ' missing-right=' + st['missing-right'] + ' equal=' + st.equal);
  console.log('  tables: base=' + ta.size + ' comp=' + tb.size + ' commonPath=' + common +
    ' changedTables=' + changedTables + ' cellDiffs=' + totalCellDiffs +
    ' dimMismatch=' + dimMismatch);
  if (dimMismatchNames.length) console.log('  dimMismatch examples: ' + dimMismatchNames.join(' | '));

  // hand-check reported cell deltas against the raw XML (independent parse)
  const rawA = rawMatrices(nameA), rawB = rawMatrices(nameB);
  let checked = 0, mismatches = 0;
  outer:
  for (const [p, tA] of ta) {
    const tB = tb.get(p);
    if (!tB) continue;
    const dt = C.diffTable(tA, tB);
    if (!dt.sameSize) continue;
    let perTable = 0;
    for (let r = 0; r < tA.rows && checked < handChecks && perTable < 3; r++) {
      for (let c = 0; c < tA.cols && checked < handChecks && perTable < 3; c++) {
        if (dt.deltaMatrix[r][c] === 0) continue;
        perTable++;
        const rA = rawA.get(p), rB = rawB.get(p);
        if (!rA || !rB) { mismatches++; console.log('  HANDCHECK missing in raw scan: ' + p); continue; }
        const x = rA.matrix[r][c], y = rB.matrix[r][c];
        const expect = x - y;
        const got = dt.deltaMatrix[r][c];
        const ok = (Number.isNaN(expect) && Number.isNaN(got)) || Math.abs(expect - got) < 1e-9;
        // also verify the lib's own base/comp matrices agree with raw XML
        const okBase = Math.abs(tA.matrix[r][c] - x) < 1e-9 || (Number.isNaN(tA.matrix[r][c]) && Number.isNaN(x));
        const okComp = Math.abs(tB.matrix[r][c] - y) < 1e-9 || (Number.isNaN(tB.matrix[r][c]) && Number.isNaN(y));
        checked++;
        if (!ok || !okBase || !okComp) {
          mismatches++;
          console.log('  HANDCHECK MISMATCH ' + p + ' [' + r + '][' + c + '] rawBase=' + x + ' rawComp=' + y +
            ' expect=' + expect + ' got=' + got + ' libBase=' + tA.matrix[r][c] + ' libComp=' + tB.matrix[r][c]);
        } else if (checked <= 5) {
          console.log('  handcheck ok: ' + p + ' [' + r + '][' + c + '] ' + x + ' - ' + y + ' = ' + got);
        }
        if (checked >= handChecks) break outer;
      }
    }
  }
  console.log('  hand-checked ' + checked + ' changed cells vs raw XML: ' + (mismatches ? mismatches + ' MISMATCHES' : 'all match'));
  return { total, dimMismatch, checked, mismatches };
}

async function main() {
  if (!fs.existsSync(DIR)) { console.log('no samples dir — skipping'); return; }
  let pass = true;
  for (const f of fs.readdirSync(DIR)) {
    const buf = fs.readFileSync(path.join(DIR, f));
    if (buf[0] !== 0x1f && buf[0] !== 0x78) continue; // skip encrypted samples
    if (!(await selfDiff(f))) pass = false;
  }

  const a = pairDiff('ft550_line_example_BMW_M3_1999_USA.ftm', 'ft550_line_example_BMW_M3_S54_final.ftm', 12);
  const b = pairDiff('ft550_line_example_LS2_turbo.ftm', 'ft550_line_example_LS3_VVT.ftm', 12);

  // dim-mismatch handling must have fired somewhere in pair (b) (261 vs 370 tables, old vs new SW)
  Promise.all([a, b]).then(r => {
    console.log('\npair dim-mismatch handling: BMW pair fired=' + r[0].dimMismatch + ', LS pair fired=' + r[1].dimMismatch);
    console.log('self-diff invariant: ' + (pass ? 'PASS for all files' : 'FAIL'));
    console.log('handcheck mismatches: ' + (r[0].mismatches + r[1].mismatches));
  });
}

main().catch(e => { console.error('CRASH', e); process.exit(1); });
