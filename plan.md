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
- [ ] 2b. Get sample FT550 .ftm files from user for validation. CHECKPOINT: ask user.
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

## Phase 2 — Format acquisition
- [ ] 2a. Get sample FT550 tune files from user (2+ files, ideally same setup
      with known differences). CHECKPOINT: ask user.
- [ ] 2b. Determine format empirically (hexdump, entropy, strings).
- [ ] 2c. Map fields: table names (fuel tables, ignition, VVT, launch, etc.),
      axes, cell values, metadata.

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
- [ ] 4c. Validate on REAL .ftm files (user samples) — the only remaining gap.
      Also eyeball the UI in a real browser (open index.html).

## Decisions log
- Local single-page web app (TuneCompare replacement UX), dependency-free,
  fully offline. Core is a UMD lib so node tests exercise the same code path.
- Deviations from original TuneCompare (documented in README): locked maps are
  shown with a warning instead of blanked; compare-only keys reported; table
  cells matched by Key not position; raw-deflate accepted as fallback.

## Findings log
- 2026-10-05: No existing tool found (research subagent). .ftm extension confirmed
  by TuneCompare copy + filext.com. .ftm ≈ deflate-compressed JSON [inferred].
- 2026-10-05: http://tunecompare.com still serves the full app (HTTP only,
  expired cert). Archived assets: research/tunecompare_live.html,
  tunecompare_script_0.js (main obfuscated script), styles.css, privacy.html.
- Search infra note: DDG/Mojeek/Ecosia/searx anti-bot blocked; Brave search via
  curl works; Bing RSS returns junk; GitHub API + Wayback CDX work.
