#!/usr/bin/env node
/**
 * Headless tests for Song Shape stroke timing, gaps, JSON, and helpers.
 * Run: node tests/test_strokes.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const SS = require("../js/strokes.js");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log("ok  " + name);
}

/** Add points along a stroke without exceeding MAX_TIME_JUMP_MS. */
function trace(session, rec, points) {
  points.forEach(function (p, i) {
    if (i === 0) SS.startStroke(session, rec, p[0], p[1]);
    else {
      var last = rec.active.points[rec.active.points.length - 1];
      var t0 = last[0];
      var y0 = last[1];
      var t1 = p[0];
      var y1 = p[1];
      var span = t1 - t0;
      var steps = Math.max(1, Math.ceil(span / 80));
      for (var s = 1; s <= steps; s++) {
        var t = Math.round(t0 + (span * s) / steps);
        var y = y0 + (y1 - y0) * (s / steps);
        SS.addPoint(session, rec, t, y);
      }
    }
  });
}

test("schema constants and new session fields", () => {
  const s = SS.createSession();
  assert.strictEqual(s.schema_version, "songshape-live-0.2");
  assert.strictEqual(s.method, "manual_listener_trace");
  assert.strictEqual(s.y_semantics, "subjective_vocal_delivery_relative_to_singer_baseline");
  assert.strictEqual(s.y_units, "normalized_relative");
  assert.strictEqual(s.baseline.y, 0);
  assert.strictEqual(s.audio.included_in_export, false);
  assert.ok(/not measured pitch/i.test(s.notes));
});

test("audioTimeMs uses playback seconds plus offset, not wall time", () => {
  assert.strictEqual(SS.audioTimeMs(1.234, 0), 1234);
  assert.strictEqual(SS.audioTimeMs(1.234, -40), 1194);
  assert.strictEqual(SS.audioTimeMs(0, 25), 25);
});

test("a held stroke records points and ends on release", () => {
  const session = SS.createSession();
  const rec = SS.createRecorder();
  SS.startStroke(session, rec, 500, 0);
  SS.addPoint(session, rec, 600, 0.2);
  SS.addPoint(session, rec, 800, 0.5);
  const saved = SS.endStroke(session, rec, 900);
  assert.strictEqual(session.strokes.length, 1);
  assert.strictEqual(saved.start_ms, 500);
  assert.ok(saved.end_ms >= 800);
  assert.ok(saved.points.length >= 3);
  assert.strictEqual(rec.active, null);
});

test("two strokes keep an exact unjoined gap that is not called a breath", () => {
  const session = SS.createSession();
  const rec = SS.createRecorder();
  trace(session, rec, [[500, 0], [1500, 0.7], [2500, 1.0]]);
  SS.endStroke(session, rec, 2500);
  trace(session, rec, [[2900, 0.95], [4000, 0], [5400, -0.8]]);
  SS.endStroke(session, rec, 5400);
  assert.strictEqual(session.strokes.length, 2);
  assert.strictEqual(session.gaps.length, 1);
  const gap = session.gaps[0];
  assert.strictEqual(gap.start_ms, 2500);
  assert.strictEqual(gap.end_ms, 2900);
  assert.strictEqual(gap.duration_ms, 400);
  assert.strictEqual(gap.breath, "unknown");
  assert.notStrictEqual(gap.label, "breath");
  const allTimes = session.strokes.flatMap((st) => st.points.map((p) => p[0]));
  assert.ok(allTimes.every((t) => t <= 2500 || t >= 2900));
});

