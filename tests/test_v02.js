#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const SS = require("../js/ai.js"); // pulls strokes + lyrics + sheet + map + ai

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log("ok  " + name);
}
function assertThrows(fn, re) {
  let threw = false;
  try { fn(); } catch (err) {
    threw = true;
    if (re) assert.ok(re.test(String(err && err.message || err)), "unexpected: " + err);
  }
  assert.ok(threw, "expected a thrown error");
}

test("v0.1 files still import under the v0.2 schema", () => {
  const raw = fs.readFileSync(path.join(__dirname, "../demo/example_peak_break_pickup_nosedive.json"), "utf8");
  const session = SS.parseSession(JSON.parse(raw));
  assert.strictEqual(session.schema_version, "songshape-live-0.1");
  assert.strictEqual(session.strokes.length, 2);
  assert.strictEqual(session.gaps.length, 1);
  assert.ok(session.lyrics);
  assert.deepStrictEqual(session.lyrics.words, []);
  assert.deepStrictEqual(session.anchors, []);
  assert.strictEqual(session.draft, null);
  const json = SS.sessionToJSON(session);
  assert.strictEqual(json.schema_version, "songshape-live-0.2");
  assert.strictEqual(json.strokes.length, 2);
  const again = SS.parseSession(json);
  assert.strictEqual(again.strokes.length, 2);
});

test("parseLyrics keeps line breaks and section tags, and sequential place/skip/line/undo works", () => {
  const session = SS.createSession();
  const text = "[Verse]\nThey marked me in red,\nA badge of disgrace,\n\n[Chorus]\nWhat color is my honor?";
  SS.setLyrics(session, text);
  assert.ok(session.lyrics.text.indexOf("\n") >= 0);
  const kinds = session.lyrics.lines.map((l) => l.kind);
  assert.deepStrictEqual(kinds, ["tag", "lyric", "lyric", "blank", "tag", "lyric"]);
  assert.strictEqual(SS.nextWord(session).text, "They");
  const a1 = SS.placeNextWord(session, { start_ms: 500, end_ms: 900, stroke_id: "stroke-1", source: "next_word" });
  assert.strictEqual(a1.word_id, "word-1");
  assert.strictEqual(SS.nextWord(session).text, "marked");
  SS.skipNextWord(session);
  assert.strictEqual(SS.nextWord(session).text, "me");
  const linePlaced = SS.placeNextLine(session, { start_ms: 1000, end_ms: 2000, stroke_id: "stroke-1" });
  assert.ok(linePlaced.length >= 2);
  assert.strictEqual(SS.nextWord(session).text, "A");
  const undoneLine = SS.undoLastAnchor(session);
  assert.ok(undoneLine.length >= 2);
  assert.strictEqual(SS.nextWord(session).text, "me");
  SS.undoLastAnchor(session); // no: skip is not an anchor. next is still "me"? Wait, skip remains. After undoing the line, next is "me".
  // undo the first word placement
  // actually last remaining anchor is a1. One more undo:
  SS.undoLastAnchor(session);
  assert.strictEqual(SS.nextWord(session).text, "They");
  const progress = SS.lyricsProgress(session);
  assert.strictEqual(progress.placed, 0);
  assert.ok(progress.skipped >= 1);
});

test("moveAnchor adjusts a placed word and export/import keeps lyrics and anchors", () => {
  const session = SS.createSession();
  SS.setLyrics(session, "Hello world\nSecond line");
  const a = SS.placeNextWord(session, { start_ms: 100, end_ms: 200 });
  SS.moveAnchor(session, a.id, 140, 240);
  const json = SS.sessionToJSON(session);
  assert.ok(json.lyrics.text.indexOf("Second line") >= 0);
  assert.strictEqual(json.anchors.length, 1);
  assert.strictEqual(json.anchors[0].start_ms, 140);
  assert.strictEqual(json.anchors[0].end_ms, 240);
  const reloaded = SS.parseSession(json);
  assert.strictEqual(reloaded.anchors[0].start_ms, 140);
  assert.strictEqual(reloaded.lyrics.words[0].text, "Hello");
  assert.ok(reloaded.lyrics.text.indexOf("\n") >= 0);
});

