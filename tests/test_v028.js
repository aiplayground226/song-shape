'use strict';
// v0.2.8: full chain on CPU with optional AI, AI context file, provider presets,
// AI-stroke confirmation, chunked line-aware AI drafts, ai-sheet, batch full chain,
// MP3 in analyze, opt-in tool hooks, guided panel wiring.
// All AI calls go to a loopback mock server started by this test. No paid API is contacted.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const SS = require('../js/vocal-handoff.js');
require('../js/ai-learn.js');
require('../js/ai-context.js');
require('../js/ai-chain.js');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'songshape.js');
const WAV = path.join(ROOT, 'demo', 'fictional_tone.wav');
const MP3 = path.join(ROOT, 'demo', 'fictional_tone.mp3');
const REF = '[Verse]\nThe fire rises\nThen we return';
const NEW = '[Verse]\nThe river calls me\nHome through the storm';
const HAS_FFMPEG = cp.spawnSync('ffmpeg', ['-version']).status === 0;
let total = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

const CHUNK_REPLY = JSON.stringify({ strokes: [{ start_ms: 0, end_ms: 1500, points: [[0, -0.2], [700, 0.3], [1500, 0.5]] }] });
const SHEET_REPLY = '[Tagged lyrics]\n[Global Vocal Direction: one lead]\n[Verse]\n[Delivery: rise on "river"]\nThe river calls me\n[Delivery: descend]\nHome through the storm\n\n[Style prompt]\nWarm lead.\n\n[Uncertainties]\nNone.';

function isSheetRequest(body) { return body && body.messages && body.messages[0].content.indexOf('final tagged lyric sheet') >= 0; }
function mockServer(reply) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        let body = null; try { body = JSON.parse(raw); } catch (e) {}
        seen.push({ url: req.url, body, auth: req.headers.authorization || null });
        const content = typeof reply === 'function' ? reply(body) : reply;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
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
function tmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'ss028-' + tag + '-')); }
function chainSession() {
  const s = SS.createSession();
  s.audio = { name: 'x.wav', duration_ms: 8000, included_in_export: false };
  SS.setLyrics(s, '[Verse]\nHello bright morning\nWe sing again\nAnd fly');
  const times = [500, 900, 1400, 3000, 3400, 3900, 6500, 6900];
  s.lyrics.words.forEach((w, i) => SS.placeNextWord(s, { start_ms: times[i], end_ms: times[i] }));
  s.draft = SS.buildDraft([...Array(400)].map((_, i) => ({ t_ms: i * 20, f0: i % 100 < 70 ? 200 + i : 0, voiced: i % 100 < 70, rms: 0.2 })));
  return s;
}

test('AI context: versioned file, embedded copy is current, JSON matches, override and idempotent system prompt', () => {
  const md = fs.readFileSync(path.join(ROOT, 'SONG_SHAPE_AI_CONTEXT.md'), 'utf8');
  const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'SONG_SHAPE_AI_CONTEXT.json'), 'utf8'));
  assert.equal(SS.AI_CONTEXT_DEFAULT_TEXT, md, 'run tools/build-ai-context.js after editing the context');
  assert.equal(SS.AI_CONTEXT_DEFAULT_SHA256, crypto.createHash('sha256').update(md, 'utf8').digest('hex'));
  assert.match(md, new RegExp('context_version: ' + json.context_version.replace(/\./g, '\\.')));
  for (const word of ['Place words', 'Draft the shape', 'Fit the replacement lyrics', 'Final sheet', '[Delivery:', 'You must', 'You must not']) assert.ok(md.includes(word), word);
  assert.equal(SS.getAiContextInfo().source, 'default');
  const m1 = SS.withAiContext([{ role: 'user', content: 'u' }]);
  assert.equal(m1[0].role, 'system'); assert.equal(m1[0].content, md);
  const m2 = SS.withAiContext([{ role: 'system', content: 'TASKTEXT' }, { role: 'user', content: 'u' }]);
  assert.ok(m2[0].content.startsWith(md) && m2[0].content.endsWith('TASKTEXT'));
  assert.deepEqual(SS.withAiContext(m2), m2, 'idempotent');
  SS.setAiContextOverride('# My context\ncontext_version: test-9\nBe careful.', 'mine.md');
  assert.deepEqual(SS.getAiContextInfo(), { source: 'override', label: 'mine.md', version: 'test-9', chars: 48 });
  assert.ok(SS.withAiContext([{ role: 'user', content: 'u' }])[0].content.startsWith('# My context'));
  assert.throws(() => SS.setAiContextOverride('x'.repeat(64001)), /larger/);
  assert.throws(() => SS.setAiContextOverride('   '), /empty/);
  SS.clearAiContextOverride();
  assert.equal(SS.getAiContextInfo().source, 'default');
});