test("JSON export/import preserves stroke separation and labels", () => {
  const session = SS.createSession();
  const rec = SS.createRecorder();
  trace(session, rec, [[44000, 0.0], [45300, 0.7], [46000, 1.0]]);
  SS.endStroke(session, rec, 46000);
  session.strokes[0].annotations = ["rise", "peak"];
  trace(session, rec, [[46400, 0.95], [47100, 0.3], [48700, -0.8]]);
  SS.endStroke(session, rec, 48700);
  session.strokes[1].annotations = ["pickup", "nosedive"];
  SS.setGapLabel(session, 46000, 46400, "user_marked_break", "unknown");
  const json = SS.sessionToJSON(session);
  assert.strictEqual(json.audio.included_in_export, false);
  const raw = JSON.stringify(json);
  const reloaded = SS.parseSession(JSON.parse(raw));
  assert.strictEqual(reloaded.strokes.length, 2);
  assert.strictEqual(reloaded.strokes[0].end_ms, reloaded.gaps[0].start_ms);
  assert.strictEqual(reloaded.strokes[1].start_ms, reloaded.gaps[0].end_ms);
  assert.strictEqual(reloaded.gaps[0].duration_ms, 400);
  assert.strictEqual(reloaded.gaps[0].label, "user_marked_break");
  assert.strictEqual(reloaded.gaps[0].breath, "unknown");
  assert.deepStrictEqual(reloaded.strokes[0].annotations, ["rise", "peak"]);
  assert.deepStrictEqual(reloaded.strokes[1].annotations, ["pickup", "nosedive"]);
});

test("seeking backward while held closes the stroke at the last sample, not the new time", () => {
  const session = SS.createSession();
  const rec = SS.createRecorder();
  SS.startStroke(session, rec, 1000, 0);
  SS.addPoint(session, rec, 1100, 0.2);
  SS.addPoint(session, rec, 1200, 0.4);
  const result = SS.addPoint(session, rec, 200, 0.4);
  assert.strictEqual(result.status, "closed_on_backward_jump");
  assert.strictEqual(rec.active, null);
  assert.strictEqual(session.strokes.length, 1);
  assert.strictEqual(session.strokes[0].end_ms, 1200);
  assert.ok(session.strokes[0].points.every((p) => p[0] >= 1000 && p[0] <= 1200));
});

test("a large forward clock jump while held closes the stroke (no join across a seek)", () => {
  const session = SS.createSession();
  const rec = SS.createRecorder();
  SS.startStroke(session, rec, 1000, 0);
  SS.addPoint(session, rec, 1200, 0.2);
  const result = SS.addPoint(session, rec, 1200 + SS.MAX_TIME_JUMP_MS + 50, 0.3);
  assert.strictEqual(result.status, "closed_on_forward_jump");
  assert.strictEqual(session.strokes[0].end_ms, 1200);
  assert.ok(session.strokes[0].points.every((p) => p[0] <= 1200));
});

test("paused clock (same currentTime) does not invent a time span", () => {
  const session = SS.createSession();
  const rec = SS.createRecorder();
  SS.startStroke(session, rec, 2000, 0.1);
  const a = SS.addPoint(session, rec, 2000, 0.4);
  const b = SS.addPoint(session, rec, 2000, 0.6);
  assert.ok(a.status === "updated_same_time" || a.status === "added");
  assert.strictEqual(b.status, "updated_same_time");
  SS.endStroke(session, rec, 2000);
  assert.strictEqual(session.strokes[0].end_ms, session.strokes[0].start_ms);
});

test("a new press after release starts a new stroke; strokes are never merged", () => {
  const session = SS.createSession();
  const rec = SS.createRecorder();
  SS.startStroke(session, rec, 1000, 0);
  SS.endStroke(session, rec, 1100);
  SS.startStroke(session, rec, 1101, 0);
  SS.endStroke(session, rec, 1200);
  assert.strictEqual(session.strokes.length, 2);
  assert.notStrictEqual(session.strokes[0].id, session.strokes[1].id);
  assert.strictEqual(session.gaps[0].duration_ms, 1);
});

test("y values are clamped to the normalized [-1, 1] range", () => {
  const session = SS.createSession();
  const rec = SS.createRecorder();
  SS.startStroke(session, rec, 0, 5);
  SS.addPoint(session, rec, 20, -4);
  SS.endStroke(session, rec, 40);
  const ys = session.strokes[0].points.map((p) => p[1]);
  assert.ok(ys.every((y) => y >= -1 && y <= 1));
  assert.strictEqual(ys[0], 1);
});

