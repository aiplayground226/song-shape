'use strict';
// v0.2.10: standalone dashes are refused with a plain message (no silent failure, no guessing);
// repeat-consistency tolerance 0.7 (was 0.15), calibrated on real songs.
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

test('standalone dashes (-, \u2013, \u2014, --) are refused with a plain message naming the line', () => {
  for (const d of ['-', '\u2013', '\u2014', '--']) {
    const text = 'First line here\nOne day ' + d + ' the rock\nLast line';
    assert.throws(() => SS.cleanLyricInput(text), (e) => {
      assert.equal(e.code, 'SONG_SHAPE_STANDALONE_DASH');
      assert.deepEqual(e.lines, [2]);
      assert.match(e.message, /^Remove the standalone dash on line 2 /);
      assert.match(e.message, /Leave out standalone dashes \(-, \u2013, \u2014\)/);
      assert.match(e.message, /Hyphenated words such as well-known are fine/);
      return true;
    });
  }
  assert.throws(() => SS.cleanLyricInput('a \u2014 b\nok\nc - d'), /Remove the standalone dashes on lines 1, 3 /);
});

test('hyphenated words, attached dashes and dashes inside [bracket] tags are left alone', () => {
  const r = SS.cleanLyricInput('[Block 1 \u2014 Disgrace]\nA well-known face\nWe ran\u2014and ran\nOh-oh-oh\n[Pitch drop \u2013 soft]\nend');
  assert.equal(r.text, '[Verse]\nA well-known face\nWe ran\u2014and ran\nOh-oh-oh\n\n[Verse]\nend');
  assert.deepEqual(SS.findStandaloneDashes('well-known\n[x \u2014 y]\nfine'), []);
  assert.deepEqual(SS.findStandaloneDashes('a - b\nok\n\u2014').map((f) => f.line), [1, 3]);
});

test('older projects with a dash "word" get a plain message on timing import, not "missing text"', () => {
  const s = SS.createSession();
  SS.setLyrics(s, 'One day \u2014 the rock'); // bypasses the cleaner, like a project saved before v0.2.10
  const data = { words: [{ text: 'One', start: 0, end: 0.2 }, { text: 'day', start: 0.2, end: 0.4 }, { text: 'the', start: 0.5, end: 0.6 }, { text: 'rock', start: 0.6, end: 0.9 }] };
  assert.throws(() => SS.proposeImportedAlignment(s, data), /standalone dash .*Remove standalone dashes \(-, \u2013, \u2014\)/);
});

test('CLI refuses lyrics with a standalone dash with the same plain message (exit code non-zero)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss0210-'));
  const lyr = path.join(dir, 'l.txt'); fs.writeFileSync(lyr, 'One day \u2014 the rock\n');
  const wav = path.join(dir, 'a.wav');
  // 1 s of quiet 16-bit mono WAV
  const n = 8000, buf = Buffer.alloc(44 + n * 2); buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(16000, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  fs.writeFileSync(wav, buf);
  const r = cp.spawnSync(process.execPath, [CLI, 'analyze', wav, lyr, lyr, '-o', path.join(dir, 'out')], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /Remove the standalone dash on line 1/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('UI and README tell people to leave out standalone dashes', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.equal((html.match(/[Ll]eave out standalone dashes/g) || []).length, 3);
  const app = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  assert.match(app, /showLyricInputError\("lyrics-input-note", "Original lyrics"/);
  assert.match(app, /showLyricInputError\("new-lyrics-input-note", "Replacement lyrics"/);
  assert.match(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), /standalone dashes/);
  assert.match(SS.LYRIC_INPUT_RULES, /Leave out standalone dashes/);
});

function feat(o) { return Object.assign({ mean: 0, start: 0, end: 0, max: 0, min: 0, range: 0, peak_pos: 0.5, hold_ms: 0, breaks: 0, turns: 0 }, o); }
test('repeat tolerance is 0.7: repeats within 0.7 share tags, wider ones keep their own; explicit tolerance still wins', () => {
  assert.equal(SS.CPU_TAG_REPEAT_TOLERANCE, 0.7);
  const rows = () => [
    { text: 'Here we stand', features: feat({}), cues: ['level line', 'mid register'] },
    { text: 'Here we stand!', features: feat({ start: 0.59, turns: 1 }), cues: ['rising line'] }, // distance 0.59
    { text: 'Here we stand', features: feat({ start: 0.8 }), cues: ['falling line'] },             // distance 0.80
    { text: 'Other words', features: feat({}), cues: ['soft'] }
  ];
  const r = SS.applyRepeatConsistency(rows());
  assert.deepEqual(r[1].cues, ['level line', 'mid register']); assert.equal(r[1].repeat_of, 0);
  assert.deepEqual(r[2].cues, ['falling line']); assert.equal(r[2].repeat_of, null);
  assert.deepEqual(r[3].cues, ['soft']);
  const strict = SS.applyRepeatConsistency(rows(), 0.15);
  assert.equal(strict[1].repeat_of, null);
  assert.ok(Math.abs(SS.featureDistance(feat({}), feat({ start: 0.59, turns: 1 })) - 0.59) < 1e-9);
});

test('version is 0.2.10 or a later 0.2.x', () => {
  assert.match(SS.APP_VERSION, /^0\.2\.(1[0-9])(-dev)?$/);
});

console.log('\n' + total + ' v0.2.10 tests passed');
