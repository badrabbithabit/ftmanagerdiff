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

## File format (what we reverse-engineered)
See [`docs/FORMAT.md`](docs/FORMAT.md) for the full writeup. TL;DR:

- `.ftm` (open flavor) = **deflate stream at byte 0** (gzip `1f8b` or zlib
  `78xx`, no header/magic) → **XML**, root `<Adjust>`. Tables are sparse
  .NET `Dictionary<double,double>` grids with `Colunas`/`Linhas` axes.
- A second **encrypted container flavor** exists for FuelTech's commercial
  PnP (plug-and-play) calibrations — entropy 8.0, incompressible, per-file
  keys. We reject those with a clear message and deliberately do not attempt
  to break them (license/DMCA). Maps you create or read from your own ECU
  are always the open flavor.
- Inside open maps there is also a *soft* lock (`Tuner_Enabled` flag) which
  FT Manager uses to hide contents — we show them with a warning instead.

## Layout
- `src/ftm-core.js` — UMD core (browser `<script>` + node `require()`):
  inflate (gzip/zlib/raw, node zlib or `DecompressionStream`), XML parser,
  table extraction, tree diff (0.001 numeric tolerance), table diff.
- `src/ui.js`, `index.html`, `styles.css` — dark single-page UI.
- `tools/make-fixtures.js` — writes synthetic `fixtures/*.ftm` (zlib + gzip +
  a tuner-locked one) and round-trips them through the core.
- `tests/` — `node tests/run-all.js` (or `npm test`) runs 3 suites:
  `core.test.js` (11), `qa/qa.test.js` (9 adversarial),
  `qa/real-samples.test.js` (10; runs only if local `samples/` is present).
- `samples/` is untracked: official FuelTech example maps from
  <https://www.fueltech.com.br/pages/mapas-de-exemplo> used for real-file QC.
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