test("undo and delete do not silently rewrite earlier strokes", () => {
  const session = SS.createSession();
  const rec = SS.createRecorder();
  SS.startStroke(session, rec, 0, 0);
  SS.endStroke(session, rec, 100);
  SS.startStroke(session, rec, 200, 0);
  SS.endStroke(session, rec, 300);
  const firstId = session.strokes[0].id;
  SS.undoLastStroke(session, rec);
  assert.strictEqual(session.strokes.length, 1);
  assert.strictEqual(session.strokes[0].id, firstId);
  SS.deleteStrokeById(session, firstId);
  assert.strictEqual(session.strokes.length, 0);
});

test("each stroke polyline stays inside its own time range and does not fill the gap", () => {
  const session = SS.createSession();
  const rec = SS.createRecorder();
  SS.startStroke(session, rec, 0, 0);
  for (let t = 50; t <= 800; t += 50) SS.addPoint(session, rec, t, t / 800);
  SS.endStroke(session, rec, 800);
  SS.startStroke(session, rec, 1000, 0.8);
  SS.addPoint(session, rec, 1080, 0.4);
  SS.addPoint(session, rec, 1160, -0.2);
  SS.addPoint(session, rec, 1400, -0.5);
  SS.endStroke(session, rec, 1600);
  const a = SS.strokePolyline(session.strokes[0]);
  const b = SS.strokePolyline(session.strokes[1]);
  assert.ok(a.length >= 2 && b.length >= 2);
  assert.ok(a.every((p) => p[0] <= 800));
  assert.ok(b.every((p) => p[0] >= 1000));
  const times = a.concat(b).map((p) => p[0]);
  assert.ok(times.every((t) => t <= 800 || t >= 1000));
  assert.strictEqual(session.gaps.length, 1);
  assert.strictEqual(session.gaps[0].start_ms, 800);
  assert.strictEqual(session.gaps[0].end_ms, 1000);
});

test("text summary describes the annotation and does not claim to hear or measure pitch", () => {
  const session = SS.parseSession({
    schema_version: "songshape-live-0.1",
    method: "manual_listener_trace",
    y_semantics: "subjective_vocal_delivery_relative_to_singer_baseline",
    strokes: [
      { id: "stroke-1", start_ms: 500, end_ms: 2500, points: [[500, 0], [2500, 1]], annotations: ["rise", "peak"] },
      { id: "stroke-2", start_ms: 2900, end_ms: 5400, points: [[2900, 0.95], [5400, -0.8]], annotations: ["pickup", "nosedive"] }
    ],
    gaps: [{ start_ms: 2500, end_ms: 2900, label: "user_marked_break", breath: "unknown" }]
  });
  const text = SS.textSummary(session);
  assert.ok(/manual/i.test(text));
  assert.ok(/not measured pitch/i.test(text));
  assert.ok(/listener marked this gap/i.test(text));
  assert.ok(/Breath: unknown/i.test(text));
  assert.ok(!/I heard/i.test(text));
  assert.ok(!/fundamental frequency/i.test(text));
  assert.ok(!/MIDI/i.test(text));
});

test("bundled example JSON matches the peak-break-pickup-nosedive structure", () => {
  const raw = fs.readFileSync(
    path.join(__dirname, "../demo/example_peak_break_pickup_nosedive.json"),
    "utf8"
  );
  const session = SS.parseSession(JSON.parse(raw));
  assert.strictEqual(session.strokes.length, 2);
  assert.strictEqual(session.gaps.length, 1);
  assert.strictEqual(session.gaps[0].duration_ms, 400);
  assert.strictEqual(session.gaps[0].breath, "unknown");
  assert.deepStrictEqual(session.strokes[0].annotations, ["rise", "peak"]);
  assert.deepStrictEqual(session.strokes[1].annotations, ["pickup", "nosedive"]);
  assert.ok(session.strokes[0].points[session.strokes[0].points.length - 1][1] >= 0.9);
  assert.ok(session.strokes[1].points[session.strokes[1].points.length - 1][1] < 0);
});

