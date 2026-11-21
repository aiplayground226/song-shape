/**
 * Song Shape v0.2.7 — "AI learns from your hand traces".
 *
 * Builds a compact few-shot (or zero-shot) request from LOCAL audio features
 * (the measured pitch/voicing contour) plus the user's chosen finished hand
 * traces, and turns the model's JSON reply into editable, clearly labeled
 * AI-drafted strokes that the user then corrects by ear.
 *
 * Nothing here touches the network. Sending happens only through
 * SongShape.sendAiChat (ai.js), which keeps the existing safety rules:
 * off by default, explicit user action, extra opt-in for non-loopback.
 * Shared by the browser UI and the CLI `ai-draft` / `ai-batch` commands.
 */
(function (root) {
  "use strict";

  var SS = root.SongShape || {};
  var AI_TAG = "ai_drafted_trace";
  var REVIEW_TAG = "needs_review";
  var MACHINE_TAGS = ["machine_measured_pitch_draft", AI_TAG];
  var MAX_EXAMPLES = 5;
  var MAX_FRAMES = 160;          // per song, keeps small local models in context
  var MAX_REPLY_STROKES = 400;
  var MAX_REPLY_POINTS = 20000;

  function finite(v) { return typeof v === "number" && Number.isFinite(v); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function r2(v) { return Math.round(v * 100) / 100; }

  function isMachineStroke(s) {
    var a = (s && s.annotations) || [];
    return a.some(function (t) {
      return MACHINE_TAGS.indexOf(t) >= 0 || String(t).indexOf("machine-draft-fingerprint:") === 0;
    });
  }

  /** Hand-drawn strokes only (machine-measured and AI-drafted strokes are excluded). */
  function humanStrokes(session) {
    return ((session && session.strokes) || []).filter(function (s) {
      return s && Array.isArray(s.points) && s.points.length >= 2 && !isMachineStroke(s);
    });
  }

  function durationOf(session) {
    var d = session && session.audio && session.audio.duration_ms;
    if (finite(d) && d > 0) return d;
    var end = 0;
    ((session && session.strokes) || []).concat((session && session.draft && session.draft.strokes) || [])
      .forEach(function (s) { if (finite(s.end_ms)) end = Math.max(end, s.end_ms); });
    return end;
  }

  function stepFor(durationMs, maxFrames) {
    var n = maxFrames || MAX_FRAMES;
    return Math.max(250, Math.ceil(durationMs / n / 50) * 50);
  }

  /** Value of a stroke set at time t (linear interpolation), or null in a gap. */
  function sampleAt(strokes, t) {
    for (var i = 0; i < strokes.length; i += 1) {
      var s = strokes[i], p = s.points || [];
      if (!p.length || t < p[0][0] || t > p[p.length - 1][0]) continue;
      for (var j = 1; j < p.length; j += 1) {
        if (t <= p[j][0]) {
          var t0 = p[j - 1][0], t1 = p[j][0];
          var y = t1 === t0 ? p[j][1] : p[j - 1][1] + (p[j][1] - p[j - 1][1]) * (t - t0) / (t1 - t0);
          return y;
        }
      }
      return p[p.length - 1][1];
    }
    return null;
  }

  /**
   * Audio features for one song: the measured pitch contour (relative to the
   * song's own median pitch, about ±1 octave) sampled on a fixed grid, with
   * null where the measurement found no voiced sound.
   */
  function audioFeatures(draft, durationMs, opts) {
    opts = opts || {};
    var strokes = (draft && draft.strokes) || [];
    var dur = finite(durationMs) && durationMs > 0 ? durationMs : 0;
    if (!dur) strokes.forEach(function (s) { dur = Math.max(dur, s.end_ms || 0); });
    var step = opts.stepMs || stepFor(dur, opts.maxFrames);
    var frames = [];
    for (var t = 0; t <= dur && frames.length < (opts.maxFrames || MAX_FRAMES) + 1; t += step) {
      var y = sampleAt(strokes, t);
      frames.push([Math.round(t), y == null ? null : r2(clamp(y, -1, 1))]);
    }
    var voiced = frames.filter(function (f) { return f[1] !== null; }).length;
    return {
      duration_ms: Math.round(dur),
      step_ms: step,
      baseline_hz: draft && finite(draft.baseline_hz) ? Math.round(draft.baseline_hz) : null,
      voiced_ratio: frames.length ? r2(voiced / frames.length) : 0,
      frames: frames
    };
  }

  /** Hand trace sampled on the same grid as the features (null = released / gap). */
  function traceOnGrid(strokes, features) {
    return features.frames.map(function (f) {
      var y = sampleAt(strokes, f[0]);
      return [f[0], y == null ? null : r2(clamp(y, -1, 1))];
    });
  }

  function gridText(frames) {
    return frames.map(function (f) { return f[0] + ":" + (f[1] === null ? "-" : f[1]); }).join(" ");
  }

  /**
   * Turn a saved Song Shape session into a training example.
   * Requires at least one hand-drawn stroke. Audio features come from the
   * session's measured draft when present.
   */
  function exampleChunks(session) {
    var fn = root.SongShape && root.SongShape.exampleChunksFromSession;
    if (typeof fn !== "function") return [];
    try { return fn(session, 3); } catch (e) { return []; }
  }

  function exampleFromSession(session, label) {
    var hand = humanStrokes(session);
    if (!hand.length) throw new Error("This project has no hand-drawn strokes to learn from.");
    var dur = durationOf(session);
    var hasDraft = !!(session.draft && session.draft.strokes && session.draft.strokes.length);
    var feats = audioFeatures(hasDraft ? session.draft : null, dur);
    return {
      label: String(label || (session.audio && session.audio.name) || "example").slice(0, 120),
      has_audio_features: hasDraft,
      features: feats,
      trace: traceOnGrid(hand, feats),
      stroke_count: hand.length,
      chunks: exampleChunks(session)
    };
  }

  var SYSTEM_PROMPT = [
    "You draft Song Shape traces. A trace is a listener's hand-drawn line of the LEAD singer's perceived",
    "vocal delivery over time, relative to that singer's own baseline (0). +1 is the most lifted/intense,",
    "-1 the lowest/softest. It is NOT measured pitch, but it often follows the pitch contour's rises, holds,",
    "breaks and falls. The listener lifts the pen during silences and breaths, so the trace has gaps.",
    "Reply with JSON only, no commentary, exactly in this form:",
    "{\"strokes\":[{\"start_ms\":0,\"end_ms\":1800,\"points\":[[0,-0.3],[600,0.1],[1800,0.4]]}]}",
    "Rules: times are integer milliseconds within the song; y values are numbers between -1 and 1;",
    "points inside a stroke are in time order; do not draw across silences (marked -); strokes must not overlap."
  ].join(" ");

  /**
   * Build OpenAI-compatible chat messages. examples may be empty (zero-shot:
   * the model drafts from the audio features alone).
   */
  function buildTraceDraftMessages(target, examples, opts) {
    opts = opts || {};
    var ex = (examples || []).slice(0, opts.maxExamples || MAX_EXAMPLES);
    var parts = [];
    if (ex.length) {
      parts.push("Here are " + ex.length + " finished example(s) from this listener. Learn how their hand trace relates to the audio features.");
      ex.forEach(function (e, i) {
        parts.push("Example " + (i + 1) + " (" + e.features.duration_ms + " ms, grid " + e.features.step_ms + " ms):");
        parts.push("audio pitch contour: " + (e.has_audio_features ? gridText(e.features.frames) : "(not available)"));
        parts.push("listener hand trace: " + gridText(e.trace));
      });
      parts.push("Now draft the listener's hand trace for a NEW song in the same style.");
    } else {
      parts.push("No examples are available. Draft a plausible hand trace from the audio features alone.");
    }
    parts.push("New song (" + target.duration_ms + " ms, grid " + target.step_ms + " ms, voiced " + Math.round(target.voiced_ratio * 100) + "%):");
    parts.push("audio pitch contour: " + gridText(target.frames));
    parts.push("Return the JSON object only.");
    return [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: parts.join("\n") }
    ];
  }

  function extractJson(text) {
    var t = String(text || "").trim();
    var fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    var first = t.search(/[\[{]/);
    if (first < 0) throw new Error("The model reply did not contain JSON.");
    var open = t[first], close = open === "{" ? "}" : "]";
    var last = t.lastIndexOf(close);
    if (last <= first) throw new Error("The model reply contained incomplete JSON.");
    return JSON.parse(t.slice(first, last + 1));
  }

  /**
   * Validate and repair a model reply into stroke objects. Never executes
   * anything; only finite numbers survive. Times are clamped to the song,
   * y to [-1, 1]; overlapping strokes are trimmed; tiny strokes dropped.
   */
  /**
   * Silent regions from the features: runs of at least minFrames unvoiced grid
   * frames. Hand traces lift the pen there, so AI strokes are split at them.
   */
  function silentRanges(features, minFrames) {
    var out = [], f = (features && features.frames) || [], run = null, n = minFrames || 2;
    for (var i = 0; i < f.length; i += 1) {
      if (f[i][1] === null) { if (!run) run = { start: i, end: i }; else run.end = i; }
      else if (run) { if (run.end - run.start + 1 >= n) out.push(run); run = null; }
    }
    if (run && run.end - run.start + 1 >= n) out.push(run);
    var step = (features && features.step_ms) || 0;
    return out.map(function (r) {
      return [f[r.start][0] - (r.start > 0 ? step / 2 : step), f[r.end][0] + step / 2];
    });
  }

  function splitAtSilence(strokePoints, ranges) {
    if (!ranges.length) return [strokePoints];
    var pieces = [], cur = [];
    strokePoints.forEach(function (p) {
      var silent = ranges.some(function (r) { return p[0] > r[0] && p[0] < r[1]; });
      var crossed = cur.length && ranges.some(function (r) { return cur[cur.length - 1][0] <= r[0] && p[0] >= r[1]; });
      if (silent || crossed) { if (cur.length) pieces.push(cur); cur = silent ? [] : [p]; }
      else cur.push(p);
    });
    if (cur.length) pieces.push(cur);
    return pieces;
  }

  function parseTraceReply(text, durationMs, features) {
    var obj;
    try { obj = extractJson(text); } catch (e) { throw new Error("Could not read the model reply as JSON: " + e.message); }
    var list = Array.isArray(obj) ? obj : (obj && (obj.strokes || obj.trace || obj.traces));
    if (!Array.isArray(list)) throw new Error("The model reply had no \"strokes\" list.");
    var dur = finite(durationMs) && durationMs > 0 ? durationMs : Infinity;
    var budget = MAX_REPLY_POINTS;
    var strokes = [];
    list.slice(0, MAX_REPLY_STROKES).forEach(function (s) {
      var pts = Array.isArray(s) ? s : (s && s.points);
      if (!Array.isArray(pts)) return;
      var clean = [];
      pts.forEach(function (p) {
        if (budget <= 0) return;
        var t = Array.isArray(p) ? p[0] : p && (p.t_ms != null ? p.t_ms : p.t);
        var y = Array.isArray(p) ? p[1] : p && p.y;
        t = Number(t); y = Number(y);
        if (!finite(t) || !finite(y) || t < 0 || t > dur) return;
        clean.push([Math.round(t), r2(clamp(y, -1, 1))]);
        budget -= 1;
      });
      clean.sort(function (a, b) { return a[0] - b[0]; });
      var dedup = [];
      clean.forEach(function (p) { if (!dedup.length || p[0] > dedup[dedup.length - 1][0]) dedup.push(p); });
      var ranges = features ? silentRanges(features, 2) : [];
      splitAtSilence(dedup, ranges).forEach(function (piece) { if (piece.length >= 2) strokes.push(piece); });
    });
    strokes.sort(function (a, b) { return a[0][0] - b[0][0]; });
    var out = [];
    strokes.forEach(function (pts) {
      var prevEnd = out.length ? out[out.length - 1].end_ms : -1;
      var kept = pts.filter(function (p) { return p[0] > prevEnd; });
      if (kept.length < 2) return;
      out.push({ start_ms: kept[0][0], end_ms: kept[kept.length - 1][0], points: kept });
    });
    if (!out.length) throw new Error("The model reply had no usable strokes (each needs two or more valid points).");
    return out;
  }

  /**
   * Add AI-drafted strokes to the session as editable, labeled proposals.
   * Hand strokes are never removed. Previous AI drafts are replaced.
   */
  function applyAiTraceDraft(session, strokes, meta) {
    meta = meta || {};
    session.strokes = (session.strokes || []).filter(function (s) {
      return (s.annotations || []).indexOf(AI_TAG) < 0;
    });
    var tags = [AI_TAG, REVIEW_TAG];
    if (meta.model) tags.push("ai-model:" + String(meta.model).slice(0, 80));
    tags.push(meta.examples ? "ai-examples:" + meta.examples : "ai-zero-shot");
    (meta.extraTags || []).forEach(function (t) { if (typeof t === "string" && t) tags.push(t.slice(0, 80)); });
    strokes.forEach(function (s) {
      session.strokes.push({
        id: SS.nextId ? SS.nextId("stroke-", session.strokes) : "stroke-" + (session.strokes.length + 1),
        phrase_id: null,
        start_ms: s.start_ms,
        end_ms: s.end_ms,
        points: s.points.map(function (p) { return [p[0], p[1]]; }),
        annotations: tags.slice(),
        section: null,
        word_id: null
      });
    });
    session.strokes.sort(function (a, b) { return a.start_ms - b.start_ms; });
    if (SS.recomputeGaps) SS.recomputeGaps(session);
    return session;
  }

  function removeAiTraceDraft(session) {
    var before = (session.strokes || []).length;
    session.strokes = (session.strokes || []).filter(function (s) { return (s.annotations || []).indexOf(AI_TAG) < 0; });
    if (SS.recomputeGaps) SS.recomputeGaps(session);
    return before - session.strokes.length;
  }

  var api = {
    AI_TRACE_TAG: AI_TAG,
    AI_MAX_EXAMPLES: MAX_EXAMPLES,
    humanStrokes: humanStrokes,
    isMachineStroke: isMachineStroke,
    audioFeatures: audioFeatures,
    exampleFromSession: exampleFromSession,
    buildTraceDraftMessages: buildTraceDraftMessages,
    parseTraceReply: parseTraceReply,
    silentRanges: silentRanges,
    applyAiTraceDraft: applyAiTraceDraft,
    parseTraceJson: extractJson,
    splitAtSilence: splitAtSilence,
    traceOnGrid: traceOnGrid,
    sampleStrokesAt: sampleAt,
    removeAiTraceDraft: removeAiTraceDraft
  };

  root.SongShape = root.SongShape || {};
  Object.keys(api).forEach(function (k) { root.SongShape[k] = api[k]; });
  if (typeof module !== "undefined" && module.exports) {
    var base;
    try { base = require("./ai.js"); } catch (e) { base = root.SongShape; }
    Object.keys(api).forEach(function (k) { base[k] = api[k]; });
    SS = base;
    module.exports = base;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
