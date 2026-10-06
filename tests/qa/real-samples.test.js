/* tests/qa/real-samples.test.js — regression tests against REAL FuelTech
 * sample maps in samples/ (from FuelTech's official example-map page).
 *
 * Guard: if samples/ is absent the whole suite skips (exit 0) so the repo
 * stays runnable without the samples.
 *
 * Ground-truth numbers (table counts, cell values, deltas) were cross-checked
 * with an INDEPENDENT tag-scanner over the gunzipped XML — see
 * tools/qc-groundtruth.js and tools/qc-diffs.js.
 *
 * Plain node runner: node tests/qa/real-samples.test.js
 */
'use strict';
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../../src/ftm-core.js');

const DIR = path.join(__dirname, '..', '..', 'samples');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); }
}

const gzipSamples = [];
if (fs.existsSync(DIR)) {
  for (const f of fs.readdirSync(DIR)) {
    const buf = fs.readFileSync(path.join(DIR, f));
    if (buf[0] === 0x1f && buf[1] === 0x8b) gzipSamples.push(f);
  }
}
const read = f => fs.readFileSync(path.join(DIR, f));
const parse = f => C.parseFtm(read(f));
const byPath = tree => {
  const m = new Map();
  C.extractTables(tree).forEach(tb => m.set(tb.path.join('/'), tb));
  return m;
};