test("file-type helper accepts wav and mp3 (v0.2.7)", () => {
  assert.ok(SS.isSupportedAudioFile({ name: "take.wav", type: "audio/wav" }));
  assert.ok(SS.isSupportedAudioFile({ name: "Take.WAV", type: "audio/x-wav" }));
  assert.ok(SS.isSupportedAudioFile({ name: "path/to/Take.WAV", type: "" }));
  assert.ok(SS.isSupportedAudioFile({ name: "take.mp3", type: "audio/mpeg" }));
  assert.ok(SS.isSupportedAudioFile({ name: "Take.MP3", type: "" }));
  assert.ok(!SS.isSupportedAudioFile({ name: "take.m4a", type: "audio/mp4" }));
  assert.ok(!SS.isSupportedAudioFile({ name: "notes.json", type: "application/json" }));
  assert.ok(!SS.isSupportedAudioFile({ name: "clip.ogg", type: "audio/ogg" }));
  assert.ok(SS.isSongShapeJSONName({ name: "shape.json" }));
});

test("embedded demo JSON and synthesized demo tone work without a network or file fetch", () => {
  const demo = require("../js/demo-data.js");
  assert.ok(demo.DEMO_EXAMPLE);
  const session = SS.parseSession(demo.DEMO_EXAMPLE);
  assert.strictEqual(session.strokes.length, 2);
  assert.strictEqual(session.gaps.length, 1);
  assert.strictEqual(session.gaps[0].duration_ms, 400);
  const wav = Buffer.from(demo.buildDemoToneWav());
  assert.strictEqual(wav.slice(0, 4).toString("ascii"), "RIFF");
  assert.strictEqual(wav.slice(8, 12).toString("ascii"), "WAVE");
  const dataSize = wav.readUInt32LE(40);
  const samples = dataSize / 2;
  const duration = samples / 44100;
  assert.ok(duration > 6.4 && duration < 6.6, "demo tone duration was " + duration);
});


