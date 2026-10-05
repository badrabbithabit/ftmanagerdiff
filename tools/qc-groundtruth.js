/* tools/qc-groundtruth.js — INDEPENDENT structural scan of the inflated XML
 * of a real .ftm, deliberately NOT using src/ftm-core.js's parser.
 * A minimal tag scanner builds a name-only tree with leaf text; we then count
 * tables (elements with a direct <Linhas> child), inspect axes/cells, and hunt
 * for structural surprises (attrs, nested tables, multiple Tabela, empty
 * tables, >2 axes, SecurityConfig/Tuner_Enabled).
 *
 * Usage: node tools/qc-groundtruth.js [sample.ftm]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function inflate(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf).toString('utf8');
  if (buf[0] === 0x78) return zlib.inflateSync(buf).toString('utf8');
  throw new Error('not gzip/zlib');
}

/* Minimal tag scanner -> lightweight tree (name, attrs, children, text). */
function scan(xml) {
  const src = xml.replace(/^\uFEFF/, '');
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_:][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m, last = 0, bad = 0;
  while ((m = re.exec(src))) {
    const [, close, name, attrSrc, selfc] = m;
    const text = src.slice(last, m.index).trim();
    last = re.lastIndex;
    if (close) {
      const e = stack.pop();
      if (e && text) e.text += ' ' + text; // text just before </name>
      if (!e || e.name !== name) bad++; // unbalanced
      continue;
    }
    if (text) stack[stack.length - 1].text += ' ' + text;
    const attrs = {};
    for (const a of attrSrc.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
      attrs[a[1]] = a[2] !== undefined ? a[2] : a[3];
    const el = { name, attrs, children: [], text: '', selfClose: !!selfc };
    stack[stack.length - 1].children.push(el);
    if (!selfc) stack.push(el);
  }
  return { root, unbalanced: bad + stack.length - 1 };
}

const isTable = el => el.children.some(c => c.name === 'Linhas');
const child = (el, name) => el.children.filter(c => c.name === name);
const dbl = el => el ? el.children.filter(c => c.name === 'double').map(c => c.text) : null;

function walk(el, cb, p) {
  cb(el, p);
  el.children.forEach(c => walk(c, cb, p.concat(el.name)));
}

function main(file) {
  const xml = inflate(fs.readFileSync(file));
  const { root, unbalanced } = scan(xml);
  console.log('file:', path.basename(file));
  console.log('unbalanced tags:', unbalanced);
  console.log('root element(s):', root.children.map(c => c.name + ' attrs=' + JSON.stringify(c.attrs)).join(', '));

  const tables = [];
  walk(root, (el, p) => { if (isTable(el)) tables.push({ el, p }); }, []);
  console.log('GROUND-TRUTH table count (elements with direct Linhas child):', tables.length);

  const attrEls = [], multiTabela = [], multiLinhas = [], multiColunas = [], emptyTables = [];
  const tableChildNames = new Map();
  let nestedTables = 0;
  walk(root, (el) => {
    if (Object.keys(el.attrs).length) attrEls.push(el.name + ' ' + JSON.stringify(el.attrs));
    if (isTable(el)) {
      const names = {};
      el.children.forEach(c => names[c.name] = (names[c.name] || 0) + 1);
      for (const n in names) tableChildNames.set(n, (tableChildNames.get(n) || 0) + names[n]);
      if ((names.Tabela || 0) > 1) multiTabela.push(el.name);
      if ((names.Linhas || 0) > 1) multiLinhas.push(el.name);
      if ((names.Colunas || 0) > 1) multiColunas.push(el.name);
      const nL = child(el, 'Linhas')[0] ? child(el, 'Linhas')[0].children.filter(c => c.name === 'double').length : 0;
      const nC = child(el, 'Colunas')[0] ? child(el, 'Colunas')[0].children.filter(c => c.name === 'double').length : 0;
      const tab = child(el, 'Tabela')[0];
      const nItems = tab ? tab.children.filter(c => c.name === 'Item').length : 0;
      if (!nL && !nItems) emptyTables.push(el.name);
      el.__dims = [nL, nC, nItems];
    }
  }, []);
  (function nestWalk(el, inside) {
    const t = isTable(el);
    if (t && inside) nestedTables++;
    el.children.forEach(c => nestWalk(c, inside || t));
  })(root, false);

  console.log('elements with attributes (non-root):',
    attrEls.filter(a => !a.startsWith('Adjust ')).length, attrEls.slice(0, 5));
  console.log('nodes with >1 Tabela child:', multiTabela.length, multiTabela.slice(0, 5));
  console.log('nodes with >1 Linhas child:', multiLinhas.length, multiLinhas.slice(0, 5));
  console.log('nodes with >1 Colunas child:', multiColunas.length, multiColunas.slice(0, 5));
  console.log('nested table-in-table:', nestedTables);
  console.log('empty tables (no Linhas doubles, no Tabela items):', emptyTables.length, emptyTables.slice(0, 5));
  console.log('child-name histogram under table nodes:', [...tableChildNames.entries()].sort((a, b) => b[1] - a[1]));

  const sec = [];
  walk(root, (el, p) => { if (/Security|Tuner_Enabled/i.test(el.name)) sec.push(p.concat(el.name).join('/')); }, []);
  console.log('Security nodes:', sec.slice(0, 10));

  const dims = {};
  tables.forEach(({ el }) => { const k = el.__dims.join('x'); dims[k] = (dims[k] || 0) + 1; });
  console.log('dims (rows x cols x items) histogram top:', Object.entries(dims).sort((a, b) => b[1] - a[1]).slice(0, 12));

  // dump a few specific tables fully for cell-level cross-check
  const picks = tables.filter(t => /Mapa_Principal|Ignicao/i.test(t.el.name)).slice(0, 2)
    .concat(tables.slice(0, 1));
  const uniq = [...new Map(picks.map(p => [p.p.join('/') + ':' + p.el.name, p])).values()].slice(0, 3);
  for (const { el, p } of uniq) {
    console.log('\nTABLE', p.concat(el.name).join('/'), 'dims', el.__dims.join('x'));
    console.log('  Linhas:', dbl(child(el, 'Linhas')[0]));
    console.log('  Colunas:', dbl(child(el, 'Colunas')[0]));
    const tab = child(el, 'Tabela')[0];
    if (tab) {
      const items = tab.children.filter(c => c.name === 'Item');
      items.slice(0, 3).forEach((it, r) => {
        const dict = it.children.find(c => c.name === 'Value');
        const sd = dict ? dict.children.find(c => c.name === 'SerializableDictionaryOfDoubleDouble') : null;
        const cells = sd ? sd.children.filter(c => c.name === 'Item') : [];
        console.log('  row', r, 'cells', cells.length, cells.slice(0, 4).map(cellTxt));
      });
    }
  }
}

function cellTxt(cell) {
  const k = cell.children.find(c => c.name === 'Key');
  const v = cell.children.find(c => c.name === 'Value');
  return 'K=' + (k ? rawText(k) : '?') + ' V=' + (v ? rawText(v) : '?');
}
function rawText(el) {
  const d = el.children.find(c => c.name === 'double');
  return d ? d.text : (el.text || '?');
}

if (require.main === module) main(process.argv[2] || 'samples/ft550_line_example_LS7.ftm');
module.exports = { inflate, scan, isTable };
