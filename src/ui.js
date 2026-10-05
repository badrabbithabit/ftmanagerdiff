/* src/ui.js — index.html front-end for ftm-core. No network, no frameworks. */
(function () {
  'use strict';
  const C = window.FtmCore;
  const $ = id => document.getElementById(id);

  const state = {
    base: null, comp: null,
    onlyDiff: true,
    tablePaths: new Set(), tcache: new Map(),
    selected: null, tab: 'base', error: null
  };

  /* ---------------- formatting helpers ---------------- */

  function fmt(v) {                       // 3 significant digits, no exponent noise
    const n = typeof v === 'number' ? v : C.toNum(v);
    if (n === null || !Number.isFinite(n)) return '';
    return String(Number(n.toPrecision(3)));
  }
  function fmtDelta(d) {
    if (Number.isNaN(d)) return '\u2014';
    if (d === 0) return '0';
    return (d > 0 ? '+' : '\u2212') + String(Number(Math.abs(d).toPrecision(3)));
  }
  function valText(v) {
    if (v == null) return '';
    if (typeof v === 'object') return Array.isArray(v) ? '[…]' : '{…}';
    return String(v);
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  /* ---------------- file loading ---------------- */

  async function loadFile(slot, file) {
    if (!file) return;
    state.error = null;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = await C.parseFtm(bytes);
      const tables = C.extractTables(parsed.tree);
      state[slot] = {
        name: file.name,
        parsed,
        tables,
        tmap: new Map(tables.map(t => [t.path.join('/'), t]))
      };
    } catch (e) {
      state[slot] = null;
      state.error = (slot === 'base' ? 'Base' : 'Compare') + ' file could not be read: ' + e.message;
    }
    render();
  }

  function wireSlot(slot, slotId, inputId) {
    const zone = $(slotId), input = $(inputId);
    zone.addEventListener('click', e => { if (e.target !== input) input.click(); });
    zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') input.click(); });
    input.addEventListener('change', () => loadFile(slot, input.files[0]));
    ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => {
      e.preventDefault(); zone.classList.add('drag');
    }));
    ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => {
      e.preventDefault(); zone.classList.remove('drag');
    }));
    zone.addEventListener('drop', e => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(slot, f);
    });
  }

  /* ---------------- table lookup ---------------- */

  function tableInfo(pk) {
    if (state.tcache.has(pk)) return state.tcache.get(pk);
    const b = state.base && state.base.tmap.get(pk);
    const c = state.comp && state.comp.tmap.get(pk);
    const info = { base: b, comp: c, diff: b && c ? C.diffTable(b, c) : null };
    // Core convention: missing-left = present in Base only; missing-right = present in Compare only.
    if (!state.comp) info.status = 'equal';
    else if (!c) info.status = 'missing-left';
    else if (!b) info.status = 'missing-right';
    else info.status = (!info.diff.sameSize || info.diff.changedCells > 0) ? 'changed' : 'equal';
    state.tcache.set(pk, info);
    return info;
  }

  /* ---------------- tree ---------------- */

  function walkDiff(diff, parentUl, path, stats) {
    for (const key of Object.keys(diff.children)) {
      const entry = diff.children[key];
      const p = path.concat(key);
      const pk = p.join('/');
      if (state.tablePaths.has(pk)) { addTableRow(parentUl, key, pk, stats); continue; }

      if (entry.status === 'nested') {
        if (state.onlyDiff && !entry.anyDiff) continue;
        const li = el('li', 'branch' + (entry.anyDiff ? ' changed' : ''));
        const row = el('div', 'row');
        const tw = el('span', 'tw', entry.anyDiff ? '\u25BC' : '\u25B6');
        row.appendChild(tw);
        row.appendChild(el('span', 'key', key));
        const ul = el('ul');
        if (!entry.anyDiff) ul.style.display = 'none';
        li.appendChild(row); li.appendChild(ul);
        row.addEventListener('click', () => {
          const open = ul.style.display !== 'none';
          ul.style.display = open ? 'none' : 'block';
          tw.textContent = open ? '\u25B6' : '\u25BC';
        });
        parentUl.appendChild(li);
        walkDiff(entry, ul, p, stats);
        continue;
      }

      if (state.onlyDiff && !entry.anyDiff) continue;
      const li = el('li', 'leaf');
      const row = el('div', 'row');
      if (entry.status === 'missing-left') {
        li.className += ' missing';
        row.appendChild(el('span', 'key', key + ' \u2717'));
        row.appendChild(el('span', 'val', 'only in Base: ' + valText(entry.base)));
        stats.params++;
      } else if (entry.status === 'missing-right') {
        li.className += ' missing';
        row.appendChild(el('span', 'key', key + ' \u2717'));
        row.appendChild(el('span', 'val', 'only in Compare: ' + valText(entry.comp)));
        stats.params++;
      } else if (entry.status === 'changed') {
        li.className += ' changed';
        row.appendChild(el('span', 'key', key));
        row.appendChild(el('span', 'val', valText(entry.base)));
        row.appendChild(el('span', 'arrow', '\u2192'));
        row.appendChild(el('span', 'val', valText(entry.comp)));
        if (entry.numeric) row.appendChild(el('span', 'delta', '\u0394 ' + fmtDelta(entry.delta)));
        stats.params++;
      } else {
        row.appendChild(el('span', 'key', key));
        row.appendChild(el('span', 'val', ': ' + valText(entry.base)));
      }
      li.dataset.pk = pk;
      row.addEventListener('click', () => openScalar(pk, entry));
      li.appendChild(row);
      parentUl.appendChild(li);
    }
  }

  function addTableRow(parentUl, key, pk, stats) {
    const info = tableInfo(pk);
    stats.tables++;
    if (info.status !== 'equal') stats.tablesChanged++;
    if (info.diff && info.diff.sameSize) stats.cells += info.diff.changedCells;

    const li = el('li', 'table' + (info.status === 'equal' ? '' : ' ' +
      (info.status === 'changed' ? 'changed' : 'missing')));
    li.dataset.pk = pk;
    const row = el('div', 'row');
    row.appendChild(el('span', 'key', key));
    row.appendChild(el('span', 'tag tbl', info.base && info.base.is1D ? 'curve' : 'table'));
    if (info.status === 'changed') {
      row.appendChild(el('span', 'delta', info.diff && info.diff.sameSize
        ? info.diff.changedCells + ' cell' + (info.diff.changedCells === 1 ? '' : 's') + ' changed'
        : 'size differs'));
    } else if (info.status === 'missing-left') {
      row.appendChild(el('span', 'val', '\u2717 missing in Compare'));
    } else if (info.status === 'missing-right') {
      row.appendChild(el('span', 'val', '\u2717 missing in Base'));
    }
    row.addEventListener('click', () => openTable(pk));
    li.appendChild(row);
    parentUl.appendChild(li);
  }

  /* ---------------- panel ---------------- */

  function selectRow(pk) {
    document.querySelectorAll('.selected').forEach(n => n.classList.remove('selected'));
    const node = document.querySelector('[data-pk="' + (window.CSS && CSS.escape ? CSS.escape(pk) : pk) + '"]');
    if (node) node.classList.add('selected');
  }

  function openScalar(pk, entry) {
    state.selected = { kind: 'scalar', pk, entry };
    $('panel').hidden = false;
    $('panelTitle').textContent = pk;
    $('tabs').hidden = true;
    const s = $('scalarInfo');
    s.hidden = false;
    s.textContent = '';
    const pair = (label, v) => {
      const p = el('span', 'pair');
      p.appendChild(el('span', 'val', label));
      p.appendChild(el('span', entry.status === 'changed' ? 'delta' : 'key', valText(v)));
      return p;
    };
    if (entry.status === 'equal') s.appendChild(pair('value:', entry.base));
    else if (entry.status === 'missing-left') s.appendChild(pair('only in Base:', entry.base));
    else if (entry.status === 'missing-right') s.appendChild(pair('only in Compare:', entry.comp));
    else {
      s.appendChild(pair('Base:', entry.base));
      s.appendChild(pair('Compare:', entry.comp));
      if (entry.numeric) s.appendChild(pair('\u0394:', fmtDelta(entry.delta)));
    }
    $('panelBody').textContent = '';
    selectRow(pk);
  }

  function openTable(pk) {
    state.selected = { kind: 'table', pk };
    state.tab = 'base';
    $('panel').hidden = false;
    $('panelTitle').textContent = pk;
    $('scalarInfo').hidden = true;
    $('tabs').hidden = !state.comp;
    paintTabs();
    renderPanelBody();
    selectRow(pk);
  }

  function paintTabs() {
    document.querySelectorAll('#tabs .tab').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === state.tab));
  }

  function renderPanelBody() {
    const body = $('panelBody');
    body.textContent = '';
    if (!state.selected || state.selected.kind !== 'table') return;
    const info = tableInfo(state.selected.pk);
    const tab = state.comp ? state.tab : 'base';

    if (tab === 'base') {
      if (info.base) body.appendChild(renderGrid(info.base, 'base', null));
      else body.appendChild(el('div', 'note', 'Table is missing in the Base file.'));
    } else if (tab === 'comp') {
      if (info.comp) body.appendChild(renderGrid(info.comp, 'comp', null));
      else body.appendChild(el('div', 'note', 'Table is missing in the Compare file.'));
    } else {
      if (!info.diff) body.appendChild(el('div', 'note', 'Table exists in only one file. No diff available.'));
      else if (!info.diff.sameSize) {
        body.appendChild(el('div', 'note', 'Base and Compare tables are not the same size (' +
          info.diff.baseSize.join(' \u00D7 ') + ' vs ' + info.diff.compSize.join(' \u00D7') +
          '). Unable to display the diff grid.'));
        if (info.base) { body.appendChild(el('div', 'legend', 'Base:')); body.appendChild(renderGrid(info.base, 'base', null)); }
        if (info.comp) { body.appendChild(el('div', 'legend', 'Compare:')); body.appendChild(renderGrid(info.comp, 'comp', null)); }
      } else {
        body.appendChild(renderGrid(info.base, 'diff', info.diff));
        body.appendChild(el('div', 'legend',
          '\u0394 = base \u2212 compare \u00B7 ' + info.diff.changedCells + ' of ' +
          (info.base.rows * info.base.cols) + ' cells changed \u00B7 ' +
          'red = base higher, blue = compare higher, saturation \u221D magnitude \u00B7 hatched = no value in the file'));
      }
    }
  }

  function deltaColor(d, maxAbs) {
    if (Number.isNaN(d) || d === 0) return '';
    const a = 0.18 + 0.72 * Math.min(1, Math.abs(d) / (maxAbs || 1));
    return d > 0 ? 'rgba(226,74,74,' + a.toFixed(2) + ')' : 'rgba(64,132,226,' + a.toFixed(2) + ')';
  }

  function renderGrid(table, mode, delta) {
    const tbl = el('table', 'grid');
    const head = el('tr');
    head.appendChild(el('th', 'corner', mode === 'diff' ? '\u0394 \\ Y' : 'X \\ Y'));
    table.xAxes.forEach((x, i) => {
      const th = el('th', null, Number.isNaN(x) ? '?' : fmt(x));
      if (mode === 'diff' && delta && Number.isFinite(delta.xDelta[i]) && delta.xDelta[i] !== 0) {
        th.appendChild(el('span', 'axdelta ' + (delta.xDelta[i] > 0 ? 'pos' : 'neg'), fmtDelta(delta.xDelta[i])));
      }
      head.appendChild(th);
    });
    tbl.appendChild(head);

    for (let r = 0; r < table.rows; r++) {
      const tr = el('tr');
      const y = table.yAxes[r];
      const th = el('th', null, Number.isNaN(y) ? '?' : fmt(y));
      if (mode === 'diff' && !table.is1D && delta && Number.isFinite(delta.yDelta[r]) && delta.yDelta[r] !== 0) {
        th.appendChild(el('span', 'axdelta ' + (delta.yDelta[r] > 0 ? 'pos' : 'neg'), fmtDelta(delta.yDelta[r])));
      }
      tr.appendChild(th);
      for (let c = 0; c < table.cols; c++) {
        let v, cls = '';
        if (mode === 'diff') {
          v = delta.deltaMatrix[r][c];
          if (Number.isNaN(v)) cls = 'nan';
          else {
            cls = v > 0 ? 'pos' : v < 0 ? 'neg' : '';
            const bg = deltaColor(v, delta.maxAbsDelta);
            if (bg) tr.appendChild(el('td', cls, fmtDelta(v))).style.backgroundColor = bg;
            else tr.appendChild(el('td', cls, '0'));
            continue;
          }
        } else {
          v = table.matrix[r][c];
          if (Number.isNaN(v)) cls = 'nan';
        }
        tr.appendChild(el('td', cls, cls === 'nan' ? '\u2014' : fmt(v)));
      }
      tbl.appendChild(tr);
    }
    return tbl;
  }

  /* ---------------- render ---------------- */

  function render() {
    state.tcache = new Map();
    state.tablePaths = new Set();
    [state.base, state.comp].forEach(f => { if (f) f.tmap.forEach((t, pk) => state.tablePaths.add(pk)); });

    for (const [slot, fileId, metaId, badgeId] of [['base', 'baseFile', 'baseMeta', 'baseBadge'],
      ['comp', 'compFile', 'compMeta', 'compBadge']]) {
      const f = state[slot];
      $(fileId).textContent = f ? f.name : 'Drop a .ftm here, or click to browse';
      $(metaId).textContent = f
        ? 'SW ' + (f.parsed.swVersion || '?') + ' \u00B7 ' + f.tables.length + ' tables \u00B7 ' +
          Object.keys(f.parsed.fileInfo).length + ' info fields'
        : '';
      const badge = $(badgeId);
      badge.textContent = f ? (f.parsed.locked ? '\u26A0 locked' : 'open') : '';
      badge.className = 'badge ' + (f && f.parsed.locked ? 'locked' : 'ok');
    }

    const banner = $('banner');
    const locked = [];
    if (state.base && state.base.parsed.locked) locked.push('Base');
    if (state.comp && state.comp.parsed.locked) locked.push('Compare');
    if (state.error) {
      banner.hidden = false;
      banner.className = 'banner error';
      banner.textContent = state.error;
    } else if (locked.length) {
      banner.hidden = false;
      banner.className = 'banner';
      banner.textContent = '\u26A0 ' + locked.join(' and ') +
        ' file is tuner-locked (Tuner_Enabled). Contents are shown anyway \u2014 treat the values with care.';
    } else {
      banner.hidden = true;
    }

    const tree = $('tree');
    tree.textContent = '';
    if (!state.base) {
      tree.appendChild(el('div', 'empty', 'No base map loaded.'));
      $('summary').textContent = 'Load a Base map to start';
      return;
    }
    const diff = C.diffTrees(state.base.parsed.tree, state.comp ? state.comp.parsed.tree : state.base.parsed.tree);
    const stats = { tables: 0, tablesChanged: 0, cells: 0, params: 0 };
    const rootUl = el('ul');
    walkDiff(diff, rootUl, [], stats);
    tree.appendChild(rootUl);
    if (!rootUl.childNodes.length) {
      tree.appendChild(el('div', 'empty', state.comp
        ? 'No differences (with ' + C.NUM_TOL + ' tolerance). Untick "Only show differences" to see everything.'
        : 'Nothing to show.'));
    }

    if (!state.comp) {
      $('summary').innerHTML = '<b>' + stats.tables + '</b> tables loaded (single file \u2014 load a Compare map to diff)';
    } else {
      $('summary').innerHTML =
        '<b>' + stats.tables + '</b> tables \u00B7 <b>' + stats.tablesChanged + '</b> changed \u00B7 ' +
        '<b>' + stats.cells + '</b> changed cells \u00B7 <b>' + stats.params + '</b> params changed';
    }
    if (state.selected) {
      if (state.selected.kind === 'table') openTable(state.selected.pk);
      else {
        const e = lookupDiff(diff, state.selected.pk.split('/'));
        if (e) openScalar(state.selected.pk, e); else $('panel').hidden = true;
      }
    }
  }

  function lookupDiff(diff, path) {
    let node = diff;
    for (const part of path) {
      if (!node || node.status !== 'nested' || !node.children[part]) return null;
      node = node.children[part];
    }
    return node;
  }

  /* ---------------- wiring ---------------- */

  wireSlot('base', 'slotBase', 'baseInput');
  wireSlot('comp', 'slotComp', 'compInput');

  $('onlyDiff').addEventListener('change', e => { state.onlyDiff = e.target.checked; render(); });
  $('clearBtn').addEventListener('click', () => {
    state.base = state.comp = state.selected = state.error = null;
    $('baseInput').value = $('compInput').value = '';
    $('panel').hidden = true;
    render();
  });
  $('panelClose').addEventListener('click', () => {
    state.selected = null;
    $('panel').hidden = true;
    document.querySelectorAll('.selected').forEach(n => n.classList.remove('selected'));
  });
  document.querySelectorAll('#tabs .tab').forEach(b =>
    b.addEventListener('click', () => { state.tab = b.dataset.tab; paintTabs(); renderPanelBody(); }));

  render();
})();
