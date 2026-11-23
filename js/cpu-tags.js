/* Song Shape v0.2.9: CPU delivery-tag vocabulary.
   Tags are derived deterministically from each line's measured/trace contour features, so
   identical or near-identical contours get identical tags, and tags only change where the
   contour changes. There is no variety or anti-repetition logic on purpose: a repeated chorus
   sung the same way gets the same tags. No network, no dependencies. */
(function (root) {
  "use strict";
  var r2 = function (v) { return Math.round(v * 100) / 100; };
  var finite = Number.isFinite;
  var STEP_MS = 50;
  var RESTRAINED_MARGIN = 0.04; // octaves below the baseline the line peak must stay for "restrained"
  var MAX_CUES = 8; // the stage-4 checker allows at most 8 cues per [Delivery: ...] tag

  /** The vocabulary, by dimension, in the order cues are written. Shared with SONG_SHAPE_AI_CONTEXT.md. */
  var VOCABULARY = {
    direction: { rising: "rising line", falling: "falling line", arch: "rise then fall", valley: "dip then recover",
      wave: "up-and-down line", level: "level line" },
    register: { high: "high register", upper: "upper-mid register", mid: "mid register", lower: "lower-mid register", low: "low register" },
    dynamics: { powerful: "powerful", building: "building intensity", steady: "steady intensity", restrained: "restrained", soft: "soft" },
    sustain: { long: "long sustained note", held: "held note" },
    emphasis: { peak: "peak on" },
    contour_detail: { dip: "dip below baseline", climb: "climb to the peak" },
    ending: { dive: "dive at the end", fall_away: "falls away at the end", lifted: "lifted ending", settle: "settles to baseline" },
    breaks: { breath: "breath", phrase_break: "phrase break mid-line" },
    rhythm: { rapid: "rapid phrasing", spacious: "slow, spacious phrasing", staccato: "short detached notes" }
  };

  // Calibrated on three real songs (full mix, separated vocals, an isolated vocal stem), v0.2.9.
  var MERGE_GAP_MS = 300, BREAK_GAP_MS = 450, SHORT_UNIT_MS = 300;

  function resample(segments) {
    var series = [];
    segments.forEach(function (s, si) {
      var pts = (s.points || []).filter(function (p) { return finite(p[0]) && finite(p[1]); }).slice().sort(function (a, b) { return a[0] - b[0]; });
      if (pts.length < 2) { if (pts.length === 1) series.push({ t: pts[0][0], y: pts[0][1], seg: si }); return; }
      var j = 0;
      for (var t = pts[0][0]; t <= pts[pts.length - 1][0]; t += STEP_MS) {
        while (j < pts.length - 2 && pts[j + 1][0] < t) j++;
        var a = pts[j], b = pts[j + 1];
        var y = b[0] === a[0] ? b[1] : a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
        series.push({ t: t, y: Math.max(-1, Math.min(1, y)), seg: si });
      }
    });
    return series;
  }

  /**
   * Contour features of one line. segments: [{start_ms,end_ms,points:[[t,y]]}] (y relative to baseline),
   * opts: {start_ms, end_ms, word_count, gaps:[{label}]}. Returns null without usable points.
   */
  function lineFeatures(segments, opts) {
    opts = opts || {};
    var segs = (segments || []).filter(function (s) { return s && s.points && s.points.length; })
      .slice().sort(function (a, b) { return a.start_ms - b.start_ms; });
    var s = resample(segs);
    if (!s.length) return null;
    var t0 = s[0].t, t1 = s[s.length - 1].t;
    var start = finite(opts.start_ms) ? Math.min(opts.start_ms, t0) : t0;
    var end = finite(opts.end_ms) ? Math.max(opts.end_ms, t1) : t1;
    var dur = Math.max(1, end - start), span = Math.max(1, t1 - t0);
    var ys = s.map(function (p) { return p.y; });
    var mean = ys.reduce(function (a, b) { return a + b; }, 0) / ys.length;
    var maxI = 0, minI = 0;
    ys.forEach(function (y, i) { if (y > ys[maxI]) maxI = i; if (y < ys[minI]) minI = i; });
    // Peak/low time = centre of the samples within 0.05 of the extreme (stable on plateaus).
    var centre = function (test) {
      var ts = s.filter(function (p) { return test(p.y); }).map(function (p) { return p.t; });
      return ts.reduce(function (a, b) { return a + b; }, 0) / ts.length;
    };
    var peakT = centre(function (y) { return y >= ys[maxI] - 0.05; });
    var lowT = centre(function (y) { return y <= ys[minI] + 0.05; });
    // Sung units: pitch-tracker fragments closer than MERGE_GAP_MS are one sung unit. Real
    // tracking splits a phrase at consonants and brief dropouts (median fragment ~30-90 ms on
    // real vocals), which must not count as breaks or detached notes.
    var units = [], unitOf = [];
    segs.forEach(function (g, gi) {
      var u = units[units.length - 1];
      if (u && g.start_ms - u.end_ms < MERGE_GAP_MS) { u.end_ms = Math.max(u.end_ms, g.end_ms); u.voiced += Math.max(0, g.end_ms - g.start_ms); }
      else { u = { start_ms: g.start_ms, end_ms: g.end_ms, voiced: Math.max(0, g.end_ms - g.start_ms) }; units.push(u); }
      unitOf[gi] = units.length - 1;
    });
    // Longest hold: run where y stays within 0.08 of the run's first value.
    var hold = 0, holdAt = 0, runStart = 0;
    for (var i = 1; i <= s.length; i++) {
      var broken = i === s.length || unitOf[s[i].seg] !== unitOf[s[runStart].seg] || Math.abs(s[i].y - s[runStart].y) > 0.08;
      if (broken) {
        var len = s[i - 1].t - s[runStart].t;
        if (len > hold) { hold = len; holdAt = (s[runStart].t + s[i - 1].t) / 2; }
        runStart = i;
      }
    }
    // Direction changes with 0.15 hysteresis.
    var turns = 0, dir = 0, ext = ys[0];
    ys.forEach(function (y) {
      if (dir === 0) { if (y > ext + 0.15) { dir = 1; ext = y; } else if (y < ext - 0.15) { dir = -1; ext = y; } }
      else if (dir === 1) { if (y > ext) ext = y; else if (y < ext - 0.15) { turns++; dir = -1; ext = y; } }
      else { if (y < ext) ext = y; else if (y > ext + 0.15) { turns++; dir = 1; ext = y; } }
    });
    var breaks = 0;
    // A break counts only inside the line (15-85 % of the sung span); a long gap right after the
    // first or before the last fragment is usually a word-timing estimate, not a sung rest.
    var uSpan = Math.max(1, units[units.length - 1].end_ms - units[0].start_ms);
    for (var k = 1; k < units.length; k++) {
      var gapMid = ((units[k].start_ms + units[k - 1].end_ms) / 2 - units[0].start_ms) / uSpan;
      if (units[k].start_ms - units[k - 1].end_ms >= BREAK_GAP_MS && gapMid >= 0.15 && gapMid <= 0.85) breaks++;
    }
    // Sung time = merged units (tracker dropouts inside a unit still count as singing).
    var voicedMs = units.reduce(function (a, u) { return a + Math.max(0, u.end_ms - u.start_ms); }, 0);
    var shortSegs = units.filter(function (u) { return u.end_ms - u.start_ms < SHORT_UNIT_MS; }).length;
    return {
      mean: r2(mean), start: r2(ys[0]), end: r2(ys[ys.length - 1]), max: r2(ys[maxI]), min: r2(ys[minI]),
      range: r2(ys[maxI] - ys[minI]),
      peak_pos: r2((peakT - t0) / span), min_pos: r2((lowT - t0) / span),
      peak_ms: Math.round(peakT), hold_ms: Math.round(hold), hold_at_ms: Math.round(holdAt),
      turns: turns, breaks: breaks, segments: units.length, short_segments: shortSegs, raw_segments: segs.length,
      voiced_ratio: r2(Math.min(1, voicedMs / dur)), duration_ms: Math.round(dur),
      // Rhythm uses voiced time, so trailing silence before the next line does not change it.
      voiced_ms: Math.round(voicedMs),
      words_per_s: opts.word_count && voicedMs > 0 ? r2(opts.word_count / (voicedMs / 1000)) : null,
      labeled_breath: (opts.gaps || []).some(function (g) { return /breath/i.test(String(g && (g.label || g.description) || "")); })
    };
  }

  function classify(f) {
    var c = {};
    var mid = function (p) { return p > 0.2 && p < 0.8; };
    if (f.range < 0.2) c.direction = "level";
    else if (f.turns >= 3) c.direction = "wave";
    else if (mid(f.peak_pos) && f.max - f.start >= 0.25 && f.max - f.end >= 0.25) c.direction = "arch";
    else if (mid(f.min_pos) && f.start - f.min >= 0.25 && f.end - f.min >= 0.25) c.direction = "valley";
    else if (f.end - f.start >= 0.25) c.direction = "rising";
    else if (f.start - f.end >= 0.25) c.direction = "falling";
    else c.direction = "level";
    // v0.2.11 fix6f: with a measured vocal range, register is the line's place in that range (fifths).
    if (typeof f.register_pos === "number" && isFinite(f.register_pos)) c.register = f.register_pos >= 0.6 ? "high" : f.register_pos >= 0.2 ? "upper" : f.register_pos > -0.2 ? "mid" : f.register_pos > -0.6 ? "lower" : "low";
    else c.register = f.mean >= 0.45 ? "high" : f.mean >= 0.15 ? "upper" : f.mean > -0.15 ? "mid" : f.mean > -0.45 ? "lower" : "low";
    if (f.max >= 0.75) c.dynamics = "powerful";
    else if (c.direction === "rising" && f.end >= 0.35) c.dynamics = "building";
    else if (f.mean <= -0.4) c.dynamics = "soft";
    // v0.2.11 fix7: a small margin so lines that just touch the baseline do not flip between restrained and steady.
    else if (f.max <= -RESTRAINED_MARGIN) c.dynamics = "restrained";
    else c.dynamics = "steady";
    if (f.hold_ms >= 1500) c.sustain = "long"; else if (f.hold_ms >= 700) c.sustain = "held";
    if (f.max >= 0.5 && f.max - f.mean >= 0.3) c.emphasis = "peak";
    if (c.direction !== "valley" && f.min <= -0.3 && f.min < f.start - 0.2 && f.min_pos > 0.15 && f.min_pos < 0.85) c.contour_detail = "dip";
    else if (c.direction === "rising" && f.peak_pos >= 0.85 && f.max - f.start >= 0.5) c.contour_detail = "climb";
    if (f.end <= f.min + 0.05 && (f.end <= -0.7 || (f.end <= -0.5 && c.direction !== "falling"))) c.ending = "dive";
    else if (f.max - f.end >= 0.5 && c.direction !== "falling" && c.direction !== "arch") c.ending = "fall_away";
    else if (f.end >= 0.5 && f.end >= f.max - 0.05 && c.direction !== "rising") c.ending = "lifted";
    else if (Math.abs(f.end) <= 0.1 && Math.abs(f.start) > 0.3 && f.range >= 0.3) c.ending = "settle";
    if (f.labeled_breath) c.breaks = "breath"; else if (f.breaks >= 1) c.breaks = "phrase_break";
    if (f.segments >= 3 && f.short_segments >= Math.ceil(f.segments * 0.6)) c.rhythm = "staccato";
    else if (f.words_per_s != null && f.words_per_s >= 3.5) c.rhythm = "rapid";
    else if (f.words_per_s != null && f.words_per_s <= 1.2 && f.voiced_ms >= 2500) c.rhythm = "spacious";
    return c;
  }

  /** Word at a relative position (0..1) of the line, from the projected target words. */
  function wordAt(words, rel) {
    if (!words || !words.length || !finite(rel)) return null;
    var w = words.find(function (x, i) { return rel >= x.relative_start && (rel < x.relative_end || i === words.length - 1); });
    return w ? String(w.word).replace(/["\\\[\]]/g, "") : null;
  }

  // v0.2.11: a peak or held note is named on a content word, not "a"/"the"/"my" (the next content word, else the previous one).
  var FUNCTION_WORDS = ["a","an","the","of","to","in","on","at","and","or","but","is","my","your","our","for","with","as","by","it"];
  function contentWordAt(words, rel) {
    var w = wordAt(words, rel);
    if (!w || FUNCTION_WORDS.indexOf(w.toLowerCase().replace(/[^a-z']/g, "")) < 0) return w;
    var i = words.findIndex(function (x, k) { return rel >= x.relative_start && (rel < x.relative_end || k === words.length - 1); });
    var clean = function (x) { return String(x.word).replace(/["\\\[\]]/g, ""); };
    var isContent = function (x) { return FUNCTION_WORDS.indexOf(clean(x).toLowerCase().replace(/[^a-z']/g, "")) < 0; };
    for (var k = i + 1; k < words.length; k++) if (isContent(words[k])) return clean(words[k]);
    for (k = i - 1; k >= 0; k--) if (isContent(words[k])) return clean(words[k]);
    return w;
  }

  /**
   * CPU delivery cues for one line. features from lineFeatures; words = projected target words
   * [{word, relative_start, relative_end}] used only to anchor "peak on" / "held note on".
   * Same features (and same words) -> same cues, always.
   */
  function cpuLineCues(features, words) {
    if (!features) return [];
    var c = classify(features);
    var V = VOCABULARY, cues = [];
    cues.push(V.direction[c.direction]);
    cues.push(V.register[c.register]);
    cues.push(V.dynamics[c.dynamics]);
    if (c.sustain) {
      var hw = contentWordAt(words, features.hold_rel != null ? features.hold_rel : null);
      cues.push(V.sustain[c.sustain] + (hw ? ' on "' + hw + '"' : ""));
    }
    if (c.emphasis) {
      var pw = contentWordAt(words, features.peak_rel != null ? features.peak_rel : features.peak_pos);
      if (pw) cues.push(V.emphasis.peak + ' "' + pw + '"');
    }
    if (c.contour_detail) cues.push(V.contour_detail[c.contour_detail]);
    if (c.ending) cues.push(V.ending[c.ending]);
    if (c.breaks) cues.push(V.breaks[c.breaks]);
    if (c.rhythm) cues.push(V.rhythm[c.rhythm]);
    return cues.filter(function (x, i, a) { return x && a.indexOf(x) === i; }).slice(0, MAX_CUES);
  }

  var KEYS = ["mean", "start", "end", "max", "min", "range", "peak_pos"];
  // v0.2.10: repeat tolerance 0.7 (was 0.15). Calibrated on 8 real songs (7 + Honor clip, RoFormer rip +
  // forced alignment): 0.15 matched 0 of 66 repeated-line pairs. 0.7 is the largest value that matched no
  // differently-sung pair (syllable pitch r < 0.5). The next differently-sung pair sits at 0.80, and many sit at 1.0
  // (one extra phrase break). Same-sung pairs (r >= 0.9) start at 0.59.
  var REPEAT_TOLERANCE = 0.7;
  /** Distance between two feature sets (0 = identical). Holds/breaks count too. */
  function featureDistance(a, b) {
    if (!a || !b) return Infinity;
    var d = 0;
    KEYS.forEach(function (k) { d = Math.max(d, Math.abs((a[k] || 0) - (b[k] || 0))); });
    d = Math.max(d, Math.abs((a.hold_ms || 0) - (b.hold_ms || 0)) / 2000, Math.abs((a.breaks || 0) - (b.breaks || 0)), Math.abs((a.turns || 0) - (b.turns || 0)) / 3);
    return r2(d);
  }

  /**
   * Keep repeated lines consistent: a line whose text matches an earlier line and whose contour
   * is within `tolerance` reuses the earlier line's cues. rows: [{text, features, cues}] (mutated:
   * adds repeat_of). Lines with a different contour keep their own cues.
   */
  function applyRepeatConsistency(rows, tolerance) {
    var tol = tolerance == null ? REPEAT_TOLERANCE : tolerance;
    var norm = function (s) { return String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); };
    rows.forEach(function (row, i) {
      row.repeat_of = null;
      for (var j = 0; j < i; j++) {
        var prev = rows[j];
        if (prev.repeat_of != null) continue;
        if (norm(prev.text) && norm(prev.text) === norm(row.text) && featureDistance(prev.features, row.features) <= tol) {
          row.cues = prev.cues.slice(); row.repeat_of = j; return;
        }
      }
    });
    return rows;
  }

  var api = {
    CPU_TAG_VOCABULARY: VOCABULARY,
    CPU_TAG_MAX_CUES: MAX_CUES,
    CPU_TAG_REPEAT_TOLERANCE: REPEAT_TOLERANCE,
    CPU_TAG_RESTRAINED_MARGIN: RESTRAINED_MARGIN,
    lineFeatures: lineFeatures,
    classifyLineFeatures: classify,
    cpuLineCues: cpuLineCues,
    featureDistance: featureDistance,
    applyRepeatConsistency: applyRepeatConsistency
  };
  root.SongShape = Object.assign(root.SongShape || {}, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
