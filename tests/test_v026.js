'use strict';
// v0.2.6 regression: the AI Send request body must be valid OpenAI-compatible
// chat JSON ({model, messages:[{role, content}]}), as accepted by Ollama,
// LM Studio and llama.cpp servers. Uses a local loopback mock server only.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const SS = require('../js/vocal-handoff.js');
require('../js/ai.js');

let total = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

function mockServer() {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        let body = null, error = null;
        try { body = JSON.parse(raw); } catch (e) { error = e; }
        seen.push({ method: req.method, url: req.url, contentType: req.headers['content-type'], body, error });
        const ok = !error && body && Array.isArray(body.messages) && body.messages.length > 0 &&
          body.messages.every((m) => m && typeof m === 'object' && typeof m.role === 'string' && typeof m.content === 'string');
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ok
          ? { choices: [{ message: { role: 'assistant', content: '[Verse]\n(start softly)\nThe river calls me' } }] }
          : { error: 'messages must be a non-empty array of {role, content}' }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: 'http://127.0.0.1:' + server.address().port + '/v1' }));
  });
}

function send(messages) {
  return new Promise((resolve) => SS.sendAiChat(messages, (err, text) => resolve({ err, text })));
}

function assertWellFormed(hit) {
  assert.ok(hit, 'mock server received a request');
  assert.equal(hit.method, 'POST');
  assert.equal(hit.url, '/v1/chat/completions');
  assert.match(String(hit.contentType), /application\/json/);
  assert.equal(hit.error, null, 'body is valid JSON');
  assert.equal(typeof hit.body.model, 'string');
  assert.ok(Array.isArray(hit.body.messages), 'body.messages is an array');
  assert.ok(hit.body.messages.length > 0);
  hit.body.messages.forEach((m) => {
    assert.ok(['system', 'user', 'assistant'].includes(m.role));
    assert.equal(typeof m.content, 'string');
  });
}

test('Send posts well-formed chat JSON with a messages array (the prompt string app.js builds)', async () => {
  const { server, seen, base } = await mockServer();
  try {
    SS.setAiConfig({ enabled: true, baseUrl: base, model: 'local-model', apiKey: '' });
    const prompt = 'You are adapting vocal delivery tags for MY ORIGINAL lyrics.';
    const r = await send(prompt); // exactly what app.js passed before the fix
    assertWellFormed(seen[0]);
    assert.equal(seen[0].body.messages[seen[0].body.messages.length - 1].content, prompt);
    assert.equal(r.err, null, r.err && r.err.message);
    assert.match(r.text, /river calls me/);
  } finally { server.close(); SS.clearAiConfig(); }
});

test('Send accepts an explicit messages array and rejects malformed input before any network call', async () => {
  const { server, seen, base } = await mockServer();
  try {
    SS.setAiConfig({ enabled: true, baseUrl: base, model: 'm', apiKey: '' });
    const r = await send([{ role: 'system', content: 'Return only tags.' }, { role: 'user', content: 'Hello' }]);
    assert.equal(r.err, null);
    assertWellFormed(seen[0]);
    assert.equal(seen[0].body.messages.length, 2);
    const before = seen.length;
    const bad = await send([{ role: 'user', content: 42 }]);
    assert.ok(bad.err);
    const empty = await send('   ');
    assert.ok(empty.err);
    assert.equal(seen.length, before, 'malformed messages never reach the network');
  } finally { server.close(); SS.clearAiConfig(); }
});

test('app.js wraps the mapping prompt as chat messages only on Send (Copy/Save stay plain text)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
  // v0.2.8: Send goes through the shared stage-4 path aiSheet() -> SS.sendAndCheckSheet, which
  // builds a [{role, content}] messages array (system task + user prompt) before sendAiChat.
  const send = src.slice(src.indexOf('"btn-map-send"'), src.indexOf('function currentDraftViewMs'));
  assert.match(send, /aiSheet\(mine\)/);
  const helper = src.slice(src.indexOf('function aiSheet(mine)'), src.indexOf('function sheetCheckNote'));
  assert.match(helper, /var prompt = privateMappingRequest\(mine\);/);
  assert.match(helper, /SS\.sendAndCheckSheet\(prompt, mine,/);
  assert.match(src, /function privateMappingRequest\(newLyrics\) \{\s*return fullHandoff\(newLyrics\)\.handoff\.prompt;/);
});

test('AI Playground credit is a plain link with no network side effects', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const links = html.match(/<a\b[^>]*aiplayground\.spot[^>]*>/g) || [];
  assert.equal(links.length, 1);
  assert.match(links[0], /href="https:\/\/www\.aiplayground\.spot\/music-master"/);
  assert.match(links[0], /rel="noopener noreferrer"/);
  // Nothing else in the page references the site (no img, script, link rel=prefetch/preconnect/dns-prefetch).
  assert.equal((html.match(/aiplayground\.spot/g) || []).length, 1);
  assert.doesNotMatch(html, /rel="(?:prefetch|preconnect|dns-prefetch|preload|prerender)"/);
  assert.doesNotMatch(html, /<(?:img|script|iframe|link)\b[^>]*https?:\/\//);
});

(async () => {
  for (const [name, fn] of queue) { await fn(); total++; console.log('ok  ' + name); }
  console.log('\n' + total + ' v0.2.6 tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
