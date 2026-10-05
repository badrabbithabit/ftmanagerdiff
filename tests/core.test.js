/* tests/core.test.js — plain node test runner: node tests/core.test.js */
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const C = require('../src/ftm-core.js');

const FIX = path.join(__dirname, '..', 'fixtures');
const read = f => fs.readFileSync(path.join(FIX, f));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); }
}

function xmlOf(name, body) {
  return '<?xml version="1.0" encoding="utf-8"?>\n<Adjust>\n' + body + '</Adjust>\n';
}

async function main() {
  await t('inflate: zlib fixture (tuneA) and gzip fixture (tuneB)', async () => {
    const a = await C.parseFtm(read('tuneA.ftm'));
    const b = await C.parseFtm(read('tuneB.ftm'));
    assert.strictEqual(a.rootName, 'Adjust');
    assert.strictEqual(b.rootName, 'Adjust');
    assert.strictEqual(a.swVersion, '3.5.1');
    assert.strictEqual(b.swVersion, '3.5.2');
    assert.ok(a.tree.Lambda_1, 'zlib payload parsed');
    assert.ok(b.tree.VVT_Advance, 'gzip payload parsed');
  });

  await t('inflate: raw deflate fallback + explicit backend override', async () => {
    const xml = xmlOf('Adjust', '  <SW_Version>1.0</SW_Version>\n');
    const raw = zlib.deflateRawSync(Buffer.from(xml, 'utf8'));
    assert.ok(raw[0] !== 0x78 && raw[0] !== 0x1f);
    const p = await C.parseFtm(raw);
    assert.strictEqual(p.swVersion, '1.0');

    C.setInflateBackend((bytes, kind) => {
      assert.strictEqual(kind, 'zlib');
      return zlib.inflateSync(Buffer.from(bytes)); // returns Uint8Array
    });
    const p2 = await C.parseFtm(zlib.deflateSync(Buffer.from(xml, 'utf8')));
    C.setInflateBackend(null);
    assert.strictEqual(p2.swVersion, '1.0');
  });

  await t('inflate: corrupt payload rejects with error', async () => {
    await assert.rejects(() => C.parseFtm(Buffer.from('not compressed at all')));
    const bad = zlib.deflateSync(Buffer.from('<Adjust/>', 'utf8'));
    bad[bad.length - 1] ^= 0xff; // break the Adler-32 trailer
    await assert.rejects(() => C.parseFtm(bad));
  });

  await t('browser environment: no require/module -> DecompressionStream path', async () => {
    const vm = require('node:vm');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ftm-core.js'), 'utf8');
    const sandbox = { Blob, Response, DecompressionStream, TextDecoder, console };
    vm.createContext(sandbox); // no require, no module -> UMD attaches to globalThis
    vm.runInContext(src, sandbox);
    const X = sandbox.FtmCore;
    assert.ok(X, 'FtmCore global exposed');
    const gz = await X.parseFtm(new Uint8Array(read('tuneB.ftm')));
    assert.strictEqual(gz.swVersion, '3.5.2');
    assert.strictEqual(X.extractTables(gz.tree).length, 3);
    const zl = await X.parseFtm(new Uint8Array(read('tuneA.ftm')));
    assert.strictEqual(zl.swVersion, '3.5.1');
    assert.strictEqual(zl.locked, false);
  });

  await t('XML: attributes, entities, CDATA, comments, consistent children', () => {
    const o = C.parseXml(
      '<!-- lead --><?xml version="1.0"?>' +
      '<Root a="1" b="x&lt;y">' +
      '<Empty/>' +
      '<One><double>5</double></One>' +
      '<Two><double>5</double><double>6</double></Two>' +
      '<Ent>&amp;&lt;&gt;&quot;&apos;&#65;&#x42;</Ent>' +
      '<C><![CDATA[a < b && "raw"]]></C>' +
      '<Mixed a="1">txt<Sub>s</Sub></Mixed>' +
      '</Root>').Root;
    assert.strictEqual(o['@a'], '1');
    assert.strictEqual(o['@b'], 'x<y');
    assert.strictEqual(o.Empty, '');
    // no single-child collapse: asArray() works for 1 and N children
    assert.deepStrictEqual(C.asArray(o.One.double), ['5']);
    assert.deepStrictEqual(C.asArray(o.Two.double), ['5', '6']);
    assert.strictEqual(o.Ent, '&<>"\'AB');
    assert.strictEqual(o.C, 'a < b && "raw"');
    assert.strictEqual(o.Mixed['#'], 'txt');
    assert.strictEqual(o.Mixed.Sub, 's');
    assert.strictEqual(o.Mixed['@a'], '1');
  });

  await t('tables: extraction, sparse dict -> dense matrix with NaN', async () => {
    const a = await C.parseFtm(read('tuneA.ftm'));
    const tables = C.extractTables(a.tree);
    const inj = tables.find(t => t.name === 'Injector_Pulse');
    assert.ok(inj);
    assert.strictEqual(inj.rows, 11);
    assert.strictEqual(inj.cols, 14);
    assert.strictEqual(inj.is1D, false);
    assert.deepStrictEqual(inj.path, ['Injector_Pulse']);
    assert.strictEqual(inj.xAxes[1], 20);
    assert.strictEqual(inj.yAxes[0], 500);
    // hole deliberately left out of the sparse dictionary at row 3, col 7
    assert.ok(Number.isNaN(inj.matrix[3][7]), 'missing cell must be NaN');
    assert.strictEqual(inj.matrix[3][6], 5.692);
    assert.strictEqual(inj.matrix[0][0], 2.575);
    const lam = tables.find(t => t.name === 'Lambda_1');
    assert.strictEqual(lam.is1D, true);
    assert.strictEqual(lam.rows, 1);
    assert.strictEqual(lam.cols, 15);
    assert.ok(Number.isNaN(lam.matrix[0][5]), '1-D sparse hole NaN');
    assert.strictEqual(lam.matrix[0][3], 1);
    // key-based placement: reordered dictionary keys still land in the right column
    const reordered = C.parseXml('<T><Colunas><double>0</double><double>10</double></Colunas>' +
      '<Linhas><double>0</double><double>1</double></Linhas>' +
      '<Tabela><Item><Value><SerializableDictionaryOfDoubleDouble>' +
      '<Item><Key><double>10</double></Key><Value><double>99</double></Value></Item>' +
      '</SerializableDictionaryOfDoubleDouble></Value></Item>' +
      '<Item><Value><SerializableDictionaryOfDoubleDouble>' +
      '<Item><Key><double>0</double></Key><Value><double>7</double></Value></Item>' +
      '</SerializableDictionaryOfDoubleDouble></Value></Item></Tabela></T>');
    const rt = C.extractTables(reordered)[0];
    assert.strictEqual(rt.matrix[0][1], 99);
    assert.strictEqual(rt.matrix[1][0], 7);
    assert.ok(Number.isNaN(rt.matrix[0][0]));
  });

  await t('diff: numeric tolerance 0.001 boundary + trimmed strings', () => {
    const mk = v => ({ P: String(v) });
    const eq = C.diffTrees(mk(1.5), mk(1.501));      // |d| == 0.001 -> equal
    assert.strictEqual(eq.children.P.status, 'equal');
    const ne = C.diffTrees(mk(1.5), mk(1.5011));     // |d| > 0.001 -> changed
    assert.strictEqual(ne.children.P.status, 'changed');
    assert.ok(Math.abs(ne.children.P.delta + 0.0011) < 1e-9, 'delta = base - comp');
    assert.strictEqual(C.diffTrees(mk(1.5), mk('1.5 ')).children.P.status, 'equal');
    assert.strictEqual(C.diffTrees({ S: 'a' }, { S: ' a ' }).children.S.status, 'equal');
    assert.strictEqual(C.diffTrees({ S: 'a' }, { S: 'b' }).children.S.status, 'changed');
    assert.strictEqual(C.diffTrees({ N: '1' }, { N: 'one' }).children.N.status, 'changed');
    assert.strictEqual(C.diffTrees({ N: '1' }, { N: '1' }).children.N.status, 'equal');
    assert.strictEqual(C.diffTrees({ G: { X: '1' } }, { G: { X: '2' } }).children.G.status, 'nested');
    assert.strictEqual(C.diffTrees({ G: { X: '1' } }, { G: { X: '2' } }).anyDiff, true);
    assert.strictEqual(C.diffTrees({ G: { X: '1' } }, { G: { X: '1' } }).anyDiff, false);
  });

  await t('diff: missing / added keys and tables on both sides', async () => {
    const a = await C.parseFtm(read('tuneA.ftm'));
    const b = await C.parseFtm(read('tuneB.ftm'));
    const d = C.diffTrees(a.tree, b.tree);
    assert.strictEqual(d.children.Ignition_Advance.status, 'missing-left', 'base-only table');
    assert.strictEqual(d.children.VVT_Advance.status, 'missing-right', 'compare-only table');
    assert.strictEqual(d.children.Lambda_1.status, 'nested');
    assert.strictEqual(d.children.Limitative.children.Rev_Limit.status, 'changed');
    assert.strictEqual(d.children.Limitative.children.Rev_Limit.delta, -100);
    assert.strictEqual(d.children.Injection_Config.children.Injector_Flow.status, 'equal', 'within tol');
    assert.strictEqual(d.children.Map_Name.status, 'changed');
    assert.strictEqual(d.anyDiff, true);
    assert.ok(C.countChanges(d) >= 3);
  });

  await t('table diff: cell deltas, NaN handling, dimension mismatch', async () => {
    const a = await C.parseFtm(read('tuneA.ftm'));
    const b = await C.parseFtm(read('tuneB.ftm'));
    const ta = C.extractTables(a.tree), tb = C.extractTables(b.tree);
    const find = (arr, n) => arr.find(t => t.name === n);

    const inj = C.diffTable(find(ta, 'Injector_Pulse'), find(tb, 'Injector_Pulse'));
    assert.strictEqual(inj.sameSize, true);
    assert.ok(inj.changedCells > 0 && inj.changedCells < 20, 'a few cells changed: ' + inj.changedCells);
    assert.ok(Math.abs(inj.deltaMatrix[2][4] + 0.35) < 1e-9, 'delta = base - comp');
    assert.strictEqual(inj.deltaMatrix[5][6], NaN, 'value vs missing cell -> NaN delta');
    assert.ok(inj.maxAbsDelta >= 0.35);

    const lam = C.diffTable(find(ta, 'Lambda_1'), find(tb, 'Lambda_1'));
    assert.strictEqual(lam.sameSize, false, '15 vs 17 columns');
    assert.deepStrictEqual(lam.baseSize, [1, 15]);
    assert.deepStrictEqual(lam.compSize, [1, 17]);

    assert.strictEqual(C.diffTable(find(ta, 'Ignition_Advance'), find(tb, 'Ignition_Advance')).sameSize, false);

    const same = C.diffTable(find(ta, 'Injector_Pulse'), find(ta, 'Injector_Pulse'));
    assert.strictEqual(same.changedCells, 0);
    assert.ok(Number.isNaN(same.deltaMatrix[3][7]), 'NaN vs NaN stays NaN, not counted');
  });

  await t('table diff stats: full shape, independently recomputed from deltaMatrix', async () => {
    const a = await C.parseFtm(read('tuneA.ftm'));
    const b = await C.parseFtm(read('tuneB.ftm'));
    const ta = C.extractTables(a.tree), tb = C.extractTables(b.tree);
    const find = (arr, n) => arr.find(t => t.name === n);
    const d = C.diffTable(find(ta, 'Injector_Pulse'), find(tb, 'Injector_Pulse'));
    assert.strictEqual(d.sameSize, true);
    assert.deepStrictEqual(d.dimsBase, [11, 14]);
    assert.deepStrictEqual(d.dimsComp, [11, 14]);
    assert.strictEqual(d.totalCells, 154);
    // independent recomputation from the base/comp matrices
    const A = find(ta, 'Injector_Pulse').matrix, B = find(tb, 'Injector_Pulse').matrix;
    let min = Infinity, max = -Infinity, maxAbs = 0, sumAbs = 0, n = 0, nanChanged = 0;
    for (let r = 0; r < 11; r++) for (let c = 0; c < 14; c++) {
      const x = A[r][c], y = B[r][c];
      if (Number.isNaN(x) && Number.isNaN(y)) continue; // NaN vs NaN: not changed
      const v = x - y;
      if (Number.isNaN(v)) { nanChanged++; continue; }  // NaN vs value: changed, no number
      if (v === 0) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
      sumAbs += Math.abs(v); n++;
    }
    assert.ok(nanChanged > 0, 'fixture must contain NaN-vs-value cells');
    assert.strictEqual(d.minDelta, min);
    assert.strictEqual(d.maxDelta, max);
    assert.strictEqual(d.maxAbsDelta, maxAbs);
    assert.ok(Math.abs(d.meanAbsDelta - sumAbs / n) < 1e-12, 'mean over changed cells only');
    // NaN cells: counted as changed, excluded from the numeric stats
    assert.strictEqual(d.changedCells, n + nanChanged, 'NaN-vs-value counts as changed');
    // equal table: zeroed stats, no NaN contamination
    const eq = C.diffTable(find(ta, 'Injector_Pulse'), find(ta, 'Injector_Pulse'));
    assert.strictEqual(eq.minDelta, 0);
    assert.strictEqual(eq.maxDelta, 0);
    assert.strictEqual(eq.meanAbsDelta, 0);
    assert.strictEqual(eq.maxAbsDelta, 0);
    assert.strictEqual(eq.totalCells, 154);
  });

  await t('table diff stats: dim mismatch + matching overlap axes -> overlap delta stats', async () => {
    const a = await C.parseFtm(read('tuneA.ftm'));
    const b = await C.parseFtm(read('tuneB.ftm'));
    const ta = C.extractTables(a.tree), tb = C.extractTables(b.tree);
    const find = (arr, n) => arr.find(t => t.name === n);
    const d = C.diffTable(find(ta, 'Lambda_1'), find(tb, 'Lambda_1')); // 1x15 vs 1x17, first 15 axes equal
    assert.strictEqual(d.sameSize, false);
    assert.deepStrictEqual(d.dimsBase, [1, 15]);
    assert.deepStrictEqual(d.dimsComp, [1, 17]);
    assert.deepStrictEqual(d.baseSize, [1, 15]);   // backward compat
    assert.deepStrictEqual(d.compSize, [1, 17]);
    // overlap axes match -> conditional overlap delta stats are reported
    assert.strictEqual(d.partialOverlap, true);
    const A = find(ta, 'Lambda_1').matrix, B = find(tb, 'Lambda_1').matrix;
    let changed = 0, min = Infinity, max = -Infinity, maxAbs = 0, sumAbs = 0, fin = 0;
    for (let r = 0; r < 1; r++) for (let c = 0; c < 15; c++) {
      const x = A[r][c], y = B[r][c];
      if (Number.isNaN(x) && Number.isNaN(y)) continue;
      if (x !== y) {
        changed++;
        const dd = x - y;
        if (Number.isFinite(dd)) {
          if (dd < min) min = dd; if (dd > max) max = dd;
          if (Math.abs(dd) > maxAbs) maxAbs = Math.abs(dd);
          sumAbs += Math.abs(dd); fin++;
        }
      }
    }
    assert.ok(changed > 0);
    assert.strictEqual(d.totalCells, 15);
    assert.strictEqual(d.changedCells, changed);
    assert.ok(Array.isArray(d.deltaMatrix) && d.deltaMatrix.length === 1 && d.deltaMatrix[0].length === 15,
      'deltaMatrix covers the overlap subgrid');
    assert.ok(Math.abs(d.minDelta - min) < 1e-12 && Math.abs(d.maxDelta - max) < 1e-12);
    assert.ok(Math.abs(d.maxAbsDelta - maxAbs) < 1e-12);
    assert.ok(Math.abs(d.meanAbsDelta - sumAbs / fin) < 1e-12);
  });

  await t('table diff stats: dim mismatch + differing overlap axes -> counts only, null deltas', () => {
    const mk = (name, xs, ys, m) => ({
      path: [name], name, xAxes: xs, yAxes: ys, rows: m.length, cols: m[0].length, matrix: m
    });
    const A = mk('T', [0, 10, 20, 30], [0], [[1, 2, 3, 4]]);
    const B = mk('T', [0, 11, 20, 30, 40, 50], [0], [[1, 9, 3, 4, 5, 6]]); // xAxes[1] differs
    const d = C.diffTable(A, B);
    assert.strictEqual(d.sameSize, false);
    assert.strictEqual(d.partialOverlap, false, 'axes differ -> no overlap stats');
    assert.strictEqual(d.totalCells, 4);
    assert.strictEqual(d.changedCells, 1);
    assert.strictEqual(d.deltaMatrix, null);
    assert.strictEqual(d.minDelta, null);
    assert.strictEqual(d.maxDelta, null);
    assert.strictEqual(d.maxAbsDelta, null);
    assert.strictEqual(d.meanAbsDelta, null);
  });

  await t('table diff stats: NaN-vs-value-only changes -> null deltas, not 0', () => {
    const mk = (name, xs, ys, m) => ({
      path: [name], name, xAxes: xs, yAxes: ys, rows: m.length, cols: m[0].length, matrix: m
    });
    const A = mk('T', [0, 10], [0, 1], [[1, NaN], [2, 3]]);
    const B = mk('T', [0, 10], [0, 1], [[1, 5], [2, 3]]); // one NaN-vs-value cell only
    const d = C.diffTable(A, B);
    assert.strictEqual(d.sameSize, true);
    assert.strictEqual(d.changedCells, 1);
    assert.ok(Number.isNaN(d.deltaMatrix[0][1]), 'NaN delta kept in the matrix');
    assert.strictEqual(d.minDelta, null);
    assert.strictEqual(d.maxDelta, null);
    assert.strictEqual(d.maxAbsDelta, null);
    assert.strictEqual(d.meanAbsDelta, null);
    // fully-equal grid still reports zeros (unchanged behaviour)
    const e = C.diffTable(A, A);
    assert.strictEqual(e.changedCells, 0);
    assert.strictEqual(e.minDelta, 0);
    assert.strictEqual(e.maxAbsDelta, 0);
    assert.strictEqual(e.meanAbsDelta, 0);
  });

  await t('summarizeTables: status-aware default sort (changed < resized), maxAbsDelta tiebreak', () => {
    const mk = (name, xs, ys, m) => ({
      path: [name], name, xAxes: xs, yAxes: ys, rows: m.length, cols: m[0].length, matrix: m
    });
    // changed X: 1 changed cell, maxAbs 5; changed Z: 1 changed cell, maxAbs 2 (tie on cells)
    const Xa = mk('X', [0, 1], [0, 1], [[1, 2], [3, 4]]), Xb = mk('X', [0, 1], [0, 1], [[6, 2], [3, 4]]);
    const Za = mk('Z', [0, 1], [0, 1], [[1, 2], [3, 4]]), Zb = mk('Z', [0, 1], [0, 1], [[3, 2], [3, 4]]);
    // resized Y: 4 changed overlap cells (more than X/Z) but must sort AFTER them
    const Ya = mk('Y', [0, 1, 2, 3], [0], [[1, 2, 3, 4]]);
    const Yb = mk('Y', [0, 1, 2, 3, 4, 5], [0], [[9, 9, 9, 9, 9, 9]]);
    const rows = C.summarizeTables([Za, Ya, Xa], [Zb, Yb, Xb]);
    assert.deepStrictEqual(rows.map(r => r.path), ['X', 'Z', 'Y'],
      'changed rows first (maxAbsDelta tiebreak 5>2), resized after, despite more changed cells');
    assert.strictEqual(rows[0].status, 'changed');
    assert.strictEqual(rows[1].status, 'changed');
    assert.strictEqual(rows[2].status, 'resized');
    assert.strictEqual(rows[0].maxAbsDelta, 5);
    assert.strictEqual(rows[1].maxAbsDelta, 2);
    assert.strictEqual(rows[2].changedCells, 4, 'resized overlap counts still reported');
    assert.strictEqual(rows[2].partialOverlap, undefined, 'row shape unchanged');
    assert.strictEqual(rows[2].diff.partialOverlap, true);
  });

  await t('summarizeTables: path collision -> " #2" suffix + console.warn, no silent drop', () => {
    const mk = (name, v) => ({
      path: ['Dup'], name, xAxes: [0, 1], yAxes: [0], rows: 1, cols: 2, matrix: [[v, v + 1]]
    });
    const warns = [];
    const origWarn = console.warn;
    console.warn = m => warns.push(String(m));
    try {
      const rows = C.summarizeTables([mk('Dup', 1), mk('Dup', 10)], null);
      console.warn = origWarn;
      assert.strictEqual(rows.length, 2, 'both colliding tables kept');
      assert.deepStrictEqual(rows.map(r => r.path), ['Dup', 'Dup #2']);
      assert.ok(warns.some(w => w.includes('Dup #2')), 'console.warn mentions the new key');
    } finally { console.warn = origWarn; }
  });


  await t('summarizeTables: statuses, path union, default sort, single-file mode', async () => {
    const a = await C.parseFtm(read('tuneA.ftm'));
    const b = await C.parseFtm(read('tuneB.ftm'));
    const ta = C.extractTables(a.tree), tb = C.extractTables(b.tree);
    const rows = C.summarizeTables(ta, tb);
    const byPath = new Map(rows.map(r => [r.path, r]));
    assert.strictEqual(rows.length, 4, 'union of 3+3 tables sharing 2 paths');
    assert.strictEqual(byPath.get('Ignition_Advance').status, 'only-in-base');
    assert.strictEqual(byPath.get('Ignition_Advance').dimsComp, null);
    assert.strictEqual(byPath.get('VVT_Advance').status, 'only-in-comp');
    assert.strictEqual(byPath.get('VVT_Advance').dimsBase, null);
    assert.strictEqual(byPath.get('Lambda_1').status, 'resized');
    assert.strictEqual(byPath.get('Injector_Pulse').status, 'changed');
    assert.ok(byPath.get('Injector_Pulse').changedCells > 0);
    assert.ok(byPath.get('Injector_Pulse').diff.sameSize, 'diff object carried on the row');
    // default sort: status rank (changed < resized < only-in-* < equal),
    // within a status changedCells desc (null counts sort last in status)
    const RANK = { changed: 0, resized: 1, 'only-in-base': 2, 'only-in-comp': 2, equal: 3 };
    for (let i = 1; i < rows.length; i++) {
      assert.ok(RANK[rows[i - 1].status] <= RANK[rows[i].status], 'status order at ' + i);
      if (rows[i - 1].status === rows[i].status) {
        const p = rows[i - 1].changedCells, q = rows[i].changedCells;
        assert.ok((p === null ? -1 : p) >= (q === null ? -1 : q), 'cells order at ' + i);
      }
    }
    assert.strictEqual(rows[rows.length - 1].status, 'only-in-comp', 'uncounted rows sort last');
    // single-file mode: everything equal, no stats
    const solo = C.summarizeTables(ta, null);
    assert.strictEqual(solo.length, 3);
    solo.forEach(r => {
      assert.strictEqual(r.status, 'equal');
      assert.strictEqual(r.diff, null);
      assert.strictEqual(r.changedCells, null);
      assert.ok(r.dimsBase);
    });
  });

  await t('lock flag: detected but contents preserved; missing SecurityConfig = unlocked', async () => {
    const l = await C.parseFtm(read('tuneLocked.ftm'));
    assert.strictEqual(l.locked, true);
    assert.ok(l.tree.Injector_Pulse, 'contents kept despite lock');
    const a = await C.parseFtm(read('tuneA.ftm'));
    assert.strictEqual(a.locked, false);
    const noSec = await C.parseFtm(zlib.deflateSync(Buffer.from(
      xmlOf('Adjust', '  <SW_Version>2.0</SW_Version>\n'), 'utf8')));
    assert.strictEqual(noSec.locked, false);
    assert.strictEqual(C.stringToBoolean(' TRUE '), true);
    assert.strictEqual(C.stringToBoolean('no'), false);
  });

  await t('fileInfo / swVersion grouping', async () => {
    const a = await C.parseFtm(read('tuneA.ftm'));
    assert.strictEqual(a.fileInfo.SW_Version, '3.5.1');
    assert.strictEqual(a.fileInfo.Map_Name, 'Track setup');
    assert.ok(a.tree.Map_Name, 'tree is not mutated by fileInfo grouping');
    assert.ok(!('Linhas' in a.fileInfo));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
