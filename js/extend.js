/* Song Shape v0.2.11 fix6: Extend. Map your sections onto the reference song's sections, write one
   [Vocal style: ...] tag per section from the measured reference (pace, holds, register, intensity,
   contour), and let sections you mark as new (or that have no reference section left) inherit the style
   of the matching section type. Your lyric words are never changed. CPU only, no network. */
(function (root) {
'use strict';
const SS = (typeof module !== 'undefined' && module.exports) ? require('./vocal-handoff.js') : (root.SongShape || {});
const num = x => typeof x === 'number' && Number.isFinite(x);
const r1 = x => Math.round(x * 10) / 10;
const TYPES = ['Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Bridge', 'Vocalise', 'Outro'];
const NEW_MARK = /\b(new|extra|extension|extend(ed)?|added)\b/i;
const VOCALISE = /^(o+h*|u+h+|a+h+|w+o+h+|wh?oa+h*|mm+|hm+|la|na|yeah|hey|ha)$/;
const GAP_SPLIT_MS = 8000;
const norm = t => String(t || '').toLowerCase().replace(/(\w)-(\w)/g, '$1$2').replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
const toks = t => norm(t).replace(/'/g, '').split(' ').filter(Boolean);
const isVocalise = t => { const w = toks(t); return w.length > 0 && w.every(x => VOCALISE.test(x)); };
const syl = w => SS.syllables ? SS.syllables(w) : Math.max(1, (String(w).toLowerCase().match(/[aeiouy]+/g) || []).length);
const lineSyl = t => String(t || '').split(/\s+/).filter(x => /[\p{L}\p{N}]/u.test(x)).reduce((a, w) => a + syl(w), 0);
const fmt = ms => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

/** Section type named in a [tag], or null. "[New Verse]" -> Verse, "[Hook]" -> Chorus. */
function headerType(tag) {
  const t = String(tag || '').toLowerCase();
  if (/pre-?\s?chorus/.test(t)) return 'Pre-Chorus';
  if (/chorus|refrain|hook/.test(t)) return 'Chorus';
  if (/verse/.test(t)) return 'Verse';
  if (/bridge|middle\s?8|middle eight/.test(t)) return 'Bridge';
  if (/outro|ending|coda/.test(t)) return 'Outro';
  if (/intro/.test(t)) return 'Intro';
  if (/vocali[sz]e|ad-?lib/.test(t)) return 'Vocalise';
  return null;
}

/**
 * Your sections: plain lines, blank line between sections; a [New ...] line above a section marks it new.
 * v0.2.11 fix6b: when your first block has a [tag], you are marking sections yourself, and a block without
 * its own [tag] continues the section above it (so a section may hold blank-line phrasing gaps).
 */
function parseBlocks(text) {
  const c = SS.cleanLyricInput(String(text == null ? '' : text));
  const marking = !!(c.sections[0] && c.sections[0].header);
  const out = [];
  c.sections.forEach((s, i) => {
    const texts = s.texts || [];
    const prev = out[out.length - 1];
    if (marking && !s.header && prev) {
      prev.texts = prev.texts.concat(texts); prev.lines = prev.texts.length; prev.syllables = prev.syllables.concat(texts.map(lineSyl));
      prev.block_indices.push(i); return;
    }
    const named = headerType(s.header);
    const type = named || (texts.length && texts.every(isVocalise) ? 'Vocalise' : s.name);
    out.push({index: out.length, block_indices: [i], texts: texts.slice(), lines: texts.length, header: s.header, type, named: !!named,
      marked_new: !!(s.header && NEW_MARK.test(s.header)), syllables: texts.map(lineSyl)});
  });
  return out;
}

function lineTiming(map, g) {
  const an = (map.anchors || []).filter(a => a.line_id === g.line_id && num(a.start_ms));
  if (!an.length) return null;
  const start = Math.min(...an.map(a => a.start_ms));
  const lastStart = Math.max(...an.map(a => a.start_ms));
  let end = Math.max(...an.map(a => num(a.end_ms) ? a.end_ms : a.start_ms));
  // The line ends where the contour segment under its last word ends (a held last note counts; later
  // segments, such as stem bleed in an instrumental break, do not).
  for (const s of g.stroke_segments || []) if (num(s.start_ms) && num(s.end_ms) && s.start_ms <= lastStart + 500 && s.end_ms >= lastStart && s.end_ms > end) end = s.end_ms;
  return {start, end};
}
function groupFeatures(g) {
  if (!SS.lineFeatures || !num(g.start_ms) || !num(g.end_ms) || g.end_ms <= g.start_ms || !(g.stroke_segments || []).length) return null;
  const gaps = (g.events || []).filter(e => e.kind === 'gap' && e.meaning === 'label_present').map(e => ({label: e.description}));
  const f = SS.lineFeatures(g.stroke_segments, {start_ms: g.start_ms, end_ms: g.end_ms, word_count: (g.word_ids || []).length, gaps});
  return f || null;
}

/**
 * Reference sections from the reference lyrics. Uses your [Verse]/[Chorus]/[Bridge]... tags when the
 * reference lyrics name at least two section types; otherwise detects them: a repeated line is chorus,
 * a wordless line is vocalise, an 8 s or longer silence (an instrumental break) starts a new section, a verse-type section after
 * two choruses is a bridge and one after the last chorus is the outro.
 */
function referenceSections(map) {
  const groups = (map.groups || []).filter(g => (g.word_ids || []).length);
  const refLines = (map.reference_lyrics && map.reference_lyrics.lines) || [];
  const tagOf = {}; let cur = null; const named = new Set();
  for (const l of refLines) {
    if (l.kind === 'tag') { cur = headerType(l.text); if (cur) named.add(cur); continue; }
    if (l.kind !== 'blank') tagOf[l.id] = cur;
  }
  const useTags = named.size >= 2;
  const count = {}; groups.forEach(g => { const k = norm(g.text); count[k] = (count[k] || 0) + 1; });
  const rows = groups.map(g => ({g, t: lineTiming(map, g), kind: useTags ? (tagOf[g.line_id] || 'Verse') :
    isVocalise(g.text) ? 'Vocalise' : count[norm(g.text)] > 1 ? 'Chorus' : 'Verse'}));
  const secs = [];
  rows.forEach((r, i) => {
    const prev = secs[secs.length - 1], pr = rows[i - 1];
    const gap = pr && pr.t && r.t ? r.t.start - pr.t.end : 0;
    if (!prev || prev.kind !== r.kind || gap >= GAP_SPLIT_MS) secs.push({kind: r.kind, rows: [r]});
    else prev.rows.push(r);
  });
  if (!useTags) {
    let choruses = 0;
    const lastChorus = secs.map(s => s.kind).lastIndexOf('Chorus');
    secs.forEach((s, i) => {
      if (s.kind === 'Chorus') { choruses += 1; return; }
      if (s.kind !== 'Verse') return;
      if (lastChorus >= 0 && i > lastChorus && i === secs.length - 1) s.kind = 'Outro';
      else if (choruses >= 2) s.kind = 'Bridge';
    });
  }
  const n = {};
  return secs.map((s, i) => {
    n[s.kind] = (n[s.kind] || 0) + 1;
    const ts = s.rows.map(r => r.t).filter(Boolean);
    return {index: i, type: s.kind, label: s.kind + ' ' + n[s.kind], group_ids: s.rows.map(r => r.g.id),
      texts: s.rows.map(r => r.g.text), lines: s.rows.length,
      start_ms: ts.length ? Math.min(...ts.map(t => t.start)) : null, end_ms: ts.length ? Math.max(...ts.map(t => t.end)) : null,
      detected_from: useTags ? 'reference_tags' : 'structure', style: sectionStyle(map, s.rows, s.kind)};
  });
}

function majority(list) {
  const c = {}; let best = null;
  list.filter(Boolean).forEach(x => { c[x] = (c[x] || 0) + 1; if (best === null || c[x] > c[best]) best = x; });
  return best;
}
/** One section's measured vocal style: a generic tag plus the numbers behind it. */
function sectionStyle(map, rows, kind) {
  const V = SS.CPU_TAG_VOCABULARY;
  const durs = [], syls = [], holds = [], cls = [];
  for (const r of rows) {
    if (r.t) durs.push(Math.max(0, r.t.end - r.t.start));
    syls.push(lineSyl(r.g.text));
    const f = groupFeatures(r.g);
    if (f && map && map.vocal_range && SS.applyVocalRange) SS.applyVocalRange(f, map.vocal_range);
    if (f) {
      const c = SS.classifyLineFeatures ? SS.classifyLineFeatures(f) : null;
      if (c) cls.push(c);
      if (f.hold_ms >= 700) {
        const rel = num(f.hold_at_ms) && r.g.end_ms > r.g.start_ms ? (f.hold_at_ms - r.g.start_ms) / (r.g.end_ms - r.g.start_ms) : null;
        holds.push({ms: f.hold_ms, at_end: rel != null && rel >= 0.6});
      }
    }
  }
  const sum = a => a.reduce((x, y) => x + y, 0);
  const sung = sum(durs), sylTotal = sum(syls);
  const pace = sung > 0 ? sylTotal / (sung / 1000) : null;
  const parts = [];
  if (kind === 'Vocalise') parts.push('wordless vocalise');
  if (pace != null) parts.push(pace < 1.8 ? 'slow, spacious phrasing' : pace < 3 ? 'moderate pace' : 'quick phrasing');
  const reg = majority(cls.map(c => c.register));
  if (reg && V) parts.push(V.register[reg]);
  const dyn = cls.map(c => c.dynamics);
  if (V && dyn.length) {
    const first = dyn[0], last = dyn[dyn.length - 1], most = majority(dyn);
    const word = d => d === 'building' ? 'building' : d === 'steady' ? 'steady' : V.dynamics[d];
    if (dyn.length >= 3 && first !== last && (last === 'powerful' || last === 'building') && (first === 'soft' || first === 'restrained' || first === 'steady'))
      parts.push('builds from ' + word(first) + ' to ' + (last === 'building' ? 'stronger' : 'powerful'));
    else parts.push(V.dynamics[most]);
  }
  const longest = holds.length ? Math.max(...holds.map(h => h.ms)) : 0;
  if (holds.length) {
    const atEnd = holds.filter(h => h.at_end).length >= Math.ceil(holds.length * 0.6);
    parts.push((longest >= 1500 ? 'long held notes' : 'held notes') + (atEnd ? ' at line ends' : ''));
  } else if (cls.length) parts.push('short notes, few holds');
  const dir = majority(cls.map(c => c.direction));
  if (dir && V && cls.filter(c => c.direction === dir).length >= Math.max(2, Math.ceil(cls.length / 2))) parts.push('mostly ' + V.direction[dir].replace(/ line$/, ' lines').replace(/^rise then fall$/, 'rise-then-fall lines').replace(/^dip then recover$/, 'dip-then-recover lines'));
  return {tag: parts.length ? '[Vocal style: ' + parts.join('; ') + ']' : null,
    lines: rows.length, mean_line_ms: durs.length ? Math.round(sung / durs.length) : null,
    mean_syllables: rows.length ? r1(sylTotal / rows.length) : null, syllables_per_s: pace == null ? null : r1(pace),
    holds: holds.length, longest_hold_ms: Math.round(longest), register: reg, intensity: dyn, contour: dir, measured_lines: cls.length};
}

const BRIDGE_LIKE = {Bridge: 1, Outro: 1, Intro: 1, 'Pre-Chorus': 1};
function matchScore(b, r) {
  let s;
  if (b.type === r.type) s = 3;
  else if (r.type === 'Vocalise' || b.type === 'Vocalise') return -100; // words never follow a wordless section
  else if (b.type === 'Verse' && !b.named && BRIDGE_LIKE[r.type]) s = 1.5;
  else if (b.type === 'Chorus' && r.type === 'Outro') s = 0.5;
  else s = -2;
  return s + 1.5 * Math.min(b.lines, r.lines) / Math.max(1, b.lines, r.lines);
}
const SKIP_REF = -0.3, SKIP_MINE = -2;
/** Order-keeping match of your sections to reference sections. Marked-new sections never match. */
function alignSections(blocks, refs) {
  const n = blocks.length, m = refs.length;
  const D = Array.from({length: n + 1}, () => new Array(m + 1).fill(-Infinity));
  const P = Array.from({length: n + 1}, () => new Array(m + 1).fill(null));
  D[0][0] = 0;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) {
    const v = D[i][j]; if (v === -Infinity) continue;
    if (i < n && j < m && !blocks[i].marked_new) { const x = v + matchScore(blocks[i], refs[j]); if (x > D[i + 1][j + 1]) { D[i + 1][j + 1] = x; P[i + 1][j + 1] = 'm'; } }
    if (i < n) { const x = v + (blocks[i].marked_new ? 0 : SKIP_MINE); if (x > D[i + 1][j]) { D[i + 1][j] = x; P[i + 1][j] = 'b'; } }
    if (j < m) { const x = v + (refs[j].type === 'Vocalise' ? -0.1 : SKIP_REF); if (x > D[i][j + 1]) { D[i][j + 1] = x; P[i][j + 1] = 'r'; } }
  }
  const match = new Array(n).fill(null);
  let i = n, j = m;
  while (i > 0 || j > 0) { const p = P[i][j]; if (p === 'm') { match[i - 1] = j - 1; i--; j--; } else if (p === 'b') i--; else j--; }
  return match;
}

/** The section plan: for each of your blocks, the reference section it maps onto or inherits from. */
function planSections(map, newLyricsText) {
  const blocks = parseBlocks(newLyricsText);
  const refs = referenceSections(map);
  const match = refs.length ? alignSections(blocks, refs) : blocks.map(() => null);
  const lastMapped = match.reduce((a, x, i) => x != null ? i : a, -1);
  const hasOutro = refs.some(r => r.type === 'Outro');
  const plan = blocks.map((b, i) => {
    // A section you named keeps your name (e.g. your Verse 3 may follow the reference's second bridge).
    if (match[i] != null) { const r = refs[match[i]]; return {block: b, type: b.named ? b.type : r.type, ref: r, mapped: true}; }
    let type = b.named ? b.type : (i > lastMapped && b.type === 'Verse' && hasOutro ? 'Outro' : b.type);
    return {block: b, type, ref: null, mapped: false, reason: b.marked_new ? 'marked_new' : 'no_reference_section_left'};
  });
  // New sections inherit from the nearest earlier section of the same type (else the nearest later one,
  // else the first reference section of that type, else the nearest mapped section).
  plan.forEach((p, i) => {
    if (p.mapped) return;
    const same = k => plan[k] && plan[k].mapped && plan[k].type === p.type;
    let src = null;
    for (let k = i - 1; k >= 0 && src == null; k--) if (same(k)) src = k;
    for (let k = i + 1; k < plan.length && src == null; k++) if (same(k)) src = k;
    if (src != null) { p.ref = plan[src].ref; p.inherits_from = src; return; }
    const r = refs.find(x => x.type === p.type);
    if (r) { p.ref = r; return; }
    for (let d = 1; d < plan.length && !p.ref; d++) for (const k of [i - d, i + d]) if (plan[k] && plan[k].mapped && !p.ref) { p.ref = plan[k].ref; p.inherits_from = k; p.type_fallback = true; }
    if (!p.ref && refs.length) { p.ref = refs[0]; p.type_fallback = true; }
  });
  const n = {};
  plan.forEach(p => { n[p.type] = (n[p.type] || 0) + 1; p.label = p.type + ' ' + n[p.type]; });
  return {blocks, refs, plan};
}

function shapeNote(p, plan, i) {
  const b = p.block, r = p.ref, st = r && r.style;
  const first = '“' + (b.texts[0] || '') + '”';
  const mine = b.syllables.length ? r1(b.syllables.reduce((a, x) => a + x, 0) / b.syllables.length) : 0;
  let head = (i + 1) + '. ' + p.label + ' ' + first + ' (' + b.lines + ' line' + (b.lines === 1 ? '' : 's') + ')';
  if (!r) return head + ': no reference section to follow; no section tag.';
  const when = num(r.start_ms) ? ', ' + fmt(r.start_ms) + '–' + fmt(r.end_ms) : '';
  if (p.mapped) head += ' ← reference ' + r.label + when + ' (' + r.lines + ' line' + (r.lines === 1 ? '' : 's') + ')';
  else head += ' — NEW (' + (p.reason === 'marked_new' ? 'marked by you' : 'no reference section left, detected') + '), inherits ' +
    (p.inherits_from != null ? 'your ' + plan[p.inherits_from].label + ' = reference ' : 'reference ') + r.label + when + (p.type_fallback ? ' (no ' + p.type + ' in the reference; nearest section used)' : '');
  const bits = [];
  if (st) {
    if (st.mean_line_ms) bits.push('about ' + r1(st.mean_line_ms / 1000) + ' s and ' + st.mean_syllables + ' syllables per line (yours: ' + mine + ')');
    if (st.syllables_per_s != null) bits.push(st.syllables_per_s + ' syllables/s');
    bits.push(st.holds ? st.holds + ' held note' + (st.holds === 1 ? '' : 's') + ', longest ' + r1(st.longest_hold_ms / 1000) + ' s' : 'no long holds');
    if (st.measured_lines < r.lines) bits.push((r.lines - st.measured_lines) + ' line(s) with no contour');
    if (mine && st.mean_syllables && Math.abs(mine - st.mean_syllables) >= 3) bits.push('syllable fit: yours are ' + (mine > st.mean_syllables ? 'longer' : 'shorter') + ' than the reference lines, check by ear');
  }
  return head + '.\n   ' + (st && st.tag ? st.tag + '\n   ' : '') + bits.join('; ') + '.';
}

// v0.2.11 fix6d: optional Lift for new (extension) sections. Off by default: new sections inherit the
// measured source tags faithfully. On: the inherited tags step up one notch (register, holds, power), most of all
// on the section's final line (long hold on the last word, lifted ending). Only words from the tag vocabulary.
const REG_UP = {'low register': 'lower-mid register', 'lower-mid register': 'mid register', 'mid register': 'upper-mid register', 'upper-mid register': 'high register', 'high register': 'high register'};
const DYN_UP = {'soft': 'restrained', 'restrained': 'steady intensity', 'steady intensity': 'building intensity', 'building intensity': 'powerful', 'powerful': 'powerful'};
const ENDINGS = /^(falls away at the end|dive at the end|settles to baseline)$/i;
function liftCues(cues, opts) {
  const final = !!(opts && opts.final), last = opts && opts.lastWord;
  let out = cues.map(c => REG_UP[c] || DYN_UP[c] || c.replace(/^held note on /i, 'long sustained note on '));
  if (!out.some(c => REG_UP[c] != null)) out.unshift('upper-mid register');
  if (!out.some(c => DYN_UP[c] != null)) out.push('building intensity');
  if (final) {
    out = out.filter(c => !ENDINGS.test(c) && !DYN_UP[c]);
    out.push('powerful');
    if (last && !out.some(c => c.toLowerCase() === ('long sustained note on "' + last + '"').toLowerCase())) out.push('long sustained note on "' + last + '"');
    out.push('lifted ending');
  }
  return out.filter((c, i) => out.indexOf(c) === i);
}
function liftStyle(tag) {
  if (!tag) return tag;
  const items = tag.replace(/^\[Vocal style:\s*/, '').replace(/\]$/, '').split('; ').map(it => {
    if (REG_UP[it]) return REG_UP[it];
    if (/^builds from /.test(it)) return 'builds to powerful';
    if (DYN_UP[it]) return DYN_UP[it];
    if (/^held notes/.test(it)) return 'long ' + it;
    return it;
  });
  items.push('lifted: higher, longer holds, more power on the final words');
  return '[Vocal style: ' + items.join('; ') + ']';
}

/** Transfer with section-aware line mapping, section headers and style tags (for makeHandoff). */
function buildExtendTransfer(map, newLyricsText, opts) {
  const lift = !!(opts && opts.lift);
  const s = planSections(map, newLyricsText);
  // Per pasted block: the groups of its section, which section it belongs to, and its header (only the first
  // block of a section writes the section tag and style line).
  const blockGroups = [], blockSection = [], heads = [];
  s.plan.forEach((p, si) => p.block.block_indices.forEach((bi, k) => {
    blockGroups[bi] = p.ref ? p.ref.group_ids.slice() : []; blockSection[bi] = si;
    const st = p.ref && p.ref.style ? p.ref.style.tag : null;
    heads[bi] = k ? {continue: true} : {header: '[' + p.type + ']', style: lift && !p.mapped ? liftStyle(st) : st};
  }));
  const transfer = SS.buildTransfer(map, newLyricsText, {blockGroups, blockSection});
  transfer.section_headers = heads;
  transfer.block_section = blockSection;
  transfer.lift = lift;
  transfer.lift_sections = lift ? s.plan.map((p, i) => p.mapped ? null : i).filter(i => i != null) : [];
  transfer.section_plan = s.plan.map((p, i) => ({index: i, label: p.label, type: p.type, mapped: p.mapped, new_reason: p.mapped ? null : p.reason,
    reference_section: p.ref ? p.ref.label : null, inherits_from_section: p.inherits_from != null ? s.plan[p.inherits_from].label : null,
    first_line: p.block.texts[0] || '', lines: p.block.lines, style_tag: p.ref && p.ref.style ? (lift && !p.mapped ? liftStyle(p.ref.style.tag) : p.ref.style.tag) : null,
    lift: lift && !p.mapped, source_style_tag: p.ref && p.ref.style ? p.ref.style.tag : null}));
  const refLine = 'Reference sections (' + (s.refs[0] && s.refs[0].detected_from === 'reference_tags' ? 'from the reference lyric tags' : 'detected from repeats, wordless lines and long silences') + '): ' +
    (s.refs.length ? s.refs.map(r => r.label + (num(r.start_ms) ? ' ' + fmt(r.start_ms) : '') + ' (' + r.lines + ')').join(', ') : 'none (place the reference words first)') + '.';
  const mapped = s.plan.filter(p => p.mapped).length, extra = s.plan.length - mapped;
  const notes = ['Section map: ' + mapped + ' of your sections follow a reference section' + (extra ? ', ' + extra + ' new section(s) inherit a styled section' : '') + '. Your lyric words are unchanged.',
    refLine, ''].concat(s.plan.map((p, i) => shapeNote(p, s.plan, i))).concat(['',
    'Pace is syllables per second of singing (Song Shape does not measure BPM). Register, intensity and contour come from the measured reference contour (relative to the singer\'s own baseline, not absolute pitch). Tags describe the sound; no artist is named.']).join('\n');
  return {transfer, plan: s.plan, refs: s.refs, notes};
}

const api = {liftCues, liftStyle, EXTEND_NEW_MARK: NEW_MARK, headerType, parseExtendBlocks: parseBlocks, referenceSections, sectionStyle, alignSections, planSections, buildExtendTransfer};
root.SongShape = Object.assign(root.SongShape || {}, api);
if (typeof module !== 'undefined' && module.exports) module.exports = Object.assign(SS, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
