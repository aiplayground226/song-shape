/**
 * Song Shape v0.2.11 — measured-pitch cleanup for the CPU contour.
 * Deterministic signal post-processing of YIN frames, not perception:
 *  - adaptive silence gate (quiet vocal stems were gated out by the fixed 0.02 RMS floor)
 *  - octave-jump folding against a local median (classic YIN half/double errors)
 *  - short spike removal (breaths, consonant noise, bleed)
 *  - short-gap bridging between frames of similar pitch (joins dots into strokes)
 *  - isolated-dot removal (runs too short to be a sung note)
 * Every change is counted and the frames keep a `cleaned` tag so measured and
 * repaired values stay distinguishable. No network. No packages.
 */
(function (root) {
  "use strict";
  var SS = root.SongShape || {};
  var CLEAN_DEFAULTS = {
    medianRadius: 7,       // frames each side for the local reference pitch
    octaveTolerance: 2.5,  // semitones around ±12 treated as an octave error
    spikeSemitones: 5,     // deviation from the local median that counts as a spike
    maxSpikeFrames: 3,     // longer deviations are kept (a real leap)
    maxFillMs: 160,        // bridge unvoiced holes up to this long
    maxFillJump: 4,        // ...only when the pitch on both sides is within this many semitones
    minRunMs: 90,          // drop isolated voiced runs shorter than this
    runFoldWithin: 0       // fold a whole run by an octave only if that lands within this many semitones of the song median
  };
  function isNum(v) { return typeof v === "number" && Number.isFinite(v); }
  function semis(hz) { return 12 * Math.log(hz / 440) / Math.LN2 + 69; }
  function hzOf(s) { return 440 * Math.pow(2, (s - 69) / 12); }
  function med(a) { if (!a.length) return NaN; var s = a.slice().sort(function (x, y) { return x - y; }); var m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  function hopOf(frames) { return frames.length > 1 ? Math.max(1, frames[1].t_ms - frames[0].t_ms) : 30; }

  /** Silence gate that follows the recording level: 8% of the 95th-percentile block RMS, within 0.002–0.02. */
  function adaptiveSilenceRms(samples, sampleRate, opts) {
    opts = opts || {};
    var block = Math.max(64, Math.round(sampleRate * 0.04));
    var vals = [];
    for (var i = 0; i + block <= samples.length; i += block) {
      var sum = 0;
      for (var j = i; j < i + block; j += 1) sum += samples[j] * samples[j];
      vals.push(Math.sqrt(sum / block));
    }
    if (!vals.length) return 0.02;
    vals.sort(function (a, b) { return a - b; });
    var p95 = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.95))];
    var ratio = opts.ratio == null ? 0.08 : opts.ratio;
    return Math.max(opts.floor == null ? 0.002 : opts.floor, Math.min(opts.ceiling == null ? 0.02 : opts.ceiling, p95 * ratio));
  }

  function cleanPitchFrames(frames, opts) {
    opts = Object.assign({}, CLEAN_DEFAULTS, opts || {});
    var out = (frames || []).map(function (f) { return Object.assign({}, f); });
    var stats = { run_octave_folded: 0, octave_folded: 0, spikes_removed: 0, frames_bridged: 0, dots_removed: 0 };
    if (!out.length) return { frames: out, stats: stats };
    var hop = hopOf(out);
    var n = out.length, i, j;
    var s = out.map(function (f) { return f.voiced && f.f0 > 0 ? semis(f.f0) : NaN; });
    function localMedian(k) {
      var win = [];
      for (var q = k - opts.medianRadius; q <= k + opts.medianRadius; q += 1) if (q >= 0 && q < n && q !== k && isNum(s[q])) win.push(s[q]);
      return win.length >= 3 ? med(win) : NaN;
    }
    // 0) whole-run octave errors: a voiced run sitting about an octave from the song's median pitch
    var all = s.filter(isNum), gmed = med(all);
    for (i = 0; i < n && opts.runFoldWithin > 0 && isNum(gmed); i += 1) {
      if (!isNum(s[i])) continue;
      j = i;
      while (j + 1 < n && isNum(s[j + 1])) j += 1;
      var run = s.slice(i, j + 1), rm = med(run), dd = rm - gmed;
      if (Math.abs(dd) > 12 - opts.octaveTolerance && Math.abs(dd - 12 * (dd > 0 ? 1 : -1)) <= opts.runFoldWithin) {
        for (var q2 = i; q2 <= j; q2 += 1) { s[q2] -= 12 * (dd > 0 ? 1 : -1); out[q2].cleaned = "run_octave_folded"; }
        stats.run_octave_folded += 1;
      }
      i = j;
    }
    // 1) octave folding
    for (i = 0; i < n; i += 1) {
      if (!isNum(s[i])) continue;
      var m = localMedian(i);
      if (!isNum(m)) continue;
      var d = s[i] - m;
      if (Math.abs(Math.abs(d) - 12) <= opts.octaveTolerance) { s[i] -= 12 * (d > 0 ? 1 : -1); stats.octave_folded += 1; out[i].cleaned = "octave_folded"; }
    }
    // 2) spikes: short runs far from the local median (computed after folding)
    var ref = s.map(function (_, k) { return isNum(s[k]) ? localMedian(k) : NaN; });
    for (i = 0; i < n; i += 1) {
      if (!isNum(s[i]) || !isNum(ref[i]) || Math.abs(s[i] - ref[i]) <= opts.spikeSemitones) continue;
      j = i;
      while (j + 1 < n && isNum(s[j + 1]) && isNum(ref[j + 1]) && Math.abs(s[j + 1] - ref[j + 1]) > opts.spikeSemitones) j += 1;
      if (j - i + 1 <= opts.maxSpikeFrames) {
        for (var k = i; k <= j; k += 1) { s[k] = NaN; out[k].cleaned = "spike_removed"; stats.spikes_removed += 1; }
      }
      i = j;
    }
    // 3) bridge short holes between similar pitches
    var maxFill = Math.floor(opts.maxFillMs / hop);
    for (i = 1; i < n; i += 1) {
      if (isNum(s[i]) || !isNum(s[i - 1])) continue;
      j = i;
      while (j < n && !isNum(s[j])) j += 1;
      if (j < n && j - i <= maxFill && Math.abs(s[j] - s[i - 1]) <= opts.maxFillJump) {
        for (var b = i; b < j; b += 1) {
          var r = (b - i + 1) / (j - i + 1);
          s[b] = s[i - 1] + (s[j] - s[i - 1]) * r;
          out[b].cleaned = "bridged"; stats.frames_bridged += 1;
        }
      }
      i = j;
    }
    // 4) isolated dots
    var minRun = Math.max(1, Math.ceil(opts.minRunMs / hop));
    for (i = 0; i < n; i += 1) {
      if (!isNum(s[i])) continue;
      j = i;
      while (j + 1 < n && isNum(s[j + 1])) j += 1;
      if (j - i + 1 < minRun) for (var z = i; z <= j; z += 1) { s[z] = NaN; out[z].cleaned = "dot_removed"; stats.dots_removed += 1; }
      i = j;
    }
    for (i = 0; i < n; i += 1) {
      if (isNum(s[i])) { out[i].f0 = hzOf(s[i]); out[i].voiced = true; }
      else { out[i].f0 = 0; out[i].voiced = false; }
    }
    return { frames: out, stats: stats };
  }

  var api = { CLEAN_DEFAULTS: CLEAN_DEFAULTS, adaptiveSilenceRms: adaptiveSilenceRms, cleanPitchFrames: cleanPitchFrames };
  if (typeof module !== "undefined" && module.exports) module.exports = Object.assign(SS, api);
  root.SongShape = Object.assign(SS, api);
})(typeof globalThis !== "undefined" ? globalThis : this);