test('every sendAiChat request carries the context in its system prompt', async () => {
  const { server, seen, base } = await mockServer('ok');
  try {
    SS.setAiConfig({ enabled: true, baseUrl: base, model: 'm', apiKey: '' });
    await new Promise((r) => SS.sendAiChat('plain prompt', r));
    await new Promise((r) => SS.sendAiChat([{ role: 'system', content: 'TASK-A' }, { role: 'user', content: 'x' }], r));
    assert.equal(seen[0].body.messages[0].role, 'system');
    assert.ok(seen[0].body.messages[0].content.startsWith('# Song Shape — AI context'));
    assert.equal(seen[0].body.messages[1].content, 'plain prompt');
    assert.ok(seen[1].body.messages[0].content.includes('TASK-A') && seen[1].body.messages[0].content.startsWith('# Song Shape'));
  } finally { server.close(); SS.clearAiConfig(); }
});

test('provider presets: local ones are loopback; xAI/OpenAI are remote with env-var key names', () => {
  const names = Object.keys(SS.AI_PRESETS).sort();
  assert.deepEqual(names, ['llamacpp', 'lmstudio', 'ollama', 'openai', 'openai-compatible', 'xai']);
  for (const n of ['ollama', 'lmstudio', 'llamacpp']) {
    assert.equal(SS.isAiLoopbackEndpoint(SS.AI_PRESETS[n].baseUrl), true, n);
    assert.equal(SS.AI_PRESETS[n].remote, false);
  }
  assert.equal(SS.AI_PRESETS.xai.baseUrl, 'https://api.x.ai/v1'); assert.equal(SS.AI_PRESETS.xai.keyEnv, 'XAI_API_KEY');
  assert.equal(SS.AI_PRESETS.openai.baseUrl, 'https://api.openai.com/v1'); assert.equal(SS.AI_PRESETS.openai.keyEnv, 'OPENAI_API_KEY');
  assert.equal(SS.AI_PRESETS.xai.remote && SS.AI_PRESETS.openai.remote, true);
  const cfg = SS.applyAiPreset('xai');
  assert.equal(cfg.remote, true); assert.equal(cfg.baseUrl, 'https://api.x.ai/v1');
  SS.clearAiConfig();
  assert.equal(SS.applyAiPreset('nope'), null);
});

test('AI strokes: flagged until confirmed; option leaves unconfirmed ones out of stages 3-4', () => {
  const s = chainSession();
  SS.applyAiTraceDraft(s, [{ start_ms: 500, end_ms: 2400, points: [[500, -0.2], [1400, 0.6], [2400, 0.1]] },
    { start_ms: 3000, end_ms: 5000, points: [[3000, 0.2], [5000, -0.4]] }], { model: 'm' });
  let map = SS.buildPerformanceMap(SS.sessionToJSON(s));
  assert.ok(map.groups[0].review_reasons.includes('ai_drafted_trace_not_confirmed'));
  assert.ok(map.groups[0].events.some((e) => e.evidence === 'ai_drafted_trace_unconfirmed'));
  assert.ok(map.warnings.some((w) => /2 unconfirmed AI-drafted stroke\(s\) are included/.test(w)));
  map = SS.buildPerformanceMap(SS.sessionToJSON(s), { excludeUnconfirmedAi: true });
  assert.ok(map.groups[0].review_reasons.includes('no_performance_strokes_for_line'));
  assert.equal(map.semantics.ai_strokes.unconfirmed_excluded, true);
  const id = s.strokes.find(SS.isAiStroke).id;
  assert.equal(SS.confirmAiStroke(s, id), true);
  assert.equal(SS.countUnconfirmedAi(s), 1);
  const c = s.strokes.find((x) => x.id === id);
  assert.ok(c.annotations.includes('ai_confirmed') && !c.annotations.includes('needs_review') && c.annotations.includes('ai_drafted_trace'));
  map = SS.buildPerformanceMap(SS.sessionToJSON(s), { excludeUnconfirmedAi: true });
  assert.ok(!map.groups[0].review_reasons.includes('ai_drafted_trace_not_confirmed'));
  assert.ok(map.groups[0].events.some((e) => e.evidence === 'ai_drafted_trace_confirmed'));
  assert.equal(SS.confirmAllAiStrokes(s), 1);
  assert.throws(() => SS.confirmAiStroke(s, 'nope'), /No stroke/);
  const parsed = SS.parseSession(JSON.parse(JSON.stringify(SS.sessionToJSON(s))));
  assert.equal(SS.countUnconfirmedAi(parsed), 0, 'confirmation survives export/import');
});

test('stage 2 chunks: lines grouped by time, window-relative grids, syllables; word text only with opt-in', () => {
  const s = chainSession();
  const chunks = SS.buildDraftChunks(s, s.draft, 8000, { chunkMs: 6000 });
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0].lines.map((l) => l.line_id), ['line-2', 'line-3']);
  assert.equal(chunks[0].features.frames[0][0], 0, 'relative grid');
  assert.equal(chunks[1].start_ms, 6500);
  const plain = SS.buildChunkMessages(chunks[0], [], {});
  assert.match(plain[0].content, /milliseconds from the start of the window/);
  assert.match(plain[1].content, /word onsets ms\(syllables\): 0\(2\) 400\(1\) 900\(2\)/);
  assert.match(plain[1].content, /word text withheld/);
  assert.ok(!/Hello|bright|morning/.test(plain[1].content));
  const withText = SS.buildChunkMessages(chunks[0], [], { includeWordText: true });
  assert.match(withText[1].content, /0 "Hello"\(2\) 400 "bright"\(1\)/);
  const none = SS.createSession(); none.audio = { duration_ms: 30000 };
  const fixed = SS.buildDraftChunks(none, s.draft, 30000, { chunkMs: 12000 });
  assert.deepEqual(fixed.map((c) => [c.start_ms, c.end_ms, c.lines.length]), [[0, 12000, 0], [12000, 24000, 0], [24000, 30000, 0]]);
  const ex = SS.exampleFromSession(Object.assign(chainSession(), { strokes: [{ id: 'stroke-1', start_ms: 400, end_ms: 2500, points: [[400, 0], [1500, 0.5], [2500, 0.1]], annotations: [] }] }), 'ex');
  assert.ok(ex.chunks.length >= 1 && ex.chunks[0].trace.some((f) => f[1] !== null));
  assert.match(SS.buildChunkMessages(chunks[0], [ex], {})[1].content, /Example 1 .*\n  line 2: 0-/);
});

