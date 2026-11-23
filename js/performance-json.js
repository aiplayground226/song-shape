/* Song Shape v0.2.11 fix6d: vocal performance JSON for Step 1 and Step 2.
   One file per step that a reasoning AI (or a person) can read to help with tag mapping: per section, line and
   word the measured reference performance (timing, relative pitch contour, register, holds, dynamics, phrasing),
   your replacement lyric, the reference line it maps to, and for extension sections the source section and
   whether Lift was on (with what it changed). Reference audio is never included; reference lyric text only when
   you tick the box. Schema: docs/vocal_json_schema.md. CPU only, no network. */
(function (root) {
'use strict';
const SCHEMA = 'songshape-vocal-performance-0.1';
const num = x => typeof x === 'number' && Number.isFinite(x);
const r3 = x => num(x) ? Math.round(x * 1000) / 1000 : null;
const rms = x => num(x) ? Math.round(x) : null;
const REG = /^(high|upper-mid|mid|lower-mid|low) register$/i, DYN = /^(powerful|building intensity|steady intensity|restrained|soft)$/i;
const DIR = /^(rising line|falling line|rise then fall|dip then recover|up-and-down line|level line)$/i;
const PHR = /^(phrase break mid-line|rapid phrasing|slow, spacious phrasing|short detached notes|breath)/i;

// downsample a stroke to at most one point per stepMs (keeps first and last)
function thin(points, stepMs) {
  const out = []; let last = -Infinity;
  (points || []).forEach((p, i, a) => { if (!num(p[0]) || !num(p[1])) return; if (p[0] - last >= stepMs || i === a.length - 1) { out.push([rms(p[0]), r3(p[1])]); last = p[0]; } });
  return out;
}
function tagParts(tags) {
  const t = tags || [];
  return {direction: t.find(x => DIR.test(x)) || null, register: (t.find(x => REG.test(x)) || '').replace(/ register$/i, '') || null,
    dynamics: t.find(x => DYN.test(x)) || null, holds: t.filter(x => /(sustained|held) note/i.test(x)), peaks: t.filter(x => /^peak on /i.test(x)),
    contour: t.filter(x => /dip below baseline|climb to the peak/i.test(x)), ending: t.find(x => /at the end$|^settles to baseline$|^lifted ending$/i.test(x)) || null,
    phrasing: t.filter(x => PHR.test(x))};
}

function buildPerformanceJson(o) {
  const map = o.map, transfer = o.transfer, handoff = o.handoff, step = o.step === 2 ? 2 : 1;
  const withRefText = !!o.includeReferenceText, stepMs = o.contourStepMs || 100;
  const groups = {}; (map.groups || []).forEach(g => { groups[g.id] = g; });
  const anchorsByWord = {}; (map.anchors || []).forEach(a => { (a.word_ids && a.word_ids.length ? a.word_ids : [a.word_id]).forEach(w => { if (w && !anchorsByWord[w]) anchorsByWord[w] = a; }); });
  const words = {}; (map.words || []).forEach(w => { words[w.id] = w; });
  const refLineNo = {}; let n = 0; (map.groups || []).forEach(g => { if (g.line_id && refLineNo[g.line_id] == null) refLineNo[g.line_id] = ++n; });
  const hRegions = Array.isArray(map.detected_harmony) ? map.detected_harmony : [];
  const plan = Array.isArray(transfer.section_plan) ? transfer.section_plan : null;
  const refs = o.refs || [];
  // which section each of your lines belongs to (same walk as the sheet)
  const rowSec = []; let bi = -1, ri = 0;
  for (const ln of transfer.parsed_lyrics.lines) {
    if (ln.kind === 'tag') { bi++; continue; }
    if (ln.kind === 'blank') continue;
    rowSec[ri++] = plan && Array.isArray(transfer.block_section) ? transfer.block_section[bi] : 0;
  }
  const lineOut = (r, i) => {
    const gs = (r.reference_group_ids || []).map(id => groups[id]).filter(Boolean);
    const start = gs.length ? Math.min(...gs.map(g => g.start_ms)) : null, end = gs.length ? Math.max(...gs.map(g => g.end_ms)) : null;
    const span = num(start) && num(end) ? end - start : null;
    const f = r.contour_features || null;
    const parts = tagParts(r.cpu_tags);
    return {
      line_number: i + 1, lyric: r.text, status: r.status,
      maps_to_reference: {line_numbers: gs.map(g => refLineNo[g.line_id]).filter(x => x != null), group_ids: gs.map(g => g.id),
        start_ms: rms(start), end_ms: rms(end), duration_ms: rms(span), word_count: r.reference_word_count,
        text: withRefText ? gs.map(g => g.text).join(' / ') : undefined,
        words: gs.flatMap(g => (g.word_ids || []).map(id => { const a = anchorsByWord[id]; const w = words[id];
          return {word_id: id, text: withRefText && w ? w.text : undefined, start_ms: a ? rms(a.start_ms) : null, harmony: (g.harmony_word_ids || []).indexOf(id) >= 0}; }))},
      delivery_tags: (r.cpu_tags || []).slice(),
      // v0.2.11 fix7: a short line split off the line before shares its tag; a lone short line keeps the essentials.
      merged_with_line: r.merged_with_line == null ? null : r.merged_with_line, short_line_rule: r.short_line ? r.short_line.rule : null,
      performance: Object.assign(parts, f ? {
        contour_mean: r3(f.mean), contour_start: r3(f.start), contour_end: r3(f.end), contour_min: r3(f.min), contour_max: r3(f.max), contour_range: r3(f.range),
        peak_at: r3(f.peak_rel), longest_hold_ms: rms(f.hold_ms), longest_hold_at: r3(f.hold_rel), turns: f.turns, breaks: f.breaks,
        voiced_ratio: r3(f.voiced_ratio), words_per_s: r3(f.words_per_s)} : {measured: false}),
      words: (r.projected_words || []).map(w => ({word: w.word, syllables: w.syllable_estimate, relative_start: r3(w.relative_start), relative_end: r3(w.relative_end),
        est_reference_start_ms: num(start) && num(span) ? rms(start + w.relative_start * span) : null,
        est_reference_end_ms: num(start) && num(span) ? rms(start + w.relative_end * span) : null, events: w.descriptions || [],
        harmony: num(start) && num(span) ? hRegions.some(h => { const a = start + w.relative_start * span, b = start + w.relative_end * span; return h.start_ms < b && h.end_ms > a; }) : false})),
      events: (r.events || []).map(e => ({kind: e.kind, description: e.description,
        start_ms: rms(e.reference_start_ms), end_ms: rms(e.reference_end_ms), at: r3(e.normalized_position), word: e.target_word || null, evidence: e.evidence})),
      contour: gs.flatMap(g => (g.stroke_segments || []).map(sg => ({start_ms: rms(sg.start_ms), end_ms: rms(sg.end_ms), points: thin(sg.points, stepMs)}))),
      harmony: {detected: gs.some(g => (g.detected_harmony || []).length), marked_by_you: gs.some(g => !!g.harmony),
        regions: [...new Set(gs.flatMap(g => g.detected_harmony || []))]},
      fit_notes: r.fit_notes || [], warnings: r.warnings || [],
      lift: r.lift ? {final_line: r.lift.final_line, tags_before: r.lift.from, tags_after: r.lift.to} : undefined};
  };
  const rows = handoff.rows;
  let sections;
  if (plan) {
    sections = plan.map((p, si) => {
      const ref = refs.find(x => x.label === p.reference_section) || null;
      return {index: si + 1, label: p.label, type: p.type, status: p.mapped ? 'mapped' : 'new', new_reason: p.new_reason || null,
        reference_section: ref ? {label: ref.label, type: ref.type, start_ms: rms(ref.start_ms), end_ms: rms(ref.end_ms), lines: ref.lines, detected_from: ref.detected_from,
          measured: ref.style ? {syllables_per_s: ref.style.syllables_per_s, mean_line_ms: ref.style.mean_line_ms, mean_syllables: ref.style.mean_syllables,
            holds: ref.style.holds, longest_hold_ms: ref.style.longest_hold_ms, register: ref.style.register, intensity: ref.style.intensity, contour: ref.style.contour} : null} : (p.reference_section ? {label: p.reference_section} : null),
        source_section: p.mapped ? null : (p.inherits_from_section || null),
        lift: !!p.lift, lift_changes: p.lift ? {style_before: p.source_style_tag, style_after: p.style_tag,
          rule: 'inherited tags stepped up one notch: register up, held notes become long holds, intensity up; on the final line powerful, a long hold on the last word and a lifted ending'} : undefined,
        style_tag: p.style_tag,
        lines: rows.map((r, i) => [r, i]).filter(([, i]) => rowSec[i] === si).map(([r, i]) => lineOut(r, i))};
    });
    sections.forEach(sec => { sec.harmony = sec.lines.some(l => l.harmony.detected || l.harmony.marked_by_you); });
  } else { sections = [{index: 1, label: 'All', type: null, status: 'mapped', lines: rows.map(lineOut)}]; sections[0].harmony = sections[0].lines.some(l => l.harmony.detected || l.harmony.marked_by_you); }
  const sheet = o.sheet || null;
  return {
    schema_version: SCHEMA, app_version: o.appVersion || null, step, step_name: step === 2 ? 'Extend in that style' : 'Map my lyrics to the reference performance',
    lift: step === 2 ? !!transfer.lift : false,
    created: o.created || new Date().toISOString(),
    purpose: 'Fidelity: your lyrics in the measured reference performance' + (step === 2 ? ', extended with new sections that inherit the source section' + (transfer.lift ? ' with Lift on (stepped up)' : ' faithfully (no added lift)') : '') + '. For a reasoning AI helping with tag mapping.',
    semantics: {time: 'milliseconds in the reference recording', pitch: 'relative contour y in [-1, 1] around the singer\'s own baseline (0); not absolute notes, no key, no BPM',
      relative_positions: '0..1 within the mapped reference line', est_reference_ms: 'proportional syllable estimate, not measured timing of your words',
      register: map.vocal_range ? 'fifths of the confident lead range, relative to its semitone midpoint' : 'from the contour relative to baseline', holds_ms: 'measured held notes'},
    vocal_range: map.vocal_range ? JSON.parse(JSON.stringify(map.vocal_range)) : null,
    performer_identity: map.performer && map.performer.identity || null,
    suno_sheet: sheet ? {text: sheet.text, characters: sheet.length, budget: sheet.budget, remaining: sheet.remaining, line_tags_shortened: !!sheet.line_tags_shortened} : null,
    full_sheet: handoff.lyrics,
    lead_singer_only: 'Song Shape tracks a single lead singer performance. Harmonies, backing vocals and choir parts are not tracked; harmony flags are hints from the vocal stem and overlapping lines.',
    harmony_regions: hRegions.map(h => ({id: h.id, start_ms: h.start_ms, end_ms: h.end_ms, score: h.score, reasons: h.reasons, source: h.source})),
    reference_sections: refs.map(x => ({label: x.label, type: x.type, start_ms: rms(x.start_ms), end_ms: rms(x.end_ms), lines: x.lines, detected_from: x.detected_from, style_tag: x.style ? x.style.tag : null})),
    sections,
    warnings: handoff.warnings || [], caveats: handoff.caveats || null, estimate_caveat: handoff.payload && handoff.payload.estimate_caveat || null,
    contains_reference_audio: false, contains_reference_lyric_text: withRefText, contains_source_artist: false, network_transmitted: false
  };
}
const api = {VOCAL_JSON_SCHEMA: SCHEMA, buildPerformanceJson};
root.SongShape = Object.assign(root.SongShape || {}, api);
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