test("malicious or invalid anchors and lyrics are rejected", () => {
  assertThrows(() => SS.parseSession({
    schema_version: "songshape-live-0.2",
    anchors: [{ id: "a1", word_id: "w1", start_ms: "<img>", end_ms: 1 }]
  }), /finite number/i);
  assertThrows(() => SS.parseSession({
    schema_version: "songshape-live-0.2",
    lyrics: { text: 123, lines: [], words: [] }
  }), /must be a string/i);
  assertThrows(() => SS.parseSession({
    schema_version: "songshape-live-0.2",
    draft: { baseline_hz: Infinity, strokes: [], gaps: [] }
  }), /finite number/i);
});

test("lyric sheet keeps line breaks and adds short Honor-style cues", () => {
  const session = SS.createSession();
  SS.setLyrics(session, "[Verse]\nThey marked me in red,\nA badge of disgrace,\n\n[Chorus]\nWhat color is my honor?");
  session.strokes = [{
    id: "stroke-1",
    start_ms: 0,
    end_ms: 2000,
    points: [[0, -0.4], [1000, 0.3], [2000, 0.9]],
    annotations: [],
    section: "Verse"
  }];
  SS.recomputeGaps(session);
  SS.placeNextLine(session, { start_ms: 0, end_ms: 2000, stroke_id: "stroke-1" });
  const sheet = SS.buildLyricSheet(session);
  assert.ok(sheet.text.indexOf("[Verse]") >= 0);
  assert.ok(sheet.text.indexOf("[Chorus]") >= 0);
  assert.ok(sheet.text.indexOf("They marked me in red,") >= 0);
  assert.ok(/\n\n/.test(sheet.text), "blank line preserved");
  assert.ok(/start softly|\[Rising pitch\]|\(rise\)/.test(sheet.text));
});

test("Map my lyrics aligns new lines to reference phrases and builds a paste-ready request", () => {
  const session = SS.createSession();
  session.reference = { title: "What Color Is My Honor", artist: "A public performer" };
  SS.setLyrics(session, "They marked me in red,\nA badge of disgrace,");
  session.strokes = [
    { id: "stroke-1", start_ms: 0, end_ms: 1500, points: [[0, -0.3], [1500, 0.8]], annotations: [], section: "Verse" },
    { id: "stroke-2", start_ms: 2000, end_ms: 3500, points: [[2000, 0.7], [3500, -0.5]], annotations: [], section: "Verse" }
  ];
  SS.recomputeGaps(session);
  SS.placeNextLine(session, { start_ms: 0, end_ms: 1500, stroke_id: "stroke-1" });
  SS.placeNextLine(session, { start_ms: 2000, end_ms: 3500, stroke_id: "stroke-2" });
  const mine = "I walk a different road,\nI keep my own name.";
  const mapped = SS.buildMappedSheet(session, mine);
  assert.ok(mapped.text.indexOf("I walk a different road,") >= 0);
  assert.ok(mapped.text.indexOf("I keep my own name.") >= 0);
  assert.ok(/do not name/i.test(mapped.stylePrompt));
  assert.ok(!/A public performer/.test(mapped.stylePrompt), "style prompt must not name the artist");
  const request = SS.buildMapRequest(session, mine);
  assert.ok(/Here is an example of public song/.test(request));
  assert.ok(/What Color Is My Honor/.test(request));
  assert.ok(/These are my lyrics/.test(request));
  assert.ok(/I walk a different road/.test(request));
  assert.ok(/Do not name the artist/.test(request));
  assert.ok(/They marked me in red/.test(request));
});

test("pitch detector tracks a synthetic sine sweep upward", () => {
  const tone = SS.makeSineSweep(1.5, 22050, 220, 660, 0.5);
  const frames = SS.analyzePitchLoudness(tone.samples, tone.sampleRate, { winMs: 40, hopMs: 20, minHz: 100, maxHz: 900, silenceRms: 0.01 });
  const voiced = frames.filter((f) => f.voiced && f.f0 > 0);
  assert.ok(voiced.length > 8, "expected voiced frames, got " + voiced.length);
  const early = voiced[Math.floor(voiced.length * 0.15)].f0;
  const late = voiced[Math.floor(voiced.length * 0.85)].f0;
  assert.ok(early > 180 && early < 350, "early f0 was " + early);
  assert.ok(late > 450 && late < 800, "late f0 was " + late);
  assert.ok(late > early + 80, "sweep should rise, early=" + early + " late=" + late);
  const draft = SS.buildDraft(frames);
  assert.ok(draft.strokes.length >= 1);
  assert.strictEqual(draft.method, "measured_pitch_and_rms");
  assert.ok(/measured_pitch/.test(draft.y_semantics));
  assert.ok(draft.baseline_hz > 0);
  const ys = draft.strokes[0].points.map((p) => p[1]);
  assert.ok(ys.every((y) => y >= -1 && y <= 1));
  // Rising sweep around a median baseline should start below and end above.
  assert.ok(ys[ys.length - 1] > ys[0]);
});