test("Ask an AI prompt describes the demo traces and asks for Suno help, without claiming to hear the audio", () => {
  const demo = require("../js/demo-data.js");
  const session = SS.parseSession(demo.DEMO_EXAMPLE);
  const prompt = SS.aiPrompt(session);
  assert.ok(prompt.indexOf(SS.AI_PROMPT_INTRO) === 0 || prompt.indexOf(SS.AI_PROMPT_INTRO) > 0);
  assert.ok(/not measured pitch/i.test(prompt));
  assert.ok(/meaning is unknown/i.test(prompt) || /unknown unless the listener labeled/i.test(prompt));
  assert.ok(/not automatically a breath/i.test(prompt));
  assert.ok(prompt.indexOf(SS.AI_PROMPT_ASK) >= 0);
  assert.ok(/Suno/i.test(prompt));
  assert.ok(/\[Verse\]/.test(prompt) && /\[Chorus\]/.test(prompt));
  assert.ok(/Here are the vocals of what I hear/i.test(prompt));
  assert.ok(/0\.50 s to 2\.50 s/.test(prompt));
  assert.ok(/2\.00 s/.test(prompt));
  assert.ok(/400 ms/.test(prompt) || /0\.40 s/.test(prompt));
  assert.ok(/2\.90 s to 5\.40 s/.test(prompt));
  assert.ok(/rise, peak/.test(prompt));
  assert.ok(/pickup, nosedive/.test(prompt));
  assert.ok(/user_marked_break/.test(prompt));
  assert.ok(/Direction: up/.test(prompt));
  assert.ok(/Direction: down/.test(prompt));
  assert.ok(/peak height y=\+1\.00/.test(prompt));
  assert.ok(/end height y=-0\.80/.test(prompt));
  assert.ok(!/I heard/i.test(prompt));
  assert.ok(!/fundamental frequency/i.test(prompt));
  assert.ok(!/https?:\/\//i.test(prompt));
});

test("Ask an AI prompt groups strokes by section labels and time ranges", () => {
  const demo = require("../js/demo-data.js");
  const session = SS.parseSession(demo.DEMO_EXAMPLE);
  SS.setStrokeSection(session, "stroke-1", "Verse");
  SS.setSectionRange(session, 2900, 5400, "Chorus");
  assert.strictEqual(session.strokes[1].section, "Chorus");
  const prompt = SS.aiPrompt(session);
  const verseAt = prompt.indexOf("Section: Verse");
  const chorusAt = prompt.indexOf("Section: Chorus");
  assert.ok(verseAt >= 0 && chorusAt > verseAt);
  assert.ok(/Section label: Verse/.test(prompt));
  assert.ok(/Section label: Chorus/.test(prompt));
  const json = SS.sessionToJSON(session);
  const reloaded = SS.parseSession(JSON.parse(JSON.stringify(json)));
  assert.strictEqual(reloaded.strokes[0].section, "Verse");
  assert.strictEqual(reloaded.strokes[1].section, "Chorus");
  assert.strictEqual(reloaded.sections.length, 1);
  assert.strictEqual(reloaded.sections[0].label, "Chorus");
});



const XSS = "<img src=x onerror=alert(1)>";

function assertThrows(fn, re) {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    if (re) {
      assert.ok(re.test(String(err && err.message || err)), "unexpected error: " + err);
    }
  }
  assert.ok(threw, "expected a thrown error");
}

function validStroke(overrides) {
  return Object.assign({
    id: "stroke-1",
    start_ms: 0,
    end_ms: 100,
    points: [[0, 0], [100, 0.5]],
    annotations: ["ok"]
  }, overrides || {});
}

test("malicious HTML in imported timestamps is rejected", () => {
  const payload = {
    schema_version: "songshape-live-0.1",
    strokes: [
      {
        id: XSS,
        start_ms: XSS,
        end_ms: XSS,
        points: [[XSS, 0], [100, 0.2]],
        annotations: [XSS]
      }
    ],
    gaps: [{ start_ms: XSS, end_ms: XSS, duration_ms: XSS, label: XSS, breath: XSS }]
  };
  assertThrows(() => SS.parseSession(payload), /finite number|Invalid Song Shape file/i);
  assertThrows(() => SS.parseSessionText(JSON.stringify(payload)), /finite number|Invalid Song Shape file|could not be parsed/i);
});

test("HTML in labels and names is stored as plain text, not rejected as a timestamp", () => {
  const session = SS.parseSession({
    schema_version: "songshape-live-0.1",
    audio: { name: XSS, duration_ms: 1000 },
    notes: XSS,
    phrases: [{ id: "phrase-1", text: XSS, stroke_ids: ["stroke-1"] }],
    strokes: [validStroke({ annotations: [XSS], section: XSS, phrase_id: "phrase-1" })]
  });
  assert.strictEqual(session.strokes[0].annotations[0], XSS);
  assert.strictEqual(session.strokes[0].section, XSS);
  assert.strictEqual(session.phrases[0].text, XSS);
  assert.strictEqual(session.audio.name, XSS);
  assert.strictEqual(session.notes, XSS);
  const json = SS.sessionToJSON(session);
  assert.strictEqual(json.strokes[0].annotations[0], XSS);
  assert.strictEqual(json.audio.name, XSS);
  const prompt = SS.aiPrompt(session);
  const summary = SS.textSummary(session);
  assert.ok(prompt.indexOf(XSS) >= 0);
  assert.ok(summary.indexOf(XSS) >= 0);
  // Exports treat the payload as plain text. Tags stay in the file as characters,
  // and are never turned into HTML structure.
  assert.strictEqual(typeof json.strokes[0].annotations[0], "string");
  assert.strictEqual(json.strokes[0].start_ms, 0);
  assert.ok(SS.isFiniteNumber(json.strokes[0].end_ms));
});

