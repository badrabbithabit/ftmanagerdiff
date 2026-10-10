# FT550 Tune Compare — Plan

Goal: a tool to compare two FuelTech FT550 (FT Manager) tune files and show a
clear diff of tables/parameters. FT Manager has no compare feature;
TuneCompare.com is dead.

## Status legend
- [ ] todo | [~] in progress | [x] done | [!] blocked

## Phase 1 — Research
- [x] 1a. Existing tools: NONE found. GitHub has no FT tune parser/differ.
      FT Manager itself has no map-vs-map diff; only Ctrl+C table copy and
      datalog export. Closest: leechardes/fueltune-analyzer (logs, not tunes).
- [x] 1b. TuneCompare.com forensics: **the site is STILL LIVE over plain HTTP**
      (http://tunecompare.com, expired cert, empty over https). Saved to
      research/tunecompare_live.html (89KB). Entire app = inline obfuscated JS,
      100% client-side (readAsArrayBuffer → pako inflate → JSON tree diff → HTML).
      Script extracted to research/tunecompare_script_0.js (84KB).
- [x] 1c. File format: **.ftm = compressed (zlib/deflate, pako) JSON payload**
      (inferred from TuneCompare's code + filext.com "compressed tuning data").
      No official spec/SDK. FTCAN 2.0 protocol doc exists but is CAN telemetry,
      not file format. No community RE write-ups.

## Phase 2 — Format acquisition
- [x] 2a. Deobfuscated TuneCompare JS → research/tunecompare_deobfuscated.js,
      research/tunecompare_strings.txt, research/tunecompare_analysis.md.
- [x] 2b. Samples: 13 official FuelTech example maps downloaded
      (fueltech.com.br/pages/mapas-de-exemplo → cdn.shopify direct links)
      into samples/ — incl. 2 genuine FT550-class maps. User's own ECU maps
      still welcome as extra QC but no longer blocking.
- [x] 2c. Format recovered from code:
      * .ftm byte 0 = deflate stream (zlib 0x78.. or gzip 0x1f8b, no magic/header).
      * Inflated payload = **XML**, root element `<Adjust>` (NOT JSON).
      * Tables: node with `Colunas.double` (X axis), `Linhas.double` (Y axis),
        `Tabela.Item[row].Value.SerializableDictionaryOfDoubleDouble.Item[]`
        of {Key:{double},Value:{double}} — sparse .NET Dictionary cells;
        len(Linhas)==1 → 1-D curve.
      * Lock: Adjust/SecurityConfig/SecurityFlags/Tuner_Enabled truthy → TuneCompare
        hides contents (we'll show with a warning instead).
      * SW_Version presence → scalars grouped under synthetic FileInfo branch.
      * Diff: recursive by key name; numeric tolerance 0.001; table diff =
        positional base−comp only if dims match; rainbow cell coloring.
      * 100% client-side, zero network calls.

## Phase 3 — Build
- [x] 3a. Core lib src/ftm-core.js (UMD, browser+node): inflate (gzip/zlib/raw
      auto-detect w/ zlib header validation), XML→object, sparse-dict table
      model, diff engine (0.001 tol), lock detection (contents preserved).
- [x] 3b. UI: index.html + src/ui.js + styles.css — dark, offline, drag-drop,
      collapsible diff tree, Base/Compare/Difference grid tabs with diverging
      color scale, only-diff toggle, summary bar. Zero network calls.
- [x] 3c. Fixtures: tools/make-fixtures.js → fixtures/tuneA.ftm (zlib),
      tuneB.ftm (gzip), tuneLocked.ftm.

## Phase 4 — QA
- [x] 4a. tests/core.test.js (11) + tests/qa/qa.test.js (9 adversarial) —
      all 20 pass via `node tests/run-all.js`.
- [x] 4b. Reviewer pass found+fixed: UI missing-left/right swap, backwards doc
      comment, codepoint-bomb crash, 0x78 raw-deflate misdetect, same-name
      sibling table path collision.
- [x] 4c. Validated on REAL maps: 13 official FuelTech example maps in
      samples/ (2 FT550-class, FT500/600/450; from fueltech.com.br
      'mapas-de-exemplo', cdn.shopify direct links). 11/11 parse (370 tables,
      correct ProductID/SW/fileInfo); 2 encrypted/protected maps (.ftm with
      non-deflate magic 39fa/4d23) rejected gracefully. Self-diff invariant
      = 0 changes for all 11. Pair diffs hand-checked vs raw XML (24 cells,
      all match); dim-mismatch fires (95/55 cases). tests/qa/real-samples.test.js
      (10) wired into run-all → 30 tests, 3 suites, all green.
- [ ] 4d. Eyeball the UI in a real browser with the samples (user).

## Phase 5 — Enhancements
- [x] 5a. Tables-first summary view: flat list of all tables with per-table
      delta stats (changed cells, min/max/avg delta, dims, status), sortable,
      searchable; click → existing Base/Compare/Difference panel. Tree view
      becomes a toggle. Core: diffTable now always returns full stats
      (totalCells, min/max/maxAbs/meanAbsDelta, dimsBase/dimsComp; dim
      mismatch = overlap counts, null delta numbers) + summarizeTables()
      (path-union rows, default most-changed-first). QA: qa/table-view.test.js
      on the BMW pair (370 rows: 47 changed / 95 resized / 228 equal, top row
      InjTables/Inj_MainTps_A_Table 23×13→24×15 299/299 overlap cells).
- [x] 5b. QA pass on 5a: reviewer found resized-rows-dominant sort, misleading
      overlap counts, NaN-only stats showing 0, path-collision drop, CSS.escape
      fallback — all fixed. Default sort now status-aware (changed → resized →
      only-in-* → equal); resized tables with matching overlap axes get real
      delta stats (16/95 in BMW pair, rest honestly '—'); new '% changed'
      sortable column + honesty tooltips. 4 suites / 42 tests green.

## Phase 5.5 — FTManager 5.6 encrypted owner maps (discovered 2026-10-05)
- [x] User's own maps (read from ECU, NO password, FTManager 5.6) are the
      encrypted container flavor. Docs corrected (FORMAT.md), error message
      improved, and a real bug found via these files: random bytes that
      coincidentally raw-inflate produced an empty parse — now rejected
      (assertXmlText + no-root guard + regression test). 43 tests green.
- [ ] Decide path for owner maps: (a) ask FuelTech support for open-format
      export; (b) try older FTManager (5.22/5.36) read/save; (c) determinism
      test — re-read same map twice, compare bytes; (d) reverse-engineering
      the container is legally gray (DMCA) — user's own data, but do NOT
      publish a general decryptor.
- [x] (d) DONE: container fully RE'd from FTManager 5.60 (AES-256-CBC, fixed
      key=SHA256(ID1), iv 'kE1(iH1#fD2@bB2+'; see research/ftm560/REVERSE.md).
      All 3 owner maps decrypt → gzip XML. Support wired into core+UI via
      src/ftm-crypto-local.js (pure JS). OWNER DECISION 2026-10: module
      PUBLISHED (option C, risk accepted — vendor-wide fixed key; restore
      the .gitignore rule if a takedown ever arrives). 5 suites/47 tests
      green incl. pure-JS AES/SHA vs node crypto cross-check + flex-vs-gas
      real diff on decrypted maps.

## Decisions log
- Local single-page web app (TuneCompare replacement UX), dependency-free,
  fully offline. Core is a UMD lib so node tests exercise the same code path.
- Deviations from original TuneCompare (documented in README): locked maps are
  shown with a warning instead of blanked; compare-only keys reported; table
  cells matched by Key not position; raw-deflate accepted as fallback.

## Findings log
- Full format writeup now lives in **docs/FORMAT.md** (single source of truth).
- 2026-10-05: **Two .ftm container flavors**: open (gzip/zlib XML at byte 0) and
  **encrypted** (observed on 2 official PnP maps: magic 39fa/4d23, entropy
  7.998, incompressible, per-file keys). Encrypted = FuelTech's commercial
  plug-and-play calibrations (IP protection); we reject them by design,
  do not attempt cracking (license/DMCA). Soft lock (Tuner_Enabled) is a
  separate, in-XML honor-system tier.
- 2026-10-05: Real-map stats: v5.x maps ≈ 370 tables + 22 scalars; v4.71 map
  had 261 (cross-version diffs produce many structural changes + resized
  tables — expected). Axis keys can be negative/fractional; empty 0×0 tables
  exist (Func_EtcSlewControl_Table); <SERIAL> is a base64 ECU-binding blob.
- 2026-10-05: No existing tool found (research subagent). .ftm extension confirmed
  by TuneCompare copy + filext.com. (Initial "compressed JSON" guess was wrong —
  it is compressed XML; corrected in Phase 2c.)
- 2026-10-05: http://tunecompare.com still serves the full app (HTTP only,
  expired cert). Archived assets: research/tunecompare_live.html,
  tunecompare_script_0.js (main obfuscated script), styles.css, privacy.html.
- Search infra note: DDG/Mojeek/Ecosia/searx anti-bot blocked; Brave search via
  curl works; Bing RSS returns junk; GitHub API + Wayback CDX work.
