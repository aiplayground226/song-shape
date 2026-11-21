#!/usr/bin/env node
'use strict';
/**
 * Optional: serve Song Shape at http://127.0.0.1:<port>/ so the browser app can reach a
 * local Ollama with Ollama's DEFAULT settings (Ollama rejects file:// pages, which Chrome
 * reports as origin "null"). Read-only, loopback only, no dependencies, no logging to disk.
 *   node tools/serve-local.js [port]        (default 8765)
 */
var http = require('http');
var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.md': 'text/plain; charset=utf-8'
};

function resolveSafe(urlPath) {
  var clean;
  try { clean = decodeURIComponent(String(urlPath).split('?')[0].split('#')[0]); } catch (e) { return null; }
  if (clean.indexOf('\0') !== -1) return null;
  if (clean === '/' || clean === '') clean = '/index.html';
  var full = path.resolve(ROOT, '.' + clean);
  if (full !== ROOT && full.indexOf(ROOT + path.sep) !== 0) return null;
  if (/[\\/](node_modules|\.git)([\\/]|$)/.test(full.slice(ROOT.length))) return null;
  return full;
}

function createServer() {
  return http.createServer(function (req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    var file = resolveSafe(req.url);
    if (!file) { res.writeHead(403); res.end('Forbidden'); return; }
    fs.stat(file, function (err, st) {
      if (err || !st.isFile()) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
      });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).pipe(res);
    });
  });
}

if (require.main === module) {
  var port = parseInt(process.argv[2] || '8765', 10);
  if (!(port > 0 && port < 65536)) { console.error('Usage: node tools/serve-local.js [port]'); process.exit(2); }
  createServer().listen(port, '127.0.0.1', function () {
    console.log('Song Shape: http://127.0.0.1:' + port + '/  (this computer only; Ctrl+C to stop)');
  });
}
module.exports = { createServer: createServer, resolveSafe: resolveSafe, ROOT: ROOT };
