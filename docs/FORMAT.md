# The FuelTech `.ftm` map file format — everything we learned

Reverse-engineered from the TuneCompare.com application (deobfuscated, see
`research/`) and validated against 13 official FuelTech example maps
(`samples/`, from <https://www.fueltech.com.br/pages/mapas-de-exemplo>,
direct `cdn.shopify.com` downloads).

## Two container flavors

| Flavor | Magic | Content | Who uses it |
|---|---|---|---|
| **Open** | byte 0 = deflate stream: `1f 8b` (gzip) or `78 xx` (zlib) | compressed XML | every map you create/read with FT Manager; all free example maps |
| **Encrypted** | per-file, no shared header (observed: `39 fa…`, `4d 23…`, `5f 08…`, `13 43…`) | ciphertext | FuelTech's commercial **PnP (plug-and-play)** calibrations AND — since at least FTManager **5.6** — maps read from the ECU with NO password set (observed 2026-10-05) |

There is **no file header, no magic number, no checksum wrapper** in the open
flavor — the very first byte is the start of the deflate stream.

### The encrypted flavor
Measured on the two encrypted official samples
(`AudiVW_A3_180cv_PnP_ME751`, `Calibra_Vectra_2.0_16V`):

- Shannon entropy **7.998 / 8.0** (perfectly random)
- gzip re-compression ratio **1.00** (totally incompressible)
- Different magic per file → per-file keys/IVs; no shared header

That is real encryption, not obfuscation. **Why:** PnP maps are the product
FuelTech sells (OEM-ECU-replacement calibrations sold via distributors); the
free example maps are open starting points, the paid calibrations are sealed.
FuelTech's protection culture extends further: the FT550 manual documents
user/tuner passwords and 6-digit remote-tuning passwords, and states "All
PowerFT ECUs are protected by US Patent 11,215,158".

**This tool deliberately does not attempt to decrypt them** — circumventing
that would likely violate FuelTech's license / DMCA anti-circumvention rules.

**UPDATE 2026-10-05:** the "maps you read from your own ECU are always the
open flavor" claim is now FALSE. FTManager 5.6 writes the encrypted container
for owner maps with no password set. Forensics on three owner maps (two
"flex" maps from the same ECU share an identical 240-byte prefix — block-
aligned — plus an identical 36-byte suffix; sizes differ by exactly 16 B;
no repeated 16-B blocks ⇒ not ECB; entropy 8.0). No public changelog or
announcement of this change exists; no open-format export option is known.

## Two-tier protection inside the open flavor

1. **Soft lock (in-XML):** `Adjust/SecurityConfig/SecurityFlags/Tuner_Enabled`
   truthy (`true|yes|1`). FT Manager and the original TuneCompare merely *hide*
   the contents ("Base file is locked. Disable lock to view contents").
   Honor-system only — this tool shows a warning banner but displays the data
   (fine for maps you own).
2. **Hard lock (container):** the encrypted flavor above.

## Open flavor: the XML payload

```
<?xml version="1.0"?>
<Adjust ...>
  <SW_Version>5.22</SW_Version>
  <FT_CLASS>FT6_CLASS</FT_CLASS>     <!-- FT45/FT5/FT55/FT6_CLASS -->
  <ProductID>600</ProductID>         <!-- 450/500/550/551(=FT550LITE)/600 -->
  <Name>LS7</Name>
  <Versao_GERAL> <Versao_ECU> <Boot_ECU> <Hard_Ver_ECU> ... (firmware stamps)
  <SERIAL> base64 blob — appears to bind the map to an ECU serial </SERIAL>
  <SecurityConfig><SecurityFlags><Tuner_Enabled>false</Tuner_Enabled>...
  ... hundreds of parameter branches and tables ...
</Adjust>
```

- Real v5.x maps carry **~370 tables + ~22 scalar params**; an old v4.71 map
  had 261 tables (maps grow with firmware; diffing across SW versions yields
  many `missing-left/right` structural entries — expected).
- Empty tables exist in stock maps (e.g. `Func_EtcSlewControl_Table` = 0×0).
- Axis keys can be **negative or fractional** (e.g. `-1 … 0.2`).

### Table structure
Any node containing a `Linhas` child is a table:

- `Colunas.double[]` — X axis
- `Linhas.double[]` — Y axis (`len==1` → 1-D curve; `1xNx1` shapes are common)
- `Tabela.Item[row].Value.SerializableDictionaryOfDoubleDouble.Item[]`
  of `{Key:{double}, Value:{double}}` — a **sparse .NET
  `Dictionary<double,double>`**, cells keyed by axis value, *not* a 2D array.
  Missing keys are genuine holes (render as "no value", never assume 0).
  Match cells by `Key`, not position.

## Diff semantics (ours, matching TuneCompare's recovered logic)

- Recursive walk by key name across both trees; statuses
  `equal | changed | nested | missing-left (Base-only) | missing-right (Compare-only)`.
- Numeric tolerance **0.001** for scalars (`|a−b| > 0.001` ⇒ changed);
  table cells compared exactly (delta = base − comp).
- Table diff is positional and only valid when row/col counts match;
  resized tables (very common across firmware versions — 95 of 370 in one
  real pair) are reported as dimension mismatches, not bogus deltas.

## TuneCompare.com forensics (how we got the format)

- The site is **still live over plain HTTP** (`http://tunecompare.com`,
  expired cert; HTTPS serves an empty body — which is why it "doesn't work").
- Entire app = one 89KB HTML page, inline obfuscated JS (obfuscator.io-style:
  string array + rotation IIFE, checksum `0x43893`), 100% client-side, zero
  network calls. Deobfuscated: `research/tunecompare_deobfuscated.js`.
- Internals: `FileReader.readAsArrayBuffer` → bundled **pako** inflate
  (windowBits 47 auto-detect: zlib *and* gzip) → `ftconvert`, a minimal
  XML→object parser (attributes→`@name`, text→`#`, CDATA, entities; has a
  single-child-collapse bug we fixed) → recursive diff → HTML grids.
- No table/parameter names are hardcoded — the XML is fully generic.

## Sample provenance (`samples/`, untracked)

13 files from FuelTech Brazil's official "Example Maps" page. 11 open
(2× FT550-class: BMW M3 S54 = ProductID 550, BMW M3 1999 = 551/FT550LITE;
plus FT500/FT600/FT450 LS-family), 2 encrypted PnP. Validated by
`tests/qa/real-samples.test.js` (self-diff = 0 changes invariant, ground-truth
cells re-derived from raw XML, graceful encrypted-container rejection).
