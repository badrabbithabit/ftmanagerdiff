/* tests/qa/qa.test.js — adversarial QA fixtures, all built in memory
 * (deflate/gzip here, no fixture files). Plain node runner:
 *   node tests/qa/qa.test.js
 */
'use strict';
const assert = require('node:assert');
const zlib = require('node:zlib');
const C = require('../../src/ftm-core.js');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); }
}

function xmlOf(body) {
  return '<?xml version="1.0" encoding="utf-8"?>\n<Adjust>\n' + body + '</Adjust>\n';
}
const zl = xml => zlib.deflateSync(Buffer.from(xml, 'utf8'));
const gz = xml => zlib.gzipSync(Buffer.from(xml, 'utf8'));

/** Minimal .ftm-style table node XML (dense cells). */
function tableXml(xAxes, yAxes, cells) {
  let s = '<Colunas>' + xAxes.map(v => '<double>' + v + '</double>').join('') + '</Colunas>' +
    '<Linhas>' + yAxes.map(v => '<double>' + v + '</double>').join('') + '</Linhas>' +
    '<Tabela>';
  cells.forEach(row => {
    s += '<Item><Value><SerializableDictionaryOfDoubleDouble>';
    row.forEach((v, c) => {
      s += '<Item><Key><double>' + xAxes[c] + '</double></Key>' +
        '<Value><double>' + v + '</double></Value></Item>';
    });
    s += '</SerializableDictionaryOfDoubleDouble></Value></Item>';
  });
  return s + '</Tabela>';
}

