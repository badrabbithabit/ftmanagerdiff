/* tools/make-fixtures.js
 * Generates synthetic FuelTech-ish .ftm fixtures in fixtures/:
 *   tuneA.ftm       zlib-wrapped deflate, unlocked
 *   tuneB.ftm       gzip-wrapped deflate, unlocked, with known diffs
 *   tuneLocked.ftm  zlib, Tuner_Enabled=True
 * Run: node tools/make-fixtures.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const FtmCore = require('../src/ftm-core.js');

const FIXDIR = path.join(__dirname, '..', 'fixtures');

/* ---- XML builders ---------------------------------------------------- */

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** <Colunas><double>..</double></Colunas> */
function axis(name, values) {
  return '    <' + name + '>' + values.map(v => '<double>' + v + '</double>').join('') + '</' + name + '>\n';
}

/**
 * Sparse .NET Dictionary<double,double> cells.
 * cells[r][c] === null => cell omitted from the dictionary (sparse).
 */
function tableXml(name, xAxes, yAxes, cells) {
  let s = '  <' + name + '>\n';
  s += axis('Colunas', xAxes);
  s += axis('Linhas', yAxes);
  s += '    <Tabela>\n';
  cells.forEach((row, r) => {
    let items = '';
    row.forEach((v, c) => {
      if (v === null) return; // sparse: skip
      items += '<Item><Key><double>' + xAxes[c] + '</double></Key>' +
        '<Value><double>' + v + '</double></Value></Item>';
    });
    s += '      <Item><Value><SerializableDictionaryOfDoubleDouble>' + items +
      '</SerializableDictionaryOfDoubleDouble></Value></Item>\n';
  });
  s += '    </Tabela>\n  </' + name + '>\n';
  return s;
}

function scalar(name, value) { return '  <' + name + '>' + esc(value) + '</' + name + '>\n'; }

function adjustXml(body) {
  return '<?xml version="1.0" encoding="utf-8"?>\n<Adjust>\n' + body + '</Adjust>\n';
}

function securityXml(locked) {
  return '  <SecurityConfig>\n    <SecurityFlags>\n' +
    '      <Tuner_Enabled>' + (locked ? 'True' : 'False') + '</Tuner_Enabled>\n' +
    '      <Map_Locked>' + (locked ? 'True' : 'False') + '</Map_Locked>\n' +
    '    </SecurityFlags>\n  </SecurityConfig>\n';
}

/* ---- Fixture data ---------------------------------------------------- */

const LAMBDA_X = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000, 6500, 7000];
const lambdaA = [[0.92, 0.95, 0.98, 1.00, 1.00, null, 0.98, 0.97, 0.95, 0.93, 0.91, 0.90, 0.88, 0.86, 0.85]];
const lambdaB = [[0.92, 0.95, 0.98, 1.01, 1.00, 1.00, 0.98, 0.97, 0.95, 0.93, 0.91, 0.90, 0.88, 0.86, 0.85, 0.84, 0.83]];

const INJ_X = [0, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 240, 250];
const INJ_Y = [500, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 7000, 8000];
function injCells(offset) {
  return INJ_Y.map((rpm, r) => INJ_X.map((kpa, c) => {
    if (r === 3 && c === 7) return null;                       // sparse hole (both files)
    if (offset && r === 5 && c === 6) return null;             // extra hole only in B
    const base = 2.4 + rpm * 0.00035 + kpa * 0.021 + (r * c) * 0.004;
    const v = Math.round((base + offset * ((r === 2 && c === 4) ? 0.35 : (r === 8 ? 0.12 : 0))) * 1000) / 1000;
    return v;
  }));
}

const IGN_X = [0, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 240, 250];
const IGN_Y = [500, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
function ignCells() {
  return IGN_Y.map((rpm, r) => IGN_X.map((kpa, c) =>
    Math.round((12 + r * 1.5 + c * 0.6 - (c > 9 ? 4 : 0)) * 10) / 10));
}

const VVT_X = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000];
function vvtCells() {
  return [VVT_X.map((x, c) => Math.min(28, Math.round(c * 2.5 * 10) / 10))];
}

