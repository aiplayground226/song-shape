'use strict';
// v0.2.7: MP3 loading, "AI learns from your hand traces" (UI + CLI ai-draft / ai-batch),
// license / NOTICE, About disclaimer and the single repo-URL constant.
// All AI calls go to a loopback mock server started by this test.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const SS = require('../js/vocal-handoff.js');
require('../js/ai-learn.js');
require('../js/project-info.js');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'songshape.js');
let total = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

const GOOD_REPLY = JSON.stringify({ strokes: [
  { start_ms: 400, end_ms: 2200, points: [[400, -0.3], [1200, 0.4], [2200, 0.6]] },
  { start_ms: 3000, end_ms: 6000, points: [[3000, 0.1], [4500, 0.8], [6000, -0.5]] }
] });

function mockServer(reply) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        let body = null; try { body = JSON.parse(raw); } catch (e) {}
        seen.push({ url: req.url, body, auth: req.headers.authorization || null });
        const ok = body && Array.isArray(body.messages) && body.messages.every((m) => typeof m.role === 'string' && typeof m.content === 'string');
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ok ? { choices: [{ message: { role: 'assistant', content: typeof reply === 'function' ? reply(body) : reply } }] } : { error: 'bad' }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: 'http://127.0.0.1:' + server.address().port + '/v1' }));
  });
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [CLI].concat(args), { env: Object.assign({}, process.env, env || {}) });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function handSession() {
  const s = SS.createSession();
  s.audio = { name: 'example.wav', duration_ms: 6000, included_in_export: false };
  s.draft = SS.buildDraft([...Array(300)].map((_, i) => ({ t_ms: i * 20, f0: 200 + i, voiced: true, rms: 0.2 })));
  s.strokes = [
    { id: 'stroke-1', start_ms: 0, end_ms: 1500, points: [[0, 0], [700, 0.5], [1500, 0.2]], annotations: [] },
    { id: 'stroke-2', start_ms: 2000, end_ms: 2600, points: [[2000, 0.1], [2600, 0.3]], annotations: ['machine_measured_pitch_draft'] },
    { id: 'stroke-3', start_ms: 3000, end_ms: 3600, points: [[3000, 0.1], [3600, 0.3]], annotations: ['ai_drafted_trace', 'needs_review'] }
  ];
  SS.recomputeGaps(s);
  return s;
}

test('MP3 and WAV headers are recognized; extension and content must agree', () => {
  const mp3 = fs.readFileSync(path.join(ROOT, 'demo', 'fictional_tone.mp3'));
  const wav = fs.readFileSync(path.join(ROOT, 'demo', 'fictional_tone.wav'));
  assert.equal(SS.validateAudio('fictional_tone.mp3', mp3), 'mp3');
  assert.equal(SS.validateAudio('Take.WAV', wav), 'wav');
  assert.ok(SS.isMp3Header(Buffer.from([0xFF, 0xFB, 0x90, 0x64])));
  for (const [name, buf] of [['song.mp3', wav], ['song.wav', mp3], ['song.ogg', mp3], ['x.mp3', Buffer.from('hello')]]) {
    assert.throws(() => SS.validateAudio(name, buf), (e) => e.code === 'UNSUPPORTED_AUDIO' && e.message === SS.SUPPORTED_AUDIO_MESSAGE);
  }
  const embedded = require('../js/demo-mp3.js');
  assert.equal(Buffer.from(embedded.buildDemoMp3()).equals(mp3), true, 'embedded demo MP3 matches demo/fictional_tone.mp3');
});

test('examples use hand strokes only; machine and AI strokes are excluded', () => {
  const ex = SS.exampleFromSession(handSession(), 'ex');
  assert.equal(ex.stroke_count, 1);
  assert.ok(ex.has_audio_features);
  assert.equal(ex.trace.filter((f) => f[1] !== null).every((f) => f[0] <= 1500), true);
  const none = SS.createSession(); none.strokes = [];
  assert.throws(() => SS.exampleFromSession(none), /no hand-drawn strokes/);
});

