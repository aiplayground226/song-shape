/* Song Shape 0.2.5 - local known-lyrics timing helpers, no model or networking.
   Energy estimates DO NOT recognize spoken/sung words. They are draft positions
   intended for correction. Imported model timestamps are also proposals. */
(function (root) {
'use strict';
const SS = (typeof module !== 'undefined' && module.exports) ? require('./performance-map.js') : (root.SongShape || {});
if (typeof module !== 'undefined' && module.exports) Object.assign(SS, require('./word-onset.js'));
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
  // v0.2.11 fix4: with words already placed, estimate each run of unplaced words only between its placed
  // neighbours. A single leftover word no longer parks at 0:00 from a whole-song estimate.
  const anchorAt = new Map((session.anchors || []).map(a => [a.word_id, a]));
  if (!opts.nextLineOnly && opts.start_ms == null && opts.end_ms == null && anchorAt.size) {
    const all = (session.lyrics.words || []).filter(w => !w.skipped), pending = new Set(words.map(w => w.id));
    const out = [], warnings = new Set(); let run = [], prevMs = null, cands = 0;
    const flush = nextMs => {
      if (!run.length) return;
      const lo = prevMs == null ? 0 : prevMs + 120, hi = nextMs == null ? f.duration : nextMs - 40;
      if (hi - lo >= 100 && (hi - lo) / run.length >= 25) {
        const r = estimateWordTimes({lyrics: {words: run}, anchors: []}, waveform, {start_ms: lo, end_ms: hi});
        r.proposals.forEach(p => out.push(p)); r.warnings.forEach(w => warnings.add(w)); cands += r.candidate_onsets || 0;
      } else warnings.add('Some unplaced words sit between placed words with no room left; place them by hand.');
      run = [];
    };
    all.forEach(w => { if (pending.has(w.id)) run.push(w); else { const a = anchorAt.get(w.id); flush(a ? a.start_ms : null); if (a) prevMs = a.start_ms; } });
    flush(null);
    return {proposals: out, warnings: [...warnings], candidate_onsets: cands};
  }
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
    // v0.2.11: optional letter/phone spans (seconds) from a local aligner, used for vowel-target starts.
    const spans = (list, key) => Array.isArray(list) ? list.slice(0, 64).filter(c => c && typeof c[key] === 'string' && number(Number(c.start)) && number(Number(c.end)))
      .map(c => ({[key]: c[key].slice(0, 8), start: Number(c.start), end: Number(c.end), vowel: c.vowel === true})) : undefined;
    return {text: text.trim(), start_ms: Math.round(start), end_ms: Math.round(end), confidence: number(w.score) ? w.score : (number(w.confidence) ? w.confidence : null),
      chars: spans(w.chars, 'c'), phones: spans(w.phones, 'p'), in_silence: w.in_silence === true};
  });
}
const STRETCHED = /\p{L}-\p{L}|(\p{L})\1\1/iu;
const VOCALISE = /^(o+h*|u+h+|a+h+|w+o+h+|wh?oa+h*|mm+|hm+|la|na|yeah|hey|ha)$/;
function proposeImportedAlignment(session, data, opts) {
  opts = opts || {};
  const reference = (session.lyrics && session.lyrics.words || []).filter(w => !w.skipped);
  // v0.2.10: a letterless lyric "word" (a standalone dash from older projects) cannot be timed. Say so plainly.
  const letterless = reference.filter(w => !normalizeText(w.text));
  if (letterless.length) throw new Error('The lyrics contain ' + letterless.length + ' standalone dash' + (letterless.length > 1 ? 'es' : '') + ' or symbol' + (letterless.length > 1 ? 's' : '') + ' (e.g. "' + letterless[0].text + '"). Remove standalone dashes (-, \u2013, \u2014) from the lyrics and paste them again before importing word timings. Hyphenated words are fine.');
  const rows = normalizeAlignment(data);
  if (rows.length !== reference.length) throw new Error('Word count mismatch: alignment has ' + rows.length + ', reference has ' + reference.length + '. Edit/re-align locally; no partial guesses imported.');
  const notHeard = [], vocalise = [], held = [], spread = [];
  const heldEnv = opts.samples && SS.levelEnvelope ? SS.levelEnvelope(opts.samples, opts.sampleRate) : null;
  // v0.2.11 fix3: line starts go to the vocal onset after a pause (quiet stretches are gaps), on the stem samples.
  // v0.2.11 fix5: tapped lines are the user's own anchors: never snapped; if an older helper ignored the tap,
  // the line's first word moves to the tap (later words keep their order).
  const taps = opts.lineTaps || {}, tapped = {}, tappedLines = new Set();
  reference.forEach((w, i) => { if (number(taps[w.id])) { tapped[i] = taps[w.id]; tappedLines.add(w.line_id); } });
  const snapped = opts.samples && opts.snapLines !== false && SS.snapLineStarts
    ? SS.snapLineStarts(rows, reference.map(w => w.line_id), opts.samples, opts.sampleRate, {skip: tapped}) : [];
  const tapMoved = [];
  Object.keys(tapped).forEach(k => {
    const i = Number(k), t = tapped[k];
    if (!rows[i] || Math.abs(rows[i].start_ms - t) <= 400) return;
    const d = t - rows[i].start_ms; rows[i].start_ms = t; rows[i].end_ms = Math.max(t, rows[i].end_ms + Math.max(0, d));
    rows[i].chars = undefined; rows[i].phones = undefined; rows[i].line_tap = true; rows[i].in_silence = false; tapMoved.push(reference[i].text);
    let prev = t;
    for (let j = i + 1; j < rows.length && reference[j].line_id === reference[i].line_id; j++) {
      if (rows[j].start_ms < prev + 60) { rows[j].start_ms = prev + 60; rows[j].end_ms = Math.max(rows[j].end_ms, rows[j].start_ms); rows[j].chars = undefined; }
      prev = rows[j].start_ms;
    }
  });
  const proposals = rows.map((r, i) => {
    if (normalizeText(r.text) !== normalizeText(reference[i].text)) throw new Error('Word mismatch at position ' + (i + 1) + ': expected "' + reference[i].text + '" but received "' + r.text + '".');
    // v0.2.11: the aligner's start is the signal (often a consonant); the word start goes on the vowel.
    let start = r.start_ms, rule = 'aligner_word_start';
    const signal = r.start_ms;
    // Default: energy vowel on the decoded (stem) samples, measured best here with the MIT aligner.
    // Phone spans (true vowels) win when an aligner supplies them; letter spans are the fallback.
    const hasPhones = r.phones && r.phones.some(p => p.vowel);
    if (opts.vowelTarget !== false && hasPhones && SS.vowelTimeFromAligned) {
      const v = SS.vowelTimeFromAligned({text: reference[i].text, start: r.start_ms / 1000, phones: r.phones});
      if (number(v.vowel_s)) { start = Math.round(v.vowel_s * 1000); rule = 'vowel_target_' + v.rule; }
    } else if (opts.vowelTarget !== false && opts.samples && opts.vowelMode !== 'letters' && SS.vowelOnsetFromAudio) {
      start = SS.vowelOnsetFromAudio(opts.samples, opts.sampleRate, r.start_ms); rule = 'vowel_target_cpu_energy';
    } else if (opts.vowelTarget !== false && r.chars && r.chars.length && SS.vowelTimeFromAligned) {
      const v = SS.vowelTimeFromAligned({text: reference[i].text, start: r.start_ms / 1000, chars: r.chars});
      if (number(v.vowel_s)) { start = Math.round(v.vowel_s * 1000); rule = 'vowel_target_' + v.rule; }
    }
    // v0.2.11 fix2: the aligner found only silence for this word: it was not sung here. Leave it unplaced.
    if (r.in_silence && opts.keepSilent !== true) { notHeard.push(reference[i].text); return null; }
    // v0.2.11 fix5: the vowel never moves a word onto or past the next word's first sound.
    if (i + 1 < rows.length && start >= rows[i + 1].start_ms && signal < rows[i + 1].start_ms) { start = signal; rule += '_kept_signal'; }
    // v0.2.11 fix4: a stretched or hyphenated word ("ho-nooor") is one held word: start on the vowel, end where
    // the held note stops (or the next word starts).
    let end = Math.max(start, r.end_ms);
    // A plain word whose letters spread over more than 4 s was stretched across a gap or a part not in the lyrics.
    if (r.end_ms - r.start_ms > 4000 && !STRETCHED.test(String(reference[i].text)) && !VOCALISE.test(normalizeText(reference[i].text))) spread.push({text: reference[i].text, start_ms: r.start_ms, span_ms: r.end_ms - r.start_ms});
    if (STRETCHED.test(String(reference[i].text)) && heldEnv) {
      const nextStart = i + 1 < rows.length ? rows[i + 1].start_ms : start + 8000;
      end = Math.max(end, Math.min(nextStart - 20, SS.sustainEndMs(heldEnv, start, nextStart)));
      rule = 'held_' + rule; held.push(reference[i].text);
    }
    if (r.line_onset) rule = 'line_onset_' + rule;
    if (r.line_tap) rule = 'line_tap_' + rule;
    // v0.2.11 fix3: sung vowels without letters to match (Oh, ooo, woh) are placed loosely by any letter aligner.
    if (VOCALISE.test(normalizeText(reference[i].text))) { rule = 'vocalise_loose_' + rule; vocalise.push(reference[i].text); }
    return {word_id: reference[i].id, text: reference[i].text, start_ms: start, end_ms: end, signal_ms: signal, anchor_rule: rule,
      source: 'imported_known_lyrics_alignment', confidence: r.confidence, tap_anchored: tappedLines.has(reference[i].line_id), needs_review: true}; // never equate model confidence with human verification
  });
  // v0.2.11 fix2: lines whose aligner score is far below the song's typical line (backing vocals, a bad stem,
  // or lyrics that differ from what is sung). Deterministic; listed for checking by ear, never auto-moved.
  const byLine = new Map();
  rows.forEach((r, i) => { if (!number(r.confidence) || r.in_silence) return; const id = reference[i].line_id;
    const e = byLine.get(id) || {sum: 0, n: 0, start_ms: r.start_ms}; e.sum += r.confidence; e.n++; byLine.set(id, e); });
  const lineMeans = [...byLine.values()].map(e => e.sum / e.n).sort((a, b) => a - b);
  const median = lineMeans.length ? lineMeans[Math.floor((lineMeans.length - 1) / 2)] : 0;
  const lineText = new Map(((session.lyrics && session.lyrics.lines) || []).map(l => [l.id, l.text]));
  const weakLines = lineMeans.length >= 4 ? [...byLine.entries()].filter(([, e]) => e.sum / e.n < median * 0.6)
    .map(([id, e]) => ({line_id: id, text: String(lineText.get(id) || '').slice(0, 80), start_ms: e.start_ms, confidence: Math.round(e.sum / e.n * 100) / 100}))
    .sort((a, b) => a.start_ms - b.start_ms) : [];
  const weakIds = new Set(weakLines.map(l => l.line_id));
  proposals.forEach((p,i) => { if(!p)return; p.review_flags=[];
    if(number(p.confidence)&&p.confidence<0.3) p.review_flags.push('low_alignment_confidence');
    if(weakIds.has(reference[i].line_id)) p.review_flags.push('weak_line_alignment');
    if(p.end_ms-p.start_ms>4000&&!STRETCHED.test(reference[i].text)&&!VOCALISE.test(normalizeText(reference[i].text))) p.review_flags.push('word_spans_long_gap');
  });
  return {proposals: proposals.filter(Boolean), not_heard: notHeard, weak_lines: weakLines,
    // Many silence or weak-match flags usually mean a live recording or lyrics that differ from the audio.
    studio_hint: notHeard.length >= 3 || weakLines.length >= Math.max(3, Math.ceil(0.2 * byLine.size)),
    vocalise: vocalise, held: held, spread: spread, taps_used: Object.keys(tapped).length, tap_moved: tapMoved, lines_snapped: snapped.map(m => ({word_id: reference[m.index].id, text: reference[m.index].text, from_ms: m.from_ms, to_ms: m.to_ms})), warnings: ['External alignment is an unverified proposal. Confirm boundary timing on the recording.',
    'Already-placed manual words will be preserved.'].concat(notHeard.length ? [notHeard.length + ' word(s) fell on silence and were left unplaced: ' + notHeard.slice(0, 12).join(' ') + '. Check that the lyrics match what is sung.'] : []), candidate_onsets: 0};
}
// v0.2.11 fix7: tapped line starts anchor the words of that line (stage 1 "place words" run after tapping).
// Hand-checked words never move. Aligner words in a tapped line keep their own timing when the line already
// starts within 400 ms of the tap; otherwise the line is shifted to the tap (relative timing kept, squeezed
// only if it would run into the next line). CPU estimates and unplaced words of a tapped line are laid out by
// syllables between the tap and the next line start. Every word of a tapped line is marked tap_anchored.
function applyTapAnchors(session, durationMs) {
  const taps = new Map((session.line_taps || []).filter(t => t && !t.skipped && number(t.t_ms)).map(t => [t.line_id, Math.max(0, t.t_ms)]));
  const words = (session.lyrics && session.lyrics.words || []).filter(w => !w.skipped);
  const lines = [...new Set(words.map(w => w.line_id))];
  session.anchors = session.anchors || [];
  const out = {lines: 0, words: 0, kept: 0, shifted: 0, laid_out: 0, skipped_lines: []};
  if (!taps.size) return out;
  const machine = a => a && a.needs_review && /^(imported_known_lyrics_alignment|cpu_energy_timing_estimate|cpu_tap_anchored_estimate)$/.test(a.source || '');
  const firstStart = id => { const t = session.anchors.filter(a => a.line_id === id).map(a => a.start_ms).filter(number); return t.length ? Math.min(...t) : null; };
  let last = session.anchors.reduce((m, a) => Math.max(m, Number(String(a.id).replace('anchor-', '')) || 0), 0);
  const dur = number(durationMs) && durationMs > 0 ? durationMs : Infinity;
  lines.forEach((id, li) => {
    if (!taps.has(id)) return;
    const tap = taps.get(id), ws = words.filter(w => w.line_id === id);
    let limit = null;
    for (let j = li + 1; j < lines.length && limit == null; j++) {
      const t = taps.has(lines[j]) ? taps.get(lines[j]) : firstStart(lines[j]);
      if (number(t) && t > tap) limit = t - 60;
    }
    if (limit == null) limit = dur;
    const byWord = new Map(session.anchors.filter(a => a.line_id === id).map(a => [a.word_id, a]));
    const hand = ws.filter(w => byWord.has(w.id) && !machine(byWord.get(w.id)));
    if (hand.length) { // never move checked words; only mark the line's machine words
      ws.forEach(w => { const a = byWord.get(w.id); if (a && machine(a)) { a.tap_anchored = true; out.words++; } });
      out.kept += hand.length; out.lines++; return;
    }
    const placed = ws.map(w => byWord.get(w.id));
    const allAligned = placed.every(a => a && a.source === 'imported_known_lyrics_alignment');
    if (allAligned) {
      const a0 = Math.min(...placed.map(a => a.start_ms)), a1 = Math.max(...placed.map(a => Math.max(a.start_ms, a.end_ms || a.start_ms)));
      if (Math.abs(a0 - tap) > 400 || a1 > limit) {
        const span = Math.max(1, a1 - a0), room = Math.max(25 * ws.length, Math.min(span, limit - tap)), k = room / span;
        placed.forEach(a => { a.start_ms = Math.round(tap + (a.start_ms - a0) * k); a.end_ms = Math.max(a.start_ms, Math.round(tap + ((a.end_ms || a.start_ms) - a0) * k)); a.anchor_ms = a.start_ms;
          a.anchor_rule = /^line_tap_/.test(a.anchor_rule || '') ? a.anchor_rule : 'line_tap_' + (a.anchor_rule || 'aligner'); });
        out.shifted += ws.length;
      } else out.kept += ws.length;
      placed.forEach(a => { a.tap_anchored = true; });
      out.words += ws.length; out.lines++; return;
    }
    // CPU estimates or unplaced words: syllable layout from the tap to the next line (at most ~0.45 s a syllable).
    const weights = ws.map(w => Math.max(1, syllables(w.text))), total = weights.reduce((x, y) => x + y, 0);
    const end = Math.min(limit, tap + total * 450 + 300);
    if (!(end - tap >= Math.max(100, ws.length * 25))) { out.skipped_lines.push(id); return; }
    let used = 0;
    ws.forEach((w, i) => {
      const t = Math.round(tap + used / total * (end - tap)); used += weights[i];
      const e = Math.round(tap + used / total * (end - tap)) - 20;
      let a = byWord.get(w.id);
      if (!a) { a = {id: 'anchor-' + (++last), word_id: w.id, line_id: w.line_id, word_ids: [w.id], kind: 'word', stroke_id: null, stroke_ids: [], harmony: false, group_id: 'group-' + last}; session.anchors.push(a); }
      Object.assign(a, {start_ms: t, end_ms: Math.max(t, e), anchor_ms: t, needs_review: true, source: 'cpu_tap_anchored_estimate', anchor_rule: 'line_tap_syllable_estimate', tap_anchored: true, signal_ms: t, confidence: null});
    });
    out.laid_out += ws.length; out.words += ws.length; out.lines++;
  });
  session.anchors.sort((a, b) => a.start_ms - b.start_ms || String(a.id).localeCompare(String(b.id)));
  return out;
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
    if (number(p.signal_ms)) { session.anchors[session.anchors.length - 1].signal_ms = p.signal_ms; session.anchors[session.anchors.length - 1].anchor_rule = p.anchor_rule || null; }
    const a = session.anchors[session.anchors.length - 1];
    a.confidence = number(p.confidence) ? Math.max(0,Math.min(1,p.confidence)) : null; a.tap_anchored = !!p.tap_anchored;
    a.review_flags = Array.isArray(p.review_flags) ? p.review_flags.slice() : [];
    existing.add(w.id); added++;
  }
  session.anchors.sort((a,b) => a.start_ms - b.start_ms || a.id.localeCompare(b.id));
  return {added, preserved};
}
const api = {estimateWordTimes,normalizeAlignment,proposeImportedAlignment,applyProposals,applyTapAnchors,syllables};
root.SongShape = Object.assign(root.SongShape || {}, api);
if (typeof module !== 'undefined' && module.exports) module.exports = Object.assign(SS, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
