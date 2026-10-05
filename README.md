# FTM Tune Compare

Offline, zero-dependency replacement for TuneCompare.com: diff two FuelTech
FT Manager `.ftm` tune files. Nothing is uploaded; everything runs locally.

## Try it
Live site: <https://badrabbithabit.github.io/ftmanagerdiff/> — your tune files
never leave the browser; the page makes no network calls.

## Use
Open `index.html` in a browser (no server needed). Drop a Base map and a
Compare map, tick/untick "Only show differences", click a table row for the
Base / Compare / Difference grids.

## Layout
- `src/ftm-core.js` — UMD core (browser `<script>` + node `require()`):
  inflate (gzip/zlib/raw, node zlib or `DecompressionStream`), XML parser,
  table extraction, tree diff (0.001 numeric tolerance), table diff.
- `src/ui.js`, `index.html`, `styles.css` — dark single-page UI.
- `tools/make-fixtures.js` — writes synthetic `fixtures/*.ftm` (zlib + gzip +
  a tuner-locked one) and round-trips them through the core.
- `tests/core.test.js` — `node tests/core.test.js` (or `npm test`).
- `research/` is git-ignored: third-party downloads (FuelTech manuals, archived
  TuneCompare.com pages) and deobfuscation scratch stay local.

## Notes vs the original TuneCompare behaviour
- Locked maps (`Tuner_Enabled` truthy) are flagged with a warning banner but
  their contents are still shown (the original wipes them).
- Keys present only in the Compare file are reported too (the original only
  walked the Base file).
- Sparse `Dictionary<double,double>` cells are matched by `Key`, not position,
  so reordered/missing columns still diff correctly; missing cells render as
  hatched "no value" cells instead of being assumed zero.