test('zero-shot and few-shot messages are chat arrays with audio features, no audio or lyrics', () => {
  const s = handSession();
  s.lyrics = { text: 'SECRET LYRIC LINE', lines: [], words: [] };
  const feats = SS.audioFeatures(s.draft, 6000);
  const zero = SS.buildTraceDraftMessages(feats, []);
  assert.equal(zero.length, 2); assert.equal(zero[0].role, 'system'); assert.equal(zero[1].role, 'user');
  assert.match(zero[1].content, /No examples are available/);
  const few = SS.buildTraceDraftMessages(feats, [SS.exampleFromSession(s, 'ex')]);
  assert.match(few[1].content, /Example 1/); assert.match(few[1].content, /listener hand trace/);
  assert.doesNotMatch(JSON.stringify(few), /SECRET LYRIC LINE/);
  assert.ok(feats.frames.length <= 161);
});

test('model replies are parsed defensively (fences, clamping, ordering, overlap, silence split)', () => {
  const feats = { step_ms: 250, frames: [[0, 0.1], [250, 0.1], [500, null], [750, null], [1000, 0.2], [1250, 0.2], [1500, 0.2]] };
  const reply = 'Sure!\n```json\n{"strokes":[{"points":[[0,5],[250,0.1],[1000,0.3],[1500,-9],["x",1]]},{"points":[[1200,0],[1400,0.1]]}]}\n```';
  const strokes = SS.parseTraceReply(reply, 1500, feats);
  assert.deepEqual(strokes.map((s) => [s.start_ms, s.end_ms]), [[0, 250], [1000, 1500]]);
  assert.equal(strokes[0].points[0][1], 1);
  assert.equal(strokes[1].points[strokes[1].points.length - 1][1], -1);
  assert.throws(() => SS.parseTraceReply('no json here', 1000), /JSON/);
  assert.throws(() => SS.parseTraceReply('{"strokes":[{"points":[[1,1]]}]}', 1000), /usable strokes/);
});

test('AI strokes are added as labeled proposals, replace earlier AI drafts, never touch hand strokes', () => {
  const s = handSession();
  SS.applyAiTraceDraft(s, SS.parseTraceReply(GOOD_REPLY, 6000), { model: 'm', examples: 0 });
  const ai = s.strokes.filter((x) => x.annotations.includes('ai_drafted_trace'));
  assert.equal(ai.length, 2);
  assert.ok(ai.every((x) => x.annotations.includes('needs_review') && x.annotations.includes('ai-zero-shot')));
  assert.ok(s.strokes.some((x) => x.id === 'stroke-1'));
  SS.applyAiTraceDraft(s, SS.parseTraceReply(GOOD_REPLY, 6000), { model: 'm', examples: 2 });
  assert.equal(s.strokes.filter((x) => x.annotations.includes('ai_drafted_trace')).length, 2);
  const json = SS.sessionToJSON(s);
  assert.equal(SS.exportContainsSecrets(json), false);
  assert.equal(SS.removeAiTraceDraft(s), 2);
  assert.ok(s.strokes.some((x) => x.id === 'stroke-1'));
  for (let i = 1; i < s.gaps.length; i++) assert.ok(s.gaps[i].start_ms >= s.gaps[i - 1].start_ms);
});

test('sendAiChat: optional JSON mode and timeout', async () => {
  const { server, seen, base } = await mockServer('{"strokes":[]}');
  try {
    SS.setAiConfig({ enabled: true, baseUrl: base, model: 'm', apiKey: '' });
    await new Promise((r) => SS.sendAiChat('hi', r, { jsonMode: true }));
    assert.deepEqual(seen[0].body.response_format, { type: 'json_object' });
    await new Promise((r) => SS.sendAiChat('hi', r));
    assert.equal(seen[1].body.response_format, undefined);
  } finally { server.close(); SS.clearAiConfig(); }
  const slow = http.createServer(() => {}).listen(0, '127.0.0.1');
  await new Promise((r) => slow.on('listening', r));
  try {
    SS.setAiConfig({ enabled: true, baseUrl: 'http://127.0.0.1:' + slow.address().port + '/v1', model: 'm' });
    const err = await new Promise((r) => SS.sendAiChat('hi', (e) => r(e), { timeoutMs: 300 }));
    assert.match(String(err && err.message), /timed out/);
  } finally { slow.closeAllConnections && slow.closeAllConnections(); slow.close(); SS.clearAiConfig(); }
});