test("NaN, Infinity, and strings-as-numbers are rejected", () => {
  assertThrows(() => SS.parseSession({
    schema_version: "songshape-live-0.1",
    strokes: [validStroke({ start_ms: NaN })]
  }), /finite number/i);
  assertThrows(() => SS.parseSession({
    schema_version: "songshape-live-0.1",
    strokes: [validStroke({ end_ms: Infinity })]
  }), /finite number/i);
  assertThrows(() => SS.parseSession({
    schema_version: "songshape-live-0.1",
    strokes: [validStroke({ start_ms: -Infinity })]
  }), /finite number/i);
  assertThrows(() => SS.parseSession({
    schema_version: "songshape-live-0.1",
    strokes: [validStroke({ start_ms: "100", end_ms: "200", points: [[0, 0], [100, 0]] })]
  }), /finite number/i);
  assertThrows(() => SS.parseSession({
    schema_version: "songshape-live-0.1",
    strokes: [validStroke({ points: [[0, "0.5"], [100, 0]] })]
  }), /finite number/i);
  assertThrows(() => SS.parseSession({
    schema_version: "songshape-live-0.1",
    strokes: [validStroke({ points: [[0, NaN], [100, 0]] })]
  }), /finite number/i);
  assertThrows(() => SS.parseSession({
    schema_version: "songshape-live-0.1",
    audio: { name: "x.wav", duration_ms: "1000" },
    strokes: []
  }), /finite number/i);
  assertThrows(() => SS.parseSession({
    schema_version: "songshape-live-0.1",
    timing_offset_ms: "40",
    strokes: []
  }), /finite number/i);
});

test("out-of-range times are rejected and out-of-range levels are clamped when finite", () => {
  assertThrows(() => SS.parseSession({
    schema_version: "songshape-live-0.1",
    strokes: [validStroke({ start_ms: -1 })]
  }), /out of range/i);
  assertThrows(() => SS.parseSession({
    schema_version: "songshape-live-0.1",
    strokes: [validStroke({ end_ms: SS.MAX_TIME_MS + 1, points: [[0, 0], [100, 0]] })]
  }), /out of range/i);
  const session = SS.parseSession({
    schema_version: "songshape-live-0.1",
    strokes: [validStroke({ points: [[0, 5], [100, -4]] })]
  });
  assert.strictEqual(session.strokes[0].points[0][1], 1);
  assert.strictEqual(session.strokes[0].points[1][1], -1);
});

test("huge stroke and point arrays are rejected", () => {
  const tooManyStrokes = [];
  for (let i = 0; i < SS.MAX_STROKES + 1; i += 1) {
    tooManyStrokes.push({
      id: "stroke-" + i,
      start_ms: i,
      end_ms: i,
      points: [[i, 0]]
    });
  }
  assertThrows(() => SS.parseSession({
    schema_version: "songshape-live-0.1",
    strokes: tooManyStrokes
  }), /too many/i);

  const points = [];
  for (let i = 0; i < SS.MAX_POINTS + 1; i += 1) {
    points.push([0, 0]);
  }
  assertThrows(() => SS.parseSession({
    schema_version: "songshape-live-0.1",
    strokes: [{ id: "stroke-1", start_ms: 0, end_ms: 0, points: points }]
  }), /too many|exceed/i);
});

