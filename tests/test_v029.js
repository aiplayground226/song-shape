'use strict';
// v0.2.9: lyric input rules (paste only; incoming [bracket] tags and (performance cues) ignored;
// output uses only Song Shape's own tags), CPU delivery-tag vocabulary derived from contour
// features (same contour -> same tags; repeated chorus stays consistent), Windows-safe tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const SS = require('../js/vocal-handoff.js');
require('../js/ai-learn.js');
require('../js/ai-context.js');
require('../js/ai-chain.js');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'songshape.js');
let total = 0;
function test(name, fn) { fn(); total++; console.log('ok  ' + name); }

// Every bracket Song Shape itself may write in a tagged sheet.
const OWN_TAG = /^\[(Global Vocal Direction: .*|Verse|Chorus|Delivery: .*|Backing harmonies support the same lead)\]$/;
function bracketLines(text) { return text.split('\n').map((l) => l.trim()).filter((l) => /\[/.test(l)); }

test('lyric input: [bracket] tags and clear (cues) are stripped; unclear ones kept and flagged; idempotent', () => {
  const raw = '\uFEFF[Intro: soft piano]\r\n[Verse 1]\r\nI walk [belted] a long road\r\n(whispered) Nobody knows\r\nCall my name (oh oh)\r\nHold me (softly, my love)\r\n\r\n[Chorus]\r\nHere we stand\r\nHere we stand [x2]\r\n\r\n[Bridge]\r\nOne more night (spoken)\r\n\r\n[Chorus]\r\nHere we stand\r\nHere we stand\r\n[Outro';
  const r = SS.cleanLyricInput(raw);
  assert.equal(r.text, '[Verse]\nI walk a long road\nNobody knows\nCall my name (oh oh)\nHold me (softly, my love)\n\n[Chorus]\nHere we stand\nHere we stand\n\n[Verse]\nOne more night\n\n[Chorus]\nHere we stand\nHere we stand');
  assert.deepEqual(r.stripped_cues, ['(whispered)', '(spoken)']);
  assert.deepEqual(r.ambiguous.map((a) => a.text), ['(softly, my love)']);
  assert.ok(r.ignored_tags.includes('[belted]') && r.ignored_tags.includes('[Intro: soft piano]') && r.ignored_tags.includes('[Outro'));
  assert.equal(SS.cleanLyricInput(r.text).text, r.text, 'idempotent');
  assert.equal(SS.classifyParenthetical('x2'), 'cue');
  assert.equal(SS.classifyParenthetical('oh oh'), 'lyric');
  assert.equal(SS.classifyParenthetical('ad-lib, louder'), 'cue');
  assert.match(SS.lyricInputNote(r), /ignored.*Song Shape writes its own tags/);
  assert.match(SS.LYRIC_INPUT_RULES, /never fetched/);
});

// Session with three placed reference lines and one stroke per line.
function session(contours, texts) {
  const s = SS.createSession();
  SS.setLyrics(s, SS.cleanLyricInput(texts.join('\n')).text);
  s.audio = { name: 'ref.wav', duration_ms: 12000, included_in_export: false };
  const words = [];
  texts.forEach((line, i) => line.split(' ').forEach((w, j, arr) => {
    const t0 = i * 4000 + 200 + j * (3000 / arr.length);
    words.push({ text: w, start: t0 / 1000, end: (t0 + 3000 / arr.length - 20) / 1000 });
  }));
  SS.applyProposals(s, SS.proposeImportedAlignment(s, { words }));
  s.strokes = contours.map((pts, i) => ({ id: 'stroke-' + (i + 1), word_id: null, start_ms: pts[0][0] + i * 4000, end_ms: pts[pts.length - 1][0] + i * 4000,
    points: pts.map((p) => [p[0] + i * 4000, p[1]]), annotations: [] }));
  return s;
}
const ARCH = [[200, -0.2], [1200, 0.6], [2000, 0.62], [3200, -0.3]];
const FALL = [[200, 0.6], [1500, 0.1], [3200, -0.8]];
function handoff(s, newText) {
  const m = SS.buildPerformanceMap(SS.sessionToJSON(s));
  return SS.makeHandoff(m, SS.buildTransfer(m, newText));
}

test('output sheet carries only Song Shape tags, never the incoming ones', () => {
  const s = session([ARCH, FALL, ARCH], ['Hold the line tonight', 'River runs below us', 'Hold the line tonight']);
  const h = handoff(s, '[Chorus: gang vocals]\n[Belting]\nKeep the fire (whispered) burning\n[Verse]\nStones beneath the water [growl]\n\n[Chorus]\nKeep the fire burning');
  for (const l of bracketLines(h.lyrics)) assert.match(l, OWN_TAG, l);
  assert.ok(!/gang vocals|Belting|growl|whispered/.test(h.lyrics));
  assert.ok(!/gang vocals|Belting|growl|whispered/.test(h.prompt), 'AI request carries the cleaned lyrics only');
  assert.ok(h.lyrics.includes('Keep the fire burning\n'));
  assert.ok(h.warnings.some((w) => /ignored/.test(w)));
});

test('CPU vocabulary: deterministic, from the contour; different shapes give different tags; <= 8 cues', () => {
  const shapes = {
    rising: [[0, -0.5], [1500, 0], [3000, 0.6]],
    falling: FALL.map((p) => [p[0] - 200, p[1]]),
    arch: ARCH.map((p) => [p[0] - 200, p[1]]),
    valley: [[0, 0.3], [1500, -0.6], [3000, 0.3]],
    level: [[0, 0.05], [3000, 0.1]],
    long_hold: [[0, 0.2], [400, 0.5], [2600, 0.52], [3000, 0.2]]
  };
  const seen = new Set();
  const all = [].concat(...Object.values(SS.CPU_TAG_VOCABULARY).map((d) => Object.values(d)));
  for (const [name, pts] of Object.entries(shapes)) {
    const f = SS.lineFeatures([{ start_ms: 0, end_ms: 3000, points: pts }], { start_ms: 0, end_ms: 3000, word_count: 5 });
    const cues = SS.cpuLineCues(f, null);
    assert.deepEqual(SS.cpuLineCues(SS.lineFeatures([{ start_ms: 0, end_ms: 3000, points: pts }], { start_ms: 0, end_ms: 3000, word_count: 5 }), null), cues, 'deterministic');
    assert.ok(cues.length >= 3 && cues.length <= SS.CPU_TAG_MAX_CUES, name);
    for (const c of cues) assert.ok(all.some((v) => c === v || c.startsWith(v + ' ')), name + ': ' + c);
    seen.add(cues.join('; '));
  }
  assert.equal(seen.size, Object.keys(shapes).length, 'each distinct shape is described differently');
  const brk = SS.cpuLineCues(SS.lineFeatures([{ start_ms: 0, end_ms: 1200, points: [[0, 0.1], [1200, 0.3]] }, { start_ms: 1700, end_ms: 3000, points: [[1700, 0.3], [3000, 0.1]] }], { start_ms: 0, end_ms: 3000 }), null);
  assert.ok(brk.includes('phrase break mid-line') && !brk.includes('breath'), 'an unlabeled gap is not called a breath');
  const breath = SS.cpuLineCues(SS.lineFeatures([{ start_ms: 0, end_ms: 1200, points: [[0, 0.1], [1200, 0.3]] }, { start_ms: 1700, end_ms: 3000, points: [[1700, 0.3], [3000, 0.1]] }], { start_ms: 0, end_ms: 3000, gaps: [{ label: 'breath' }] }), null);
  assert.ok(breath.includes('breath'));
});

test('repeated chorus sung the same way gets the same tags; a different contour gets different tags', () => {
  const NEAR = ARCH.map((p, i) => [p[0] + (i ? 40 : 0), p[1] + (i % 2 ? 0.03 : -0.02)]); // near-identical
  const s = session([ARCH, FALL, NEAR], ['Hold the line tonight', 'River runs below us', 'Hold the line tonight']);
  const h = handoff(s, 'Hold the line tonight\nRiver runs below us\nHold the line tonight');
  const [c1, v, c2] = h.rows;
  assert.deepEqual(c2.cpu_tags, c1.cpu_tags, 'same contour, same tags');
  assert.notDeepEqual(v.cpu_tags, c1.cpu_tags, 'different contour, different tags');
  // No anti-repetition: the identical tag line is written twice.
  const delivery = h.lyrics.split('\n').filter((l) => l.startsWith('[Delivery:'));
  assert.equal(delivery[0], delivery[2]);
  assert.equal(h.payload.projected_lines[2].same_tags_as_line, 1);
  // Same words but sung differently: tags follow the contour, not the text.
  const s2 = session([ARCH, FALL, FALL], ['Hold the line tonight', 'River runs below us', 'Hold the line tonight']);
  const h2 = handoff(s2, 'Hold the line tonight\nRiver runs below us\nHold the line tonight');
  assert.notDeepEqual(h2.rows[2].cpu_tags, h2.rows[0].cpu_tags);
  assert.equal(h2.rows[2].tags_repeat_of_line, null);
  // The generated sheet passes the stage-4 format check.
  const chk = SS.checkSheetAgainstLyrics(h.lyrics, 'Hold the line tonight\nRiver runs below us\nHold the line tonight');
  assert.equal(chk.ok, true); assert.deepEqual(chk.format_warnings, []);
});

test('pitch-tracker fragments are one sung unit: no false breaks or detached notes (real-song calibration)', () => {
  // A smooth arch, as one stroke and as 40 ms fragments with 80 ms dropouts (what real tracking produces).
  const y = (t) => Math.round(Math.sin(Math.PI * t / 3000) * 0.8 * 100) / 100;
  const whole = [{ start_ms: 0, end_ms: 3000, points: Array.from({ length: 31 }, (_, i) => [i * 100, y(i * 100)]) }];
  const frags = [];
  for (let t = 0; t + 40 <= 3000; t += 120) frags.push({ start_ms: t, end_ms: t + 40, points: [[t, y(t)], [t + 40, y(t + 40)]] });
  const opts = { start_ms: 0, end_ms: 3000, word_count: 6 };
  const a = SS.cpuLineCues(SS.lineFeatures(whole, opts), null), b = SS.cpuLineCues(SS.lineFeatures(frags, opts), null);
  assert.ok(!b.includes('phrase break mid-line') && !b.includes('short detached notes'), b.join('; '));
  const core = (c) => c.filter((x) => !/held note|sustained/.test(x)); // hold length may differ by one 120 ms sample
  assert.deepEqual(core(b), core(a), 'fragmented and continuous tracking of the same arch give the same tags');
  // A real rest (>= 0.45 s) in the middle is still a phrase break; one at the very start is not.
  const rest = [{ start_ms: 0, end_ms: 1200, points: [[0, 0.1], [1200, 0.4]] }, { start_ms: 1800, end_ms: 3000, points: [[1800, 0.4], [3000, 0.1]] }];
  assert.ok(SS.cpuLineCues(SS.lineFeatures(rest, opts), null).includes('phrase break mid-line'));
  const lead = [{ start_ms: 0, end_ms: 60, points: [[0, 0], [60, 0]] }, { start_ms: 700, end_ms: 3000, points: [[700, 0.1], [3000, 0.4]] }];
  assert.ok(!SS.cpuLineCues(SS.lineFeatures(lead, opts), null).includes('phrase break mid-line'));
});

test('CLI: bracketed lyric files -> only Song Shape tags in tagged-lyrics.txt; input report in QUALITY_CHECK', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'songshape-v029-'));
  try {
    fs.writeFileSync(path.join(work, 'ref.txt'), '\uFEFFMy Song Title?\n[Verse 1: whispered]\nThe fire rises\n(spoken) Then we return');
    fs.writeFileSync(path.join(work, 'new.txt'), '[Verse]\n[Powerful belt]\nThe river calls me\nHome through the storm (echo)');
    const r = cp.spawnSync(process.execPath, [CLI, 'analyze', path.join(ROOT, 'demo', 'fictional_tone.wav'), path.join(work, 'ref.txt'), path.join(work, 'new.txt'), '-o', path.join(work, 'out')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const sheet = fs.readFileSync(path.join(work, 'out', 'tagged-lyrics.txt'), 'utf8');
    const tagged = sheet.split('\n[Style prompt]')[0];
    for (const l of bracketLines(tagged)) assert.match(l, OWN_TAG, l);
    assert.ok(!/whispered|Powerful belt|echo|spoken/.test(sheet));
    assert.ok(sheet.includes('Home through the storm\n'));
    const q = JSON.parse(fs.readFileSync(path.join(work, 'out', 'QUALITY_CHECK.json'), 'utf8'));
    assert.equal(q.chain.lyric_input.original_lyrics.ignored_tags, 1);
    assert.equal(q.chain.lyric_input.original_lyrics.stripped_cues, 1);
    assert.equal(q.chain.lyric_input.new_lyrics.ignored_tags, 2);
    const usage = cp.spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
    assert.match(usage.stdout + usage.stderr, /never fetches lyrics/i);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('AI context documents the vocabulary and the same-contour-same-tags rule; UI has two labeled paste boxes', () => {
  const md = fs.readFileSync(path.join(ROOT, 'SONG_SHAPE_AI_CONTEXT.md'), 'utf8');
  for (const dim of Object.values(SS.CPU_TAG_VOCABULARY)) for (const term of Object.values(dim)) assert.ok(md.includes(term), 'context lists "' + term + '"');
  assert.match(md, /same contour/i); assert.match(md, /ignored/i);
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /Original lyrics \(paste\)/); assert.match(html, /Your replacement lyrics \(paste\)/);
  assert.match(html, /never downloads lyrics/); assert.match(html, /id="lyrics-format-help"/);
  assert.ok(html.indexOf('js/lyric-input.js') < html.indexOf('js/performance-map.js'));
  assert.ok(html.indexOf('js/cpu-tags.js') < html.indexOf('js/vocal-handoff.js'));
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /blank line between sections/i);
});

test('tests no longer hard-code /tmp (Windows)', () => {
  for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.js'))) {
    assert.ok(!/["']\/tmp[\/"']/.test(fs.readFileSync(path.join(__dirname, f), 'utf8')), f);
  }
});

console.log('\n' + total + ' v0.2.9 tests passed');
