/**
 * Song Shape — stroke model, JSON schema, timing helpers.
 * Works in the browser and in Node (for tests).
 *
 * Vertical values are a listener's subjective delivery relative to a
 * singer-specific baseline, NOT measured pitch (Hz / MIDI / semitones).
 * The playback clock (audio.currentTime), not wall time, is authoritative.
 */
(function (root) {
  "use strict";

  var SCHEMA_VERSION = "songshape-live-0.2";
  var SCHEMA_VERSION_V01 = "songshape-live-0.1";
  var APP_VERSION = "0.2.11-dev";
  var MIN_POINT_SPACING_MS = 8;
  var MAX_TIME_JUMP_MS = 200;
  var MAX_TIME_MS = 24 * 60 * 60 * 1000;
  var MAX_STRING_LEN = 200;
  var MAX_NOTES_LEN = 4000;
  var MAX_STROKES = 10000;
  var MAX_GAPS = 10000;
  var MAX_PHRASES = 10000;
  var MAX_SECTIONS = 10000;
  var MAX_POINTS = 100000;
  var MAX_ANNOTATIONS = 100;
  var MAX_STROKE_IDS = 10000;
  var MAX_IMPORT_BYTES = 20 * 1024 * 1024;
  var MAX_LYRICS_CHARS = 100000;
  var MAX_WORDS = 20000;
  var MAX_LINES = 10000;
  var MAX_ANCHORS = 20000;
  var Y_MIN = -1;
  var Y_MAX = 1;

  function isFiniteNumber(v) {
    return typeof v === "number" && Number.isFinite(v);
  }

  function stripControlChars(s) {
    return String(s).replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
  }

  function keepMultiline(s, maxLen) {
    var text = String(s == null ? "" : s).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
    if (maxLen && text.length > maxLen) text = text.slice(0, maxLen);
    return text;
  }

  /**
   * Soft sanitizer for labels, names, and other short strings.
   * Control characters are stripped and the result is length-capped.
   * Non-strings become an empty string (except finite numbers, which are stringified).
   */
  function sanitizeLabel(v, maxLen) {
    if (v == null) return "";
    if (typeof v !== "string") {
      if (isFiniteNumber(v)) v = String(v);
      else return "";
    }
    var cleaned = stripControlChars(v);
    var limit = maxLen == null ? MAX_STRING_LEN : maxLen;
    if (cleaned.length > limit) cleaned = cleaned.slice(0, limit);
    return cleaned;
  }

  function requireString(v, field, maxLen) {
    if (typeof v !== "string") {
      throw new Error("Invalid Song Shape file: " + field + " must be a string.");
    }
    return sanitizeLabel(v, maxLen);
  }

  function optionalString(v, field, maxLen) {
    if (v == null) return null;
    return requireString(v, field, maxLen);
  }

  function requireFiniteNumber(v, field) {
    if (!isFiniteNumber(v)) {
      throw new Error("Invalid Song Shape file: " + field + " must be a finite number.");
    }
    return v;
  }

  function requireTimeMs(v, field) {
    requireFiniteNumber(v, field);
    if (v < 0 || v > MAX_TIME_MS) {
      throw new Error("Invalid Song Shape file: " + field + " is out of range (0 to 24 hours).");
    }
    return v;
  }

  function requireOffsetMs(v, field) {
    requireFiniteNumber(v, field);
    if (v < -MAX_TIME_MS || v > MAX_TIME_MS) {
      throw new Error("Invalid Song Shape file: " + field + " is out of range.");
    }
    return v;
  }

  function requireLevel(v, field) {
    requireFiniteNumber(v, field);
    return clamp(v, Y_MIN, Y_MAX);
  }

  function requireArray(v, field, maxLen) {
    if (!Array.isArray(v)) {
      throw new Error("Invalid Song Shape file: " + field + " must be an array.");
    }
    if (v.length > maxLen) {
      throw new Error("Invalid Song Shape file: " + field + " has too many items.");
    }
    return v;
  }

  function optionalArray(v, field, maxLen) {
    if (v == null) return [];
    return requireArray(v, field, maxLen);
  }

  function requirePlainObject(v, field) {
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      throw new Error("Invalid Song Shape file: " + field + " must be an object.");
    }
    return v;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function createSession(overrides) {
    var session = {
      schema_version: SCHEMA_VERSION,
      app_version: APP_VERSION,
      method: "manual_listener_trace",
      y_semantics: "subjective_vocal_delivery_relative_to_singer_baseline",
      y_units: "normalized_relative",
      audio: { name: "", included_in_export: false, duration_ms: 0 },
      baseline: { y: 0.0, defined_by: "annotator" },
      timing_offset_ms: 0,
      phrases: [],
      sections: [],
      strokes: [],
      gaps: [],
      lyrics: { text: "", lines: [], words: [] },
      replacement_lyrics: "", // kept separate from reference lyric tokens
      extend_lyrics: "", // v0.2.11 fix6b: Step 2 (your song with [New ...] sections added), kept separately
      anchors: [],
      draft: null,
      reference: { title: "", artist: "" },
      active_word_id: null,
      place_parentheses: false,
      harmony_ranges: [],
      vocal_range: null, // v0.2.11 fix6f: the lead singer's measured range; the Singer baseline is its midpoint
      detected_harmony: [], // v0.2.11 fix6e: harmony regions found in the vocal stem / overlapping lines (hints only)
      line_taps: [],
      performer: {
        identity:
          "One consistent lead singer for all sung passages; same vocal timbre, character, and diction throughout. Intensity, register, sustain, dynamics, and expression may vary naturally. No unexpected additional singer, duet, choir handoff, or voice-character change.",
        allow_harmony: false
      },
      notes:
        "Manual subjective annotation of perceived vocal delivery. " +
        "Not measured pitch, not automatic transcription, and not a verified analysis of the recording."
    };
    if (overrides) Object.assign(session, overrides);
    return session;
  }

  function createRecorder() {
    return { active: null };
  }

  function nextId(prefix, items) {
    var n = 1;
    var used = {};
    (items || []).forEach(function (s) { used[s.id] = true; });
    while (used[prefix + n]) n += 1;
    return prefix + n;
  }

  /**
   * Convert the audio element clock to annotation milliseconds.
   * currentTimeSec comes from audio.currentTime (playback clock).
   */
  function audioTimeMs(currentTimeSec, offsetMs) {
    return Math.round((Number(currentTimeSec) || 0) * 1000 + (Number(offsetMs) || 0));
  }

  function startStroke(session, recorder, timeMs, y, phraseId) {
    if (recorder.active) {
      var last = lastPoint(recorder.active);
      endStroke(session, recorder, last ? last[0] : timeMs);
    }
    var t = Math.max(0, Math.round(timeMs));
    var yy = clamp(Number(y) || 0, -1, 1);
    recorder.active = {
      id: nextId("stroke-", session.strokes),
      phrase_id: phraseId || null,
      start_ms: t,
      end_ms: t,
      points: [[t, yy]],
      annotations: [],
      section: null,
      word_id: null
    };
    return recorder.active;
  }

  function lastPoint(stroke) {
    if (!stroke || !stroke.points || !stroke.points.length) return null;
    return stroke.points[stroke.points.length - 1];
  }

  /**
   * Sample a point while the button is held.
   * Returns a status so the UI can react to clock jumps (seek, etc.).
   */
  function addPoint(session, recorder, timeMs, y) {
    var stroke = recorder.active;
    if (!stroke) return { status: "idle" };
    var t = Math.round(timeMs);
    var yy = clamp(Number(y) || 0, -1, 1);
    var last = lastPoint(stroke);
    if (!last) {
      stroke.points.push([t, yy]);
      stroke.end_ms = t;
      return { status: "added" };
    }
    var dt = t - last[0];
    if (dt < 0) {
      endStroke(session, recorder, last[0]);
      return { status: "closed_on_backward_jump", dt: dt };
    }
    if (dt === 0) {
      last[1] = yy;
      stroke.end_ms = t;
      return { status: "updated_same_time" };
    }
    if (dt > MAX_TIME_JUMP_MS) {
      endStroke(session, recorder, last[0]);
      return { status: "closed_on_forward_jump", dt: dt };
    }
    if (dt < MIN_POINT_SPACING_MS && Math.abs(yy - last[1]) < 0.01) {
      return { status: "skipped_dense" };
    }
    stroke.points.push([t, yy]);
    stroke.end_ms = t;
    return { status: "added" };
  }

  function endStroke(session, recorder, timeMs) {
    var stroke = recorder.active;
    if (!stroke) return null;
    var last = lastPoint(stroke);
    if (timeMs != null && last) {
      var t = Math.round(timeMs);
      var dt = t - last[0];
      if (dt > 0 && dt <= MAX_TIME_JUMP_MS) {
        if (t !== last[0]) stroke.points.push([t, last[1]]);
      }
    }
    last = lastPoint(stroke);
    stroke.end_ms = last ? last[0] : stroke.start_ms;
    var saved = {
      id: stroke.id,
      phrase_id: stroke.phrase_id,
      start_ms: stroke.start_ms,
      end_ms: stroke.end_ms,
      points: stroke.points.map(function (p) { return [p[0], p[1]]; }),
      annotations: stroke.annotations.slice(),
      section: stroke.section || null,
      word_id: session.active_word_id || null
    };
    session.strokes.push(saved);
    recorder.active = null;
    recomputeGaps(session);
    // Associate with the active word if one is set. This does not advance
    // the lyric queue — a word is not a stroke.
    if (saved.word_id && root.SongShape && root.SongShape.assignStrokeToWord) {
      root.SongShape.assignStrokeToWord(session, saved.id, saved.word_id);
    }
    return saved;
  }

  function abandonActive(recorder) {
    recorder.active = null;
  }

  function recomputeGaps(session) {
    var prev = {};
    (session.gaps || []).forEach(function (g) {
      prev[g.start_ms + ":" + g.end_ms] = { label: g.label, breath: g.breath };
    });
    var strokes = session.strokes.slice().sort(function (a, b) {
      return a.start_ms - b.start_ms;
    });
    var gaps = [];
    for (var i = 0; i < strokes.length - 1; i += 1) {
      var a = strokes[i];
      var b = strokes[i + 1];
      if (b.start_ms > a.end_ms) {
        var key = a.end_ms + ":" + b.start_ms;
        var prior = prev[key] || {};
        gaps.push({
          start_ms: a.end_ms,
          end_ms: b.start_ms,
          duration_ms: b.start_ms - a.end_ms,
          label: prior.label || "unlabeled_gap",
          breath: prior.breath || "unknown"
        });
      }
    }
    session.gaps = gaps;
    return gaps;
  }

  function undoLastStroke(session, recorder) {
    if (recorder && recorder.active) {
      recorder.active = null;
      return { undone: "active" };
    }
    if (!session.strokes.length) return { undone: null };
    var removed = session.strokes.pop();
    if (removed && root.SongShape && root.SongShape.unassignStroke) {
      root.SongShape.unassignStroke(session, removed.id);
    }
    recomputeGaps(session);
    return { undone: removed };
  }

  function deleteStrokeById(session, id) {
    var i = session.strokes.findIndex(function (s) { return s.id === id; });
    if (i < 0) return null;
    var removed = session.strokes.splice(i, 1)[0];
    if (removed && root.SongShape && root.SongShape.unassignStroke) {
      root.SongShape.unassignStroke(session, removed.id);
    }
    recomputeGaps(session);
    return removed;
  }

  function clearStrokes(session, recorder) {
    if (recorder) recorder.active = null;
    session.strokes = [];
    session.gaps = [];
  }

  /**
   * Start the annotation over on the same loaded audio.
   * Drops any in-progress stroke, clears strokes, gaps, sections, phrases,
   * and labels/annotations, and restores default notes. There is no separate
   * undo stack beyond the stroke list, so clearing strokes clears undo.
   * Audio metadata, baseline, and timing offset are kept.
   */
  function resetTrace(session, recorder) {
    if (recorder) recorder.active = null;
    session.strokes = [];
    session.gaps = [];
    session.sections = [];
    session.phrases = [];
    session.notes = createSession().notes;
    session.draft = null;
    session.anchors = [];
    session.active_word_id = null;
    session.harmony_ranges = [];
    (session.strokes || []).forEach(function (s) { s.word_id = null; });
    if (session.lyrics && Array.isArray(session.lyrics.words)) {
      session.lyrics.words.forEach(function (w) { w.skipped = false; });
    } else {
      session.lyrics = { text: "", lines: [], words: [] };
    }
    return session;
  }

  function setStrokeAnnotations(session, id, annotations) {
    var s = session.strokes.find(function (x) { return x.id === id; });
    if (!s) return null;
    var list = Array.isArray(annotations) ? annotations : [];
    var cleaned = [];
    var i;
    for (i = 0; i < list.length && cleaned.length < MAX_ANNOTATIONS; i += 1) {
      var label = sanitizeLabel(list[i], MAX_STRING_LEN).trim();
      if (label) cleaned.push(label);
    }
    s.annotations = cleaned;
    return s;
  }

  function setGapLabel(session, startMs, endMs, label, breath) {
    recomputeGaps(session);
    var g = (session.gaps || []).find(function (x) {
      return x.start_ms === startMs && x.end_ms === endMs;
    });
    if (!g) return null;
    if (label != null) g.label = sanitizeLabel(label, MAX_STRING_LEN) || "unlabeled_gap";
    if (breath != null) g.breath = sanitizeLabel(breath, MAX_STRING_LEN) || "unknown";
    return g;
  }

  function exportTime(v, fallback) {
    return isFiniteNumber(v) ? v : (fallback || 0);
  }

  function exportLevel(v) {
    if (!isFiniteNumber(v)) return 0;
    return clamp(v, Y_MIN, Y_MAX);
  }

  function exportPhrase(p) {
    var ids = [];
    var src = p && Array.isArray(p.stroke_ids) ? p.stroke_ids : [];
    var i;
    for (i = 0; i < src.length && ids.length < MAX_STROKE_IDS; i += 1) {
      var id = sanitizeLabel(src[i], MAX_STRING_LEN);
      if (id) ids.push(id);
    }
    return {
      id: sanitizeLabel(p && p.id, MAX_STRING_LEN) || "phrase",
      text: sanitizeLabel(p && p.text, MAX_STRING_LEN),
      stroke_ids: ids
    };
  }

  function exportSection(sec) {
    var a = exportTime(sec && sec.start_ms, 0);
    var b = exportTime(sec && sec.end_ms, 0);
    if (a < 0) a = 0;
    if (b < 0) b = 0;
    if (a > MAX_TIME_MS) a = MAX_TIME_MS;
    if (b > MAX_TIME_MS) b = MAX_TIME_MS;
    return {
      id: sanitizeLabel(sec && sec.id, MAX_STRING_LEN) || "section",
      label: sanitizeLabel(sec && sec.label, MAX_STRING_LEN),
      start_ms: Math.min(a, b),
      end_ms: Math.max(a, b)
    };
  }

  function exportStroke(s) {
    var points = [];
    var src = s && Array.isArray(s.points) ? s.points : [];
    var i;
    for (i = 0; i < src.length && points.length < MAX_POINTS; i += 1) {
      var p = src[i];
      if (!Array.isArray(p) || p.length < 2) continue;
      if (!isFiniteNumber(p[0]) || !isFiniteNumber(p[1])) continue;
      if (p[0] < 0 || p[0] > MAX_TIME_MS) continue;
      points.push([p[0], clamp(p[1], Y_MIN, Y_MAX)]);
    }
    var annotations = [];
    var tags = s && Array.isArray(s.annotations) ? s.annotations : [];
    for (i = 0; i < tags.length && annotations.length < MAX_ANNOTATIONS; i += 1) {
      var tag = sanitizeLabel(tags[i], MAX_STRING_LEN);
      if (tag) annotations.push(tag);
    }
    var start = isFiniteNumber(s && s.start_ms) ? s.start_ms : (points.length ? points[0][0] : 0);
    var end = isFiniteNumber(s && s.end_ms) ? s.end_ms : (points.length ? points[points.length - 1][0] : start);
    if (start < 0) start = 0;
    if (end < 0) end = 0;
    if (start > MAX_TIME_MS) start = MAX_TIME_MS;
    if (end > MAX_TIME_MS) end = MAX_TIME_MS;
    if (end < start) end = start;
    return {
      id: sanitizeLabel(s && s.id, MAX_STRING_LEN) || "stroke",
      phrase_id: s && s.phrase_id != null ? (sanitizeLabel(s.phrase_id, MAX_STRING_LEN) || null) : null,
      start_ms: start,
      end_ms: end,
      points: points,
      annotations: annotations,
      section: s && s.section ? (sanitizeLabel(s.section, MAX_STRING_LEN) || null) : null,
      word_id: s && s.word_id ? sanitizeLabel(s.word_id, MAX_STRING_LEN) : null
    };
  }

  function exportGap(g) {
    var start = exportTime(g && g.start_ms, 0);
    var end = exportTime(g && g.end_ms, start);
    if (start < 0) start = 0;
    if (end < 0) end = 0;
    if (start > MAX_TIME_MS) start = MAX_TIME_MS;
    if (end > MAX_TIME_MS) end = MAX_TIME_MS;
    if (end < start) end = start;
    var duration = isFiniteNumber(g && g.duration_ms) ? g.duration_ms : (end - start);
    if (!isFiniteNumber(duration) || duration < 0) duration = end - start;
    return {
      start_ms: start,
      end_ms: end,
      duration_ms: duration,
      label: sanitizeLabel(g && g.label, MAX_STRING_LEN) || "unlabeled_gap",
      breath: sanitizeLabel(g && g.breath, MAX_STRING_LEN) || "unknown"
    };
  }


  function exportLyrics(lyrics) {
    var src = lyrics || { text: "", lines: [], words: [] };
    var text = keepMultiline(typeof src.text === "string" ? src.text : "", MAX_LYRICS_CHARS);
    var words = (src.words || []).slice(0, MAX_WORDS).map(function (w, i) {
      return {
        id: sanitizeLabel(w && w.id, MAX_STRING_LEN) || ("word-" + (i + 1)),
        line_id: sanitizeLabel(w && w.line_id, MAX_STRING_LEN) || "line-1",
        index: isFiniteNumber(w && w.index) ? w.index : i,
        text: sanitizeLabel(w && w.text, MAX_STRING_LEN),
        skipped: !!(w && w.skipped)
      };
    });
    var lines = (src.lines || []).slice(0, MAX_LINES).map(function (ln, i) {
      var ids = [];
      (ln && Array.isArray(ln.word_ids) ? ln.word_ids : []).forEach(function (id) {
        var s = sanitizeLabel(id, MAX_STRING_LEN);
        if (s && ids.length < MAX_WORDS) ids.push(s);
      });
      var kind = ln && ln.kind === "tag" ? "tag" : (ln && ln.kind === "blank" ? "blank" : "lyric");
      return {
        id: sanitizeLabel(ln && ln.id, MAX_STRING_LEN) || ("line-" + (i + 1)),
        index: isFiniteNumber(ln && ln.index) ? ln.index : i,
        text: sanitizeLabel(ln && ln.text, 2000),
        kind: kind,
        word_ids: ids
      };
    });
    return { text: text, lines: lines, words: words };
  }

  function exportAnchor(a, i) {
    var start = exportTime(a && a.start_ms, 0);
    var end = exportTime(a && a.end_ms, start);
    if (start < 0) start = 0;
    if (end < 0) end = 0;
    if (end < start) end = start;
    var wordIds = [];
    (a && Array.isArray(a.word_ids) ? a.word_ids : []).forEach(function (id) {
      var s = sanitizeLabel(id, MAX_STRING_LEN);
      if (s && wordIds.length < MAX_WORDS) wordIds.push(s);
    });
    var wordId = a && a.word_id ? sanitizeLabel(a.word_id, MAX_STRING_LEN) : (wordIds[0] || "");
    if (wordId && wordIds.indexOf(wordId) < 0) wordIds.unshift(wordId);
    return {
      id: sanitizeLabel(a && a.id, MAX_STRING_LEN) || ("anchor-" + (i + 1)),
      word_id: wordId,
      line_id: sanitizeLabel(a && a.line_id, MAX_STRING_LEN) || "",
      word_ids: wordIds,
      kind: a && a.kind === "line" ? "line" : "word",
      start_ms: start,
      end_ms: end,
      anchor_ms: exportTime(a && a.anchor_ms, start),
      stroke_id: (a && a.stroke_ids && a.stroke_ids[0]) ? sanitizeLabel(a.stroke_ids[0], MAX_STRING_LEN) : (a && a.stroke_id ? sanitizeLabel(a.stroke_id, MAX_STRING_LEN) : null),
      stroke_ids: (function () {
        var ids = [];
        (a && Array.isArray(a.stroke_ids) ? a.stroke_ids : []).forEach(function (id) {
          var s = sanitizeLabel(id, MAX_STRING_LEN);
          if (s && ids.indexOf(s) < 0) ids.push(s);
        });
        if (a && a.stroke_id) {
          var one = sanitizeLabel(a.stroke_id, MAX_STRING_LEN);
          if (one && ids.indexOf(one) < 0) ids.unshift(one);
        }
        return ids;
      }()),
      needs_review: !!(a && a.needs_review),
      harmony: !!(a && a.harmony),
      source: sanitizeLabel(a && a.source, MAX_STRING_LEN) || "next_word",
      group_id: a && a.group_id ? sanitizeLabel(a.group_id, MAX_STRING_LEN) : null,
      // v0.2.11: optional machine signal (consonant trigger) time and the rule used for the word start.
      signal_ms: a && isFiniteNumber(a.signal_ms) && a.signal_ms >= 0 ? Math.round(a.signal_ms) : null,
      anchor_rule: a && a.anchor_rule ? sanitizeLabel(a.anchor_rule, 60) : null,
      tap_anchored: !!(a && a.tap_anchored),
      confidence: a && isFiniteNumber(a.confidence) && a.confidence >= 0 && a.confidence <= 1 ? a.confidence : null,
      review_flags: a && Array.isArray(a.review_flags) ? a.review_flags.slice(0, 12).map(function (s) { return sanitizeLabel(s, 80); }).filter(Boolean) : []
    };
  }

  function exportDraft(draft) {
    if (!draft || typeof draft !== "object") return null;
    return {
      method: "measured_pitch_and_rms",
      y_semantics: "measured_pitch_relative_to_estimated_baseline",
      y_units: "normalized_octaves_around_median_f0",
      baseline_hz: isFiniteNumber(draft.baseline_hz) && draft.baseline_hz >= 0 ? draft.baseline_hz : 0,
      baseline_from: draft.baseline_from === "vocal_range_midpoint" || draft.baseline_from === "fixed" ? draft.baseline_from : "median_f0",
      strokes: (draft.strokes || []).slice(0, MAX_STROKES).map(exportStroke),
      gaps: (draft.gaps || []).slice(0, MAX_GAPS).map(exportGap),
      accepted: !!draft.accepted
    };
  }

  function sessionToJSON(session) {
    var src = session || createSession();
    var offset = isFiniteNumber(src.timing_offset_ms) ? src.timing_offset_ms : 0;
    if (offset < -MAX_TIME_MS) offset = -MAX_TIME_MS;
    if (offset > MAX_TIME_MS) offset = MAX_TIME_MS;
    var duration = src.audio && isFiniteNumber(src.audio.duration_ms) ? src.audio.duration_ms : 0;
    if (duration < 0) duration = 0;
    if (duration > MAX_TIME_MS) duration = MAX_TIME_MS;
    var baselineY = src.baseline ? exportLevel(src.baseline.y) : 0;
    return {
      schema_version: SCHEMA_VERSION,
      app_version: sanitizeLabel(src.app_version, MAX_STRING_LEN) || APP_VERSION,
      method: sanitizeLabel(src.method, MAX_STRING_LEN) || "manual_listener_trace",
      y_semantics: sanitizeLabel(src.y_semantics, 400) || "subjective_vocal_delivery_relative_to_singer_baseline",
      y_units: sanitizeLabel(src.y_units, MAX_STRING_LEN) || "normalized_relative",
      audio: {
        name: sanitizeLabel(src.audio && src.audio.name, MAX_STRING_LEN),
        included_in_export: false,
        duration_ms: duration
      },
      baseline: {
        y: baselineY,
        defined_by: sanitizeLabel(src.baseline && src.baseline.defined_by, MAX_STRING_LEN) || "annotator"
      },
      timing_offset_ms: offset,
      phrases: (src.phrases || []).slice(0, MAX_PHRASES).map(exportPhrase),
      sections: (src.sections || []).slice(0, MAX_SECTIONS).map(exportSection),
      strokes: (src.strokes || []).slice(0, MAX_STROKES).map(exportStroke),
      gaps: (src.gaps || []).slice(0, MAX_GAPS).map(exportGap),
      lyrics: exportLyrics(src.lyrics),
      replacement_lyrics: keepMultiline(src.replacement_lyrics || "", MAX_LYRICS_CHARS),
      extend_lyrics: keepMultiline(src.extend_lyrics || "", MAX_LYRICS_CHARS),
      anchors: (src.anchors || []).slice(0, MAX_ANCHORS).map(exportAnchor),
      draft: exportDraft(src.draft),
      reference: {
        title: sanitizeLabel(src.reference && src.reference.title, MAX_STRING_LEN),
        artist: sanitizeLabel(src.reference && src.reference.artist, MAX_STRING_LEN)
      },
      active_word_id: src.active_word_id ? sanitizeLabel(src.active_word_id, MAX_STRING_LEN) : null,
      place_parentheses: !!src.place_parentheses,
      harmony_ranges: exportHarmonyRanges(src.harmony_ranges),
      detected_harmony: exportDetectedHarmony(src.detected_harmony),
      vocal_range: exportVocalRange(src.vocal_range),
      line_taps: exportLineTaps(src.line_taps),
      performer: exportPerformer(src.performer),
      notes: sanitizeLabel(src.notes, MAX_NOTES_LEN)
    };
  }


  // v0.2.11 fix5: tapped line starts ({line_id, t_ms, raw_ms} or {line_id, skipped: true}).
  function exportLineTaps(taps) {
    if (!Array.isArray(taps)) return [];
    return taps.slice(0, MAX_LINES).filter(function (t) { return t && typeof t.line_id === "string"; }).map(function (t) {
      if (t.skipped) return { line_id: sanitizeLabel(t.line_id, MAX_STRING_LEN), skipped: true };
      return { line_id: sanitizeLabel(t.line_id, MAX_STRING_LEN), t_ms: Math.max(0, Math.min(MAX_TIME_MS, Math.round(Number(t.t_ms) || 0))),
        raw_ms: Math.max(0, Math.min(MAX_TIME_MS, Math.round(Number(t.raw_ms) || 0))) };
    });
  }
  function parseLineTaps(arr) {
    if (arr == null) return [];
    var src = requireArray(arr, "line_taps", MAX_LINES);
    return src.map(function (t, i) {
      requirePlainObject(t, "line_taps[" + i + "]");
      var id = requireString(t.line_id, "line_taps[" + i + "].line_id", MAX_STRING_LEN);
      if (t.skipped) return { line_id: id, skipped: true };
      return { line_id: id, t_ms: requireTimeMs(t.t_ms, "line_taps[" + i + "].t_ms"), raw_ms: t.raw_ms == null ? requireTimeMs(t.t_ms, "line_taps[" + i + "].t_ms") : requireTimeMs(t.raw_ms, "line_taps[" + i + "].raw_ms") };
    });
  }

  function exportHarmonyRanges(ranges) {
    var out = [];
    if (!Array.isArray(ranges)) return out;
    ranges.forEach(function (r, i) {
      var start = exportTime(r && r.start_ms, 0);
      var end = exportTime(r && r.end_ms, start);
      if (end < start) end = start;
      out.push({
        id: sanitizeLabel(r && r.id, MAX_STRING_LEN) || ("harmony-" + (i + 1)),
        start_ms: start,
        end_ms: end
      });
    });
    return out;
  }

  // v0.2.11 fix6f: measured lead range (numbers and note names only).
  function exportVocalRange(r) {
    if (!r || typeof r !== "object" || Array.isArray(r)) return null;
    var n = function (v, lo, hi) { return typeof v === "number" && isFinite(v) && v >= lo && v <= hi ? Math.round(v * 100) / 100 : null; };
    var note = function (v) { return typeof v === "string" && /^[A-G]#?-?\d{1,2}$/.test(v) ? v : null; };
    var low = n(r.low_hz, 20, 5000), high = n(r.high_hz, 20, 5000), base = n(r.baseline_hz, 20, 5000);
    if (low == null || high == null || base == null || high < low) return null;
    var ex = r.excluded && typeof r.excluded === "object" ? r.excluded : {};
    var cnt = function (v) { return typeof v === "number" && isFinite(v) && v >= 0 ? Math.round(v) : 0; };
    return { method: "percentiles_of_confident_lead_frames",
      percentiles: Array.isArray(r.percentiles) && r.percentiles.length === 2 ? [n(r.percentiles[0], 0, 50) || 2, n(r.percentiles[1], 50, 100) || 98] : [2, 98],
      low_hz: low, high_hz: high, baseline_hz: base, low_note: note(r.low_note), high_note: note(r.high_note), baseline_note: note(r.baseline_note),
      low_midi: n(r.low_midi, 0, 140), high_midi: n(r.high_midi, 0, 140), baseline_midi: n(r.baseline_midi, 0, 140),
      span_semitones: n(r.span_semitones, 0, 100), half_span_octaves: n(r.half_span_octaves, 0.01, 5) || Math.max(1 / 12, Math.log(high / low) / Math.log(2) / 2),
      median_hz: n(r.median_hz, 20, 5000), frames_used: cnt(r.frames_used), frames_voiced: cnt(r.frames_voiced),
      excluded: { harmony_regions: cnt(ex.harmony_regions), quiet: cnt(ex.quiet), unstable_or_isolated: cnt(ex.unstable_or_isolated), outlier_clusters: cnt(ex.outlier_clusters) },
      harmony_regions_excluded: cnt(r.harmony_regions_excluded),
      source: ["vocal_stem", "song_mix"].indexOf(r.source) >= 0 ? r.source : "vocal_stem",
      register_bands: "fifths of the range: low < -0.6, lower-mid < -0.2, mid within \u00b10.2, upper-mid \u2264 0.6, high above (\u22121 = lowest note, +1 = highest note)" };
  }

  function exportDetectedHarmony(regions) {
    var out = [];
    if (!Array.isArray(regions)) return out;
    regions.slice(0, MAX_SECTIONS).forEach(function (r, i) {
      if (!r || typeof r !== "object") return;
      var start = exportTime(r.start_ms, 0), end = exportTime(r.end_ms, start);
      if (end < start) end = start;
      var score = typeof r.score === "number" && isFinite(r.score) ? Math.max(0, Math.min(1, Math.round(r.score * 100) / 100)) : null;
      out.push({ id: sanitizeLabel(r.id, MAX_STRING_LEN) || ("auto-harmony-" + (i + 1)), start_ms: start, end_ms: end, score: score,
        reasons: (Array.isArray(r.reasons) ? r.reasons : []).slice(0, 4).map(function (x) { return sanitizeLabel(x, 80); }).filter(Boolean),
        source: ["stem", "words", "stem+words"].indexOf(r.source) >= 0 ? r.source : "stem" });
    });
    return out;
  }

  function defaultPerformerIdentityText() {
    if (root.SongShape && root.SongShape.defaultPerformerIdentity) {
      return root.SongShape.defaultPerformerIdentity();
    }
    return "One consistent lead singer for all sung passages; same vocal timbre, character, and diction throughout. Intensity, register, sustain, dynamics, and expression may vary naturally. No unexpected additional singer, duet, choir handoff, or voice-character change.";
  }

  function exportPerformer(p) {
    var identity = sanitizeLabel(p && p.identity, MAX_NOTES_LEN) || defaultPerformerIdentityText();
    return {
      identity: identity,
      allow_harmony: !!(p && p.allow_harmony)
    };
  }

  function parseHarmonyRanges(arr) {
    if (arr == null) return [];
    var src = requireArray(arr, "harmony_ranges", MAX_SECTIONS);
    return src.map(function (r, i) {
      requirePlainObject(r, "harmony_ranges[" + i + "]");
      var start = requireTimeMs(r.start_ms, "harmony_ranges[" + i + "].start_ms");
      var end = r.end_ms == null ? start : requireTimeMs(r.end_ms, "harmony_ranges[" + i + "].end_ms");
      if (end < start) {
        throw new Error("Invalid Song Shape file: harmony_ranges[" + i + "] end_ms is before start_ms.");
      }
      return {
        id: r.id == null ? ("harmony-" + (i + 1)) : requireString(r.id, "harmony_ranges[" + i + "].id", MAX_STRING_LEN) || ("harmony-" + (i + 1)),
        start_ms: start,
        end_ms: end
      };
    });
  }

  function parsePerformer(obj) {
    if (obj == null) {
      return { identity: defaultPerformerIdentityText(), allow_harmony: false };
    }
    requirePlainObject(obj, "performer");
    return {
      identity: obj.identity == null ? defaultPerformerIdentityText() : requireString(obj.identity, "performer.identity", MAX_NOTES_LEN) || defaultPerformerIdentityText(),
      allow_harmony: !!obj.allow_harmony
    };
  }

  function parsePoint(p, field) {
    if (!Array.isArray(p) || p.length < 2) {
      throw new Error("Invalid Song Shape file: " + field + " must be a [time, level] pair.");
    }
    return [requireTimeMs(p[0], field + " time"), requireLevel(p[1], field + " level")];
  }

  function parseStroke(s, index, pointBudget) {
    requirePlainObject(s, "strokes[" + index + "]");
    var pointsSrc = requireArray(s.points, "strokes[" + index + "].points", MAX_POINTS);
    if (pointsSrc.length < 1) {
      throw new Error("Invalid Song Shape file: strokes[" + index + "] must have at least one point.");
    }
    if (pointsSrc.length > pointBudget.remaining) {
      throw new Error("Invalid Song Shape file: total points exceed " + MAX_POINTS + ".");
    }
    var points = [];
    var i;
    for (i = 0; i < pointsSrc.length; i += 1) {
      points.push(parsePoint(pointsSrc[i], "strokes[" + index + "].points[" + i + "]"));
    }
    pointBudget.remaining -= points.length;
    var start = requireTimeMs(s.start_ms, "strokes[" + index + "].start_ms");
    var end = requireTimeMs(s.end_ms, "strokes[" + index + "].end_ms");
    if (end < start) {
      throw new Error("Invalid Song Shape file: strokes[" + index + "] end_ms is before start_ms.");
    }
    var annotations = [];
    if (s.annotations != null) {
      var tags = requireArray(s.annotations, "strokes[" + index + "].annotations", MAX_ANNOTATIONS);
      for (i = 0; i < tags.length; i += 1) {
        annotations.push(requireString(tags[i], "strokes[" + index + "].annotations[" + i + "]", MAX_STRING_LEN));
      }
    }
    return {
      id: requireString(s.id, "strokes[" + index + "].id", MAX_STRING_LEN) || ("stroke-" + (index + 1)),
      phrase_id: optionalString(s.phrase_id, "strokes[" + index + "].phrase_id", MAX_STRING_LEN),
      start_ms: start,
      end_ms: end,
      points: points,
      annotations: annotations,
      section: optionalString(s.section, "strokes[" + index + "].section", MAX_STRING_LEN),
      word_id: s.word_id == null ? null : optionalString(s.word_id, "strokes[" + index + "].word_id", MAX_STRING_LEN)
    };
  }

  function parseGap(g, index) {
    requirePlainObject(g, "gaps[" + index + "]");
    var start = requireTimeMs(g.start_ms, "gaps[" + index + "].start_ms");
    var end = requireTimeMs(g.end_ms, "gaps[" + index + "].end_ms");
    if (end < start) {
      throw new Error("Invalid Song Shape file: gaps[" + index + "] end_ms is before start_ms.");
    }
    var duration = g.duration_ms == null ? (end - start) : requireFiniteNumber(g.duration_ms, "gaps[" + index + "].duration_ms");
    if (duration < 0 || duration > MAX_TIME_MS) {
      throw new Error("Invalid Song Shape file: gaps[" + index + "].duration_ms is out of range.");
    }
    return {
      start_ms: start,
      end_ms: end,
      duration_ms: duration,
      label: g.label == null ? "unlabeled_gap" : requireString(g.label, "gaps[" + index + "].label", MAX_STRING_LEN) || "unlabeled_gap",
      breath: g.breath == null ? "unknown" : requireString(g.breath, "gaps[" + index + "].breath", MAX_STRING_LEN) || "unknown"
    };
  }

  function parsePhrase(p, index) {
    requirePlainObject(p, "phrases[" + index + "]");
    var ids = [];
    if (p.stroke_ids != null) {
      var src = requireArray(p.stroke_ids, "phrases[" + index + "].stroke_ids", MAX_STROKE_IDS);
      var i;
      for (i = 0; i < src.length; i += 1) {
        ids.push(requireString(src[i], "phrases[" + index + "].stroke_ids[" + i + "]", MAX_STRING_LEN));
      }
    }
    return {
      id: p.id == null ? ("phrase-" + (index + 1)) : requireString(p.id, "phrases[" + index + "].id", MAX_STRING_LEN) || ("phrase-" + (index + 1)),
      text: p.text == null ? "" : requireString(p.text, "phrases[" + index + "].text", MAX_STRING_LEN),
      stroke_ids: ids
    };
  }

  function parseSection(sec, index) {
    requirePlainObject(sec, "sections[" + index + "]");
    var start = requireTimeMs(sec.start_ms, "sections[" + index + "].start_ms");
    var end = requireTimeMs(sec.end_ms, "sections[" + index + "].end_ms");
    if (end < start) {
      throw new Error("Invalid Song Shape file: sections[" + index + "] end_ms is before start_ms.");
    }
    return {
      id: sec.id == null ? ("section-" + (index + 1)) : requireString(sec.id, "sections[" + index + "].id", MAX_STRING_LEN) || ("section-" + (index + 1)),
      label: requireString(sec.label, "sections[" + index + "].label", MAX_STRING_LEN),
      start_ms: start,
      end_ms: end
    };
  }

  function parseSession(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      throw new Error("Invalid Song Shape file.");
    }
    var session = createSession();
    if (obj.schema_version != null) session.schema_version = requireString(obj.schema_version, "schema_version", MAX_STRING_LEN) || SCHEMA_VERSION;
    if (obj.app_version != null) session.app_version = requireString(obj.app_version, "app_version", MAX_STRING_LEN) || APP_VERSION;
    if (obj.method != null) session.method = requireString(obj.method, "method", MAX_STRING_LEN) || session.method;
    if (obj.y_semantics != null) session.y_semantics = requireString(obj.y_semantics, "y_semantics", 400) || session.y_semantics;
    if (obj.y_units != null) session.y_units = requireString(obj.y_units, "y_units", MAX_STRING_LEN) || session.y_units;
    if (obj.audio != null) {
      requirePlainObject(obj.audio, "audio");
      session.audio = {
        name: obj.audio.name == null ? "" : requireString(obj.audio.name, "audio.name", MAX_STRING_LEN),
        included_in_export: false,
        duration_ms: obj.audio.duration_ms == null ? 0 : requireTimeMs(obj.audio.duration_ms, "audio.duration_ms")
      };
    }
    if (obj.baseline != null) {
      requirePlainObject(obj.baseline, "baseline");
      session.baseline = {
        y: obj.baseline.y == null ? 0 : requireLevel(obj.baseline.y, "baseline.y"),
        defined_by: obj.baseline.defined_by == null ? "annotator" : requireString(obj.baseline.defined_by, "baseline.defined_by", MAX_STRING_LEN) || "annotator"
      };
    }
    session.timing_offset_ms = obj.timing_offset_ms == null ? 0 : requireOffsetMs(obj.timing_offset_ms, "timing_offset_ms");
    var phrases = optionalArray(obj.phrases, "phrases", MAX_PHRASES);
    session.phrases = phrases.map(function (p, i) { return parsePhrase(p, i); });
    var sections = optionalArray(obj.sections, "sections", MAX_SECTIONS);
    session.sections = sections.map(function (sec, i) { return parseSection(sec, i); });
    var strokes = optionalArray(obj.strokes, "strokes", MAX_STROKES);
    var pointBudget = { remaining: MAX_POINTS };
    session.strokes = strokes.map(function (s, i) { return parseStroke(s, i, pointBudget); });
    var gaps = optionalArray(obj.gaps, "gaps", MAX_GAPS);
    session.gaps = gaps.map(function (g, i) { return parseGap(g, i); });
    if (obj.notes != null) session.notes = requireString(obj.notes, "notes", MAX_NOTES_LEN);
    if (obj.schema_version && obj.schema_version !== SCHEMA_VERSION && obj.schema_version !== SCHEMA_VERSION_V01) {
      // Unknown versions are accepted only if the known fields validate.
      session.schema_version = requireString(obj.schema_version, "schema_version", MAX_STRING_LEN);
    } else if (!obj.schema_version || obj.schema_version === SCHEMA_VERSION_V01) {
      session.schema_version = obj.schema_version === SCHEMA_VERSION_V01 ? SCHEMA_VERSION_V01 : SCHEMA_VERSION;
    }
    session.lyrics = obj.lyrics != null ? parseLyricsBlock(obj.lyrics) : { text: "", lines: [], words: [] };
    if (obj.replacement_lyrics != null) {
      if (typeof obj.replacement_lyrics !== "string" || obj.replacement_lyrics.length > MAX_LYRICS_CHARS) {
        throw new Error("Invalid Song Shape file: replacement_lyrics exceeds the limit or is not text.");
      }
      session.replacement_lyrics = keepMultiline(obj.replacement_lyrics, MAX_LYRICS_CHARS);
    }
    if (obj.vocal_range != null) {
      if (typeof obj.vocal_range !== "object" || Array.isArray(obj.vocal_range)) throw new Error("Invalid Song Shape file: vocal_range must be an object.");
      session.vocal_range = exportVocalRange(obj.vocal_range);
    }
    if (obj.detected_harmony != null) {
      if (!Array.isArray(obj.detected_harmony)) throw new Error("Invalid Song Shape file: detected_harmony must be a list.");
      session.detected_harmony = exportDetectedHarmony(obj.detected_harmony);
    }
    if (obj.extend_lyrics != null) {
      if (typeof obj.extend_lyrics !== "string" || obj.extend_lyrics.length > MAX_LYRICS_CHARS) {
        throw new Error("Invalid Song Shape file: extend_lyrics exceeds the limit or is not text.");
      }
      session.extend_lyrics = keepMultiline(obj.extend_lyrics, MAX_LYRICS_CHARS);
    }
    session.anchors = obj.anchors != null ? parseAnchorsBlock(obj.anchors) : [];
    session.draft = obj.draft != null ? parseDraftBlock(obj.draft) : null;
    if (obj.reference != null) {
      requirePlainObject(obj.reference, "reference");
      session.reference = {
        title: obj.reference.title == null ? "" : requireString(obj.reference.title, "reference.title", MAX_STRING_LEN),
        artist: obj.reference.artist == null ? "" : requireString(obj.reference.artist, "reference.artist", MAX_STRING_LEN)
      };
    }
    session.active_word_id = obj.active_word_id == null ? null : optionalString(obj.active_word_id, "active_word_id", MAX_STRING_LEN);
    session.place_parentheses = !!obj.place_parentheses;
    session.harmony_ranges = parseHarmonyRanges(obj.harmony_ranges);
    session.line_taps = parseLineTaps(obj.line_taps);
    session.performer = parsePerformer(obj.performer);
    recomputeGaps(session);
    return session;
  }

  function parseLyricsBlock(obj) {
    requirePlainObject(obj, "lyrics");
    var text = "";
    if (obj.text == null) text = "";
    else if (typeof obj.text !== "string") {
      throw new Error("Invalid Song Shape file: lyrics.text must be a string.");
    } else {
      text = keepMultiline(obj.text, MAX_LYRICS_CHARS);
    }
    var wordsSrc = optionalArray(obj.words, "lyrics.words", MAX_WORDS);
    var linesSrc = optionalArray(obj.lines, "lyrics.lines", MAX_LINES);
    var words = wordsSrc.map(function (w, i) {
      requirePlainObject(w, "lyrics.words[" + i + "]");
      return {
        id: requireString(w.id, "lyrics.words[" + i + "].id", MAX_STRING_LEN) || ("word-" + (i + 1)),
        line_id: requireString(w.line_id, "lyrics.words[" + i + "].line_id", MAX_STRING_LEN) || "line-1",
        index: w.index == null ? i : requireFiniteNumber(w.index, "lyrics.words[" + i + "].index"),
        text: requireString(w.text, "lyrics.words[" + i + "].text", MAX_STRING_LEN),
        skipped: !!w.skipped
      };
    });
    var lines = linesSrc.map(function (ln, i) {
      requirePlainObject(ln, "lyrics.lines[" + i + "]");
      var kind = ln.kind == null ? "lyric" : requireString(ln.kind, "lyrics.lines[" + i + "].kind", 20);
      if (kind !== "tag" && kind !== "blank") kind = "lyric";
      var ids = [];
      if (ln.word_ids != null) {
        optionalArray(ln.word_ids, "lyrics.lines[" + i + "].word_ids", MAX_WORDS).forEach(function (id, j) {
          ids.push(requireString(id, "lyrics.lines[" + i + "].word_ids[" + j + "]", MAX_STRING_LEN));
        });
      }
      var lineText;
      if (typeof ln.text !== "string") {
        throw new Error("Invalid Song Shape file: lyrics.lines[" + i + "].text must be a string.");
      }
      lineText = keepMultiline(ln.text, 2000);
      return {
        id: ln.id == null ? ("line-" + (i + 1)) : requireString(ln.id, "lyrics.lines[" + i + "].id", MAX_STRING_LEN) || ("line-" + (i + 1)),
        index: ln.index == null ? i : requireFiniteNumber(ln.index, "lyrics.lines[" + i + "].index"),
        text: lineText,
        kind: kind,
        word_ids: ids
      };
    });
    return { text: text, lines: lines, words: words };
  }

  function parseAnchorsBlock(arr) {
    var src = requireArray(arr, "anchors", MAX_ANCHORS);
    return src.map(function (a, i) {
      requirePlainObject(a, "anchors[" + i + "]");
      var start = requireTimeMs(a.start_ms, "anchors[" + i + "].start_ms");
      var end = a.end_ms == null ? start : requireTimeMs(a.end_ms, "anchors[" + i + "].end_ms");
      if (end < start) {
        throw new Error("Invalid Song Shape file: anchors[" + i + "] end_ms is before start_ms.");
      }
      var wordIds = [];
      if (a.word_ids != null) {
        requireArray(a.word_ids, "anchors[" + i + "].word_ids", MAX_WORDS).forEach(function (id, j) {
          wordIds.push(requireString(id, "anchors[" + i + "].word_ids[" + j + "]", MAX_STRING_LEN));
        });
      }
      var wordId = a.word_id == null ? (wordIds[0] || "") : requireString(a.word_id, "anchors[" + i + "].word_id", MAX_STRING_LEN);
      if (wordId && wordIds.indexOf(wordId) < 0) wordIds.unshift(wordId);
      var kind = a.kind == null ? "word" : requireString(a.kind, "anchors[" + i + "].kind", 20);
      if (kind !== "line") kind = "word";
      return {
        id: a.id == null ? ("anchor-" + (i + 1)) : requireString(a.id, "anchors[" + i + "].id", MAX_STRING_LEN) || ("anchor-" + (i + 1)),
        word_id: wordId,
        line_id: a.line_id == null ? "" : requireString(a.line_id, "anchors[" + i + "].line_id", MAX_STRING_LEN),
        word_ids: wordIds,
        kind: kind,
        start_ms: start,
        end_ms: end,
        anchor_ms: a.anchor_ms == null ? start : requireTimeMs(a.anchor_ms, "anchors[" + i + "].anchor_ms"),
        stroke_id: a.stroke_id == null ? null : requireString(a.stroke_id, "anchors[" + i + "].stroke_id", MAX_STRING_LEN),
        stroke_ids: (function () {
          var ids = [];
          if (a.stroke_ids != null) {
            requireArray(a.stroke_ids, "anchors[" + i + "].stroke_ids", MAX_STROKES).forEach(function (id, j) {
              var s = requireString(id, "anchors[" + i + "].stroke_ids[" + j + "]", MAX_STRING_LEN);
              if (s && ids.indexOf(s) < 0) ids.push(s);
            });
          }
          if (a.stroke_id) {
            var one = requireString(a.stroke_id, "anchors[" + i + "].stroke_id", MAX_STRING_LEN);
            if (one && ids.indexOf(one) < 0) ids.unshift(one);
          }
          return ids;
        }()),
        needs_review: !!a.needs_review,
        harmony: !!a.harmony,
        source: a.source == null ? "next_word" : requireString(a.source, "anchors[" + i + "].source", MAX_STRING_LEN) || "next_word",
        group_id: a.group_id == null ? null : requireString(a.group_id, "anchors[" + i + "].group_id", MAX_STRING_LEN),
        signal_ms: a.signal_ms == null ? null : requireTimeMs(a.signal_ms, "anchors[" + i + "].signal_ms"),
        anchor_rule: a.anchor_rule == null ? null : requireString(a.anchor_rule, "anchors[" + i + "].anchor_rule", 60),
        tap_anchored: a.tap_anchored === true,
        confidence: isFiniteNumber(a.confidence) && a.confidence >= 0 && a.confidence <= 1 ? a.confidence : null,
        review_flags: Array.isArray(a.review_flags) ? a.review_flags.slice(0, 12).map(function (s) { return sanitizeLabel(s, 80); }).filter(Boolean) : []
      };
    });
  }

  function parseDraftBlock(obj) {
    requirePlainObject(obj, "draft");
    var pointBudget = { remaining: MAX_POINTS };
    var strokes = optionalArray(obj.strokes, "draft.strokes", MAX_STROKES).map(function (s, i) {
      return parseStroke(s, i, pointBudget);
    });
    var gaps = optionalArray(obj.gaps, "draft.gaps", MAX_GAPS).map(function (g, i) {
      return parseGap(g, i);
    });
    var hz = 0;
    if (obj.baseline_hz != null) {
      hz = requireFiniteNumber(obj.baseline_hz, "draft.baseline_hz");
      if (hz < 0 || hz > 20000) {
        throw new Error("Invalid Song Shape file: draft.baseline_hz is out of range.");
      }
    }
    return {
      method: "measured_pitch_and_rms",
      y_semantics: "measured_pitch_relative_to_estimated_baseline",
      y_units: "normalized_octaves_around_median_f0",
      baseline_hz: hz,
      baseline_from: obj.baseline_from === "vocal_range_midpoint" || obj.baseline_from === "fixed" ? obj.baseline_from : "median_f0",
      strokes: strokes,
      gaps: gaps,
      accepted: !!obj.accepted
    };
  }

  function parseSessionText(text, byteLength) {
    if (typeof text !== "string") {
      throw new Error("Invalid Song Shape file.");
    }
    var size = isFiniteNumber(byteLength) ? byteLength : text.length;
    if (size > MAX_IMPORT_BYTES || text.length > MAX_IMPORT_BYTES) {
      throw new Error("Invalid Song Shape file: the file is too large (limit 20 MB).");
    }
    var obj;
    try {
      obj = JSON.parse(text);
    } catch (err) {
      throw new Error("Invalid Song Shape file: the JSON could not be parsed.");
    }
    return parseSession(obj);
  }


  function setStrokeSection(session, id, label) {
    var s = session.strokes.find(function (x) { return x.id === id; });
    if (!s) return null;
    var v = sanitizeLabel(label, MAX_STRING_LEN).trim();
    s.section = v || null;
    return s;
  }

  function setSectionRange(session, startMs, endMs, label) {
    var v = sanitizeLabel(label, MAX_STRING_LEN).trim();
    if (!v) return null;
    if (!isFiniteNumber(startMs) || !isFiniteNumber(endMs)) return null;
    var a = Math.round(Math.min(startMs, endMs));
    var b = Math.round(Math.max(startMs, endMs));
    if (a < 0) a = 0;
    if (b < 0) b = 0;
    if (a > MAX_TIME_MS) a = MAX_TIME_MS;
    if (b > MAX_TIME_MS) b = MAX_TIME_MS;
    if (b <= a) return null;
    session.sections = session.sections || [];
    var existing = session.sections.find(function (sec) {
      return sec.start_ms === a && sec.end_ms === b;
    });
    if (existing) existing.label = v;
    else {
      session.sections.push({
        id: nextId("section-", session.sections),
        label: v,
        start_ms: a,
        end_ms: b
      });
    }
    session.strokes.forEach(function (s) {
      var mid = (s.start_ms + s.end_ms) / 2;
      if (mid >= a && mid <= b) s.section = v;
    });
    return session.sections;
  }

  function phraseText(session, phraseId) {
    if (!phraseId) return null;
    var p = (session.phrases || []).find(function (x) { return x.id === phraseId; });
    return p && p.text ? p.text : null;
  }

  function strokeSectionLabel(session, stroke) {
    if (stroke.section && String(stroke.section).trim()) return String(stroke.section).trim();
    var mid = (stroke.start_ms + stroke.end_ms) / 2;
    var ranges = (session.sections || []).filter(function (sec) {
      return mid >= sec.start_ms && mid <= sec.end_ms && sec.label;
    });
    if (!ranges.length) return null;
    ranges.sort(function (a, b) {
      return (a.end_ms - a.start_ms) - (b.end_ms - b.start_ms);
    });
    return ranges[0].label;
  }

  function formatSeconds(ms) {
    var n = isFiniteNumber(ms) ? ms : 0;
    return (n / 1000).toFixed(2) + " s";
  }

  function formatY(y) {
    var n = isFiniteNumber(y) ? y : 0;
    var sign = n > 0 ? "+" : "";
    return sign + n.toFixed(2);
  }

  function describeDirection(stroke) {
    var pts = stroke.points || [];
    if (pts.length < 2) return "held";
    var start = pts[0][1];
    var end = pts[pts.length - 1][1];
    var peak = Math.max.apply(null, pts.map(function (p) { return p[1]; }));
    var low = Math.min.apply(null, pts.map(function (p) { return p[1]; }));
    var range = peak - low;
    var dy = end - start;
    if (range < 0.12) return "held";
    var peakInMiddle = peak > start + 0.15 && peak > end + 0.15;
    var lowInMiddle = low < start - 0.15 && low < end - 0.15;
    if (peakInMiddle) return "up, then down";
    if (lowInMiddle) return "down, then up";
    if (dy > 0.12) return "up";
    if (dy < -0.12) return "down";
    return "held";
  }

  function strokeHeights(stroke) {
    var pts = stroke.points || [];
    var start = pts.length ? pts[0][1] : 0;
    var end = pts.length ? pts[pts.length - 1][1] : 0;
    var ys = pts.map(function (p) { return p[1]; });
    return {
      start: start,
      peak: ys.length ? Math.max.apply(null, ys) : start,
      end: end
    };
  }

  var AI_PROMPT_ASK =
    "Help me write Suno lyrics with section tags and delivery notes, such as [Verse], [Chorus], and parenthetical cues, so a generated song follows this delivery shape. Point out where my phrasing, line length and pauses should go.";

  var AI_PROMPT_INTRO =
    "Song Shape traces are a listener's manual annotation of perceived vocal tone and delivery relative to that singer's baseline (the center line). " +
    "Vertical height is how high or low the delivery felt compared with that baseline; it is not measured pitch, not Hertz, and not an emotion score. " +
    "Each stroke is one press-and-hold while the song played; releasing ends the stroke. " +
    "A gap is a timed break between strokes whose meaning is unknown unless the listener labeled it — it is not automatically a breath.";

  /**
   * Self-contained prompt for pasting into ChatGPT or GrokBot.
   * No audio is included. No Suno API is called.
   */
  function aiPrompt(session) {
    var lines = [];
    lines.push("SONG SHAPE — delivery trace for writing a similar vocal shape");
    lines.push("");
    lines.push(AI_PROMPT_INTRO);
    lines.push("");
    lines.push("These notes describe only the annotation I made. They are not a transcription of lyrics, not measured pitch, and not a claim that software heard the recording.");
    if (session.audio && session.audio.name) {
      lines.push("Audio file name (the audio itself is not included): " + session.audio.name);
    }
    if (session.audio && session.audio.duration_ms) {
      lines.push("Audio duration: " + formatSeconds(session.audio.duration_ms) + " (" + session.audio.duration_ms + " ms).");
    }
    lines.push("Timing offset applied: " + (session.timing_offset_ms || 0) + " ms.");
    lines.push("Height scale: y = 0 is the singer baseline, y = +1 is a more expressive rise, y = -1 is an expressive fall.");
    lines.push("");

    var strokes = (session.strokes || []).slice().sort(function (a, b) { return a.start_ms - b.start_ms; });
    var gaps = session.gaps || [];
    if (!strokes.length) {
      lines.push("No strokes have been recorded yet.");
    } else {
      var i = 0;
      while (i < strokes.length) {
        var label = strokeSectionLabel(session, strokes[i]);
        var j = i + 1;
        while (j < strokes.length && strokeSectionLabel(session, strokes[j]) === label) j += 1;
        var group = strokes.slice(i, j);
        var headStart = group[0].start_ms;
        var headEnd = group[group.length - 1].end_ms;
        if (label) {
          lines.push("Section: " + label + " (" + formatSeconds(headStart) + " to " + formatSeconds(headEnd) + ")");
        } else if (strokes.some(function (s) { return strokeSectionLabel(session, s); })) {
          lines.push("Unlabeled span (" + formatSeconds(headStart) + " to " + formatSeconds(headEnd) + ")");
        }
        group.forEach(function (s, idx) {
          var n = i + idx + 1;
          var dur = s.end_ms - s.start_ms;
          var h = strokeHeights(s);
          var direction = describeDirection(s);
          var tags = s.annotations && s.annotations.length ? s.annotations.join(", ") : "none";
          var phrase = phraseText(session, s.phrase_id);
          var row =
            "Stroke " + n + " (" + s.id + "): " +
            formatSeconds(s.start_ms) + " to " + formatSeconds(s.end_ms) +
            " (duration " + formatSeconds(dur) + " / " + dur + " ms). " +
            "Start height y=" + formatY(h.start) +
            ", peak height y=" + formatY(h.peak) +
            ", end height y=" + formatY(h.end) +
            ". Direction: " + direction +
            ". Listener labels: " + tags + ".";
          if (phrase) row += " Phrase label: " + phrase + ".";
          if (s.section) row += " Section label: " + s.section + ".";
          lines.push(row);
          var gap = gaps.find(function (g) { return g.start_ms === s.end_ms; });
          if (gap) {
            var meaning;
            if (gap.label && gap.label !== "unlabeled_gap") {
              meaning = "Listener label: " + gap.label + ".";
            } else {
              meaning = "The listener released here; this is a timed break, not automatically a breath.";
            }
            var breath = (gap.breath && gap.breath !== "unknown")
              ? " Breath (user-set): " + gap.breath + "."
              : " Meaning of the gap: unknown.";
            lines.push(
              "Gap after this stroke: " + formatSeconds(gap.end_ms - gap.start_ms) +
              " (" + formatSeconds(gap.start_ms) + " to " + formatSeconds(gap.end_ms) +
              " / " + (gap.end_ms - gap.start_ms) + " ms). " + meaning + breath
            );
          }
        });
        lines.push("");
        i = j;
      }
    }

    lines.push("What I need:");
    lines.push("Here are the vocals of what I hear. How do I get the AI music (Suno) to do something similar?");
    lines.push(AI_PROMPT_ASK);
    return lines.join("\n");
  }

  function textSummary(session) {
    var lines = [];
    lines.push("SONG SHAPE — manual listener trace");
    lines.push(
      "This is a human annotation of perceived vocal delivery relative to a singer-specific baseline."
    );
    lines.push(
      "It is not measured pitch, not automatic transcription, and not a verified analysis of the audio."
    );
    lines.push("Y units: normalized relative (−1 below baseline, 0 = singer baseline, +1 above).");
    if (session.audio && session.audio.name) {
      lines.push("Audio file name (audio not included in this export): " + session.audio.name);
    }
    if (session.audio && session.audio.duration_ms) {
      lines.push("Audio duration: " + session.audio.duration_ms + " ms");
    }
    lines.push("Timing offset applied (ms): " + (session.timing_offset_ms || 0));
    var strokes = session.strokes || [];
    lines.push("Stroke count: " + strokes.length);
    strokes.forEach(function (s, i) {
      var labels = s.annotations && s.annotations.length ? s.annotations.join(", ") : "unlabeled";
      var dur = s.end_ms - s.start_ms;
      var ys = (s.points || []).map(function (p) { return p[1]; });
      var yStart = s.points && s.points[0] ? s.points[0][1] : 0;
      var yEnd = s.points && s.points.length ? s.points[s.points.length - 1][1] : 0;
      var yPeak = ys.length ? Math.max.apply(null, ys) : 0;
      var yMin = ys.length ? Math.min.apply(null, ys) : 0;
      lines.push(
        "Stroke " + (i + 1) + " (" + s.id + "): " + s.start_ms + "–" + s.end_ms +
        " ms (" + dur + " ms), labels: " + labels + ". " +
        "Start y=" + yStart.toFixed(2) +
        ", peak y=" + yPeak.toFixed(2) +
        ", low y=" + yMin.toFixed(2) +
        ", end y=" + yEnd.toFixed(2) + "."
      );
    });
    (session.gaps || []).forEach(function (g, i) {
      var dur = g.end_ms - g.start_ms;
      var meaning;
      if (g.label && g.label !== "unlabeled_gap") {
        meaning = "The listener marked this gap as: " + g.label + ".";
      } else {
        meaning =
          "The listener released the mouse here; the gap is a timed break in the annotation, not automatically a breath.";
      }
      var breath =
        g.breath && g.breath !== "unknown"
          ? " Breath (user-set): " + g.breath + "."
          : " Breath: unknown (not inferred).";
      lines.push(
        "Gap " + (i + 1) + ": " + g.start_ms + "–" + g.end_ms + " ms (" + dur + " ms). " +
        meaning + breath
      );
    });
    if (!strokes.length) lines.push("No strokes recorded.");
    return lines.join("\n");
  }

  // v0.2.7: the browser app decodes .wav and .mp3 locally with the browser's own
  // decodeAudioData (no libraries, no network). The Node CLI reads .wav natively and
  // .mp3 only through a user-supplied ffmpeg (--ffmpeg), because Node has no MP3 decoder.
  var SUPPORTED_AUDIO_MESSAGE = "Song Shape accepts .wav and .mp3 files (decoded locally in your browser).";
  var WAV_ONLY_MESSAGE = "The command line reads .wav (16-bit PCM or 32-bit float). For .mp3, pass --ffmpeg <path> or use the browser app.";

  function fileBaseName(name) {
    var base = String(name == null ? "" : name);
    var slash = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
    if (slash >= 0) base = base.slice(slash + 1);
    return base;
  }

  function isWavExtension(name) {
    return fileBaseName(name).toLowerCase().endsWith(".wav");
  }

  function isMp3Extension(name) {
    return fileBaseName(name).toLowerCase().endsWith(".mp3");
  }

  function audioKindFromName(name) {
    if (isWavExtension(name)) return "wav";
    if (isMp3Extension(name)) return "mp3";
    return null;
  }

  /**
   * Quick name check used by the picker and drag-and-drop.
   * .wav and .mp3 are accepted; the content header is verified before decode.
   */
  function isSupportedAudioFile(file) {
    if (!file || !file.name) return false;
    return audioKindFromName(file.name) !== null;
  }

  function asByteView(buf) {
    if (!buf) return new Uint8Array(0);
    if (buf instanceof Uint8Array) return buf;
    if (typeof Buffer !== "undefined" && Buffer.isBuffer && Buffer.isBuffer(buf)) {
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    if (typeof ArrayBuffer !== "undefined" && buf instanceof ArrayBuffer) {
      return new Uint8Array(buf);
    }
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(buf)) {
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    return new Uint8Array(0);
  }

  function isRiffWaveHeader(buf) {
    var u8 = asByteView(buf);
    if (u8.length < 12) return false;
    return u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 &&
      u8[8] === 0x57 && u8[9] === 0x41 && u8[10] === 0x56 && u8[11] === 0x45;
  }

  /**
   * Require a .wav extension and a RIFF/WAVE header before any decode.
   * Throws a friendly, identical error for other formats.
   */
  function validateWavAudio(name, buf) {
    if (!isWavExtension(name) || !isRiffWaveHeader(buf)) {
      var err = new Error(WAV_ONLY_MESSAGE);
      err.code = "WAV_ONLY";
      throw err;
    }
    return true;
  }

  /**
   * MPEG audio: an ID3v2 tag ("ID3") or an MPEG frame sync (11 set bits) with a
   * valid layer, bitrate index and sample-rate index.
   */
  function isMp3Header(buf) {
    var u8 = asByteView(buf);
    if (u8.length < 4) return false;
    if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) return true; // "ID3"
    var syncOk = u8[0] === 0xFF && (u8[1] & 0xE0) === 0xE0;
    var layer = (u8[1] >> 1) & 0x03;
    var version = (u8[1] >> 3) & 0x03;
    var bitrate = (u8[2] >> 4) & 0x0F;
    var rate = (u8[2] >> 2) & 0x03;
    return syncOk && layer !== 0 && version !== 1 && bitrate !== 0x0F && rate !== 0x03;
  }

  /**
   * Browser loader check: the extension and the content header must agree.
   * Returns "wav" or "mp3"; throws SUPPORTED_AUDIO_MESSAGE otherwise.
   */
  function validateAudio(name, buf) {
    var kind = audioKindFromName(name);
    var ok = (kind === "wav" && isRiffWaveHeader(buf)) || (kind === "mp3" && isMp3Header(buf));
    if (!ok) {
      var err = new Error(SUPPORTED_AUDIO_MESSAGE);
      err.code = "UNSUPPORTED_AUDIO";
      throw err;
    }
    return kind;
  }

  function isSongShapeJSONName(file) {
    if (!file || !file.name) return false;
    var name = String(file.name).toLowerCase();
    return name.endsWith(".json");
  }

  /**
   * Build a polyline for one stroke only. Never include points from another stroke
   * or invent points inside a gap.
   */
  function strokePolyline(stroke) {
    return (stroke.points || []).map(function (p) { return [p[0], p[1]]; });
  }

  var api = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    SCHEMA_VERSION_V01: SCHEMA_VERSION_V01,
    APP_VERSION: APP_VERSION,
    MIN_POINT_SPACING_MS: MIN_POINT_SPACING_MS,
    MAX_TIME_JUMP_MS: MAX_TIME_JUMP_MS,
    MAX_TIME_MS: MAX_TIME_MS,
    MAX_STRING_LEN: MAX_STRING_LEN,
    MAX_NOTES_LEN: MAX_NOTES_LEN,
    MAX_STROKES: MAX_STROKES,
    MAX_GAPS: MAX_GAPS,
    MAX_POINTS: MAX_POINTS,
    MAX_IMPORT_BYTES: MAX_IMPORT_BYTES,
    MAX_LYRICS_CHARS: MAX_LYRICS_CHARS,
    MAX_WORDS: MAX_WORDS,
    MAX_ANCHORS: MAX_ANCHORS,
    Y_MIN: Y_MIN,
    Y_MAX: Y_MAX,
    isFiniteNumber: isFiniteNumber,
    sanitizeLabel: sanitizeLabel,
    WAV_ONLY_MESSAGE: WAV_ONLY_MESSAGE,
    SUPPORTED_AUDIO_MESSAGE: SUPPORTED_AUDIO_MESSAGE,
    isWavExtension: isWavExtension,
    isMp3Extension: isMp3Extension,
    audioKindFromName: audioKindFromName,
    isMp3Header: isMp3Header,
    validateAudio: validateAudio,
    isRiffWaveHeader: isRiffWaveHeader,
    validateWavAudio: validateWavAudio,
    parseSessionText: parseSessionText,
    clamp: clamp,
    createSession: createSession,
    createRecorder: createRecorder,
    nextId: nextId,
    audioTimeMs: audioTimeMs,
    startStroke: startStroke,
    addPoint: addPoint,
    endStroke: endStroke,
    abandonActive: abandonActive,
    recomputeGaps: recomputeGaps,
    undoLastStroke: undoLastStroke,
    deleteStrokeById: deleteStrokeById,
    clearStrokes: clearStrokes,
    resetTrace: resetTrace,
    setStrokeAnnotations: setStrokeAnnotations,
    setGapLabel: setGapLabel,
    setStrokeSection: setStrokeSection,
    setSectionRange: setSectionRange,
    strokeSectionLabel: strokeSectionLabel,
    describeDirection: describeDirection,
    strokeHeights: strokeHeights,
    sessionToJSON: sessionToJSON,
    parseSession: parseSession,
    textSummary: textSummary,
    aiPrompt: aiPrompt,
    AI_PROMPT_ASK: AI_PROMPT_ASK,
    AI_PROMPT_INTRO: AI_PROMPT_INTRO,
    isSupportedAudioFile: isSupportedAudioFile,
    isSongShapeJSONName: isSongShapeJSONName,
    strokePolyline: strokePolyline
  };

  root.SongShape = root.SongShape || {};
  Object.keys(api).forEach(function (k) { root.SongShape[k] = api[k]; });
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