test("AI output is validated and secrets never appear in exports", () => {
  const session = SS.createSession();
  session.api_key = "sk-secret-should-never-export";
  session.ai = { apiKey: "sk-secret", baseUrl: "http://127.0.0.1:11434/v1" };
  const json = SS.sessionToJSON(session);
  const dumped = JSON.stringify(json);
  assert.ok(dumped.indexOf("sk-secret") < 0);
  assert.ok(!Object.prototype.hasOwnProperty.call(json, "api_key"));
  assert.ok(!Object.prototype.hasOwnProperty.call(json, "ai"));
  assert.ok(!SS.exportContainsSecrets(json));

  const badDraft = SS.validateAiDraft({ strokes: [{ id: "s", start_ms: "nope", end_ms: 1, points: [[0, 0]] }] });
  assert.strictEqual(badDraft.ok, false);

  const goodDraft = SS.validateAiDraft({
    strokes: [{ id: "stroke-1", start_ms: 0, end_ms: 100, points: [[0, 0], [100, 0.2]], annotations: [] }]
  });
  assert.ok(goodDraft.ok, goodDraft.error);

  const scripted = SS.validateAiSheet("<script>alert(1)</script>\nHello");
  assert.strictEqual(scripted.ok, false);

  const sheet = SS.validateAiSheet("[Verse]\n(start softly)\nHello world");
  assert.ok(sheet.ok);
  assert.ok(sheet.text.indexOf("[Verse]") >= 0);

  const cfg = SS.setAiConfig({ enabled: false, baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.1", apiKey: "sk-test" });
  assert.strictEqual(cfg.hasKey, true);
  const exportedAgain = JSON.stringify(SS.sessionToJSON(session));
  assert.ok(exportedAgain.indexOf("sk-test") < 0);
  SS.clearAiConfig();
});

test("Place-word and Trace are separate: ending a stroke never consumes the next lyric", () => {
  const session = SS.createSession();
  SS.setLyrics(session, "honor shown clearly");
  const rec = SS.createRecorder();
  SS.startStroke(session, rec, 0, -0.2);
  SS.addPoint(session, rec, 200, 0.1);
  SS.addPoint(session, rec, 400, 0.4);
  const stroke = SS.endStroke(session, rec, 500);
  assert.ok(stroke);
  assert.strictEqual(session.anchors.length, 0, "tracing must not place a word");
  assert.strictEqual(SS.nextWord(session).text, "honor");
  assert.strictEqual(stroke.word_id, null, "unassigned when no active word");

  const a = SS.placeNextWord(session, { start_ms: 0, end_ms: 0 });
  assert.strictEqual(a.word_id, session.active_word_id);
  assert.strictEqual(SS.nextWord(session).text, "shown");

  // Further traces attach to the active word and must not advance the queue.
  SS.startStroke(session, rec, 600, 0.4);
  SS.addPoint(session, rec, 800, 0.45);
  const hold = SS.endStroke(session, rec, 1100);
  SS.startStroke(session, rec, 1400, 0.4);
  SS.addPoint(session, rec, 1600, 0.1);
  const descent = SS.endStroke(session, rec, 1900);
  assert.strictEqual(SS.nextWord(session).text, "shown", "active word can own many strokes");
  assert.strictEqual(hold.word_id, a.word_id);
  assert.strictEqual(descent.word_id, a.word_id);
  const anchor = SS.anchorForWord(session, a.word_id);
  assert.ok(anchor.stroke_ids.indexOf(hold.id) >= 0);
  assert.ok(anchor.stroke_ids.indexOf(descent.id) >= 0);
  assert.ok(anchor.stroke_ids.length >= 2);

  const beforeStrokes = session.strokes.length;
  const undone = SS.undoLastAnchor(session);
  assert.ok(undone.length >= 1);
  assert.strictEqual(session.strokes.length, beforeStrokes, "undo word keeps strokes");
  assert.ok(session.strokes.every((s) => s.word_id === null));
  assert.strictEqual(SS.nextWord(session).text, "honor");

  SS.placeNextWord(session, { start_ms: 0, end_ms: 0 });
  SS.assignStrokeToWord(session, hold.id, session.active_word_id);
  const nAnchors = session.anchors.length;
  SS.undoLastStroke(session);
  assert.strictEqual(session.anchors.length, nAnchors, "undo stroke keeps the word anchor");
});

test("drag keeps token identity and marks associations for review when they no longer overlap", () => {
  const session = SS.createSession();
  SS.setLyrics(session, "honor");
  const a = SS.placeNextWord(session, { start_ms: 100, end_ms: 400 });
  session.strokes = [{ id: "stroke-1", start_ms: 100, end_ms: 400, points: [[100, 0], [400, 0.2]], annotations: [], word_id: a.word_id }];
  SS.assignStrokeToWord(session, "stroke-1", a.word_id);
  const moved = SS.moveAnchor(session, a.id, 2000, 2300);
  assert.strictEqual(moved.word_id, a.word_id);
  assert.strictEqual(session.lyrics.words[0].text, "honor");
  assert.strictEqual(moved.needs_review, true);
});

test("performer lock: sheet writes the lead once and never implies a vocalist swap", () => {
  const session = SS.createSession();
  assert.ok(/lead singer/i.test(session.performer.identity));
  assert.strictEqual(session.performer.allow_harmony, false);
  SS.setLyrics(session, "First line of the lead\nSecond line of the lead");
  session.strokes = [
    { id: "s1", start_ms: 0, end_ms: 1000, points: [[0, 0], [1000, 0.2]], annotations: [] },
    { id: "s2", start_ms: 1200, end_ms: 2200, points: [[1200, 0.2], [2200, 0]], annotations: [] }
  ];
  SS.placeNextLine(session, { start_ms: 0, end_ms: 1000, stroke_id: "s1" });
  SS.placeNextLine(session, { start_ms: 1200, end_ms: 2200, stroke_id: "s2" });
  const sheet = SS.buildLyricSheet(session);
  assert.ok(sheet.text.indexOf("[Global Vocal Direction:") === 0 || sheet.text.indexOf("[Global Vocal Direction:") >= 0);
  const directionHits = sheet.text.split("[Global Vocal Direction:").length - 1;
  assert.strictEqual(directionHits, 1);
  assert.ok(/First line of the lead/.test(sheet.text));
  assert.ok(/Second line of the lead/.test(sheet.text));
  // The global identity may mention "duet" / "choir handoff" as things not to do.
  // Per-line cues after that heading must not introduce a swap.
  const afterDirection = sheet.text.split("\n").filter((ln) => !/^\[Global Vocal Direction:/i.test(ln)).join("\n");
  assert.ok(!/\bduet\b|choir handoff|now a different singer|swap(?:ping)? (?:the )?vocalist|hand(?:s|ed) off/i.test(afterDirection));
  assert.ok(sheet.text.indexOf(SS.harmonyCue(session)) < 0, "unmarked lines must not grow a harmony cue");
  // Default identity is generic — not a hardcoded named singer.
  assert.ok(!/Cain|Thiel|Freddie/i.test(session.performer.identity));
});

test("Lantern harmony-then-solo: same lead throughout", () => {
  // Worked example (times approximate): at ~0:45 the line
  // "who keeps the lantern burning" is a harmonized group with the lead;
  // at ~0:49+ "burning into the night" is solo lead. Export keeps the
  // same lead on both lines. Harmony is backing, never a handoff.
  const session = SS.createSession();
  session.reference = { title: "Keep The Lantern Burning", artist: "" };
  session.performer.identity = "One consistent bright, clean male lyric tenor throughout. Same vocal timbre, character, and diction. Intensity and register may vary; no unexpected additional singer, duet, or choir handoff.";
  SS.setLyrics(session, "who keeps the lantern burning\nburning into the night");
  session.strokes = [
    { id: "stroke-harmony", start_ms: 45000, end_ms: 48800, points: [[45000, 0.1], [46500, 0.45], [48800, 0.2]], annotations: [], section: "Bridge" },
    { id: "stroke-solo", start_ms: 49000, end_ms: 53000, points: [[49000, 0.15], [53000, 0.1]], annotations: [], section: "Bridge" }
  ];
  SS.recomputeGaps(session);
  const harm = SS.placeNextLine(session, { start_ms: 45000, end_ms: 48800, stroke_id: "stroke-harmony" });
  const solo = SS.placeNextLine(session, { start_ms: 49000, end_ms: 53000, stroke_id: "stroke-solo" });
  assert.ok(harm.length >= 1);
  assert.ok(solo.length >= 1);
  SS.setHarmonyOnLine(session, harm[0].line_id, true);
  assert.ok(harm.every((a) => a.harmony === true));
  assert.ok(solo.every((a) => a.harmony !== true));

  const sheet = SS.buildLyricSheet(session);
  const cue = SS.harmonyCue(session);
  assert.ok(/same lead tenor, backing harmony joins under him/.test(cue));
  assert.ok(sheet.text.indexOf(cue) >= 0);
  assert.ok(/who keeps the lantern burning/.test(sheet.text));
  assert.ok(/burning into the night/.test(sheet.text));
  assert.ok(/\[Global Vocal Direction:/.test(sheet.text));
  assert.ok(/male lyric tenor/.test(sheet.text));

  const harmAt = sheet.text.indexOf("who keeps the lantern burning");
  const soloAt = sheet.text.indexOf("burning into the night");
  const cueAt = sheet.text.indexOf(cue);
  assert.ok(harmAt >= 0 && soloAt > harmAt);
  assert.ok(cueAt >= 0 && cueAt < harmAt, "harmony cue belongs with the marked line");
  assert.ok(sheet.text.indexOf(cue, harmAt) < 0, "solo line must not repeat the harmony cue");
  const afterDirection = sheet.text.split("\n").filter((ln) => !/^\[Global Vocal Direction:/i.test(ln)).join("\n");
  assert.ok(!/\bduet\b|choir handoff|different singer|now the choir|hand(?:s|ed) off/i.test(afterDirection));
  // The lead identity appears in the one global direction, not as a per-line swap.
  const tenorMentions = sheet.text.split(/lead tenor/i).length - 1;
  assert.ok(tenorMentions >= 1);
  assert.ok(tenorMentions <= 2, "do not repeat the lead on every line");

  const json = SS.sessionToJSON(session);
  assert.ok(json.anchors.some((a) => a.harmony === true));
  assert.ok(json.anchors.some((a) => a.harmony === false && a.start_ms >= 49000));
  const reloaded = SS.parseSession(json);
  const again = SS.buildLyricSheet(reloaded);
  assert.ok(again.text.indexOf(cue) >= 0);
  assert.ok(/burning into the night/.test(again.text));
  assert.ok(again.text.indexOf(cue, again.text.indexOf("who keeps the lantern burning")) < 0);
});

test("gaps stay unlabeled and Map my lyrics keeps the performer lock", () => {
  const session = SS.createSession();
  session.strokes = [
    { id: "a", start_ms: 0, end_ms: 500, points: [[0, 0], [500, 0.1]], annotations: [] },
    { id: "b", start_ms: 900, end_ms: 1400, points: [[900, 0.1], [1400, 0]], annotations: [] }
  ];
  SS.recomputeGaps(session);
  assert.ok(session.gaps.length >= 1);
  assert.ok(session.gaps.every((g) => g.breath === "unknown" || g.breath == null || g.label === "unlabeled_gap" || g.label == null || g.label === "gap"));
  const request = SS.buildMapRequest(session, "new words here");
  assert.ok(/lead singer only/i.test(request));
  assert.ok(/Do not imply a vocalist swap/i.test(request));
});

test("CLI WAV reader rejects non-WAV audio and accepts a RIFF/WAVE file", () => {
  const msg = SS.WAV_ONLY_MESSAGE;
  // v0.2.7: the browser also opens .mp3; the CLI WAV reader still needs RIFF/WAVE (MP3 via --ffmpeg).
  assert.strictEqual(msg, "The command line reads .wav (16-bit PCM or 32-bit float). For .mp3, pass --ffmpeg <path> or use the browser app.");

  const tone = SS.makeSineSweep(0.2, 8000, 220, 440, 0.4);
  const wavBuf = Buffer.from(SS.writeWavPcm16(tone.samples, tone.sampleRate));
  assert.ok(SS.isRiffWaveHeader(wavBuf));
  assert.strictEqual(SS.validateWavAudio("tone.wav", wavBuf), true);
  assert.strictEqual(SS.validateWavAudio("path/to/Tone.WAV", wavBuf), true);

  const id3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(32, 0xFF)]);
  const fakeMp3NamedWav = Buffer.concat([Buffer.from([0xFF, 0xFB]), Buffer.alloc(40, 0)]);
  function reject(name, buf) {
    let err = null;
    try { SS.validateWavAudio(name, buf); } catch (e) { err = e; }
    assert.ok(err, "expected rejection for " + name);
    assert.strictEqual(err.message, msg);
  }
  reject("song.mp3", id3);
  reject("song.ogg", wavBuf); // real WAVE bytes, wrong extension
  reject("song.m4a", wavBuf);
  reject("song.flac", wavBuf);
  reject("disguised.wav", fakeMp3NamedWav); // .wav name, not a RIFF/WAVE header
  reject("disguised.wav", id3);
  reject("too-small.wav", Buffer.from("RIFF"));

  // CLI draft uses the same helper.
  const { spawnSync } = require("child_process");
  const fs = require("fs");
  const path = require("path");
  const tmp = path.join(__dirname, "..", "examples");
  const badPath = path.join(require("os").tmpdir(), "songshape-reject.mp3");
  fs.writeFileSync(badPath, id3);
  const cli = path.join(__dirname, "..", "cli", "songshape.js");
  const mp3Run = spawnSync(process.execPath, [cli, "draft", badPath], { encoding: "utf8" });
  assert.ok(mp3Run.status !== 0);
  assert.ok((mp3Run.stderr || mp3Run.stdout).indexOf(msg) >= 0);

  const renamed = path.join(require("os").tmpdir(), "songshape-fake.wav");
  fs.writeFileSync(renamed, id3);
  const fakeWavRun = spawnSync(process.execPath, [cli, "draft", renamed], { encoding: "utf8" });
  assert.ok(fakeWavRun.status !== 0);
  assert.ok((fakeWavRun.stderr || fakeWavRun.stdout).indexOf(msg) >= 0);

  const good = path.join(tmp, "sine_sweep.wav");
  const okRun = spawnSync(process.execPath, [cli, "draft", good, "-o", path.join(require("os").tmpdir(), "songshape-wav-ok.json")], { encoding: "utf8" });
  assert.strictEqual(okRun.status, 0, okRun.stderr || okRun.stdout);
  assert.ok(fs.existsSync(path.join(require("os").tmpdir(), "songshape-wav-ok.json")));
  const dumped = JSON.parse(fs.readFileSync(path.join(require("os").tmpdir(), "songshape-wav-ok.json"), "utf8"));
  assert.strictEqual(dumped.schema_version, "songshape-live-0.2");
  assert.ok(dumped.draft && dumped.draft.strokes);
});

test("inline bracket cues are never placed as words and stay in the exported line", () => {
  const session = SS.createSession();
  SS.setLyrics(session, "What color is my [hold] honor\n[pause: 1 bar] They marked me\nStart [rise] the [hold] fire");
  assert.deepStrictEqual(
    session.lyrics.words.map((w) => w.text),
    ["What", "color", "is", "my", "honor", "They", "marked", "me", "Start", "the", "fire"]
  );
  assert.ok(session.lyrics.words.every((w) => !/\[/.test(w.text)));
  assert.ok(session.lyrics.lines[0].text.indexOf("[hold]") >= 0);
  assert.ok(session.lyrics.lines[1].text.indexOf("[pause: 1 bar]") >= 0);
  assert.ok(session.lyrics.lines[2].text.indexOf("[rise]") >= 0);
  assert.ok(session.lyrics.lines[2].text.indexOf("[hold]") >= 0);
  assert.ok(session.lyrics.lines.every((l) => l.kind === "lyric"));
  // Next-word queue skips cues: first word is What, not [hold].
  assert.strictEqual(SS.nextWord(session).text, "What");
  while (SS.nextWord(session)) SS.placeNextWord(session, { start_ms: 0, end_ms: 0 });
  const sheet = SS.buildLyricSheet(session);
  assert.ok(sheet.text.indexOf("What color is my [hold] honor") >= 0);
  assert.ok(sheet.text.indexOf("[pause: 1 bar] They marked me") >= 0);
  assert.ok(sheet.text.indexOf("Start [rise] the [hold] fire") >= 0);
  // A line that is only cues becomes kind "tag" and is still exported in place.
  SS.setLyrics(session, "[Verse]\n[hold]");
  assert.deepStrictEqual(session.lyrics.lines.map((l) => l.kind), ["tag", "tag"]);
  assert.deepStrictEqual(session.lyrics.words, []);
  const cueOnly = SS.buildLyricSheet(session);
  assert.ok(cueOnly.text.indexOf("[Verse]") >= 0);
  assert.ok(cueOnly.text.indexOf("[hold]") >= 0);
});

test("parenthesis words are not placed unless the toggle is on, and exports keep the (ad-libs)", () => {
  const session = SS.createSession();
  assert.strictEqual(session.place_parentheses, false);
  SS.setLyrics(session, "Hello (ooh) world\n(ooh)");
  assert.deepStrictEqual(session.lyrics.words.map((w) => w.text), ["Hello", "world"]);
  assert.strictEqual(session.lyrics.lines[0].kind, "lyric");
  assert.strictEqual(session.lyrics.lines[1].kind, "tag");
  assert.ok(session.lyrics.lines[0].text.indexOf("(ooh)") >= 0);
  assert.strictEqual(session.lyrics.lines[1].text.trim(), "(ooh)");
  SS.placeNextWord(session, { start_ms: 0, end_ms: 0 });
  SS.placeNextWord(session, { start_ms: 100, end_ms: 100 });
  const offSheet = SS.buildLyricSheet(session);
  assert.ok(offSheet.text.indexOf("Hello (ooh) world") >= 0);
  assert.ok(offSheet.text.indexOf("(ooh)") >= 0);

  SS.setPlaceParentheses(session, true);
  assert.strictEqual(session.place_parentheses, true);
  assert.strictEqual(session.anchors.length, 0, "toggling re-tokenizes and clears placements");
  assert.deepStrictEqual(session.lyrics.words.map((w) => w.text), ["Hello", "ooh", "world", "ooh"]);
  assert.strictEqual(session.lyrics.lines[1].kind, "lyric");
  assert.ok(session.lyrics.lines[0].text.indexOf("(ooh)") >= 0);
  const json = SS.sessionToJSON(session);
  assert.strictEqual(json.place_parentheses, true);
  const reloaded = SS.parseSession(json);
  assert.strictEqual(reloaded.place_parentheses, true);
  // Line text still has the parentheses, even when the inner words are placeable.
  const onSheet = SS.buildLyricSheet(session);
  assert.ok(onSheet.text.indexOf("Hello (ooh) world") >= 0);

  SS.setPlaceParentheses(session, false);
  assert.deepStrictEqual(session.lyrics.words.map((w) => w.text), ["Hello", "world"]);
  assert.strictEqual(session.place_parentheses, false);
});

test("Map my lyrics word counts ignore inline bracket cues", () => {
  const parsed = SS.splitNewLyrics("I keep [hold] my own name.\n(ooh)\n[Verse]\nHello [rise] there");
  const verse = parsed.sections.filter((s) => s.tag && /Verse/.test(s.tag))[0];
  assert.ok(verse, "entire [Verse] line remains a section tag");
  assert.strictEqual(verse.lines[0].text, "Hello [rise] there");
  assert.strictEqual(verse.lines[0].wordCount, 2);
  const first = parsed.sections[0].lines[0];
  assert.strictEqual(first.text, "I keep [hold] my own name.");
  assert.strictEqual(first.wordCount, 5);
  const adlib = parsed.sections[0].lines[1];
  assert.strictEqual(adlib.text, "(ooh)");
  assert.strictEqual(adlib.wordCount, 0);

  const session = SS.createSession();
  SS.setLyrics(session, "They marked me in red,");
  session.strokes = [{ id: "s1", start_ms: 0, end_ms: 1000, points: [[0, 0], [1000, 0.2]], annotations: [] }];
  SS.placeNextLine(session, { start_ms: 0, end_ms: 1000, stroke_id: "s1" });
  const mapped = SS.buildMappedSheet(session, "What color is my [hold] honor");
  assert.ok(mapped.text.indexOf("What color is my [hold] honor") >= 0);
});

test("no-audio draft plan returns the visible message and view-only defaults", () => {
  const planned = SS.planDraftJob({ hasAudio: false });
  assert.strictEqual(planned.ok, false);
  assert.strictEqual(planned.message, SS.NO_AUDIO_DRAFT_MESSAGE);
  assert.strictEqual(planned.message, "Open audio (.wav or .mp3) first, then build a draft from the decoded audio.");
  assert.strictEqual(planned.highlightOpen, true);

  const region = SS.planDraftJob({
    hasAudio: true,
    durationMs: 240000,
    onlyView: true,
    view: { startMs: 15000, endMs: 20000 }
  });
  assert.strictEqual(region.ok, true);
  assert.strictEqual(region.startMs, 15000);
  assert.strictEqual(region.endMs, 20000);

  const looped = SS.planDraftJob({
    hasAudio: true,
    durationMs: 240000,
    onlyView: true,
    view: { startMs: 0, endMs: 8000 },
    loop: { startMs: 15000, endMs: 20000 }
  });
  assert.strictEqual(looped.startMs, 15000);
  assert.strictEqual(looped.endMs, 20000);

  assert.ok(SS.shouldDefaultDraftOnlyView({
    durationMs: 240000,
    view: { startMs: 15000, endMs: 20000 }
  }), "a 5s window into a 4-minute file is zoomed in");
  assert.ok(SS.shouldDefaultDraftOnlyView({
    durationMs: 240000,
    loop: { startMs: 15000, endMs: 20000 },
    view: { startMs: 0, endMs: 240000 }
  }));
  assert.ok(!SS.shouldDefaultDraftOnlyView({
    durationMs: 6500,
    view: { startMs: 0, endMs: 6500 }
  }));

  const silence = new Float32Array(8000);
  const silentFrames = SS.analyzePitchLoudness(silence, 8000, { winMs: 40, hopMs: 20 });
  const silentDraft = SS.buildDraft(silentFrames);
  assert.strictEqual(silentDraft.strokes.length, 0, "silence should produce zero draft strokes");
});

function testAsync(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(function () {
      passed += 1;
      console.log("ok  " + name);
    });
}

Promise.resolve()
  .then(function () {
    return testAsync("chunked pitch analysis matches the sync result", function () {
      const tone = SS.makeSineSweep(1.5, 22050, 220, 660, 0.5);
      const opts = { winMs: 40, hopMs: 20, minHz: 100, maxHz: 900, silenceRms: 0.01 };
      const sync = SS.analyzePitchLoudness(tone.samples, tone.sampleRate, opts);
      assert.ok(sync.length > 8);
      const progress = [];
      return SS.analyzePitchLoudnessChunked(tone.samples, tone.sampleRate, Object.assign({
        framesPerSlice: 7,
        onProgress: function (p) { progress.push(p.percent); }
      }, opts)).then(function (chunked) {
        assert.strictEqual(chunked.length, sync.length);
        for (let i = 0; i < sync.length; i += 1) {
          assert.strictEqual(chunked[i].t_ms, sync[i].t_ms);
          assert.strictEqual(chunked[i].voiced, sync[i].voiced);
          assert.ok(Math.abs((chunked[i].f0 || 0) - (sync[i].f0 || 0)) < 1e-9);
          assert.ok(Math.abs(chunked[i].rms - sync[i].rms) < 1e-12);
        }
        assert.ok(progress.length >= 1);
        assert.strictEqual(progress[progress.length - 1], 100);
        const draftSync = SS.buildDraft(sync);
        const draftChunked = SS.buildDraft(chunked);
        assert.strictEqual(draftChunked.strokes.length, draftSync.strokes.length);
      });
    });
  })
  .then(function () {
    return testAsync("range-limited chunked analysis matches a 20-second-style window", function () {
      const tone = SS.makeSineSweep(4, 16000, 220, 660, 0.5);
      const opts = { winMs: 40, hopMs: 20, minHz: 100, maxHz: 900, startMs: 1000, endMs: 3000 };
      const sync = SS.analyzePitchLoudness(tone.samples, tone.sampleRate, opts);
      assert.ok(sync.length > 0);
      assert.ok(sync[0].t_ms >= 1000);
      assert.ok(sync[sync.length - 1].t_ms <= 3000);
      return SS.analyzePitchLoudnessChunked(tone.samples, tone.sampleRate, Object.assign({
        framesPerSlice: 11
      }, opts)).then(function (chunked) {
        assert.strictEqual(chunked.length, sync.length);
        assert.strictEqual(chunked[0].t_ms, sync[0].t_ms);
        assert.strictEqual(chunked[chunked.length - 1].t_ms, sync[chunked.length - 1].t_ms);
        for (let i = 0; i < sync.length; i += 1) {
          assert.ok(Math.abs((chunked[i].f0 || 0) - (sync[i].f0 || 0)) < 1e-9);
        }
      });
    });
  })
  .then(function () {
    return testAsync("chunked analysis can be canceled", function () {
      const tone = SS.makeSineSweep(2, 22050, 220, 440, 0.5);
      const cancel = { canceled: false };
      const pending = SS.analyzePitchLoudnessChunked(tone.samples, tone.sampleRate, {
        winMs: 40,
        hopMs: 20,
        framesPerSlice: 1,
        cancel: cancel
      });
      cancel.canceled = true;
      return pending.then(
        function () { assert.fail("canceled analysis should not resolve"); },
        function (err) {
          assert.strictEqual(err.code, "CANCELED");
          assert.ok(/canceled/i.test(err.message));
        }
      );
    });
  })
  .then(function () {
    console.log("\n" + passed + " v0.2 tests passed");
  })
  .catch(function (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });

