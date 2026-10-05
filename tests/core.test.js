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
