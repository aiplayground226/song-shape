/* Song Shape 0.2.5 - local known-lyrics timing helpers, no model or networking.
   Energy estimates DO NOT recognize spoken/sung words. They are draft positions
   intended for correction. Imported model timestamps are also proposals. */
(function (root) {
'use strict';
const SS = (typeof module !== 'undefined' && module.exports) ? require('./performance-map.js') : (root.SongShape || {});
const number = x => typeof x === 'number' && Number.isFinite(x);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function syllables(word) {
  const text = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!text) return 1;
  const groups = (text.replace(/e$/, '').match(/[aeiouy]+/g) || []).length;
  return Math.max(1, Math.min(12, groups || 1));
}
function allPending(session, lineOnly) {
  const placed = new Set((session.anchors || []).map(a => a.word_id));
  const words = (session.lyrics && session.lyrics.words || []).filter(w => !w.skipped && !placed.has(w.id));
  if (!lineOnly || !words.length) return words;
  return words.filter(w => w.line_id === words[0].line_id);
}
function waveformFeatures(waveform) {
  if (!waveform || !waveform.peaks || !waveform.peaks.length || !number(waveform.duration) || waveform.duration <= 0)
    throw new Error('A decoded local WAV waveform is required to estimate timing.');
  const duration = waveform.duration * 1000;
  const peaks = Array.from(waveform.peaks, x => clamp(Number(x) || 0, 0, 1));
  const step = duration / peaks.length;
  const max = peaks.reduce((m,v)=>Math.max(m,v),0);
  const threshold = Math.max(0.006, max * 0.10);
  return {peaks, step, duration, threshold};
}
function fitOnsets(features, start, end) {
  const {peaks, step, threshold} = features;
  const out = [start];
  const lo = Math.max(1, Math.floor(start / step));
  const hi = Math.min(peaks.length - 1, Math.ceil(end / step));
  let last = start;
  // Hard onsets or emergence from locally low amplitude; not phonetic recognition.
  for (let i = lo; i <= hi; i++) {
    const prev = (peaks[i - 1] + (peaks[i - 2] || 0)) / 2;
    const next = (peaks[i] + (peaks[i + 1] || peaks[i])) / 2;
    const t = i * step;
    if (t - last < 105 || t > end - 70) continue;
    if (next > threshold && (prev < threshold * 0.7 || next - prev > Math.max(threshold * 0.85, prev * 0.9))) {
      out.push(t); last = t;
    }
  }
  return out;
}
function firstLastActive(features, start, end) {
  const {peaks, step, threshold} = features;
  const lo = clamp(Math.floor(start / step), 0, peaks.length - 1);
  const hi = clamp(Math.ceil(end / step), lo, peaks.length - 1);
  let first = start, last = end, found = false;
  for (let i = lo; i <= hi; i++) { if (peaks[i] >= threshold) {first = Math.max(start, i * step); found = true; break;} }
  if (found) for (let i = hi; i >= lo; i--) {if (peaks[i] >= threshold) {last = Math.min(end, (i + 1) * step); break;} }
  return found ? [first, Math.max(last, first + 1)] : [start, end];
}
function estimateWordTimes(session, waveform, opts) {
  opts = opts || {};
  const words = allPending(session, !!opts.nextLineOnly);
  if (!words.length) return {proposals: [], warnings: ['No unplaced words remain.']};
  const f = waveformFeatures(waveform);
  let start = opts.start_ms == null ? 0 : opts.start_ms;
  let end = opts.end_ms == null ? f.duration : opts.end_ms;
  if (!number(start) || !number(end) || start < 0 || end > f.duration + 10 || end - start < 100) throw new Error('Select an audio range at least 100 ms long.');
  // Use active edges only for a selected, short line; entire-song intro/outro may be instrumental.
  if (opts.nextLineOnly) [start, end] = firstLastActive(f, start, end);
  if ((end-start)/words.length < 25) throw new Error('Audio region is too short to estimate this many words. Select a longer loop or correct the lyrics.');
  const onsets = fitOnsets(f, start, end);
  const weights = words.map(w => syllables(w.text));
  const total = weights.reduce((a, b) => a + b, 0);
  let consumed = 0, prior = start - 1;
  const proposals = words.map((w, i) => {
    const center = start + (consumed + weights[i] * 0.5) / total * (end - start);
    const ideal = start + consumed / total * (end - start);
    const rangeWidth = (end - start) / Math.max(1, words.length);
    const nearest = onsets.filter(t => t > prior + 40 && Math.abs(t - ideal) <= Math.min(220, rangeWidth * 0.5))
      .sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal))[0];
    const t = clamp(nearest == null ? ideal : nearest, Math.max(start, prior + 1), end);
    prior = t;
    consumed += weights[i];
    return {word_id: w.id, text: w.text, start_ms: Math.round(t), end_ms: Math.round(t),
      source: 'cpu_energy_timing_estimate', needs_review: true,
      confidence: null, method: nearest == null ? 'proportional_syllable_heuristic' : 'waveform_onset_heuristic'};
  });
  return {proposals, warnings: [
    'This is an amplitude/syllable timing proposal, NOT recognition or forced alignment. Correct every uncertain boundary.',
    opts.nextLineOnly ? 'Proposal applies only to the next unplaced lyric line in the selected loop.' : 'Whole-song estimates can drift across instrumental breaks and repeated sections.'
  ], duration_ms: Math.round(end - start), candidate_onsets: onsets.length};
}
// Understand exported word-level timings from an explicitly invoked local aligner.
// All matching is sequence-based with a strict surface-text check; never silently skip a lyric.
function normalizeText(s) { return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); }
function normalizeAlignment(input) {
  let src;
  if (Array.isArray(input)) src = input;
  else if (input && Array.isArray(input.words)) src = input.words;
  else if (input && Array.isArray(input.segments)) src = input.segments.flatMap(s => s.words || []);
  else throw new Error('Alignment must contain a words[] array or segments[].words[].');
  if (src.length > 20000) throw new Error('Too many aligned words.');
  return src.map((w, i) => {
    const text = w.text == null ? w.word : w.text;
    const start = w.start_ms == null ? Number(w.start) * 1000 : w.start_ms;
    const end = w.end_ms == null ? Number(w.end) * 1000 : w.end_ms;
    if (typeof text !== 'string' || !normalizeText(text)) throw new Error('Alignment word ' + (i + 1) + ' is missing text.');
    if (!number(start) || !number(end) || start < 0 || end < start || end > 86400000) throw new Error('Invalid times at aligned word ' + (i + 1));
    return {text: text.trim(), start_ms: Math.round(start), end_ms: Math.round(end), confidence: number(w.score) ? w.score : (number(w.confidence) ? w.confidence : null)};
  });
}
function proposeImportedAlignment(session, data) {
  const reference = (session.lyrics && session.lyrics.words || []).filter(w => !w.skipped);
  const rows = normalizeAlignment(data);
  if (rows.length !== reference.length) throw new Error('Word count mismatch: alignment has ' + rows.length + ', reference has ' + reference.length + '. Edit/re-align locally; no partial guesses imported.');
  const proposals = rows.map((r, i) => {
    if (normalizeText(r.text) !== normalizeText(reference[i].text)) throw new Error('Word mismatch at position ' + (i + 1) + ': expected "' + reference[i].text + '" but received "' + r.text + '".');
    return {word_id: reference[i].id, text: reference[i].text, start_ms: r.start_ms, end_ms: r.end_ms,
      source: 'imported_known_lyrics_alignment', confidence: r.confidence, needs_review: true}; // never equate model confidence with human verification
  });
  return {proposals, warnings: ['External alignment is an unverified proposal. Confirm boundary timing on the recording.',
    'Already-placed manual words will be preserved.'], candidate_onsets: 0};
}
function applyProposals(session, result, opts) {
  opts = opts || {};
  if (!result || !Array.isArray(result.proposals)) throw new Error('Missing proposals.');
  const known = new Map((session.lyrics && session.lyrics.words || []).map(w => [w.id, w]));
  const existing = new Set((session.anchors || []).map(a => a.word_id));
  if (session.anchors.length + result.proposals.length > 20000) throw new Error('Too many word anchors.');
  // Preflight every row before modifying the project: atomic on failure.
  const seen = new Set();
  for (const p of result.proposals) {
    const w = known.get(p.word_id);
    if (!w || w.skipped) throw new Error('Proposal refers to an invalid or skipped word.');
    if (seen.has(p.word_id)) throw new Error('Duplicate word in alignment proposal.');
    seen.add(p.word_id);
    if (!number(p.start_ms) || !number(p.end_ms) || p.start_ms < 0 || p.end_ms < p.start_ms || p.end_ms > 86400000) throw new Error('Invalid proposal timing.');
  }
  let last = (session.anchors||[]).reduce((max,a)=>Math.max(max,Number(a.id.replace('anchor-', ''))||0),0);
  let added = 0, preserved = 0;
  for (const p of result.proposals) {
    const w = known.get(p.word_id);
    if (existing.has(p.word_id)) { preserved++; continue; }
    session.anchors.push({id: 'anchor-' + (++last),word_id: w.id,line_id: w.line_id,word_ids:[w.id],kind:'word',
      start_ms: p.start_ms,end_ms: p.end_ms,anchor_ms:p.start_ms,stroke_id:null,stroke_ids:[],
      needs_review: !!p.needs_review,harmony:false,source:p.source || 'unverified_import', group_id:'group-' + last});
    existing.add(w.id); added++;
  }
  session.anchors.sort((a,b) => a.start_ms - b.start_ms || a.id.localeCompare(b.id));
  return {added, preserved};
}
const api = {estimateWordTimes,normalizeAlignment,proposeImportedAlignment,applyProposals,syllables};
root.SongShape = Object.assign(root.SongShape || {}, api);
if (typeof module !== 'undefined' && module.exports) module.exports = Object.assign(SS, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