test("prototype-pollution keys are dropped and do not pollute Object.prototype", () => {
  assert.strictEqual(Object.prototype.songshapePolluted, undefined);
  const text = '{"schema_version":"songshape-live-0.1","strokes":[],"__proto__":{"songshapePolluted":true},"constructor":{"prototype":{"songshapePolluted":true}},"prototype":{"songshapePolluted":true}}';
  const session = SS.parseSessionText(text);
  assert.strictEqual(Object.prototype.songshapePolluted, undefined);
  assert.strictEqual(Object.prototype.hasOwnProperty("songshapePolluted"), false);
  assert.strictEqual(session.songshapePolluted, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(session, "constructor") || session.constructor === Object);

  const obj = {
    schema_version: "songshape-live-0.1",
    strokes: [validStroke()]
  };
  obj.constructor = { prototype: { songshapePolluted: true } };
  obj.prototype = { songshapePolluted: true };
  const session2 = SS.parseSession(obj);
  assert.strictEqual(Object.prototype.songshapePolluted, undefined);
  const exported = SS.sessionToJSON(session2);
  assert.strictEqual(exported.songshapePolluted, undefined);
  assert.ok(!Object.keys(exported).includes("__proto__"));
  assert.ok(!Object.keys(exported).includes("prototype"));
  assert.ok(!Object.keys(exported.strokes[0]).includes("__proto__"));
});

test("unknown keys are dropped on import and export", () => {
  const session = SS.parseSession({
    schema_version: "songshape-live-0.1",
    evildata: XSS,
    extra: 1,
    strokes: [Object.assign(validStroke(), { extra: XSS, evildata: 2 })]
  });
  assert.strictEqual(session.evildata, undefined);
  assert.strictEqual(session.extra, undefined);
  assert.strictEqual(session.strokes[0].extra, undefined);
  const json = SS.sessionToJSON(session);
  assert.strictEqual(json.evildata, undefined);
  assert.strictEqual(json.extra, undefined);
  assert.strictEqual(json.strokes[0].extra, undefined);
  assert.deepStrictEqual(
    Object.keys(json).sort(),
    [
      "active_word_id",
      "app_version",
      "anchors",
      "audio",
      "baseline",
      "detected_harmony", "vocal_range",
      "draft",
      "extend_lyrics",
      "gaps",
      "harmony_ranges",
      "line_taps",
      "lyrics",
      "method",
      "notes",
      "performer",
      "place_parentheses",
      "phrases",
      "reference",
      "replacement_lyrics",
      "schema_version",
      "sections",
      "strokes",
      "timing_offset_ms",
      "y_semantics",
      "y_units"
    ].sort()
  );
});

test("parseSessionText rejects invalid JSON and oversized imports, leaving callers to keep the old session", () => {
  const previous = SS.createSession();
  previous.notes = "keep me";
  assertThrows(() => SS.parseSessionText("{not json"), /could not be parsed|Invalid Song Shape file/i);
  assertThrows(() => SS.parseSessionText("{}", SS.MAX_IMPORT_BYTES + 1), /too large/i);
  assert.strictEqual(previous.notes, "keep me");
  assert.strictEqual(SS.MAX_IMPORT_BYTES, 20 * 1024 * 1024);
});

test("control characters are stripped from imported strings and exports emit only finite numbers", () => {
  const session = SS.parseSession({
    schema_version: "songshape-live-0.1",
    audio: { name: "song\u0000name.wav", duration_ms: 1500 },
    notes: "hello\u0007world",
    strokes: [validStroke({ annotations: ["rise\u0000, peak"], id: "stroke-1" })]
  });
  assert.strictEqual(session.audio.name, "songname.wav");
  assert.strictEqual(session.notes, "helloworld");
  assert.strictEqual(session.strokes[0].annotations[0], "rise, peak");
  const json = SS.sessionToJSON(session);
  assert.strictEqual(json.audio.name, "songname.wav");
  assert.ok(SS.isFiniteNumber(json.audio.duration_ms));
  assert.ok(SS.isFiniteNumber(json.timing_offset_ms));
  assert.ok(json.strokes[0].points.every((p) => SS.isFiniteNumber(p[0]) && SS.isFiniteNumber(p[1])));
  const unclean = SS.createSession();
  unclean.timing_offset_ms = Infinity;
  unclean.audio = { name: "x.wav", duration_ms: NaN };
  unclean.strokes = [{
    id: "stroke-1",
    start_ms: NaN,
    end_ms: "nope",
    points: [[0, 0.25], [Infinity, 2], ["x", 0]],
    annotations: [XSS],
    section: XSS
  }];
  const cleaned = SS.sessionToJSON(unclean);
  assert.ok(SS.isFiniteNumber(cleaned.timing_offset_ms));
  assert.ok(SS.isFiniteNumber(cleaned.audio.duration_ms));
  assert.ok(SS.isFiniteNumber(cleaned.strokes[0].start_ms));
  assert.ok(SS.isFiniteNumber(cleaned.strokes[0].end_ms));
  assert.ok(cleaned.strokes[0].points.every((p) => SS.isFiniteNumber(p[0]) && SS.isFiniteNumber(p[1])));
  assert.strictEqual(cleaned.strokes[0].annotations[0], XSS);
  assert.strictEqual(cleaned.strokes[0].section, XSS);
});


