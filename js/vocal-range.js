/* Song Shape v0.2.11 fix6f — the lead singer's measured range and the Singer baseline.
   Once the vocal stem is measured, the singer's lowest and highest notes are robust percentiles
   (default 2nd / 98th) of confident voiced lead-vocal frames: octave errors and spikes cleaned,
   quiet frames, isolated blips and unstable pitch dropped, detected harmony regions excluded, and
   outlier clusters cut off from the main body of the voice by an empty pitch gap left out.
   The Singer baseline (the middle line) is the midpoint of that range in semitones (log pitch),
   and register labels (low / lower-mid / mid / upper-mid / high) are fifths of the range.
   CPU only, no network. */
(function (root) {
'use strict';
const SS = root.SongShape || (root.SongShape = {});
if (typeof module !== 'undefined' && module.exports && !SS.cleanPitchFrames) Object.assign(SS, require('./contour-clean.js'));
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const num = v => typeof v === 'number' && Number.isFinite(v);
const midiOf = hz => 69 + 12 * Math.log2(hz / 440);
const hzOf = m => 440 * Math.pow(2, (m - 69) / 12);
function noteName(hz) {
  if (!num(hz) || hz <= 0) return null;
  const m = Math.round(midiOf(hz));
  return NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}
function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p / 100, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
function inRegions(t, regions) {
  for (const r of regions || []) if (r && t >= r.start_ms && t <= r.end_ms) return true;
  return false;
}
/**
 * frames: [{t_ms, f0, rms, voiced}] from the pitch tracker (vocal stem when open).
 * opts: {harmonyRegions, pLow: 2, pHigh: 98, minRunFrames: 4, maxJumpSemis: 1.5, loudShare: 0.2,
 *        minHz: 60, maxHz: 1400, cleanup: true}
 * Returns null when fewer than 40 confident frames remain.
 */
function measureVocalRange(frames, opts) {
  opts = opts || {};
  const pLow = num(opts.pLow) ? opts.pLow : 2, pHigh = num(opts.pHigh) ? opts.pHigh : 98;
  const minRun = opts.minRunFrames || 4, maxJump = opts.maxJumpSemis || 1.5, loudShare = num(opts.loudShare) ? opts.loudShare : 0.2;
  const minHz = opts.minHz || 60, maxHz = opts.maxHz || 1400;
  let fr = frames || [];
  if (opts.cleanup !== false && SS.cleanPitchFrames) fr = SS.cleanPitchFrames(fr).frames;
  const voiced = fr.filter(f => f && f.voiced && num(f.f0) && f.f0 >= minHz && f.f0 <= maxHz);
  if (!voiced.length) return null;
  const rmsSorted = voiced.map(f => f.rms || 0).sort((a, b) => a - b);
  const loud = loudShare * percentile(rmsSorted, 90);
  // confident = inside a voiced run of at least minRun frames whose pitch moves smoothly
  const ok = new Array(fr.length).fill(false);
  let i = 0;
  const good = f => f && f.voiced && num(f.f0) && f.f0 >= minHz && f.f0 <= maxHz;
  while (i < fr.length) {
    if (!good(fr[i])) { i++; continue; }
    let j = i;
    while (j + 1 < fr.length && good(fr[j + 1]) && Math.abs(12 * Math.log2(fr[j + 1].f0 / fr[j].f0)) <= maxJump) j++;
    if (j - i + 1 >= minRun) for (let k = i; k <= j; k++) ok[k] = true;
    i = j + 1;
  }
  let harmonyExcluded = 0, quiet = 0, unstable = 0;
  let semis = [];
  fr.forEach((f, k) => {
    if (!good(f)) return;
    if (!ok[k]) { unstable++; return; }
    if ((f.rms || 0) < loud) { quiet++; return; }
    if (inRegions(f.t_ms, opts.harmonyRegions)) { harmonyExcluded++; return; }
    semis.push(midiOf(f.f0));
  });
  if (semis.length < 40) return null;
  semis.sort((a, b) => a - b);
  // Glitch clusters: walk out from the median semitone by semitone; three neighbouring semitones that
  // each hold under 0.3 % of the frames are an empty pitch gap, and anything beyond it (stem bleed,
  // octave errors the cleanup missed) is left out before the percentiles.
  const total = semis.length, bins = {};
  semis.forEach(m => { const k = Math.round(m); bins[k] = (bins[k] || 0) + 1; });
  const thin = k => (bins[k] || 0) < Math.max(2, total * (num(opts.gapShare) ? opts.gapShare : 0.003));
  const med = Math.round(percentile(semis, 50));
  let bodyLo = med, bodyHi = med, run = 0;
  for (let k = med - 1; k >= Math.round(semis[0]); k--) { if (thin(k)) { if (++run >= 3) break; } else { run = 0; bodyLo = k; } }
  run = 0;
  for (let k = med + 1; k <= Math.round(semis[semis.length - 1]); k++) { if (thin(k)) { if (++run >= 3) break; } else { run = 0; bodyHi = k; } }
  const body = semis.filter(m => Math.round(m) >= bodyLo && Math.round(m) <= bodyHi);
  const outliers = total - body.length;
  if (body.length >= 40) semis = body;
  const lo = percentile(semis, pLow), hi = percentile(semis, pHigh), mid = (lo + hi) / 2;
  const r = x => Math.round(x * 100) / 100;
  const lowHz = hzOf(lo), highHz = hzOf(hi), baseHz = hzOf(mid);
  return {
    method: 'percentiles_of_confident_lead_frames', percentiles: [pLow, pHigh],
    low_hz: r(lowHz), high_hz: r(highHz), baseline_hz: r(baseHz),
    low_note: noteName(lowHz), high_note: noteName(highHz), baseline_note: noteName(baseHz),
    low_midi: r(lo), high_midi: r(hi), baseline_midi: r(mid),
    span_semitones: r(hi - lo), half_span_octaves: r(Math.max(1 / 12, (hi - lo) / 24)),
    median_hz: r(hzOf(percentile(semis, 50))),
    frames_used: semis.length, frames_voiced: voiced.length,
    excluded: {harmony_regions: harmonyExcluded, quiet: quiet, unstable_or_isolated: unstable, outlier_clusters: outliers},
    harmony_regions_excluded: (opts.harmonyRegions || []).length,
    source: opts.source || 'vocal_stem',
    register_bands: 'fifths of the range: low < -0.6, lower-mid < -0.2, mid within ±0.2, upper-mid ≤ 0.6, high above (−1 = lowest note, +1 = highest note)'
  };
}
/** Range label for the UI, e.g. "Range D3–A4, baseline F#3". */
function rangeLabel(range) {
  if (!range || !range.low_note) return '';
  return 'Range ' + range.low_note + '–' + range.high_note + ', baseline ' + range.baseline_note;
}
/** Position of a contour value y (octaves around the baseline) within the range: −1 lowest note, +1 highest. */
function rangePosition(y, range) {
  if (!num(y) || !range || !num(range.half_span_octaves) || range.half_span_octaves <= 0) return null;
  return Math.max(-1.5, Math.min(1.5, y / range.half_span_octaves));
}
/** Register band from a range position (fifths of the range). */
function registerFromPosition(pos) {
  if (!num(pos)) return null;
  return pos >= 0.6 ? 'high' : pos >= 0.2 ? 'upper' : pos > -0.2 ? 'mid' : pos > -0.6 ? 'lower' : 'low';
}
/** Adds register_pos (the line's mean height within the singer's range) to lineFeatures output. */
function applyVocalRange(features, range) {
  if (!features || !range) return features;
  const p = rangePosition(features.mean, range);
  if (p != null) features.register_pos = Math.round(p * 100) / 100;
  return features;
}
Object.assign(SS, {measureVocalRange, vocalRangeLabel: rangeLabel, rangePosition, registerFromPosition, applyVocalRange, noteName});
if (typeof module !== 'undefined' && module.exports) module.exports = SS;
})(typeof window !== 'undefined' ? window : globalThis);