async function main() {
  if (!fs.existsSync(DIR) || !gzipSamples.length) {
    console.log('SKIP real-samples: no samples/ directory (or no readable samples) — ' +
      'suite skipped, not a failure');
    return;
  }

  /* ---- task 1: every gzip sample parses; encrypted ones reject gracefully */
  await t('all gzip samples parse: root=Adjust, locked=false, tables>0', async () => {
    for (const f of gzipSamples) {
      const p = await parse(f);
      assert.strictEqual(p.rootName, 'Adjust', f + ' root');
      assert.strictEqual(p.locked, false, f + ' locked');
      assert.ok(p.swVersion, f + ' swVersion');
      const n = C.extractTables(p.tree).length;
      assert.ok(n > 100, f + ' table count ' + n);
      assert.ok(Object.keys(p.fileInfo).length >= 20, f + ' scalar params');
    }
  });

  await t('encrypted/protected maps (39fa/4d23 magic) rejected with clear message, fast', async () => {
    const enc = fs.readdirSync(DIR).filter(f => {
      const b = read(f);
      return !(b[0] === 0x1f && b[1] === 0x8b) && !(b[0] === 0x78);
    });
    assert.ok(enc.length >= 2, 'expected >=2 non-compressed samples, got ' + enc.length);
    for (const f of enc) {
      const t0 = Date.now();
      let msg = null;
      try { await parse(f); } catch (e) { msg = e.message; }
      assert.ok(msg, f + ' must reject, not hang/return');
      assert.ok(/protected\/?encrypted|unrecognized container/i.test(msg),
        f + ' unclear error: ' + msg);
      assert.ok(Date.now() - t0 < 5000, f + ' rejected too slowly');
    }
  });

  /* ---- task 2: ground-truth table counts (independent XML scan) */
  const GT_COUNTS = {
    'ft550_line_example_LS7.ftm': 370,
    'ft550_line_example_LS2_turbo.ftm': 261,
    'ft550_line_example_LS_58x_4x.ftm': 355,
    'ft550_line_example_BMW_M3_1999_USA.ftm': 370,
    'ft550_line_example_Viper_V10.ftm': 370
  };
  await t('extractTables count matches independent raw-XML count', async () => {
    for (const [f, n] of Object.entries(GT_COUNTS)) {
      if (!fs.existsSync(path.join(DIR, f))) continue;
      const p = await parse(f);
      assert.strictEqual(C.extractTables(p.tree).length, n, f);
    }
  });

  await t('ground-truth cell values (LS7 Inj_MainTpsTable_A_Legacy row 0)', async () => {
    const f = 'ft550_line_example_LS7.ftm';
    if (!fs.existsSync(path.join(DIR, f))) return;
    const p = await parse(f);
    const tb = byPath(p.tree).get('InjTables/Inj_MainTpsTable_A_Legacy');
    assert.ok(tb, 'table present');
    // raw XML (Linhas=1, Colunas=0..100): first cells 4.933, 6.267, 7.467.
    // NOTE: 1.366/2.3/3.166 belong to the BMW M3 1999 USA map, not LS7.
    assert.ok(Math.abs(tb.matrix[0][0] - 4.933) < 1e-9);
    assert.ok(Math.abs(tb.matrix[0][1] - 6.267) < 1e-9);
    assert.ok(Math.abs(tb.matrix[0][2] - 7.467) < 1e-9);
  });

  /* ---- task 3c: self-diff invariant (CRITICAL) */
  await t('self-diff of every sample reports ZERO changes (tree + tables)', async () => {
    for (const f of gzipSamples) {
      const p = await parse(f);
      assert.strictEqual(C.countChanges(C.diffTrees(p.tree, p.tree)), 0, f + ' tree self-diff');
      for (const tb of C.extractTables(p.tree)) {
        const dt = C.diffTable(tb, tb);
        assert.ok(dt.sameSize, f + ' ' + tb.name + ' self dim-mismatch');
        assert.strictEqual(dt.changedCells, 0, f + ' ' + tb.name + ' self cell diff');
      }
    }
  });

  /* ---- task 3a: BMW M3 FT550LITE(551) vs FT550(550) pair */
  const BMW_A = 'ft550_line_example_BMW_M3_1999_USA.ftm';
  const BMW_B = 'ft550_line_example_BMW_M3_S54_final.ftm';
  await t('BMW M3 pair: many diffs incl. structural; dim-mismatch fires; hand-checked delta', async () => {
    if (!fs.existsSync(path.join(DIR, BMW_A)) || !fs.existsSync(path.join(DIR, BMW_B))) return;
    const [a, b] = [await parse(BMW_A), await parse(BMW_B)];
    assert.strictEqual(a.fileInfo.ProductID, '551');
    assert.strictEqual(b.fileInfo.ProductID, '550');
    const d = C.diffTrees(a.tree, b.tree);
    const n = C.countChanges(d);
    assert.ok(n > 5000, 'expected many changes, got ' + n);
    // structural: entries only on one side
    let ml = 0, mr = 0, dimMismatch = 0;
    (function w(x) {
      if (!x) return;
      if (x.status === 'missing-left') ml++;
      else if (x.status === 'missing-right') mr++;
      else if (x.status === 'nested') Object.values(x.children).forEach(w);
    })(d);
    assert.ok(ml > 500 && mr > 500, 'structural diffs expected, got ml=' + ml + ' mr=' + mr);
    const ta = byPath(a.tree), tb = byPath(b.tree);
    for (const [p, x] of ta) {
      const y = tb.get(p);
      if (!y) continue;
      const dt = C.diffTable(x, y);
      if (!dt.sameSize) dimMismatch++;
    }
    assert.ok(dimMismatch > 50, 'dim-mismatch handling expected, got ' + dimMismatch);
    // hand-checked ground truth: Inj_MainTpsTable_A_Legacy[0][0] 1.366 - 5.55 = -4.184
    const x = ta.get('InjTables/Inj_MainTpsTable_A_Legacy');
    const y = tb.get('InjTables/Inj_MainTpsTable_A_Legacy');
    const dt = C.diffTable(x, y);
    assert.ok(dt.sameSize);
    assert.ok(Math.abs(dt.deltaMatrix[0][0] - (1.366 - 5.55)) < 1e-9, 'delta ' + dt.deltaMatrix[0][0]);
  });

  /* ---- task 3b: LS2_turbo vs LS3_VVT (both FT5_CLASS/ProductID 500) */
  const LS_A = 'ft550_line_example_LS2_turbo.ftm';
  const LS_B = 'ft550_line_example_LS3_VVT.ftm';
  await t('LS2 vs LS3 pair: structural + dim-mismatch + hand-checked delta', async () => {
    if (!fs.existsSync(path.join(DIR, LS_A)) || !fs.existsSync(path.join(DIR, LS_B))) return;
    const [a, b] = [await parse(LS_A), await parse(LS_B)];
    assert.strictEqual(a.fileInfo.FT_CLASS, 'FT5_CLASS');
    assert.strictEqual(b.fileInfo.FT_CLASS, 'FT5_CLASS');
    const n = C.countChanges(C.diffTrees(a.tree, b.tree));
    assert.ok(n > 3000, 'expected many changes, got ' + n);
    const ta = byPath(a.tree), tb = byPath(b.tree);
    let dimMismatch = 0;
    for (const [p, x] of ta) {
      const y = tb.get(p);
      if (y && !C.diffTable(x, y).sameSize) dimMismatch++;
    }
    assert.ok(dimMismatch > 30, 'dim-mismatch expected, got ' + dimMismatch);
    // hand-checked ground truth: [0][0] 3.3 - 3.943
    const dt = C.diffTable(
      ta.get('InjTables/Inj_MainTpsTable_A_Legacy'),
      tb.get('InjTables/Inj_MainTpsTable_A_Legacy'));
    assert.ok(Math.abs(dt.deltaMatrix[0][0] - (3.3 - 3.943)) < 1e-9, 'delta ' + dt.deltaMatrix[0][0]);
  });

  /* ---- task 4: real-file structural facts our parser must honor */
  await t('real files: SecurityConfig/Tuner_Enabled present and false => locked=false', async () => {
    for (const f of gzipSamples) {
      const p = await parse(f);
      const sec = C.getPath(p.tree, 'SecurityConfig/SecurityFlags/Tuner_Enabled');
      assert.notStrictEqual(sec, undefined, f + ' Tuner_Enabled path');
      assert.strictEqual(String(sec).trim().toLowerCase(), 'false', f);
      assert.strictEqual(p.locked, false, f);
    }
  });

  await t('regression: self-closing empty tables (<Linhas/> etc.) are 0x0, not 1x1-NaN', async () => {
    const p = await parse('ft550_line_example_LS7.ftm');
    const tb = byPath(p.tree).get('FuncTables/Func_EtcSlewControl_Table');
    assert.ok(tb, 'empty table found');
    assert.strictEqual(tb.rows, 0);
    assert.strictEqual(tb.cols, 0);
    // and it diffs equal against itself, mismatched against a real table
    const other = byPath(p.tree).get('InjTables/Inj_TpsIdle_Table');
    assert.strictEqual(C.diffTable(tb, tb).changedCells, 0);
    assert.strictEqual(C.diffTable(tb, other).sameSize, false);
  });

  await t('regression: row-level <Item><Key> (Y key) present in real files; positional rows align', async () => {
    // every Tabela Item in real files carries a Key (row Y value) that we
    // intentionally ignore; ordering matches Linhas (verified over all 11
    // samples by tools/qc-diffs.js). Spot-check axes here.
    const p = await parse('ft550_line_example_LS7.ftm');
    const tb = byPath(p.tree).get('InjTables/Inj_MainMap_B_Table');
    assert.ok(tb && tb.rows === tb.yAxes.filter(Number.isFinite).length);
  });

  console.log('\nreal-samples: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

main().catch(e => { console.error('CRASH', e); process.exit(1); });