test('chunk replies: relative or absolute times, clipped to the window, split at silence, stitched without overlap', async () => {
  const s = chainSession();
  const chunks = SS.buildDraftChunks(s, s.draft, 8000, { chunkMs: 6000 });
  const c = chunks[1]; // 6500-8000
  const rel = SS.parseChunkReply(JSON.stringify({ strokes: [{ points: [[0, 0.1], [600, 0.5], [99999, 1]] }] }), c);
  assert.equal(rel.time_base, 'window');
  assert.deepEqual([rel.strokes[0][0][0], rel.strokes[0][rel.strokes[0].length - 1][0]], [6500, 7100]);
  assert.ok(rel.strokes[0].every((p, i, a) => i === 0 || p[0] > a[i - 1][0]), 'time-ordered after resampling');
  const abs = SS.parseChunkReply(JSON.stringify({ strokes: [{ points: [[6600, 0.1], [7000, 0.9]] }] }), c);
  assert.equal(abs.time_base, 'absolute');
  assert.deepEqual([abs.strokes[0][0], abs.strokes[0][abs.strokes[0].length - 1]], [[6600, 0.1], [7000, 0.9]]);
  assert.throws(() => SS.parseChunkReply('no json', c), /JSON/);
  // Seen with qwen2.5:7b: a few coarse points, some inside silences. Resampling keeps the voiced shape.
  const c0 = chunks[0];
  const coarse = SS.parseChunkReply(JSON.stringify({ strokes: [{ points: [[0, -0.5], [c0.end_ms - c0.start_ms, 0.5]] }] }), c0);
  const voiced = c0.features.frames.filter((f) => f[1] !== null).length;
  const covered = c0.features.frames.filter((f) => f[1] !== null && coarse.strokes.some((st) => st[0][0] <= c0.start_ms + f[0] && st[st.length - 1][0] >= c0.start_ms + f[0])).length;
  assert.ok(covered / voiced > 0.8, 'coarse reply still covers the voiced frames: ' + covered + '/' + voiced);
  const st = SS.stitchStrokes([[[100, 0], [500, 0.2]], [[400, 0.1], [450, 0.2], [800, 0.3], [900, 0]]]);
  assert.deepEqual(st.map((x) => [x.start_ms, x.end_ms]), [[100, 500], [800, 900]]);
  let n = 0;
  const r = await SS.runChunkedTraceDraft(s, s.draft, 8000, [], { chunkMs: 6000, send: () => { n += 1; return Promise.resolve(n <= 2 ? 'garbage' : CHUNK_REPLY); } });
  assert.equal(r.chunks, 2); assert.equal(r.failed.length, 1, 'first window failed after one retry'); assert.equal(n, 3);
  assert.ok(r.strokes.length >= 1 && r.used_word_timing && !r.word_text_sent);
  await assert.rejects(SS.runChunkedTraceDraft(s, s.draft, 8000, [], { send: () => Promise.resolve('x') }), /failed for every window/);
});

test('stage 4 send-and-check: missing lyric lines are reported; unsafe replies rejected', async () => {
  const ok = await SS.sendAndCheckSheet('prompt', NEW, (m) => { assert.match(m[0].content, /final tagged lyric sheet/); return Promise.resolve(SHEET_REPLY); });
  assert.equal(ok.check.ok, true); assert.equal(ok.check.lyric_lines, 2); assert.deepEqual(ok.check.missing_blocks, []);
  const miss = await SS.sendAndCheckSheet('p', NEW, () => Promise.resolve('[Tagged lyrics]\nThe river calls me'));
  assert.deepEqual(miss.check.missing_lines, ['Home through the storm']);
  assert.deepEqual(miss.check.missing_blocks, ['[Style prompt]', '[Uncertainties]']);
  await assert.rejects(SS.sendAndCheckSheet('p', NEW, () => Promise.resolve('<script>x</script>')), /rejected/);
  assert.deepEqual(ok.check.format_warnings, [], JSON.stringify(ok.check.format_warnings));
  // Seen with qwen2.5:7b in the real-model run: section and delivery merged into one tag.
  const merged = SS.checkSheetAgainstLyrics('[Tagged lyrics]\n[Verse: Delivery: rise on "The"; hold]\nThe river calls me\nHome through the storm\n[Style prompt]\nx\n[Uncertainties]\n- y', NEW);
  assert.equal(merged.ok, true);
  assert.equal(merged.format_warnings.length, 2);
  assert.match(merged.format_warnings.join(' '), /Global Vocal Direction/); assert.match(merged.format_warnings.join(' '), /merged/);
  const inline = SS.checkSheetAgainstLyrics('[Global Vocal Direction: x]\n[Delivery: rise] The river calls me\nHome through the storm', NEW);
  assert.equal(inline.ok, true); assert.match(inline.format_warnings.join(' '), /share a line/);
});

