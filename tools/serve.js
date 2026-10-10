/* tools/serve.js — zero-dependency local web server for the FT Manager diff
 * tool. Run:  node tools/serve.js   (then open http://localhost:8765)
 *
 * Why bother? Some browsers restrict drag-drop/file reads on file:// pages,
 * and a URL is nicer to bookmark. Everything stays on your machine — this
 * server binds to localhost only and makes no outbound requests.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 8765);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ftm': 'application/octet-stream',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8'
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  // serve only files inside the project dir
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
});

// localhost only — never expose this on a public network
server.listen(PORT, '127.0.0.1', () => {
  const url = 'http://localhost:' + PORT;
  console.log('FT Manager diff tool serving at ' + url);
  console.log('Ctrl+C to stop.');
  // best-effort browser open (Windows)
  try { require('node:child_process').spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore' }); }
  catch (e) { /* open it manually */ }
});