test("resetTrace clears strokes, gaps, sections, labels and an active stroke, but keeps the audio", () => {
  const session = SS.createSession();
  session.audio = { name: "demo.wav", included_in_export: false, duration_ms: 6500 };
  session.timing_offset_ms = 40;
  session.notes = "custom imported notes";
  const rec = SS.createRecorder();
  trace(session, rec, [[500, 0], [1500, 0.7], [2500, 1.0]]);
  SS.endStroke(session, rec, 2500);
  session.strokes[0].annotations = ["rise", "peak"];
  SS.setStrokeSection(session, session.strokes[0].id, "Verse");
  trace(session, rec, [[2900, 0.95], [4000, 0], [5400, -0.8]]);
  SS.endStroke(session, rec, 5400);
  session.strokes[1].annotations = ["pickup", "nosedive"];
  SS.setSectionRange(session, 2900, 5400, "Chorus");
  session.phrases = [{ id: "phrase-1", text: "demo phrase", stroke_ids: [session.strokes[0].id] }];
  SS.setGapLabel(session, 2500, 2900, "user_marked_break", "unknown");
  SS.startStroke(session, rec, 6000, 0.2);
  SS.addPoint(session, rec, 6100, 0.3);
  assert.ok(rec.active);
  assert.strictEqual(session.strokes.length, 2);
  assert.ok(session.gaps.length >= 1);
  assert.ok(session.sections.length >= 1);

  SS.resetTrace(session, rec);

  assert.strictEqual(rec.active, null);
  assert.strictEqual(session.strokes.length, 0);
  assert.strictEqual(session.gaps.length, 0);
  assert.strictEqual(session.sections.length, 0);
  assert.strictEqual(session.phrases.length, 0);
  assert.strictEqual(session.audio.name, "demo.wav");
  assert.strictEqual(session.audio.duration_ms, 6500);
  assert.strictEqual(session.audio.included_in_export, false);
  assert.strictEqual(session.timing_offset_ms, 40);
  assert.strictEqual(session.baseline.y, 0);
  assert.ok(/not measured pitch/i.test(session.notes));
  assert.ok(!/custom imported notes/.test(session.notes));
  const json = SS.sessionToJSON(session);
  assert.strictEqual(json.strokes.length, 0);
  assert.strictEqual(json.gaps.length, 0);
  assert.strictEqual(json.sections.length, 0);
  assert.strictEqual(json.phrases.length, 0);
  assert.strictEqual(json.audio.name, "demo.wav");
  const summary = SS.textSummary(session);
  assert.ok(/Stroke count: 0/.test(summary));
  assert.ok(/No strokes recorded/.test(summary));
  const prompt = SS.aiPrompt(session);
  assert.ok(/No strokes have been recorded yet/.test(prompt));
  const undo = SS.undoLastStroke(session, rec);
  assert.strictEqual(undo.undone, null);
});

console.log("\n" + passed + " tests passed");
