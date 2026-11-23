/* Song Shape v0.2.11 fix6e: harmony detector (CPU only, no network). Song Shape tracks ONE lead singer;
   this only labels where the vocal stem probably holds stacked voices (harmonies, backing vocals, choir), so
   you know where the lead trace and word placement are least reliable and where unplaced words may hide.
   Evidence per 50 ms frame of the vocal stem:
     - two simultaneous pitches: after the strongest harmonic series is removed from the spectrum, a second,
       unrelated series stays strong (iterative harmonic-sum estimate);
     - strong vocal energy with low pitch confidence (YIN aperiodicity high): stacked voices blur one period;
   and from the words: placed lines that overlap in time (a repeated line sung over another).
   Regions are smoothed (at least 1 s, gaps under 0.8 s joined). Labels are hints for your ear, never facts. */
(function (root) {
'use strict';
const TARGET_SR = 11025, WIN = 2048, HOP_MS = 50;

function fftMag(re) { // in-place radix-2 FFT of a real window; returns magnitudes of the first n/2 bins
  const n = re.length, im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  const mag = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  return mag;
}
function downsample(samples, sr) {
  const f = Math.max(1, Math.round(sr / TARGET_SR)), n = Math.floor(samples.length / f), out = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < f; k++) s += samples[i * f + k]; out[i] = s / f; }
  return {x: out, sr: sr / f};
}
const CANDS = (() => { const c = []; for (let m = 43; m <= 81; m += 0.5) c.push(440 * Math.pow(2, (m - 69) / 12)); return c; })(); // ~87–880 Hz
function salience(mag, binHz, f0) {
  let s = 0;
  for (let h = 1; h <= 10; h++) {
    const b = Math.round(h * f0 / binHz); if (b + 1 >= mag.length) break;
    s += Math.max(mag[b - 1] || 0, mag[b], mag[b + 1]) / h;
  }
  return s;
}
function best(mag, binHz) {
  let bs = 0, bf = 0;
  for (const f of CANDS) { const s = salience(mag, binHz, f); if (s > bs) { bs = s; bf = f; } }
  return {s: bs, f: bf};
}
function yinAperiodicity(x, start, n, sr) { // min of the cumulative-mean-normalised difference (0 = clean period)
  const tauMin = Math.floor(sr / 900), tauMax = Math.floor(sr / 85);
  let running = 0, minV = 1;
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0; for (let i = 0; i < n - tauMax; i++) { const d = x[start + i] - x[start + i + tau]; sum += d * d; }
    running += sum; const v = running ? sum * tau / running : 1;
    if (tau >= tauMin && v < minV) minV = v;
  }
  return minV;
}
const HANN = (() => { const w = new Float64Array(WIN); for (let i = 0; i < WIN; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WIN - 1)); return w; })();

/** Per-frame evidence. Returns {hop_ms, frames:[{t_ms, rms, poly, aper, f1, f2}]} */
function harmonyFrames(samples, sampleRate) {
  const d = downsample(samples, sampleRate), x = d.x, sr = d.sr, hop = Math.round(sr * HOP_MS / 1000), binHz = sr / WIN;
  const frames = [];
  for (let st = 0; st + WIN <= x.length; st += hop) {
    let e = 0; for (let i = 0; i < WIN; i++) e += x[st + i] * x[st + i];
    const rms = Math.sqrt(e / WIN), t_ms = Math.round((st + WIN / 2) / sr * 1000);
    if (rms < 1e-3) { frames.push({t_ms, rms, poly: 0, aper: 1, f1: 0, f2: 0}); continue; }
    const re = new Float64Array(WIN); for (let i = 0; i < WIN; i++) re[i] = x[st + i] * HANN[i];
    const mag = fftMag(re);
    const a = best(mag, binHz);
    for (let h = 1; h <= 12; h++) { const lo = Math.floor(h * a.f * 0.97 / binHz) - 1, hi = Math.ceil(h * a.f * 1.03 / binHz) + 1; for (let b = Math.max(0, lo); b <= hi && b < mag.length; b++) mag[b] = 0; }
    const b2 = best(mag, binHz);
    const cents = Math.abs(1200 * Math.log2(b2.f / a.f)) % 1200;
    const related = cents < 60 || cents > 1140; // octave relatives are one voice
    const poly = a.s > 0 && !related ? b2.s / a.s : 0;
    const centre = st + (WIN >> 1) - 512, aper = yinAperiodicity(x, Math.max(0, centre), Math.min(1024, x.length - centre), sr);
    frames.push({t_ms, rms, poly, aper, f1: Math.round(a.f), f2: Math.round(b2.f)});
  }
  return {hop_ms: HOP_MS, frames};
}
function pct(arr, p) { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0; }