test('CLI ai-draft: zero-shot and with examples; non-local endpoint refused without --allow-remote', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ss027-'));
  const { server, seen, base } = await mockServer(GOOD_REPLY);
  try {
    const out1 = path.join(work, 'zero.json');
    const r1 = await runCli(['ai-draft', path.join(ROOT, 'demo', 'fictional_tone.wav'), '--endpoint', base, '--model', 'mock', '-o', out1]);
    assert.equal(r1.code, 0, r1.err);
    const p1 = JSON.parse(fs.readFileSync(out1, 'utf8'));
    assert.ok(p1.strokes.length >= 2 && p1.strokes.every((s) => s.annotations.includes('ai_drafted_trace')));
    assert.ok(p1.draft && p1.draft.strokes.length, 'measured draft layer kept separately');
    assert.equal(p1.audio.included_in_export, false);
    assert.match(seen[0].body.messages[1].content, /No examples are available/);
    const exFile = path.join(work, 'example.json');
    fs.writeFileSync(exFile, JSON.stringify(SS.sessionToJSON(handSession())));
    const out2 = path.join(work, 'few.json');
    const r2 = await runCli(['ai-draft', path.join(ROOT, 'demo', 'fictional_tone.wav'), '--endpoint', base, '--model', 'mock', '--examples', exFile, '-o', out2]);
    assert.equal(r2.code, 0, r2.err);
    assert.match(seen[1].body.messages[1].content, /Example 1/);
    assert.ok(JSON.parse(fs.readFileSync(out2, 'utf8')).strokes.some((s) => s.annotations.includes('ai-examples:1')));
    const r3 = await runCli(['ai-draft', path.join(ROOT, 'demo', 'fictional_tone.wav'), '--endpoint', 'https://example.org/v1', '--model', 'x', '-o', path.join(work, 'r.json')]);
    assert.notEqual(r3.code, 0); assert.match(r3.err, /--allow-remote/);
    assert.equal(fs.existsSync(path.join(work, 'r.json')), false);
    const r4 = await runCli(['ai-draft', path.join(ROOT, 'demo', 'fictional_tone.wav'), '--endpoint', base, '--model', 'mock', '-o', out1]);
    assert.notEqual(r4.code, 0); assert.match(r4.err, /already exists/);
    assert.equal(seen.length, 2, 'refused runs made no request');
  } finally { server.close(); fs.rmSync(work, { recursive: true, force: true }); }
});

test('CLI ai-batch: folder without hand work, log + resume, never overwrites, MP3 via --ffmpeg', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ss027b-'));
  const songs = path.join(work, 'songs'); fs.mkdirSync(path.join(songs, 'sub'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'demo', 'fictional_tone.wav'), path.join(songs, 'a.wav'));
  fs.copyFileSync(path.join(ROOT, 'examples', 'sine_sweep.wav'), path.join(songs, 'sub', 'b.wav'));
  fs.copyFileSync(path.join(ROOT, 'demo', 'fictional_tone.mp3'), path.join(songs, 'c.mp3'));
  fs.writeFileSync(path.join(songs, 'notes.txt'), 'ignored');
  const out = path.join(work, 'out');
  let calls = 0;
  const { server, base } = await mockServer(() => { calls += 1; return calls === 2 ? 'not json at all' : GOOD_REPLY; });
  try {
    const r1 = await runCli(['ai-batch', songs, '-o', out, '--endpoint', base, '--model', 'mock', '--recursive']);
    assert.equal(r1.code, 0, r1.err);
    const log = fs.readFileSync(path.join(out, 'batch-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(log.length, 2, 'two WAVs attempted; MP3 skipped without --ffmpeg');
    assert.deepEqual(log.map((e) => e.status).sort(), ['failed', 'ok']);
    assert.match(r1.err, /1 MP3 skipped/);
    const r2 = await runCli(['ai-batch', songs, '-o', out, '--endpoint', base, '--model', 'mock']);
    assert.notEqual(r2.code, 0); assert.match(r2.err, /--resume/);
    const r3 = await runCli(['ai-batch', songs, '-o', out, '--endpoint', base, '--model', 'mock', '--recursive', '--resume']);
    assert.equal(r3.code, 0, r3.err);
    const done = fs.readdirSync(out).filter((f) => f.endsWith('.songshape.json')).sort();
    assert.deepEqual(done, ['a.songshape.json', 'sub__b.songshape.json']);
    const ffmpeg = cp.spawnSync('ffmpeg', ['-version']).status === 0;
    if (ffmpeg) {
      const r4 = await runCli(['ai-batch', songs, '-o', out, '--endpoint', base, '--model', 'mock', '--resume', '--ffmpeg', 'ffmpeg']);
      assert.equal(r4.code, 0, r4.err);
      const c = JSON.parse(fs.readFileSync(path.join(out, 'c.songshape.json'), 'utf8'));
      assert.ok(c.audio.duration_ms > 6400 && c.strokes.length >= 2);
    } else {
      console.log('    (ffmpeg not found: MP3 batch branch skipped)');
    }
  } finally { server.close(); fs.rmSync(work, { recursive: true, force: true }); }
});

test('Apache-2.0 LICENSE, NOTICE credit, and one repo-URL constant (placeholder) for About and Report a bug', () => {
  const lic = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  assert.match(lic, /Apache License\s+Version 2\.0, January 2004/);
  const notice = fs.readFileSync(path.join(ROOT, 'NOTICE'), 'utf8');
  assert.match(notice, /Song Shape — Copyright 2026 Ben Hayward and AI Playground LLC\./);
  assert.match(notice, /credit Ben Hayward and AI Playground LLC \(https:\/\/www\.aiplayground\.spot\)/);
  assert.equal(SS.PROJECT_INFO.REPO_URL, 'https://github.com/aiplayground226/song-shape');
  assert.equal(SS.PROJECT_INFO.ISSUES_URL, SS.PROJECT_INFO.REPO_URL + '/issues');
  assert.equal(SS.PROJECT_INFO.REPO_IS_PLACEHOLDER, false);
  const jsFiles = fs.readdirSync(path.join(ROOT, 'js')).map((f) => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'));
  assert.equal(jsFiles.filter((t) => t.includes('github.com/aiplayground226')).length, 1, 'URL defined in exactly one JS file');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /github\.com/, 'index.html gets the URL from the constant');
  assert.match(html, /The original Song Shape has no tracking, analytics, accounts or data collection\. Use the official repository as the verified source; copies from elsewhere may have been modified\./);
  assert.match(html, /id="link-report-bug"/);
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /The original Song Shape has no tracking, analytics, accounts or data collection/);
  assert.match(readme, /credit/i); assert.doesNotMatch(readme, /PLACEHOLDER/);
});