async function main() {

  /* (a) entity codepoint bombs */
  await t('entities: codepoint bombs do not throw; invalid entities kept verbatim', () => {
    const o = C.parseXml('<R><V>a&#1114112;b&#xFFFFFFFF;c&#x110000;d&#xD800;e&#xDFFF;' +
      'f&#99999999999999;g&#65;&#x42;&#38;</V></R>');
    assert.strictEqual(o.R.V,
      'a&#1114112;b&#xFFFFFFFF;c&#x110000;d&#xD800;e&#xDFFF;f&#99999999999999;gAB&');
  });

  await t('entities: codepoint bomb inside a real .ftm payload parses', async () => {
    const p = await C.parseFtm(zl(xmlOf('<V>&#1114112;&#xFFFFFFFF;&#xD800;ok&#65;</V>')));
    assert.ok(p.tree.V.includes('okA'), 'valid entities still decoded: ' + p.tree.V);
    assert.ok(p.tree.V.includes('&#1114112;'), 'invalid entity kept verbatim');
  });

  /* (b) raw-deflate stream whose first byte is 0x78 (stored block, BFINAL=0) */
  await t('inflate: raw-deflate stream starting with 0x78 falls back to raw', async () => {
    let xml = xmlOf('  <SW_Version>raw78</SW_Version>\n');
    let body = Buffer.from(xml, 'utf8');
    // pad until the 2-byte prefix is NOT a valid zlib header, so the
    // classifier must fall through to raw deflate
    while (((0x78 << 8) | (body.length & 0xff)) % 31 === 0) {
      xml = xml.replace('</Adjust>', ' <!--x--></Adjust>');
      body = Buffer.from(xml, 'utf8');
    }
    const len = body.length;
    const stream = Buffer.concat([
      Buffer.from([0x78, len & 0xff, (len >> 8) & 0xff, (~len) & 0xff, ((~len) >> 8) & 0xff]),
      body,
      Buffer.from([0x01, 0x00, 0x00, 0xff, 0xff]) // final empty stored block
    ]);
    assert.strictEqual(stream[0], 0x78);
    assert.ok(((stream[0] << 8) | stream[1]) % 31 !== 0, 'prefix must not look like a zlib header');
    assert.strictEqual(zlib.inflateRawSync(stream).toString('utf8'), xml, 'sanity: valid raw deflate');
    const p = await C.parseFtm(stream);
    assert.strictEqual(p.swVersion, 'raw78');
  });

  /* (c) plain uncompressed XML */
  await t('graceful reject: plain uncompressed XML (no hang, no sync throw)', async () => {
    await assert.rejects(() => C.parseFtm(
      Buffer.from('<?xml version="1.0"?><Adjust><SW_Version>1</SW_Version></Adjust>', 'utf8')));
  });

  /* (d) empty / truncated / corrupt containers */
  await t('graceful rejects: empty file, truncated gzip, bad-checksum zlib', async () => {
    await assert.rejects(() => C.parseFtm(Buffer.alloc(0)));
    await assert.rejects(() => C.parseFtm(Buffer.alloc(1)));
    const g = gz(xmlOf('<SW_Version>1</SW_Version>'));
    await assert.rejects(() => C.parseFtm(g.slice(0, g.length - 8))); // CRC/ISIZE trailer gone
    const z = zl(xmlOf('<SW_Version>1</SW_Version>'));
    z[z.length - 1] ^= 0xff; // break Adler-32
    await assert.rejects(() => C.parseFtm(z));
  });

  await t('garbage that happens to inflate (raw deflate of non-XML) is rejected, not parsed empty', async () => {
    const zlib = require('zlib');
    // Real-world case: an encrypted FTManager 5.6 map whose random bytes
    // began with a coincidentally-valid raw-deflate header, yielding an
    // empty tree instead of an error.
    const raw = zlib.deflateRawSync(Buffer.from('hello world, not xml at all'));
    await assert.rejects(() => C.parseFtm(raw), /protected\/encrypted|not XML|no XML root/i);
    const raw2 = zlib.deflateRawSync(Buffer.from('<not-a-root')); // starts with '<' but no valid root object
    await assert.rejects(() => C.parseFtm(raw2));
  });

  /* (e) XML edge cases */
  await t('XML: self-closing, duplicate siblings, unicode names, CDATA mixed with text', () => {
    const o = C.parseXml(
      '<Root><Self a="1"/><Dup>x</Dup><Dup>y</Dup>' +
      '<Ignição>ig</Ignição><λ>lam</λ>' +
      '<Mix>pre<![CDATA[ <raw> ]]>&amp;post</Mix></Root>');
    assert.deepStrictEqual(o.Root.Self, { '@a': '1' });
    assert.deepStrictEqual(o.Root.Dup, ['x', 'y']);
    assert.strictEqual(o.Root['Ignição'], 'ig');
    assert.strictEqual(o.Root['λ'], 'lam');
    assert.strictEqual(o.Root.Mix, 'pre <raw> &post');
  });

  await t('tables: attributes on the table node itself are tolerated', async () => {
    const p = await C.parseFtm(zl(xmlOf('  <MyTbl units="%">\n' + tableXml([0, 10], [1], [[3, 4]]) + '\n  </MyTbl>\n')));
    const tb = C.extractTables(p.tree)[0];
    assert.strictEqual(tb.name, 'MyTbl');
    assert.strictEqual(tb.matrix[0][1], 4);
  });

  /* (f) hand-built tree diff */
  await t('tree diff: statuses, delta, 0.001 tolerance (hand-built)', () => {
    const a = { X: '5', Y: '1.000', Z: '1.000', G: { W: 'a' }, OnlyA: '1' };
    const b = { X: '2', Y: '1.0005', Z: '1.002', G: { W: 'b' }, OnlyB: '2' };
    const d = C.diffTrees(a, b);
    assert.strictEqual(d.status, 'nested');
    assert.strictEqual(d.children.X.status, 'changed');
    assert.strictEqual(d.children.X.delta, 3, 'delta = base - comp');
    assert.strictEqual(d.children.Y.status, 'equal', 'within 0.001');
    assert.strictEqual(d.children.Z.status, 'changed');
    assert.ok(Math.abs(d.children.Z.delta + 0.002) < 1e-9, 'delta = base - comp');
    // core convention: missing-left = present in BASE only, missing-right = COMPARE only
    assert.strictEqual(d.children.OnlyA.status, 'missing-left');
    assert.strictEqual(d.children.OnlyA.base, '1');
    assert.strictEqual(d.children.OnlyA.comp, undefined);
    assert.strictEqual(d.children.OnlyB.status, 'missing-right');
    assert.strictEqual(d.children.OnlyB.base, undefined);
    assert.strictEqual(d.children.OnlyB.comp, '2');
    assert.strictEqual(d.children.G.status, 'nested');
    assert.strictEqual(d.children.G.children.W.status, 'changed');
    assert.strictEqual(C.countChanges(d), 5);
  });

  /* (g) sibling tables with the same name */
  await t('sibling same-name tables: extractTables returns BOTH with unique paths', async () => {
    const xml = xmlOf('  <Group>\n' +
      '    <Sub>\n' + tableXml([0, 1], [0], [[1, 2]]) + '\n    </Sub>\n' +
      '    <Sub>\n' + tableXml([0, 1], [0], [[1, 9]]) + '\n    </Sub>\n' +
      '  </Group>\n');
    const p = await C.parseFtm(zl(xml));
    const tables = C.extractTables(p.tree);
    assert.strictEqual(tables.length, 2, 'both tables must be extracted');
    const keys = tables.map(x => x.path.join('/'));
    assert.strictEqual(new Set(keys).size, 2, 'paths must be unique (array index in key)');
    // UI-style tmap keying must not collapse the two tables
    assert.strictEqual(new Map(tables.map(x => [x.path.join('/'), x])).size, 2);
    assert.strictEqual(tables[0].matrix[0][1], 2);
    assert.strictEqual(tables[1].matrix[0][1], 9);
    // diff tree keys arrays by index, so UI table paths line up with diff paths
    const d = C.diffTrees(p.tree, p.tree);
    assert.ok(d.children.Group.children.Sub.children['0'], 'diff keys array by index (0)');
    assert.ok(d.children.Group.children.Sub.children['1'], 'diff keys array by index (1)');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
