/* tests/qa/local-crypto.test.js — OPTIONAL suite (skipped by run-all.js when
 * src/ftm-crypto-local.js is absent, e.g. in the public repo).
 *
 * NOTE: the official PnP example files share the same fixed vendor key, so
 * this tool could technically open them. Use only on your own maps. This
 * suite deliberately touches ONLY the owner's three maps. */
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const C = require('../../src/ftm-core.js');
const L = require('../../src/ftm-crypto-local.js');

const t = async (name, fn) => {
  try { await fn(); console.log('ok   ' + name); return true; }
  catch (e) { console.log('FAIL ' + name + '\n     ' + e.message); return false; }
};

(async () => {
  let pass = 0, fail = 0;
  const run = async (n, f) => ((await t(n, f)) ? pass++ : fail++);

  await run('pure-JS SHA-256 and AES-256-CBC match node crypto on random vectors', () => {
    for (const s of ['', 'abc', 'x'.repeat(55), 'y'.repeat(64), 'z'.repeat(1000)]) {
      assert.strictEqual(Buffer.from(L.sha256(Buffer.from(s))).toString('hex'),
        crypto.createHash('sha256').update(s).digest('hex'), 'sha ' + s.length);
    }
    for (let i = 0; i < 10; i++) {
      const key = crypto.randomBytes(32), iv = crypto.randomBytes(16);
      const pt = crypto.randomBytes(16 * (1 + Math.floor(Math.random() * 40)));
      const cip = crypto.createCipheriv('aes-256-cbc', key, iv);
      const ct = Buffer.concat([cip.update(pt), cip.final()]);
      const dec = crypto.createDecipheriv('aes-256-cbc', key, iv);
      const unp = Buffer.concat([dec.update(ct), dec.final()]);
      assert.ok(Buffer.from(L.aesCbcDecrypt(key, iv, new Uint8Array(ct))).equals(unp), 'aes t' + i);
    }
  });

  const OWNER = ['Map_1_-_flex final.ftm', 'Active_Map_2_-_flex final.ftm', 'Map_3_-_gas final.ftm'];
  const dir = path.join(__dirname, '..', '..', 'samples');
  const have = OWNER.filter(f => fs.existsSync(path.join(dir, f)));
  if (!have.length) console.log('SKIP owner-map tests (samples absent)');
  else {
  await run('parseFtm opens all three owner FTManager 5.6 maps', async () => {
    for (const f of have) {
      const r = await C.parseFtm(fs.readFileSync(path.join(dir, f)));
      assert.strictEqual(C.getPath(r.tree, 'ProductID'), '550', f + ' ProductID');
      assert.strictEqual(C.getPath(r.tree, 'SW_Version'), '5.60', f + ' SW_Version');
      assert.ok(r.rootName === 'Adjust', f + ' root');
    }
  });

  await run('self-diff invariant holds on decrypted maps', async () => {
    for (const f of have) {
      const r = await C.parseFtm(fs.readFileSync(path.join(dir, f)));
      const d = C.diffTrees(r.tree, r.tree);
      assert.strictEqual(C.countChanges(d), 0, f + ' tree self-diff');
      const rows = C.summarizeTables(C.extractTables(r.tree), C.extractTables(r.tree));
      assert.ok(rows.every(x => !x.changedCells), f + ' table self-diff');
    }
  });

  await run('real diff: flex vs gas maps produce table changes', async () => {
    const a = await C.parseFtm(fs.readFileSync(path.join(dir, OWNER[0])));
    const b = await C.parseFtm(fs.readFileSync(path.join(dir, OWNER[2])));
    const ta = C.extractTables(a.tree), tb = C.extractTables(b.tree);
    const rows = C.summarizeTables(ta, tb);
    const changed = rows.filter(r => r.status === 'changed' || r.status === 'resized');
    assert.ok(changed.length > 0, 'expected changes between flex and gas maps');
    // top changed row's cell deltas must match the diff's own table data
    const top = rows.find(r => r.status === 'changed' && r.changedCells > 0);
    assert.ok(top, 'no changed row');
    const byPath = arr => { const m = new Map(); for (const x of arr) m.set(x.path.join('/'), x); return m; };
    const A = byPath(ta).get(top.path), B = byPath(tb).get(top.path);
    let checked = 0;
    for (let r0 = 0; r0 < Math.min(A.rows, B.rows); r0++)
      for (let c0 = 0; c0 < Math.min(A.cols, B.cols); c0++) {
        const av = A.values[r0][c0], bv = B.values[r0][c0];
        const d = top.diff ? top.diff.deltaMatrix[r0][c0] : null;
        if (av !== bv) { assert.strictEqual(d, av - bv, 'delta mismatch'); checked++; }
      }
    assert.ok(checked > 0, 'no deltas checked');
    console.log('     (' + changed.length + ' changed/resized rows, top=' + top.path +
      ' ' + top.changedCells + '/' + top.totalCells + ')');
  });
  } // if have

  console.log('\nlocal-crypto: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