function tuneBody(sw, locked, opts) {
  let s = '';
  s += scalar('SW_Version', sw);
  s += scalar('Map_Name', opts.mapName);
  s += scalar('Car_Name', 'Golf GTI');
  s += scalar('Date', '2026-10-05');
  s += securityXml(locked);
  s += '  <Limitative>\n';
  s += '    <Rev_Limit>' + opts.revLimit + '</Rev_Limit>\n';
  s += '    <Speed_Limit>250</Speed_Limit>\n';
  s += '    <Lambda_Cut_Value>16</Lambda_Cut_Value>\n';
  s += '  </Limitative>\n';
  s += '  <Injection_Config>\n';
  s += '    <Cylinders>4</Cylinders>\n';
  s += '    <Injector_Flow>' + opts.injFlow + '</Injector_Flow>\n';
  s += '    <Idle_Stepper>Idle-&amp;-Warmup</Idle_Stepper>\n';
  s += '  </Injection_Config>\n';
  s += tableXml('Lambda_1', opts.lambdaX, [0], opts.lambda);
  s += tableXml('Injector_Pulse', INJ_X, INJ_Y, opts.inj);
  if (opts.ignition) s += tableXml('Ignition_Advance', IGN_X, IGN_Y, ignCells());
  if (opts.vvt) s += tableXml('VVT_Advance', VVT_X, [0], vvtCells());
  return s;
}

const tuneAXml = adjustXml(tuneBody('3.5.1', false, {
  mapName: 'Track setup',
  revLimit: 7500,
  injFlow: 320,
  lambdaX: LAMBDA_X,
  lambda: lambdaA,
  inj: injCells(0),
  ignition: true,
  vvt: false
}));

const tuneBXml = adjustXml(tuneBody('3.5.2', false, {
  mapName: 'Track setup v2',
  revLimit: 7600,          // scalar changed
  injFlow: 320.0004,       // within 0.001 tolerance -> equal
  lambdaX: LAMBDA_X.concat([7500, 8000]), // resized 1-D table
  lambda: lambdaB,         // + filled hole + one changed cell
  inj: injCells(1),        // a few cells changed, one extra hole
  ignition: false,         // whole table removed (missing-right)
  vvt: true                // whole table added  (missing-left)
}));

const lockedXml = adjustXml(tuneBody('3.5.1', true, {
  mapName: 'Dealer map',
  revLimit: 7500,
  injFlow: 320,
  lambdaX: LAMBDA_X,
  lambda: lambdaA,
  inj: injCells(0),
  ignition: true,
  vvt: false
}));

/* ---- Write + round-trip --------------------------------------------- */

function write(name, buf) {
  const p = path.join(FIXDIR, name);
  fs.writeFileSync(p, buf);
  return p;
}

async function main() {
  fs.mkdirSync(FIXDIR, { recursive: true });
  const files = [
    write('tuneA.ftm', zlib.deflateSync(Buffer.from(tuneAXml, 'utf8'))),          // zlib 78 ..
    write('tuneB.ftm', zlib.gzipSync(Buffer.from(tuneBXml, 'utf8'))),             // gzip 1f 8b
    write('tuneLocked.ftm', zlib.deflateSync(Buffer.from(lockedXml, 'utf8')))
  ];
  for (const f of files) console.log('wrote', f, fs.statSync(f).size, 'bytes');

  // Round-trip: the core must read back what we just wrote.
  const a = await FtmCore.parseFtm(fs.readFileSync(files[0]));
  const b = await FtmCore.parseFtm(fs.readFileSync(files[1]));
  const l = await FtmCore.parseFtm(fs.readFileSync(files[2]));

  const aTables = FtmCore.extractTables(a.tree).map(t => t.name);
  const bTables = FtmCore.extractTables(b.tree).map(t => t.name);
  const assert = require('node:assert');
  assert.deepStrictEqual(aTables, ['Lambda_1', 'Injector_Pulse', 'Ignition_Advance']);
  assert.deepStrictEqual(bTables, ['Lambda_1', 'Injector_Pulse', 'VVT_Advance']);
  assert.strictEqual(a.locked, false);
  assert.strictEqual(l.locked, true);
  assert.strictEqual(a.swVersion, '3.5.1');
  assert.strictEqual(b.swVersion, '3.5.2');
  assert.strictEqual(a.tree.Injection_Config['Idle_Stepper'], 'Idle-&-Warmup');
  console.log('round-trip OK: A tables=' + aTables.join(',') + ' | B tables=' + bTables.join(',') +
    ' | locked fixture locked=' + l.locked);
}

main().catch(e => { console.error(e); process.exit(1); });