test('UI is wired: AI example and draft controls exist and sending happens only inside the Draft click handler', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const id of ['btn-ai-example-current', 'btn-ai-example-files', 'file-ai-examples', 'btn-ai-draft-trace', 'btn-ai-remove-draft', 'chk-ai-json', 'btn-load-demo-mp3']) {
    assert.match(html, new RegExp('id="' + id + '"'), id);
  }
  assert.match(html, /accept="\.wav,\.mp3,/);
  const app = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  // Updated in v0.2.8: requests go through SS.sendAiChatAsync in exactly two helpers,
  // aiSheet (Send / guided stage 4) and aiDraftRun (Draft trace / guided stage 2).
  assert.equal(app.split('SS.sendAiChat(').length - 1, 0, 'no direct sendAiChat calls left in app.js');
  assert.equal(app.split('SS.sendAiChatAsync(').length - 1, 2, 'only the stage-2 and stage-4 helpers call the network helper');
  const handler = app.slice(app.indexOf('function aiDraftRun()'), app.indexOf('"btn-ai-draft-trace").addEventListener'));
  assert.match(handler, /SS\.sendAiChatAsync\(messages/);
  assert.match(handler, /if \(!cfg\.enabled \|\| !cfg\.baseUrl\)/);
});

test('tools/serve-local.js serves the app on loopback only, read-only, without path traversal', async () => {
  const srv = require(path.join(ROOT, 'tools', 'serve-local.js'));
  assert.equal(srv.resolveSafe('/../../etc/passwd'), null);
  assert.equal(srv.resolveSafe('/%2e%2e/%2e%2e/etc/passwd'), null);
  assert.equal(srv.resolveSafe('/node_modules/x.js'), null);
  assert.equal(srv.resolveSafe('/'), path.join(srv.ROOT, 'index.html'));
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'serve-local.js'), 'utf8');
  assert.match(src, /listen\(port, '127\.0\.0\.1'/);
  const server = srv.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const ok = await fetch('http://127.0.0.1:' + port + '/');
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /Song Shape/);
    const post = await fetch('http://127.0.0.1:' + port + '/index.html', { method: 'POST', body: 'x' });
    assert.equal(post.status, 405);
  } finally { server.close(); }
});

(async () => {
  for (const [name, fn] of queue) { await fn(); total++; console.log('ok  ' + name); }
  console.log('\n' + total + ' v0.2.7 tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
