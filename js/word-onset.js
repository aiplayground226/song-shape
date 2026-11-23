/**
 * Song Shape v0.2.11 — vowel-onset word starts (Ben's listening rule).
 * The first sound of a word (often a consonant) is the trigger; the word's start
 * is placed on its first vowel sound, or on the 2nd vowel when the first vowel
 * sound is a double vowel ("dreams" -> the "a" of "ea", "our" -> "u").
 * Spelling is only a stand-in for phonemes (English is irregular): treat the
 * text rule as a heuristic and check by ear. No network. No packages.
 */
(function (root) {
  "use strict";
  var SS = root.SongShape || {};
  var VOWELS = "aeiou";
  function isNum(v) { return typeof v === "number" && Number.isFinite(v); }
  function letters(word) { return String(word || "").toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z]/g, ""); }

  /** Index (into letters(word)) of the letter that marks the vowel target. */
  function vowelTarget(word, opts) {
    opts = opts || {};
    var w = letters(word);
    if (!w) return { index: 0, letters: w, rule: "no_letters" };
    var i, first = -1;
    for (i = 0; i < w.length; i += 1) {
      var c = w[i];
      // y counts as a vowel when it is not the first letter ("my", "fly"), never in "yet"/"you".
      if (VOWELS.indexOf(c) >= 0 || (c === "y" && i > 0)) { first = i; break; }
    }
    if (first < 0) return { index: 0, letters: w, rule: "no_vowel_letter" };
    var next = w[first + 1];
    var isDouble = next && (VOWELS.indexOf(next) >= 0 || (next === "y" && first + 1 === w.length - 1));
    if (isDouble && opts.secondOfDouble !== false) return { index: first + 1, letters: w, rule: "second_vowel_of_double" };
    return { index: first, letters: w, rule: "first_vowel" };
  }

  /**
   * Aligner output with letter (or phone) spans -> vowel-target times.
   * word.chars: [{c, start, end}] in seconds (CTC letter spans), letters in the word's order.
   * word.phones (optional, preferred): [{p, start, end, vowel:true|false}].
   */
  function vowelTimeFromAligned(word, opts) {
    var startS = isNum(word.start) ? word.start : (isNum(word.start_ms) ? word.start_ms / 1000 : null);
    if (Array.isArray(word.phones) && word.phones.length) {
      var vs = word.phones.filter(function (p) { return p && p.vowel && isNum(p.start); });
      if (vs.length) return { signal_s: startS, vowel_s: vs[0].start, rule: "first_vowel_phone" };
    }
    if (!Array.isArray(word.chars) || !word.chars.length) return { signal_s: startS, vowel_s: startS, rule: "no_letter_spans" };
    var t = vowelTarget(word.text == null ? word.word : word.text, opts);
    var cs = word.chars.filter(function (c) { return c && isNum(c.start); });
    var k = Math.min(t.index, cs.length - 1);
    return { signal_s: startS != null ? startS : cs[0].start, vowel_s: cs[k].start, rule: t.rule };
  }

  /**
   * CPU fallback, no aligner: given a detected onset (the signal), walk forward until the
   * level reaches `riseRatio` of the loudest frame in the next `lookMs`, while voiced.
   * Vowels carry most of a sung syllable's energy; this is a heuristic, not phoneme detection.
   */
  function vowelOnsetFromAudio(samples, sampleRate, signalMs, opts) {
    opts = opts || {};
    var lookMs = opts.lookMs == null ? 280 : opts.lookMs;
    var hopMs = opts.hopMs == null ? 5 : opts.hopMs;
    var winMs = opts.winMs == null ? 20 : opts.winMs;
    var riseRatio = opts.riseRatio == null ? 0.6 : opts.riseRatio;
    var win = Math.round(sampleRate * winMs / 1000), hop = Math.max(1, Math.round(sampleRate * hopMs / 1000));
    var a = Math.max(0, Math.round(sampleRate * signalMs / 1000)), b = Math.min(samples.length - win, a + Math.round(sampleRate * lookMs / 1000));
    var levels = [], i, j;
    for (i = a; i <= b; i += hop) {
      var sum = 0;
      for (j = i; j < i + win; j += 1) sum += samples[j] * samples[j];
      levels.push(Math.sqrt(sum / win));
    }
    if (!levels.length) return signalMs;
    var peak = Math.max.apply(null, levels);
    if (!(peak > 0)) return signalMs;
    for (i = 0; i < levels.length; i += 1) if (levels[i] >= peak * riseRatio) return Math.round(signalMs + i * hopMs + winMs / 2);
    return signalMs;
  }

  /** Move word-start proposals to the vowel target; the original start is kept as signal_ms. */
  function applyVowelTargets(proposals, samples, sampleRate, opts) {
    return (proposals || []).map(function (p) {
      var signal = p.signal_ms != null ? p.signal_ms : p.start_ms;
      var v = samples ? vowelOnsetFromAudio(samples, sampleRate, signal, opts) : signal;
      return Object.assign({}, p, { signal_ms: signal, start_ms: v, end_ms: Math.max(v, p.end_ms || v), anchor_rule: "vowel_target_cpu_energy" });
    });
  }


  /**
   * v0.2.11 fix3: a line starts on a vocal onset after a pause. CTC letters are spiky and blanks are free, so a
   * line's first word can land in the fading tail of the previous held note, or in a quiet stretch (common in
   * live recordings). Quiet stretches are gaps: when a clear onset (>=150 ms quiet, then a rise) sits near the
   * line start but the start is not on one, move the line's first word there. Later words keep their order.
   * rows: [{start_ms, end_ms, in_silence}], lineIds: line id per row. Mutates rows; returns the moves.
   */
  function snapLineStarts(rows, lineIds, samples, sampleRate, opts) {
    opts = opts || {};
    var quiet = opts.quiet == null ? 0.15 : opts.quiet, quietMs = opts.quietMs == null ? 150 : opts.quietMs, loud = opts.loud == null ? 0.4 : opts.loud;
    var keepMs = opts.keepMs == null ? 150 : opts.keepMs, afterMs = opts.afterMs == null ? 300 : opts.afterMs, beforeMs = opts.beforeMs == null ? 250 : opts.beforeMs;
    if (!samples || !(sampleRate > 0) || !rows || rows.length < 2) return [];
    var hop = Math.max(1, Math.round(sampleRate * 0.02)), n = Math.floor(samples.length / hop), e = new Float32Array(n), i, j, k;
    for (i = 0; i < n; i += 1) { var sum = 0; for (j = i * hop; j < (i + 1) * hop; j += 1) sum += samples[j] * samples[j]; e[i] = Math.sqrt(sum / hop); }
    var sorted = Array.prototype.slice.call(e).sort(function (a, b) { return a - b; }), p95 = sorted[Math.floor(0.95 * (n - 1))] || 0;
    if (!(p95 > 0)) return [];
    var onsets = [], run = 0, need = Math.round(quietMs / 20);
    for (i = 0; i < n; i += 1) {
      if (e[i] / p95 < quiet) { run += 1; continue; }
      if (run >= need) { var m = 0; for (k = i; k < Math.min(n, i + 8); k += 1) m = Math.max(m, e[k] / p95); if (m >= loud) onsets.push(i * 20); }
      run = 0;
    }
    var moved = [];
    for (i = 1; i < rows.length; i += 1) {
      if (lineIds[i] === lineIds[i - 1] || rows[i].in_silence || (opts.skip && opts.skip[i])) continue;
      var s = rows[i].start_ms, nx = i + 1 < rows.length && lineIds[i + 1] === lineIds[i] ? rows[i + 1].start_ms : s + 2000;
      if (onsets.some(function (t) { return Math.abs(t - s) <= keepMs; })) continue;
      var lo = rows[i - 1].start_ms + beforeMs, hi = Math.max(nx, s) + afterMs;
      var cand = onsets.filter(function (t) { return t > lo && t <= hi; });
      if (!cand.length) continue;
      var t = cand.reduce(function (a, b) { return Math.abs(b - s) < Math.abs(a - s) ? b : a; });
      rows[i].start_ms = t; rows[i].end_ms = Math.max(t, rows[i].end_ms + Math.max(0, t - s)); rows[i].chars = undefined; rows[i].phones = undefined; rows[i].line_onset = true;
      moved.push({ index: i, from_ms: s, to_ms: t });
      var prev = t;
      for (k = i + 1; k < rows.length && lineIds[k] === lineIds[i]; k += 1) {
        if (rows[k].start_ms < prev + 60) { rows[k].start_ms = prev + 60; rows[k].end_ms = Math.max(rows[k].end_ms, rows[k].start_ms); rows[k].chars = undefined; rows[k].phones = undefined; }
        prev = rows[k].start_ms;
      }
    }
    return moved;
  }


  /** v0.2.11 fix4: 20 ms RMS envelope normalised to the song's 95th percentile (1.0 = loud singing). */
  function levelEnvelope(samples, sampleRate) {
    var hop = Math.max(1, Math.round(sampleRate * 0.02)), n = Math.floor(samples.length / hop), e = new Float32Array(n), i, j;
    for (i = 0; i < n; i += 1) { var sum = 0; for (j = i * hop; j < (i + 1) * hop; j += 1) sum += samples[j] * samples[j]; e[i] = Math.sqrt(sum / hop); }
    var sorted = Array.prototype.slice.call(e).sort(function (a, b) { return a - b; }), p95 = sorted[Math.floor(0.95 * (n - 1))] || 0;
    if (p95 > 0) for (i = 0; i < n; i += 1) e[i] /= p95;
    return { level: e, frameMs: 20 };
  }
  /** End of the sustained sound that starts at startMs: the first 100 ms below the quiet level, capped at limitMs. */
  function sustainEndMs(env, startMs, limitMs, opts) {
    opts = opts || {};
    var quiet = opts.quiet == null ? 0.15 : opts.quiet, f = env.frameMs, i = Math.max(0, Math.floor(startMs / f)), last = Math.min(env.level.length, Math.floor(limitMs / f)), run = 0;
    for (; i < last; i += 1) { if (env.level[i] < quiet) { run += 1; if (run >= 5) return (i - run + 1) * f; } else run = 0; }
    return last * f;
  }

  var api = { vowelTarget: vowelTarget, vowelTimeFromAligned: vowelTimeFromAligned, vowelOnsetFromAudio: vowelOnsetFromAudio, applyVowelTargets: applyVowelTargets, snapLineStarts: snapLineStarts, levelEnvelope: levelEnvelope, sustainEndMs: sustainEndMs };
  if (typeof module !== "undefined" && module.exports) module.exports = Object.assign(SS, api);
  root.SongShape = Object.assign(SS, api);
})(typeof globalThis !== "undefined" ? globalThis : this);
