/* tests/run-all.js — runs every suite in a child process: node tests/run-all.js */
'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const suites = ['core.test.js', path.join('qa', 'qa.test.js'), path.join('qa', 'real-samples.test.js'),
  path.join('qa', 'table-view.test.js')];

let failed = 0;
for (const s of suites) {
  console.log('\n=== ' + s + ' ===');
  const r = spawnSync(process.execPath, [path.join(__dirname, s)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log('\n' + (failed ? failed + ' suite(s) FAILED' : 'all ' + suites.length + ' suites passed'));
process.exit(failed ? 1 : 0);