test('CLI analyze: CPU-only chain from WAV and from MP3 via --ffmpeg; MP3 without ffmpeg is refused', async () => {
  const work = tmp('an');
  try {
    fs.writeFileSync(path.join(work, 'ref.txt'), REF); fs.writeFileSync(path.join(work, 'new.txt'), NEW);
    const r1 = await runCli(['analyze', WAV, path.join(work, 'ref.txt'), path.join(work, 'new.txt'), '-o', path.join(work, 'w')]);
    assert.equal(r1.code, 0, r1.err);
    const sheet = fs.readFileSync(path.join(work, 'w', 'tagged-lyrics.txt'), 'utf8');
    assert.match(sheet, /\[Global Vocal Direction:/); assert.match(sheet, /\[Delivery:/); assert.match(sheet, /The river calls me/);
    const q = JSON.parse(fs.readFileSync(path.join(work, 'w', 'QUALITY_CHECK.json'), 'utf8'));
    assert.equal(q.chain.stages.draft_shape.mode, 'cpu'); assert.equal(q.chain.stages.place_words.source, 'cpu_energy_estimate');
    const r2 = await runCli(['analyze', MP3, path.join(work, 'ref.txt'), path.join(work, 'new.txt'), '-o', path.join(work, 'm0')]);
    assert.notEqual(r2.code, 0); assert.match(r2.err, /--ffmpeg/); assert.equal(fs.existsSync(path.join(work, 'm0')), false);
    if (HAS_FFMPEG) {
      const r3 = await runCli(['analyze', MP3, path.join(work, 'ref.txt'), path.join(work, 'new.txt'), '-o', path.join(work, 'm'), '--ffmpeg', 'ffmpeg']);
      assert.equal(r3.code, 0, r3.err);
      assert.match(fs.readFileSync(path.join(work, 'm', 'tagged-lyrics.txt'), 'utf8'), /\[Delivery:/);
    } else console.log('    (ffmpeg not found: MP3 analyze branch skipped)');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('CLI analyze with AI: chunked line-aware draft + AI sheet, context in every request, word text only with opt-in', async () => {
  const work = tmp('ai');
  const { server, seen, base } = await mockServer((body) => isSheetRequest(body) ? SHEET_REPLY : CHUNK_REPLY);
  try {
    fs.writeFileSync(path.join(work, 'ref.txt'), REF); fs.writeFileSync(path.join(work, 'new.txt'), NEW);
    const r = await runCli(['analyze', WAV, path.join(work, 'ref.txt'), path.join(work, 'new.txt'), '-o', path.join(work, 'o'), '--endpoint', base, '--model', 'mock']);
    assert.equal(r.code, 0, r.err);
    const q = JSON.parse(fs.readFileSync(path.join(work, 'o', 'QUALITY_CHECK.json'), 'utf8'));
    assert.equal(q.chain.stages.draft_shape.mode, 'ai'); assert.equal(q.chain.stages.draft_shape.used_word_timing, true);
    assert.equal(q.chain.stages.final_sheet.ai_sheet, 'ai-tagged-lyrics.txt');
    assert.ok(fs.readFileSync(path.join(work, 'o', 'ai-tagged-lyrics.txt'), 'utf8').includes('[Tagged lyrics]'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(work, 'o', 'ai-sheet-check.json'), 'utf8')).ok, true);
    assert.ok(q.ai_unconfirmed_strokes >= 1, 'AI strokes stay unconfirmed');
    assert.ok(seen.length >= 2);
    for (const req of seen) {
      assert.ok(req.body.messages[0].content.startsWith('# Song Shape — AI context'), 'context in system prompt');
      assert.ok(!/The fire rises|"fire"/.test(JSON.stringify(req.body)), 'no reference lyric text without opt-in');
    }
    const n0 = seen.length;
    const r2 = await runCli(['analyze', WAV, path.join(work, 'ref.txt'), path.join(work, 'new.txt'), '-o', path.join(work, 'o2'), '--endpoint', base, '--model', 'mock', '--send-word-text', '--no-ai-sheet']);
    assert.equal(r2.code, 0, r2.err);
    const draftReqs = seen.slice(n0);
    assert.ok(draftReqs.some((x) => /"fire"/.test(x.body.messages[1].content)), 'word text sent only with --send-word-text');
    assert.ok(draftReqs.every((x) => !isSheetRequest(x.body)), '--no-ai-sheet');
    assert.equal(fs.existsSync(path.join(work, 'o2', 'ai-tagged-lyrics.txt')), false);
    assert.ok(fs.existsSync(path.join(work, 'o2', 'tagged-lyrics.txt')), 'CPU sheet always written');
  } finally { server.close(); fs.rmSync(work, { recursive: true, force: true }); }
});

test('CLI batch: CPU-only full chain per song, lyrics matched by filename, resumable, never overwrites', async () => {
  const work = tmp('b');
  try {
    const songs = path.join(work, 'songs'), lyr = path.join(work, 'lyrics'), out = path.join(work, 'out');
    fs.mkdirSync(path.join(songs, 'sub'), { recursive: true }); fs.mkdirSync(path.join(lyr, 'sub'), { recursive: true });
    fs.copyFileSync(WAV, path.join(songs, 'a.wav')); fs.copyFileSync(WAV, path.join(songs, 'sub', 'b.wav')); fs.copyFileSync(WAV, path.join(songs, 'nolyrics.wav'));
    fs.writeFileSync(path.join(lyr, 'a.txt'), REF); fs.writeFileSync(path.join(lyr, 'sub', 'b.txt'), REF);
    fs.writeFileSync(path.join(work, 'new.txt'), NEW);
    const args = ['batch', songs, '-o', out, '--lyrics-dir', lyr, '--new-lyrics', path.join(work, 'new.txt'), '--recursive'];
    const r1 = await runCli(args);
    assert.equal(r1.code, 0, r1.err);
    assert.match(r1.err, /CPU only/);
    for (const d of ['a', 'sub__b']) {
      for (const f of ['project.json', 'performance-map.json', 'ai-handoff.json', 'ai-request.txt', 'tagged-lyrics.txt', 'visual-map.svg', 'visual-handoff.html', 'QUALITY_CHECK.json']) assert.ok(fs.existsSync(path.join(out, d, f)), d + '/' + f);
      assert.match(fs.readFileSync(path.join(out, d, 'tagged-lyrics.txt'), 'utf8'), /\[Delivery:/);
    }
    const log = fs.readFileSync(path.join(out, 'batch-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(log.map((e) => e.status).sort(), ['ok', 'ok', 'skipped_no_lyrics']);
    assert.ok(log.filter((e) => e.status === 'ok').every((e) => e.stages.draft_shape.mode === 'cpu' && e.stages.final_sheet.cpu_sheet));
    assert.ok(!fs.readdirSync(out).some((f) => f.includes('.partial-')), 'no partial folders left');
    const r2 = await runCli(args);
    assert.notEqual(r2.code, 0); assert.match(r2.err, /--resume/);
    fs.writeFileSync(path.join(lyr, 'nolyrics.txt'), REF);
    const r3 = await runCli(args.concat(['--resume']));
    assert.equal(r3.code, 0, r3.err);
    assert.match(r3.err, /1 ok, 0 partial, 0 failed, 2 already done/);
    const r4 = await runCli(['ai-batch', songs, '-o', path.join(work, 'out2'), '--lyrics-dir', lyr, '--new-lyrics', path.join(work, 'new.txt'), '--limit', '1']);
    assert.equal(r4.code, 0, r4.err); assert.match(r4.err, /CPU only/);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('CLI ai-batch full chain with AI; remote and API-provider safety checks happen before any request', async () => {
  const work = tmp('ab');
  const { server, seen, base } = await mockServer((body) => isSheetRequest(body) ? SHEET_REPLY : CHUNK_REPLY);
  try {
    const songs = path.join(work, 'songs'), lyr = path.join(work, 'lyrics'), neu = path.join(work, 'new');
    [songs, lyr, neu].forEach((d) => fs.mkdirSync(d));
    fs.copyFileSync(WAV, path.join(songs, 'a.wav')); fs.writeFileSync(path.join(lyr, 'a.txt'), REF); fs.writeFileSync(path.join(neu, 'a.txt'), NEW);
    const r = await runCli(['ai-batch', songs, '-o', path.join(work, 'out'), '--lyrics-dir', lyr, '--new-lyrics', neu, '--endpoint', base, '--model', 'mock']);
    assert.equal(r.code, 0, r.err);
    const e = JSON.parse(fs.readFileSync(path.join(work, 'out', 'batch-log.jsonl'), 'utf8').trim());
    assert.equal(e.status, 'ok'); assert.equal(e.stages.draft_shape.mode, 'ai'); assert.equal(e.stages.final_sheet.ai_sheet, 'ai-tagged-lyrics.txt');
    assert.ok(fs.existsSync(path.join(work, 'out', 'a', 'ai-tagged-lyrics.txt')) && fs.existsSync(path.join(work, 'out', 'a', 'tagged-lyrics.txt')));
    const n = seen.length;
    const base2 = ['ai-batch', songs, '-o', path.join(work, 'x'), '--lyrics-dir', lyr, '--new-lyrics', neu];
    const r1 = await runCli(base2.concat(['--endpoint', 'https://example.org/v1', '--model', 'm']));
    assert.notEqual(r1.code, 0); assert.match(r1.err, /--allow-remote/);
    const env = Object.assign({}, process.env); delete env.XAI_API_KEY;
    const r2 = await runCli(base2.concat(['--provider', 'xai', '--model', 'grok-test', '--allow-remote']), { XAI_API_KEY: '' });
    assert.notEqual(r2.code, 0); assert.match(r2.err, /XAI_API_KEY is empty/);
    const r3 = await runCli(base2.concat(['--provider', 'xai', '--model', 'grok-test']), { XAI_API_KEY: 'test-not-a-key' });
    assert.notEqual(r3.code, 0); assert.match(r3.err, /--allow-remote/);
    const r4 = await runCli(base2.concat(['--provider', 'openai', '--allow-remote']), { OPENAI_API_KEY: 'test-not-a-key' });
    assert.notEqual(r4.code, 0); assert.match(r4.err, /--model/);
    assert.equal(seen.length, n, 'refused runs made no request'); assert.equal(fs.existsSync(path.join(work, 'x')), false);
  } finally { server.close(); fs.rmSync(work, { recursive: true, force: true }); }
});

test('CLI ai-sheet, confirm and --context override share the app paths', async () => {
  const work = tmp('sh');
  const { server, seen, base } = await mockServer(SHEET_REPLY);
  try {
    fs.writeFileSync(path.join(work, 'ref.txt'), REF); fs.writeFileSync(path.join(work, 'new.txt'), NEW);
    const a = await runCli(['analyze', WAV, path.join(work, 'ref.txt'), path.join(work, 'new.txt'), '-o', path.join(work, 'o')]);
    assert.equal(a.code, 0, a.err);
    fs.writeFileSync(path.join(work, 'ctx.md'), '# House context\ncontext_version: house-1\nUse short tags.');
    const r = await runCli(['ai-sheet', path.join(work, 'o', 'project.json'), path.join(work, 'new.txt'), '-o', path.join(work, 'sheet.txt'), '--endpoint', base, '--model', 'mock', '--context', path.join(work, 'ctx.md')]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /all 2 lyric lines present/); assert.match(r.err, /house-1/);
    assert.ok(fs.readFileSync(path.join(work, 'sheet.txt'), 'utf8').includes('[Style prompt]'));
    assert.ok(seen[0].body.messages[0].content.startsWith('# House context'));
    assert.match(seen[0].body.messages[0].content, /final tagged lyric sheet/);
    assert.match(seen[0].body.messages[1].content, /adapt_performance_tags_to_original_lyrics/);
    const again = await runCli(['ai-sheet', path.join(work, 'o', 'project.json'), path.join(work, 'new.txt'), '-o', path.join(work, 'sheet.txt'), '--endpoint', base, '--model', 'mock']);
    assert.notEqual(again.code, 0); assert.match(again.err, /already exists/); assert.equal(seen.length, 1);
    const proj = SS.parseSessionText(fs.readFileSync(path.join(work, 'o', 'project.json'), 'utf8'), 1e6);
    SS.applyAiTraceDraft(proj, [{ start_ms: 100, end_ms: 900, points: [[100, 0], [900, 0.4]] }], { model: 'm' });
    fs.writeFileSync(path.join(work, 'p.json'), JSON.stringify(SS.sessionToJSON(proj)));
    const c = await runCli(['confirm', path.join(work, 'p.json'), '--all', '-o', path.join(work, 'p2.json')]);
    assert.equal(c.code, 0, c.err); assert.match(c.out, /Confirmed 1 AI-drafted stroke\(s\); 0 still unconfirmed/);
  } finally { server.close(); fs.rmSync(work, { recursive: true, force: true }); }
});

test('opt-in tool hooks: separator output feeds analysis, aligner JSON feeds the word import; nothing runs without a path', async () => {
  const work = tmp('hk');
  try {
    fs.writeFileSync(path.join(work, 'ref.txt'), REF); fs.writeFileSync(path.join(work, 'new.txt'), NEW);
    const sep = path.join(work, 'sep.js');
    fs.writeFileSync(sep, "require('fs').copyFileSync(process.argv[2], process.argv[3]);");
    const ali = path.join(work, 'align.js');
    fs.writeFileSync(ali, "const fs=require('fs');const words=fs.readFileSync(process.argv[3],'utf8').split(/\\s+/).filter(w=>w&&!/^\\[/.test(w));" +
      "fs.writeFileSync(process.argv[4],JSON.stringify({words:words.map((w,i)=>({text:w,start:0.5+i*0.8,end:0.9+i*0.8}))}));");
    const r = await runCli(['analyze', WAV, path.join(work, 'ref.txt'), path.join(work, 'new.txt'), '-o', path.join(work, 'o'),
      '--separator', process.execPath, '--separator-args', JSON.stringify(sep) + ' {audio} {out}',
      '--aligner', process.execPath, '--aligner-args', JSON.stringify(ali) + ' {audio} {lyrics} {out}']);
    assert.equal(r.code, 0, r.err);
    const q = JSON.parse(fs.readFileSync(path.join(work, 'o', 'QUALITY_CHECK.json'), 'utf8'));
    assert.deepEqual(q.chain.stages.separate, { tool: 'generic', ok: true });
    assert.equal(q.chain.stages.place_words.source, 'aligner:generic');
    assert.equal(q.chain.stages.place_words.anchors, 6);
    const r2 = await runCli(['analyze', WAV, path.join(work, 'ref.txt'), path.join(work, 'new.txt'), '-o', path.join(work, 'o2'), '--aligner', path.join(work, 'missing.exe'), '--aligner-args', '{audio}']);
    assert.notEqual(r2.code, 0); assert.match(r2.err, /path not found/);
    const r3 = await runCli(['analyze', WAV, path.join(work, 'ref.txt'), path.join(work, 'new.txt'), '-o', path.join(work, 'o3'), '--aligner', process.execPath]);
    assert.notEqual(r3.code, 0); assert.match(r3.err, /--aligner-args/);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('UI wiring: guided panel, confirm controls, six presets, context controls, word-text opt-in, script order', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const id of ['guided', 'btn-g-run-1', 'btn-g-run-2', 'btn-g-run-3', 'btn-g-run-4', 'btn-g-run-all', 'btn-g-continue', 'g-status-1', 'g-status-4',
    'chk-g-ai-draft', 'chk-g-ai-sheet', 'chk-exclude-unconfirmed-ai', 'btn-confirm-ai-stroke', 'btn-confirm-all-ai',
    'btn-ai-context-load', 'btn-ai-context-reset', 'file-ai-context', 'chk-ai-word-text']) assert.match(html, new RegExp('id="' + id + '"'), id);
  for (const p of Object.keys(SS.AI_PRESETS)) assert.match(html, new RegExp('data-ai-preset="' + p + '"'), p);
  const order = ['js/ai.js', 'js/ai-learn.js', 'js/ai-context.js', 'js/ai-chain.js', 'js/app.js'].map((f) => html.indexOf('src="' + f + '"'));
  assert.ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), 'script order');
  assert.ok(!/<script[^>]+src="https?:/i.test(html), 'no remote scripts');
  const app = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  const runAll = app.slice(app.indexOf('function runFrom(n)'), app.indexOf('[1, 2, 3, 4].forEach'));
  assert.match(runAll, /k === 1 \|\| k === 2/, 'Run all pauses after stages 1 and 2');
  assert.match(fs.readFileSync(path.join(ROOT, 'js', 'ai.js'), 'utf8'), /withAiContext/);
});

(async () => {
  for (const [name, fn] of queue) { await fn(); total++; console.log('ok  ' + name); }
  console.log('\n' + total + ' v0.2.8 tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