/** Regions where stacked voices are likely. opts: {polyMin, aperMin, energyRel, minMs, joinMs, lineSpans} */
function detectHarmony(samples, sampleRate, opts) {
  opts = opts || {};
  const ev = opts.frames ? {hop_ms: HOP_MS, frames: opts.frames} : harmonyFrames(samples, sampleRate);
  const fr = ev.frames;
  const loud = pct(fr.map(f => f.rms).filter(r => r > 1e-3), 0.9);
  const energyMin = (opts.energyRel == null ? 0.25 : opts.energyRel) * loud;
  const polyMin = opts.polyMin == null ? 0.62 : opts.polyMin, aperMin = opts.aperMin == null ? 0.35 : opts.aperMin;
  const flag = fr.map(f => f.rms >= energyMin && (f.poly >= polyMin || f.aper >= aperMin));
  const why = fr.map(f => f.rms >= energyMin ? (f.poly >= polyMin ? 'two pitches at once' : f.aper >= aperMin ? 'strong voice, unclear pitch' : null) : null);
  // smooth: share of flagged frames among the loud frames in a 1.5 s window
  const half = Math.round(750 / ev.hop_ms), on = [];
  for (let i = 0; i < fr.length; i++) {
    let n = 0, k = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(fr.length - 1, i + half); j++) if (fr[j].rms >= energyMin) { n++; if (flag[j]) k++; }
    on.push(fr[i].rms >= energyMin && n >= 6 && k / n >= (opts.share == null ? 0.5 : opts.share));
  }
  const minMs = opts.minMs == null ? 1000 : opts.minMs, joinMs = opts.joinMs == null ? 800 : opts.joinMs;
  let regions = [];
  for (let i = 0; i < fr.length; i++) {
    if (!on[i]) continue;
    let j = i; while (j + 1 < fr.length && on[j + 1]) j++;
    const seg = fr.slice(i, j + 1), loudSeg = seg.filter(f => f.rms >= energyMin);
    const reasons = {}; for (let k = i; k <= j; k++) if (why[k]) reasons[why[k]] = (reasons[why[k]] || 0) + 1;
    regions.push({start_ms: fr[i].t_ms - ev.hop_ms / 2, end_ms: fr[j].t_ms + ev.hop_ms / 2,
      score: Math.round(100 * loudSeg.filter((f, q) => flag[i + seg.indexOf(f)]).length / Math.max(1, loudSeg.length)) / 100,
      reasons: Object.keys(reasons).sort((a, b) => reasons[b] - reasons[a]), source: 'stem'});
    i = j;
  }
  // join close regions, drop short ones
  const joined = [];
  for (const r of regions) { const last = joined[joined.length - 1]; if (last && r.start_ms - last.end_ms < joinMs) { last.end_ms = r.end_ms; last.score = Math.max(last.score, r.score); r.reasons.forEach(x => { if (last.reasons.indexOf(x) < 0) last.reasons.push(x); }); } else joined.push(Object.assign({}, r)); }
  regions = joined.filter(r => r.end_ms - r.start_ms >= minMs);
  // words: placed lines that overlap in time
  (opts.lineSpans || []).forEach((a, i, all) => all.slice(i + 1).forEach(b => {
    const s = Math.max(a.start_ms, b.start_ms), e = Math.min(a.end_ms, b.end_ms);
    if (e - s >= 300) regions.push({start_ms: s, end_ms: e, score: 1, reasons: ['lines placed on top of each other' + (a.text && b.text && norm(a.text) === norm(b.text) ? ' (repeated line)' : '')], source: 'words'});
  }));
  regions.sort((a, b) => a.start_ms - b.start_ms);
  const merged = [];
  for (const r of regions) { const last = merged[merged.length - 1]; if (last && r.start_ms <= last.end_ms) { last.end_ms = Math.max(last.end_ms, r.end_ms); last.score = Math.max(last.score, r.score); r.reasons.forEach(x => { if (last.reasons.indexOf(x) < 0) last.reasons.push(x); }); if (last.source !== r.source) last.source = 'stem+words'; } else merged.push(Object.assign({}, r, {reasons: r.reasons.slice()})); }
  return merged.map((r, i) => ({id: 'auto-harmony-' + (i + 1), start_ms: Math.round(r.start_ms), end_ms: Math.round(r.end_ms), score: r.score, reasons: r.reasons, source: r.source}));
}
function norm(t) { return String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function regionAt(regions, startMs, endMs, padMs) {
  const p = padMs || 0, e = endMs == null ? startMs : endMs;
  return (regions || []).find(r => r.start_ms - p <= e && r.end_ms + p >= startMs) || null;
}
function fmtTime(ms) { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
/** Where an unplaced word probably is: between the placed words around it. */
function unplacedHints(session, regions) {
  const words = (session.lyrics && session.lyrics.words) || [], anchors = session.anchors || [];
  const at = {}; anchors.forEach(a => { (a.word_ids && a.word_ids.length ? a.word_ids : [a.word_id]).forEach(w => { at[w] = a; }); });
  const out = [];
  words.forEach((w, i) => {
    if (w.skipped || at[w.id]) return;
    let p = i - 1; while (p >= 0 && !at[words[p].id]) p--;
    let q = i + 1; while (q < words.length && !at[words[q].id]) q++;
    const from = p >= 0 ? at[words[p].id].end_ms || at[words[p].id].start_ms : 0, to = q < words.length ? at[words[q].id].start_ms : (from + 15000);
    const r = regionAt(regions, from, Math.max(from, to), 3000);
    out.push({word_id: w.id, text: w.text, after_ms: from, before_ms: to, harmony_region: r ? r.id : null, near_ms: r ? Math.max(r.start_ms, Math.min(from, r.end_ms)) : null});
  });
  return out;
}
const api = {harmonyFrames, detectHarmony, harmonyRegionAt: regionAt, unplacedHarmonyHints: unplacedHints, formatMmSs: fmtTime};
root.SongShape = Object.assign(root.SongShape || {}, api);
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
