/* tests/qa/table-view.test.js — asserts the DATA MODEL the tables-first view
 * renders from (C.summarizeTables) against the real BMW M3 sample pair.
 * No DOM automation (the repo has no persistent DOM shim); the UI renders
 * exactly this array. Ground truth cross-checked by tools/qc-diffs.js.
 *
 * Guard: if samples/ is absent the suite skips (exit 0).
 * Plain node runner: node tests/qa/table-view.test.js
 */
'use strict';
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../../src/ftm-core.js');

const DIR = path.join(__dirname, '..', '..', 'samples');
const BMW_A = 'ft550_line_example_BMW_M3_1999_USA.ftm';
const BMW_B = 'ft550_line_example_BMW_M3_S54_final.ftm';

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); }
}

async function main() {
  if (!fs.existsSync(DIR) || !fs.existsSync(path.join(DIR, BMW_A)) || !fs.existsSync(path.join(DIR, BMW_B))) {
    console.log('SKIP table-view: samples/ (or the BMW pair) not present — suite skipped, not a failure');
    return;
  }
  const a = await C.parseFtm(fs.readFileSync(path.join(DIR, BMW_A)));
  const b = await C.parseFtm(fs.readFileSync(path.join(DIR, BMW_B)));
  const rows = C.summarizeTables(C.extractTables(a.tree), C.extractTables(b.tree));

  await t('BMW pair: 370 rows (both maps have 370 tables, all paths matched)', () => {
    assert.strictEqual(rows.length, 370);
    const st = {};
    rows.forEach(r => st[r.status] = (st[r.status] || 0) + 1);
    assert.deepStrictEqual(st, { changed: 47, resized: 95, equal: 228 },
      'status counts ' + JSON.stringify(st));
  });

  await t('BMW pair: default sort = status-aware; top row is Inj_LambdaTimeStage_Table (changed)', () => {
    const RANK = { changed: 0, resized: 1, 'only-in-base': 2, 'only-in-comp': 2, equal: 3 };
    for (let i = 1; i < rows.length; i++) {
      assert.ok(RANK[rows[i - 1].status] <= RANK[rows[i].status], 'status order at ' + i);
      if (rows[i - 1].status === rows[i].status) {
        const p = rows[i - 1].changedCells, q = rows[i].changedCells;
        assert.ok((p === null ? -1 : p) >= (q === null ? -1 : q), 'cells order at ' + i);
        if (p !== null && p === q) {
          const px = rows[i - 1].maxAbsDelta, qx = rows[i].maxAbsDelta;
          assert.ok((px === null ? -1 : px) >= (qx === null ? -1 : qx), 'maxAbsDelta tiebreak at ' + i);
        }
      }
    }
    const top = rows[0];
    assert.strictEqual(top.status, 'changed', 'same-size changed rows lead the table');
    assert.strictEqual(top.path, 'InjTables/Inj_LambdaTimeStage_Table');
    assert.deepStrictEqual(top.dimsBase, [16, 6]);
    assert.deepStrictEqual(top.dimsComp, [16, 6]);
    assert.strictEqual(top.changedCells, 96);
    assert.strictEqual(top.totalCells, 96);
    assert.ok(Number.isFinite(top.minDelta) && Number.isFinite(top.maxDelta) &&
      Number.isFinite(top.maxAbsDelta) && Number.isFinite(top.meanAbsDelta), 'changed row carries full stats');
  });

  await t('BMW pair: every changed row precedes every resized row; resized overlap stats are honest', () => {
    const lastChanged = rows.map(r => r.status).lastIndexOf('changed');
    const firstResized = rows.map(r => r.status).indexOf('resized');
    assert.ok(lastChanged >= 0 && firstResized >= 0, 'both statuses present');
    assert.ok(lastChanged < firstResized,
      'last changed row (idx ' + lastChanged + ') precedes all resized rows (first at ' + firstResized + ')');
    // Inj_MainTps_A_Table: 23x13 vs 24x15, overlap AXES DIFFER -> counts but null deltas
    const t = rows.find(r => r.path === 'InjTables/Inj_MainTps_A_Table');
    assert.strictEqual(t.status, 'resized');
    assert.deepStrictEqual(t.dimsBase, [23, 13]);
    assert.deepStrictEqual(t.dimsComp, [24, 15]);
    assert.strictEqual(t.changedCells, 299);   // over the 23x13 overlap
    assert.strictEqual(t.totalCells, 299);
    assert.strictEqual(t.diff.partialOverlap, false, 'overlap axes differ');
    assert.strictEqual(t.minDelta, null);
    assert.strictEqual(t.maxDelta, null);
    assert.strictEqual(t.maxAbsDelta, null);
    assert.strictEqual(t.meanAbsDelta, null);
    // at least one resized table has matching overlap axes -> stats present
    const withStats = rows.filter(r => r.status === 'resized' && r.diff.partialOverlap);
    assert.ok(withStats.length >= 10, 'resized rows with matching overlap axes: ' + withStats.length);
    withStats.forEach(r => {
      assert.ok(Number.isFinite(r.maxAbsDelta) && Number.isFinite(r.meanAbsDelta),
        'partialOverlap row ' + r.path + ' carries overlap delta stats');
      assert.ok(Array.isArray(r.diff.deltaMatrix), 'overlap deltaMatrix present');
    });
  });

  await t('BMW pair: top changed (same-size) row + total changed cells match qc-diffs (960)', () => {
    const changed = rows.filter(r => r.status === 'changed');
    const totalCells = changed.reduce((s, r) => s + r.changedCells, 0);
    assert.strictEqual(totalCells, 960, 'sum of changedCells over changed tables');
    const top = changed[0];
    assert.ok(top.changedCells > 0 && top.maxAbsDelta > 0);
    assert.ok(Number.isFinite(top.minDelta) && Number.isFinite(top.maxDelta) &&
      Number.isFinite(top.meanAbsDelta), 'changed rows carry full delta stats');
    assert.ok(top.minDelta < 0 && top.maxDelta > 0 || top.minDelta <= top.maxDelta);
  });

  await t('BMW pair: equal rows carry zeroed stats; every row has a path/name', () => {
    rows.forEach(r => {
      assert.ok(r.path && r.name);
      if (r.status === 'equal') {
        assert.strictEqual(r.changedCells, 0);
        assert.strictEqual(r.maxAbsDelta, 0);
        assert.strictEqual(r.meanAbsDelta, 0);
      }
    });
  });

  console.log('\ntable-view: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

main().catch(e => { console.error('CRASH', e); process.exit(1); });
