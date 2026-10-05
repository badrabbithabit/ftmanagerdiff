/* ftm-core.js
 * Offline comparison core for FuelTech FT Manager .ftm files.
 * UMD: usable from a browser <script> (window.FtmCore) and from node require().
 * No dependencies, no DOM APIs. Spec source: research/tunecompare_analysis.md
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FtmCore = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const NUM_TOL = 0.001;

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  /** Wrap a possibly-collapsed single child in an array. */
  function asArray(v) { return v == null ? [] : Array.isArray(v) ? v : [v]; }

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  /** Text of a node: bare string (text-only element) or its '#' key. */
  function scalarText(v) {
    if (v == null) return '';
    if (typeof v === 'object') return isPlainObject(v) && '#' in v ? String(v['#']) : '';
    return String(v);
  }

  /** 'true'|'yes'|'1' -> true, 'false'|'no'|'0'|'' -> false, else Boolean(v). */
  function stringToBoolean(v) {
    switch (scalarText(v).toLowerCase().trim()) {
      case 'true': case 'yes': case '1': return true;
      case 'false': case 'no': case '0': case '': return false;
      default: return Boolean(v);
    }
  }

  /** Numeric parse of a scalar; null when not a plain number. */
  function toNum(v) {
    const s = scalarText(v).trim();
    if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  /** Follow a 'a/b/c' path through the parsed tree; arrays use their first item. */
  function getPath(obj, path) {
    let cur = obj;
    for (const part of String(path).split('/')) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[part];
      if (Array.isArray(cur)) cur = cur[0];
    }
    return cur;
  }

  /* ------------------------------------------------------------------ *
   * Inflate (pluggable backend; node zlib / browser DecompressionStream)
   * ------------------------------------------------------------------ */

  let inflateBackend = null; // fn(bytes, kind) -> string | Uint8Array | Promise<...>

  /** Override the inflate implementation (tests / exotic environments). */
  function setInflateBackend(fn) { inflateBackend = fn; }

  function decodeText(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    return Buffer.from(bytes).toString('utf8');
  }

  function nodeZlib() {
    try {
      if (typeof require === 'function') return require('zlib');
    } catch (e) { /* browser */ }
    return null;
  }

  /**
   * Inflate a .ftm buffer to XML text.
   * Accepts gzip (1f 8b), zlib (78 xx) or, as a fallback, raw deflate.
   * Returns a Promise<string> (DecompressionStream is async in the browser).
   */
  function inflateFtm(bytes) {
    let buf;
    try { buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); }
    catch (e) { return Promise.reject(new Error('input is not a byte buffer')); }
    if (buf.length < 2) return Promise.reject(new Error('file too small to be a .ftm'));

    let kind;
    if (buf[0] === 0x1f && buf[1] === 0x8b) kind = 'gzip';
    else if (buf[0] === 0x78 && (buf[0] & 0x0f) === 8 && (((buf[0] << 8) | buf[1]) % 31 === 0)) kind = 'zlib';
    else kind = 'raw'; // raw deflate, incl. 0x78-prefixed streams with an invalid zlib header

    if (inflateBackend) {
      return Promise.resolve(inflateBackend(buf, kind)).then(r =>
        typeof r === 'string' ? r : decodeText(r));
    }

    const zlib = nodeZlib();
    if (zlib) {
      try {
        const out = kind === 'gzip' ? zlib.gunzipSync(buf)
          : kind === 'zlib' ? zlib.inflateSync(buf)
          : zlib.inflateRawSync(buf);
        return Promise.resolve(decodeText(out));
      } catch (e) {
        return Promise.reject(new Error('inflate failed (' + kind + '): ' + e.message));
      }
    }

    if (typeof DecompressionStream === 'function' && typeof Response !== 'undefined') {
      const label = kind === 'gzip' ? 'gzip' : kind === 'zlib' ? 'deflate' : 'deflate-raw';
      return new Response(new Blob([buf]).stream()
        .pipeThrough(new DecompressionStream(label))).text();
    }
    return Promise.reject(new Error('no inflate backend available'));
  }

  /* ------------------------------------------------------------------ *
   * XML parser (self-contained, xml-js-minimal style, no single-child bug)
   * ------------------------------------------------------------------ */

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

  function decodeEntities(s) {
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
      if (g[0] === '#') {
        const cp = (g[1] === 'x' || g[1] === 'X') ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
        const ok = Number.isInteger(cp) && cp >= 0 && cp <= 0x10FFFF &&
          !(cp >= 0xD800 && cp <= 0xDFFF); // reject out-of-range and lone surrogates
        return ok ? String.fromCodePoint(cp) : m;
      }
      return Object.prototype.hasOwnProperty.call(ENTITIES, g) ? ENTITIES[g] : m;
    });
  }

  function parseAttrs(src) {
    const out = {};
    const re = /([A-Za-z_:][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/g;
    let m;
    while ((m = re.exec(src))) out['@' + m[1]] = decodeEntities(m[2].slice(1, -1));
    return out;
  }

  /**
   * XML text -> plain object tree keyed by the root element name, e.g.
   * { Adjust: { ... } } (same convention as TuneCompare's ftconvert).
   *  - attributes  -> '@name' keys
   *  - text        -> '#' key (only when the element also has attrs/children)
   *  - repeated siblings -> array; single sibling -> single value (use asArray())
   *  - text-only element -> the text string (so <double>0</double> === '0')
   *  - comments, PIs, DOCTYPE are skipped; CDATA kept verbatim
   */
  function parseXml(text) {
    const src = String(text).replace(/^\uFEFF/, '');
    const rootEl = { name: '#document', attrs: {}, children: [], text: '' };
    const stack = [rootEl];
    const top = () => stack[stack.length - 1];
    const addText = (raw, verbatim) => {
      const t = verbatim ? raw : decodeEntities(raw);
      if (!t || !t.trim()) return;
      const n = top();
      n.text = n.text ? n.text + ' ' + t.trim() : t.trim();
    };

    let i = 0;
    const len = src.length;
    while (i < len) {
      const lt = src.indexOf('<', i);
      if (lt < 0) { addText(src.slice(i)); break; }
      if (lt > i) addText(src.slice(i, lt));

      if (src.startsWith('<!--', lt)) {
        const e = src.indexOf('-->', lt + 4); i = e < 0 ? len : e + 3; continue;
      }
      if (src.startsWith('<![CDATA[', lt)) {
        const e = src.indexOf(']]>', lt + 9);
        addText(src.slice(lt + 9, e < 0 ? len : e), true);
        i = e < 0 ? len : e + 3; continue;
      }
      if (src.startsWith('<?', lt)) { const e = src.indexOf('?>', lt + 2); i = e < 0 ? len : e + 2; continue; }
      if (src.startsWith('<!', lt)) { const e = src.indexOf('>', lt + 2); i = e < 0 ? len : e + 1; continue; }
      if (src.startsWith('</', lt)) {
        const e = src.indexOf('>', lt);
        const name = src.slice(lt + 2, e < 0 ? len : e).trim();
        for (let s = stack.length - 1; s > 0; s--) {
          if (stack[s].name === name) { stack.length = s; break; }
        }
        i = e < 0 ? len : e + 1; continue;
      }

      let j = lt + 1, q = 0;
      for (; j < len; j++) {
        const ch = src[j];
        if (q) { if (ch === q) q = 0; continue; }
        if (ch === '"' || ch === "'") { q = ch; continue; }
        if (ch === '>') break;
      }
      let inner = src.slice(lt + 1, j);
      const selfClose = inner.endsWith('/');
      if (selfClose) inner = inner.slice(0, -1);
      const sp = inner.search(/\s/);
      const name = sp < 0 ? inner : inner.slice(0, sp);
      const attrs = parseAttrs(sp < 0 ? '' : inner.slice(sp + 1));
      const el = { name, attrs, children: [], text: '' };
      top().children.push(el);
      if (!selfClose) stack.push(el);
      i = j + 1;
    }

    function toObj(n) {
      const hasAttrs = Object.keys(n.attrs).length > 0;
      if (!hasAttrs && n.children.length === 0) return n.text; // text-only or empty -> string
      const out = {};
      for (const k in n.attrs) out[k] = n.attrs[k];
      if (n.text) out['#'] = n.text;
      for (const c of n.children) {
        const v = toObj(c);
        if (Object.prototype.hasOwnProperty.call(out, c.name)) {
          const prev = out[c.name];
          if (Array.isArray(prev)) prev.push(v); else out[c.name] = [prev, v];
        } else out[c.name] = v;
      }
      return out;
    }

    const out = {};
    for (const el of rootEl.children) {
      const v = toObj(el);
      if (Object.prototype.hasOwnProperty.call(out, el.name)) {
        const prev = out[el.name];
        if (Array.isArray(prev)) prev.push(v); else out[el.name] = [prev, v];
      } else out[el.name] = v;
    }
    return out; // keyed by root element name, e.g. { Adjust: {...} }
  }

  /* ------------------------------------------------------------------ *
   * .ftm parsing
   * ------------------------------------------------------------------ */

  /**
   * bytes -> Promise<{ tree, rootName, locked, swVersion, fileInfo }>
   * A locked map keeps its contents (unlike TuneCompare, which wipes them);
   * `locked` is set so the UI can warn.
   */
  function parseFtm(bytes) {
    return inflateFtm(bytes).then(xml => {
      const doc = parseXml(xml);
      const rootName = Object.keys(doc)[0] || '';
      const tree = isPlainObject(doc[rootName]) ? doc[rootName] : {};
      const lockNode = getPath(tree, 'SecurityConfig/SecurityFlags/Tuner_Enabled');
      const swVersion = getPath(tree, 'SW_Version');
      const fileInfo = {};
      for (const k of Object.keys(tree)) {
        if (k[0] === '@' || k === '#') continue;
        if (isPlainObject(tree[k]) || Array.isArray(tree[k])) continue;
        fileInfo[k] = scalarText(tree[k]);
      }
      return {
        tree,
        rootName,
        locked: lockNode === undefined ? false : stringToBoolean(lockNode),
        swVersion: swVersion === undefined ? null : scalarText(swVersion),
        fileInfo
      };
    });
  }

  /* ------------------------------------------------------------------ *
   * Table extraction
   * ------------------------------------------------------------------ */

  function doubles(node) {
    return asArray(isPlainObject(node) ? node.double : node).map(v => {
      const n = toNum(v);
      return n === null ? NaN : n;
    });
  }

  /** Item[] of a row's sparse Dictionary<double,double> (empty when absent). */
  function cellItems(rowItem) {
    if (!isPlainObject(rowItem) || !isPlainObject(rowItem.Value)) return [];
    const dict = rowItem.Value.SerializableDictionaryOfDoubleDouble;
    return asArray(isPlainObject(dict) ? dict.Item : undefined);
  }

  function cellNum(cell, key) {
    if (!isPlainObject(cell)) return NaN;
    const raw = isPlainObject(cell[key]) ? cell[key].double !== undefined ? cell[key].double : cell[key] : cell[key];
    const n = toNum(Array.isArray(raw) ? raw[0] : raw);
    return n === null ? NaN : n;
  }

  /**
   * Walk the tree and return every table node (a node that has `Linhas`).
   * Each entry: { path, name, xAxes, yAxes, rows, cols, matrix, is1D }
   * matrix is dense rows x cols, NaN where the sparse dictionary has no cell.
   */
  function extractTables(tree) {
    const out = [];

    function readTable(node, path) {
      const xAxes = doubles(isPlainObject(node.Colunas) ? node.Colunas.double : node.Colunas);
      const yAxes = doubles(isPlainObject(node.Linhas) ? node.Linhas.double : node.Linhas);
      const items = asArray(isPlainObject(node.Tabela) ? node.Tabela.Item : undefined);
      const rows = Math.max(yAxes.length, items.length);
      while (yAxes.length < rows) yAxes.push(NaN);
      const cols = Math.max(xAxes.length, items.reduce((mx, it) => Math.max(mx, cellItems(it).length), 0));
      while (xAxes.length < cols) xAxes.push(NaN);

      const matrix = [];
      for (let r = 0; r < rows; r++) matrix.push(new Array(cols).fill(NaN));

      items.forEach((it, r) => {
        if (r >= rows || !isPlainObject(it)) return;
        const cells = cellItems(it);
        cells.forEach((cell, idx) => {
          const key = cellNum(cell, 'Key');
          const val = cellNum(cell, 'Value');
          let c = -1;
          if (Number.isFinite(key)) {
            for (let k = 0; k < xAxes.length; k++) {
              if (Math.abs(xAxes[k] - key) < 1e-9) { c = k; break; }
            }
          }
          if (c < 0) c = idx;
          if (c >= 0 && c < cols) matrix[r][c] = val;
        });
      });

      out.push({
        path: path.slice(),
        name: path[path.length - 1],
        xAxes, yAxes, rows, cols, matrix,
        is1D: rows === 1
      });
    }

    function walk(node, path) {
      if (Array.isArray(node)) { node.forEach(n => walk(n, path)); return; }
      if (!isPlainObject(node)) return;
      for (const k of Object.keys(node)) {
        if (k[0] === '@' || k === '#') continue;
        const kids = asArray(node[k]);
        kids.forEach((c, idx) => {
          // Array children get their index in the path so same-name sibling
          // tables stay addressable and match the diff tree, which keys
          // arrays by index.
          const childPath = kids.length > 1 ? path.concat(k, String(idx)) : path.concat(k);
          if (isPlainObject(c) && Object.prototype.hasOwnProperty.call(c, 'Linhas')) readTable(c, childPath);
          else walk(c, childPath);
        });
      }
    }

    if (isPlainObject(tree) && Object.prototype.hasOwnProperty.call(tree, 'Linhas')) {
      readTable(tree, ['(root)']); // caller handed in the table node itself
    } else {
      walk(tree, []);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Tree diff
   * ------------------------------------------------------------------ */

  function compareNode(a, b) {
    const out = { status: 'nested', anyDiff: false, children: {} };
    const keys = [];
    const seen = {};
    for (const src of [a, b]) {
      if (!isPlainObject(src) && !Array.isArray(src)) continue;
      for (const k of Object.keys(src)) {
        if (k[0] === '@' || k === '#' || seen[k]) continue;
        seen[k] = 1; keys.push(k);
      }
    }
    for (const k of keys) {
      const inA = (isPlainObject(a) || Array.isArray(a)) && Object.prototype.hasOwnProperty.call(a, k);
      const inB = (isPlainObject(b) || Array.isArray(b)) && Object.prototype.hasOwnProperty.call(b, k);
      let e;
      if (inA && !inB) e = { status: 'missing-left', base: a[k], comp: undefined, anyDiff: true };
      else if (!inA && inB) e = { status: 'missing-right', base: undefined, comp: b[k], anyDiff: true };
      else e = compareValues(a[k], b[k]);
      out.children[k] = e;
      if (e.anyDiff) out.anyDiff = true;
    }
    return out;
  }

  function compareValues(a, b) {
    const ao = isPlainObject(a) || Array.isArray(a);
    const bo = isPlainObject(b) || Array.isArray(b);
    if (ao && bo) return compareNode(a, b);
    if (ao !== bo) return { status: 'changed', base: a, comp: b, anyDiff: true, typeChange: true };
    const an = toNum(a), bn = toNum(b);
    if (an !== null && bn !== null) {
      const delta = an - bn;
      const changed = Math.abs(delta) > NUM_TOL;
      return { status: changed ? 'changed' : 'equal', base: a, comp: b, delta, numeric: true, anyDiff: changed };
    }
    const changed = scalarText(a).trim() !== scalarText(b).trim();
    return { status: changed ? 'changed' : 'equal', base: a, comp: b, anyDiff: changed };
  }

  /**
   * Recursive diff of two parsed trees.
   * status: equal | changed | missing-left (only in base, entry.base set) |
   * missing-right (only in compare, entry.comp set) | nested. Numeric leaves
   * use tolerance NUM_TOL (0.001).
   */
  function diffTrees(a, b) { return compareNode(a, b); }

  /** Count changed / missing leaves in a diff result (nested branches excluded). */
  function countChanges(diff) {
    if (!diff || diff.status !== 'nested') {
      return diff && diff.anyDiff ? 1 : 0;
    }
    let n = 0;
    for (const k of Object.keys(diff.children)) {
      const e = diff.children[k];
      if (e.status === 'nested') n += countChanges(e);
      else if (e.anyDiff) n++;
    }
    return n;
  }

  /* ------------------------------------------------------------------ *
   * Table diff
   * ------------------------------------------------------------------ */

  /**
   * Positional cell diff of two extracted tables: delta = base - comp.
   * Returns { sameSize:false, reason } when dimensions differ.
   * NaN cells (missing in the sparse dict) stay NaN; NaN-vs-value counts
   * as changed, NaN-vs-NaN does not.
   */
  function diffTable(base, comp) {
    if (!base || !comp) return { sameSize: false, reason: 'table missing on one side' };
    if (base.rows !== comp.rows || base.cols !== comp.cols) {
      return {
        sameSize: false,
        reason: 'Base and Compare tables are not the same size',
        baseSize: [base.rows, base.cols],
        compSize: [comp.rows, comp.cols]
      };
    }
    const deltaMatrix = [];
    let changedCells = 0, maxAbsDelta = 0;
    for (let r = 0; r < base.rows; r++) {
      const row = new Array(base.cols);
      for (let c = 0; c < base.cols; c++) {
        const x = base.matrix[r][c], y = comp.matrix[r][c];
        const xn = Number.isNaN(x), yn = Number.isNaN(y);
        if (xn && yn) { row[c] = NaN; continue; }
        const d = x - y;
        row[c] = d;
        if (d !== 0) {
          changedCells++;
          if (Number.isFinite(d) && Math.abs(d) > maxAbsDelta) maxAbsDelta = Math.abs(d);
        }
      }
      deltaMatrix.push(row);
    }
    const axisDelta = (u, v) => u.map((x, i) => x - v[i]);
    return {
      sameSize: true,
      deltaMatrix,
      changedCells,
      maxAbsDelta,
      xDelta: axisDelta(base.xAxes, comp.xAxes),
      yDelta: axisDelta(base.yAxes, comp.yAxes)
    };
  }

  return {
    NUM_TOL,
    asArray, scalarText, stringToBoolean, toNum, getPath,
    setInflateBackend, inflateFtm,
    parseXml, parseFtm,
    extractTables,
    diffTrees, countChanges,
    diffTable
  };
}));
