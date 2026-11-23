/* Song Shape v0.2.11 fix6d: Suno character budget. Fits a tagged lyric sheet into the lyrics box limit
   (default 5,000 characters) without ever touching a lyric word. Nothing is shortened when the full sheet
   fits. Build order (Ben):
     1. lyrics + per-line performance tags + section headers first;
     2. characters left = budget - that length;
     3. the global description (global vocal direction, section [Style] lines) is written to fit what is
        left, richest version that fits, using up to the budget but never past it.
   Only if lyrics + line tags alone are over the budget are per-line tags shortened (redundant words
   first; holds, peaks, dips and register kept; never lyric words), with a warning. CPU only, no network. */
(function (root) {
'use strict';
const DEFAULT_BUDGET = 5000;
const DEFAULT_IDENTITY = 'One consistent lead singer for all sung passages; same vocal timbre, character, and diction throughout. Intensity, register, sustain, dynamics, and expression may vary naturally. No unexpected additional singer, duet, choir handoff, or voice-character change.';
const SHORT_GLOBAL = '[Global: one consistent lead singer throughout; same timbre and diction. No duet, choir handoff, or voice change.]';
const MIN_GLOBAL = '[One lead singer throughout]';
const chars = s => String(s || '').length; // conservative browser character count (UTF-16, includes line breaks)
const norm = t => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function classify(line) {
  const t = line.trim();
  if (!t) return 'blank';
  if (!/^\[.*\]$/.test(t)) return 'lyric';
  if (/^\[Global\b/i.test(t) || t === MIN_GLOBAL) return 'global';
  if (/^\[(Vocal style|Style)\s*:/i.test(t)) return 'style';
  if (/^\[Delivery\s*:/i.test(t)) return 'delivery';
  if (/^\[Backing harmony\]$/i.test(t)) return 'hnote'; // detected harmony note: lowest priority
  if (/^\[Backing harmon/i.test(t)) return 'harmony';
  return 'header';
}
function splitItems(body) { // split on ';' outside quotes
  const out = []; let cur = '', q = false;
  for (const ch of body) {
    if (ch === '"' || ch === '\u201c' || ch === '\u201d') q = ch === '\u201c' ? true : ch === '\u201d' ? false : !q;
    if (ch === ';' && !q) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const inner = t => t.trim().replace(/^\[[^:\]]*:\s*/, '').replace(/\]$/, '');

// ---- shortening of single items ----
function shortStyleItem(it) {
  if (/^steady( intensity)?$/i.test(it)) return null;
  return it.replace(/^slow, spacious phrasing$/i, 'slow, spacious').replace(/^moderate pace$/i, 'moderate').replace(/^quick phrasing$/i, 'quick')
    .replace(/ register\b/i, '').replace(/^builds from (\w+) to /i, 'builds to ').replace(/^mostly /i, '');
}
function isQuoted(it) { return /["\u201c]/.test(it); }
function trimLineItem(it, ctx) {
  if (/^(phrase break mid-line|steady intensity|settles to baseline)$/i.test(it)) return null;
  if (/^(slow, spacious phrasing|moderate pace|quick phrasing)$/i.test(it) && ctx.pace && it.toLowerCase().indexOf(ctx.pace) === 0) return null;
  return it.replace(/^long sustained note on /i, 'long hold ').replace(/^held note on /i, 'hold ').replace(/^peak on /i, 'peak ')
    .replace(/^(rising|falling|level|up-and-down) line$/i, '$1').replace(/^climb to the peak$/i, 'climb to peak').replace(/^dip below baseline$/i, 'dip')
    .replace(/^falls away at the end$/i, 'falls away').replace(/^dive at the end$/i, 'dive at end').replace(/^lifted ending$/i, 'lifted end')
    .replace(/^building intensity$/i, 'building').replace(/^short detached notes$/i, 'short notes').replace(/^long sustained note$/i, 'long hold')
    .replace(/^(high|upper-mid|mid|lower-mid|low) register$/i, '$1').replace(/^breath \(labeled gaps only\)$/i, 'breath');
}
// minimal: direction, register, holds, peaks, dips, endings
const KEEP_MIN = /^(rising|falling|level|up-and-down|rise then fall|dip then recover|high|upper-mid|mid|lower-mid|low|long hold|hold|peak|dip|dive at end|falls away|climb to peak|lifted end)\b/i;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function parse(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const rows = []; let block = 0, sectionHeader = null, style = null;
  lines.forEach((l, i) => {
    const kind = classify(l);
    if (kind === 'header') { block += 1; sectionHeader = l.trim(); style = null; }
    const r = {kind, text: l, block, header: sectionHeader};
    if (kind === 'style') { style = r; r.items = splitItems(inner(l)); }
    if (kind === 'delivery') { r.items = splitItems(inner(l)); r.style = style; }
    rows.push(r);
  });
  // a delivery tag belongs to the next lyric line
  for (let i = 0; i < rows.length; i++) if (rows[i].kind === 'delivery') {
    for (let j = i + 1; j < rows.length; j++) { if (rows[j].kind === 'lyric') { rows[i].lyric = rows[j]; rows[j].tag = rows[i]; break; } if (rows[j].kind !== 'harmony' && rows[j].kind !== 'hnote') break; }
  }
  return rows;
}
function ctxOf(r) {
  const s = r.style && r.style.items || [];
  const pace = s.map(x => x.toLowerCase()).find(x => /^(slow|moderate|quick)/.test(x));
  return {pace: pace ? pace.split(/[ ,]/)[0] : null};
}
// per-line levels: 0 full; 1 no "phrase break mid-line"; 2 also no steady intensity / settles to baseline /
// pace already in the section style; 3 short wording; 4 minimal; 'none' removed
function renderDelivery(r) {
  const lv = r.level || 0;
  if (lv === 'none' || r.collapsed_away) return null;
  if (lv === 0) return r.text.trim();
  if (lv < 3 && !r.collapse_label) {
    const keep = r.items.filter(it => !/^phrase break mid-line$/i.test(it) &&
      (lv < 1.25 || !/^steady intensity$/i.test(it)) &&
      (lv < 1.5 || !/^settles to baseline$/i.test(it)) &&
      (lv < 2 || trimLineItem(it, ctxOf(r)) != null));
    return keep.length ? '[Delivery: ' + keep.join('; ') + ']' : null;
  }
  let items = r.items.map(it => trimLineItem(it, ctxOf(r))).filter(Boolean);
  if (lv === 4) items = items.filter(it => KEEP_MIN.test(it));
  if (r.collapse_label) items = items.filter(it => !isQuoted(it)).concat(r.collapse_label);
  if (!items.length) return null;
  return '[' + cap(items.join(', ')) + ']';
}
function render(rows) {
  const out = [];
  for (const r of rows) {
    if (r.kind === 'global') { if (r.level === 'none') continue; if (r.level === 'short') out.push(r.short); else if (r.level === 'min') out.push(MIN_GLOBAL); else out.push(r.text); continue; }
    if (r.kind === 'style') { if (r.level === 'none') continue; out.push(r.level === 'short' ? '[Style: ' + r.items.map(shortStyleItem).filter(Boolean).join('; ') + ']' : r.text); continue; }
    if (r.kind === 'delivery') { const t = renderDelivery(r); if (t) out.push(t); continue; }
    if (r.kind === 'hnote') { if (r.level !== 'none') out.push(r.text); continue; }
    if (r.kind === 'harmony') { if (r.level !== 'none') out.push(r.level === 'short' ? '[Backing harmonies]' : r.text); continue; }
    out.push(r.text);
  }
  // no blank line left at the top when the global line goes
  return out.join('\n');
}
function lyricLines(text) { return String(text || '').replace(/\r\n?/g, '\n').split('\n').filter(l => classify(l) === 'lyric').map(l => l); }

function fitSunoBudget(text, opts) {
  const budget = Math.max(200, Math.round((opts && opts.budget) || DEFAULT_BUDGET));
  const source = String(text || '');
  const rows = parse(source);
  const original = chars(source);
  const bareLyrics = rows.filter(r => r.kind === 'lyric').map(r => r.text).join('\n');
  const lyricsOnly = chars(bareLyrics);
  const steps = [];
  const G = rows.filter(r => r.kind === 'global'), S = rows.filter(r => r.kind === 'style');
  G.forEach(r => { const body = inner(r.text).replace(/\s+/g, ' ').trim(); r.short = body === DEFAULT_IDENTITY ? SHORT_GLOBAL : '[Global: ' + body + ']'; });
  const draw = () => render(rows).replace(/^\n+/, '');
  let cur;
  const fits = () => chars(cur) <= budget;

  // 1. lyrics + per-line tags + section headers first (no global description yet)
  const HN = rows.filter(r => r.kind === 'hnote');
  G.forEach(r => { r.level = 'none'; }); S.forEach(r => { r.level = 'none'; }); HN.forEach(r => { r.level = 'none'; });
  cur = draw();
  const coreFull = chars(cur);
  // 1b. only when lyrics + line tags alone are over the budget: shorten per-line tags (never lyric words)
  const blocks = [...new Set(rows.map(r => r.block))];
  function uniform(name, pick, apply) {
    if (fits()) return;
    const sel = rows.filter(pick); if (!sel.length) return;
    sel.forEach(apply); cur = draw(); steps.push(name);
  }
  const D = r => r.kind === 'delivery' && typeof (r.level || 0) === 'number';
  uniform('per-line tags without "phrase break mid-line"', r => D(r) && (r.level || 0) < 1, r => { r.level = 1; });
  uniform('without "steady intensity"', r => D(r) && r.level < 1.25, r => { r.level = 1.25; });
  uniform('without "settles to baseline"', r => D(r) && r.level < 1.5, r => { r.level = 1.5; });
  uniform('without pace words', r => D(r) && r.level < 2, r => { r.level = 2; });
  uniform('short per-line wording (holds, peaks, dips and register kept)', r => (D(r) && r.level < 3) || (r.kind === 'harmony' && !r.level), r => { r.level = r.kind === 'harmony' ? 'short' : 3; });
  if (!fits()) { // runs of one- or two-word lines sung the same way share one tag
    let did = false;
    for (const b of blocks) {
      const lyr = rows.filter(r => r.block === b && r.kind === 'lyric');
      const key = r => r.tag ? r.tag.items.map(it => trimLineItem(it, {pace: null})).filter(it => it && !isQuoted(it)).join('|') : null;
      const short = r => r.tag && r.text.trim().split(/\s+/).length <= 2;
      let i = 0;
      while (i < lyr.length) {
        let j = i;
        while (j + 1 < lyr.length && short(lyr[i]) && short(lyr[j + 1]) && key(lyr[j + 1]) === key(lyr[i]) && rows.indexOf(lyr[j + 1]) - rows.indexOf(lyr[j]) <= 3) j += 1;
        if (j > i) {
          const tags = lyr.slice(i, j + 1).map(r => r.tag);
          const longs = tags.every(t => t.items.some(it => /^long sustained note/i.test(it)));
          const holds = tags.every(t => t.items.some(it => /^(long sustained|held) note/i.test(it)));
          tags[0].collapse_label = longs ? 'long hold each word' : holds ? 'hold each word' : [];
          if (typeof tags[0].level !== 'number' || tags[0].level < 3) tags[0].level = 3;
          tags.slice(1).forEach(t => { t.collapsed_away = true; }); did = true;
        }
        i = j + 1;
      }
    }
    cur = draw(); if (did) steps.push('one tag for runs of one-word lines sung the same way');
  }
  if (!fits()) { // a chorus with the same words as an earlier chorus drops its line tags
    const seen = []; let did = false;
    for (const b of blocks) {
      const head = rows.find(r => r.block === b && r.kind === 'header');
      if (!head || !/chorus|hook/i.test(head.text)) continue;
      const key = rows.filter(r => r.block === b && r.kind === 'lyric').map(r => norm(r.text)).join('/');
      if (seen.indexOf(key) >= 0) { rows.filter(r => r.block === b && (r.kind === 'delivery' || r.kind === 'harmony')).forEach(r => { r.level = 'none'; }); did = true; }
      else seen.push(key);
    }
    cur = draw(); if (did) steps.push('repeated choruses without line tags');
  }
  uniform('minimal per-line tags (direction, register, holds, peaks, dips, endings)', r => D(r) && r.level < 4, r => { r.level = 4; });
  if (!fits()) { // last resort: line tags removed from the end of the song, one at a time
    const tagRows = rows.filter(r => (r.kind === 'delivery' || r.kind === 'harmony') && r.level !== 'none').reverse();
    for (const r of tagRows) { r.level = 'none'; cur = draw(); if (fits()) break; }
    steps.push('per-line tags removed from the end of the song');
  }
  if (!fits()) { cur = bareLyrics; steps.push('only lyric lines remain (no tags or blank gaps)'); }
  const core = chars(cur);
  const lineTagsShortened = steps.length > 0;

  // 2. characters left = budget - (lyrics + line tags)
  // 3. the global description (global vocal direction, section [Style] lines) is written to fit what is left,
  //    richest version first, then single style lines are upgraded while they still fit.
  let globalNote = 'none (no room)';
  if (!lineTagsShortened || chars(cur) < budget) {
    const variants = [['full', 'full'], ['short', 'full'], ['short', 'short'], ['min', 'short'], ['short', 'none'], ['min', 'none'], ['none', 'short'], ['none', 'none']];
    for (const [g, st] of variants) {
      if (!G.length && g !== 'none') continue;
      if (!S.length && st !== 'none') continue;
      G.forEach(r => { r.level = g === 'full' ? undefined : g; });
      S.forEach(r => { r.level = st === 'full' ? undefined : st; });
      cur = draw();
      if (fits()) {
        if (st !== 'full' && S.length) for (const r of S) { // use what is left: upgrade style lines one by one
          const prev = r.level; r.level = st === 'none' ? 'short' : undefined; cur = draw();
          if (!fits()) { r.level = prev; cur = draw(); }
        }
        const nFull = S.filter(r => r.level === undefined).length, nShort = S.filter(r => r.level === 'short').length;
        globalNote = ({full: 'full', short: 'short', min: 'one-line', none: 'no'})[g] + ' global vocal direction' +
          (S.length ? ', section [Style] lines on ' + (nFull + nShort) + ' of ' + S.length + ' sections' + (nFull && nShort ? ' (' + nFull + ' full, ' + nShort + ' short)' : nShort ? ' (short)' : nFull ? ' (full)' : '') : '');
        break;
      }
    }
  }
  if (!fits()) { G.forEach(r => { r.level = 'none'; }); S.forEach(r => { r.level = 'none'; }); cur = draw(); if (!fits()) cur = bareLyrics; }
  const beforeNotes = chars(cur);
  // 4. lowest priority: detected-harmony notes, one at a time while they still fit
  let harmonyNotes = 0;
  if (fits() && cur !== bareLyrics) for (const r of HN) { r.level = undefined; cur = draw(); if (fits()) harmonyNotes++; else { r.level = 'none'; cur = draw(); } }
  const ok = lyricLines(cur).join('\n') === lyricLines(source).join('\n'); // lyric words never change
  if (!ok) throw new Error('Song Shape budget check: lyric lines changed.');
  const used = chars(cur);
  return {text: cur, length: used, budget, remaining: budget - used, original_length: original, core_full_length: coreFull, core_length: core,
    global_length: beforeNotes - core, harmony_notes_length: used - beforeNotes, global_choice: globalNote, lyrics_only_length: lyricsOnly, fits: used <= budget, shortened: cur !== source,
    line_tags_shortened: lineTagsShortened, steps, harmony_notes: harmonyNotes, harmony_notes_total: HN.length, lyrics_over_budget: lyricsOnly > budget};
}
function budgetNote(r) {
  if (!r) return '';
  const n = x => x.toLocaleString('en-US');
  if (r.lyrics_over_budget) return 'Your lyrics alone are ' + n(r.lyrics_only_length) + ' characters, over the ' + n(r.budget) + ' limit. Song Shape never cuts lyric words: shorten the lyrics or split the song.';
  if (!r.shortened) return 'Full sheet: ' + n(r.length) + ' of ' + n(r.budget) + ' characters, ' + n(r.remaining) + ' left; nothing shortened.' + (r.harmony_notes_total ? ' Harmony notes: ' + r.harmony_notes_total + '.' : '');
  const head = 'Lyrics + line tags ' + n(r.core_length) + ' characters' + (r.line_tags_shortened ? ' (line tags shortened from ' + n(r.core_full_length) + ': ' + r.steps.join('; ') + ')' : '') +
    '; ' + n(r.budget - r.core_length) + ' left for the global description: ' + r.global_choice + ' (' + n(r.global_length) + '). ';
  return head + (r.harmony_notes_total ? 'Harmony notes: ' + r.harmony_notes + ' of ' + r.harmony_notes_total + ' fit (lowest priority' + (r.harmony_notes ? ', ' + n(r.harmony_notes_length) : '') + '). ' : '') + 'Used ' + n(r.length) + ' of ' + n(r.budget) + ', ' + n(r.remaining) + ' left.' + (r.line_tags_shortened ? ' Warning: lyrics and line tags alone were over the limit.' : '') + ' Lyric words unchanged.';
}
const api = {SUNO_DEFAULT_BUDGET: DEFAULT_BUDGET, fitSunoBudget, sunoBudgetNote: budgetNote, sheetChars: chars};
root.SongShape = Object.assign(root.SongShape || {}, api);
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
