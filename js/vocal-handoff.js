/* Song Shape v0.2.5: visual and text handoff of manually/locally mapped vocal contours.
   Entirely offline and deterministic. No source audio embedded. */
(function(root){
'use strict';
const SS = (typeof module !== 'undefined' && module.exports) ? require('./align-assist.js') : (root.SongShape || {});
if (typeof module !== 'undefined' && module.exports) Object.assign(SS, require('./cpu-tags.js'), require('./vocal-range.js'));
const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const numeric=x=>typeof x==='number' && Number.isFinite(x);
const round=x=>Math.round(x * 1000)/1000;
// v0.2.11 fix7: fit notes are reported but never block a line; a count difference beyond the tolerance does.
const FIT_NOTES=['target_word_count_differs_from_reference','word_count_differs_within_tolerance'];
const tolerance=n=>SS.wordCountTolerance?SS.wordCountTolerance(n):Math.max(1,Math.round(0.35*(n||0)));
function wordProjection(map, transfer) {
  const anchors = new Map(map.anchors.map(a=>[a.word_id,a]));
  const counts=transfer.rows.map(row=>transfer.parsed_lyrics.words.filter(w=>w.line_id===row.line_id).length);
  const runWords=SS.splitRunWords?SS.splitRunWords(transfer.rows.map(r=>r.reference_group_ids),counts):counts;
  return transfer.rows.map((row,rowI) => {
    const targetWords = transfer.parsed_lyrics.words.filter(w=>w.line_id===row.line_id);
    const groups = row.reference_group_ids.map(id=>map.groups.find(g=>g.id===id)).filter(Boolean);
    const groupRanges = groups.filter(g=>numeric(g.start_ms)&&numeric(g.end_ms)&&g.end_ms>g.start_ms);
    const duration = groupRanges.reduce((sum,g)=>sum+g.end_ms-g.start_ms,0);
    const weights=targetWords.map(w=>SS.syllables(w.text));
    const total=weights.reduce((a,b)=>a+b,0)||1;
    const spans=[];let pos=0;
    for(let i=0;i<targetWords.length;i++) {
      const a=pos/total;pos+=weights[i];const b=pos/total;
      spans.push({word:targetWords[i].text,word_id:targetWords[i].id,syllable_estimate:weights[i],relative_start:round(a),relative_end:round(b),
        event_kinds:[],descriptions:[]});
    }
    const events=[];
    let elapsed=0;
    for(const g of groupRanges) {
      const span = g.end_ms-g.start_ms;
      for(const e of g.events) {
        const time = numeric(e.end_ms) && numeric(e.start_ms) ? (e.start_ms+e.end_ms)/2 : g.start_ms;
        const relative = clamp((elapsed+clamp(time-g.start_ms,0,span))/duration,0,1);
        const wIndex = spans.findIndex((w,i)=>relative>=w.relative_start && (relative<w.relative_end || i===spans.length-1));
        const word = wIndex>=0?spans[wIndex]:null;
        const event = {kind:e.kind, description:e.description, normalized_position:round(relative),
          reference_start_ms:e.start_ms,reference_end_ms:e.end_ms,
          target_word_index:wIndex<0?null:wIndex,target_word:word?word.word:null,
          evidence:e.evidence || 'stroke_geometry',meaning:e.meaning||null};
        events.push(event);
        if(word && e.kind !== 'gap' && e.kind !== 'start' && e.kind !== 'pickup') {
          if(!word.event_kinds.includes(e.kind)) word.event_kinds.push(e.kind);
          if(!word.descriptions.includes(e.description)) word.descriptions.push(e.description);
        }
      }
      elapsed+=span;
    }
    // An unanchored or zero-duration group cannot support precise placement.
    const refWords=groups.flatMap(g=>g.word_ids).filter((id,i,a)=>a.indexOf(id)===i);
    const knownRefs=refWords.filter(id=>anchors.has(id)).length;
    const warnings=row.reasons.slice();
    if(!duration) warnings.push('reference_line_duration_unknown');
    if(refWords.length!==targetWords.length) warnings.push(Math.abs(refWords.length-targetWords.length)>tolerance(refWords.length)&&Math.abs(refWords.length-runWords[rowI])>tolerance(refWords.length)?'word_or_line_count_mismatch':'target_word_count_differs_from_reference');
    if(knownRefs<refWords.length) warnings.push('reference_word_timing_incomplete');
    // v0.2.11 fix7: machine-estimated word times are one global caveat (payload.estimate_caveat), not a per-line flag.
    const estimated=groups.some(g=>g.anchor_ids.some(id=>map.anchors.some(a=>a.id===id && a.needs_review)));
    // Explicitly no target audio time: projected locations are a songwriting suggestion.
    // v0.2.11: a different word count is a fit note (new lyrics usually differ), not a timing problem.
    const blocking=warnings.filter(w=>FIT_NOTES.indexOf(w)<0);
    return {line_id:row.line_id,text:row.text,status:blocking.length?'needs_review':(row.status==='needs_review'&&!blocking.length?'line_level_draft':row.status),fit_notes:warnings.filter(w=>FIT_NOTES.indexOf(w)>=0),
      reference_group_ids:row.reference_group_ids,reference_word_count:refWords.length,
      reference_words_timed:knownRefs,source_duration_ms:round(duration),
      projected_words:spans,events:events,
      warnings:[...new Set(warnings)],reference_words_estimated:estimated,
      projection_method:'syllable_weighted_proportion_NOT_acoustic_target_word_alignment'};
  });
}
function describeEvent(ev) {
  if(ev.kind==='start') return ev.description;
  if(ev.kind==='gap') return ev.meaning==='label_present' ? 'labeled interval ('+ev.description+')' : 'unmarked interval (meaning unknown)';
  if(ev.kind==='pickup') return 'trace resumes';
  if(ev.kind==='hold') return 'hold';
  if(ev.description==='recover toward baseline') return 'recover toward baseline';
  if(ev.description==='fall below baseline') return 'dip below baseline';
  return ev.kind==='fall'?'descend':ev.kind==='rise'?'rise':ev.description;
}
function lineCues(projected) {
  // v0.2.4-v0.2.8 event-by-event cues; still used when a line has no usable contour points.
  const cues=[];
  for(const ev of projected.events) {
    if(ev.kind==='gap' || ev.kind==='pickup') continue;
    const short=describeEvent(ev);
    const label=ev.target_word?'on "'+ev.target_word+'"':'in the phrase';
    const cue=ev.kind==='start'?short:short+' '+label;
    if(cues[cues.length-1]!==cue) cues.push(cue);
  }
  return cues.filter((v,i,a)=>i===0||v!==a[i-1]).slice(0,8);
}
/** v0.2.9: contour features of the reference line(s) a new line is mapped onto. */
function rowFeatures(map, row) {
  if(!SS.lineFeatures) return null;
  const groups=row.reference_group_ids.map(id=>map.groups.find(g=>g.id===id)).filter(g=>g&&numeric(g.start_ms)&&numeric(g.end_ms)&&g.end_ms>g.start_ms);
  if(!groups.length) return null;
  // Lay several reference lines end to end (same timeline the projected words use).
  let offset=0;const segs=[];const gaps=[];let words=0;
  for(const g of groups){
    const shift=offset-g.start_ms;
    for(const s of g.stroke_segments||[]) segs.push({start_ms:s.start_ms+shift,end_ms:s.end_ms+shift,points:(s.points||[]).map(p=>[p[0]+shift,p[1]])});
    for(const e of g.events||[]) if(e.kind==='gap'&&e.meaning==='label_present') gaps.push({label:e.description});
    words+=(g.word_ids||[]).length;
    offset+=g.end_ms-g.start_ms;
  }
  const f=SS.lineFeatures(segs,{start_ms:0,end_ms:offset,word_count:words,gaps});
  if(!f) return null;
  if(map.vocal_range&&SS.applyVocalRange) SS.applyVocalRange(f,map.vocal_range);
  f.peak_rel=round(clamp(f.peak_ms/offset,0,1));f.hold_rel=round(clamp(f.hold_at_ms/offset,0,1));
  return f;
}
// v0.2.11 fix7: very short lines (1-2 words). A short line that the user split off a longer sung line (same
// reference line(s) as the line before) has no tag of its own: the line before carries it. Any other short
// line keeps only the essentials: direction, register, a hold and a peak.
const SHORT_LINE_WORDS=2;
const ESSENTIAL_CUE=/^(rising line|falling line|rise then fall|dip then recover|up-and-down line|level line|[a-z-]+ register|long sustained note|held note|peak on)\b/i;
function shortLinePolicy(rows){
  const count=t=>String(t||'').split(/\s+/).filter(Boolean).length;
  const same=(a,b)=>a.length>0&&a.length===b.length&&a.every((x,i)=>x===b[i]);
  rows.forEach((r,i)=>{
    if(count(r.text)>SHORT_LINE_WORDS||!r.cpu_tags.length) return;
    let head=i-1;while(head>=0&&rows[head].merged_with_line!=null) head=rows[head].merged_with_line-1;
    if(i>0&&same(r.reference_group_ids,rows[i-1].reference_group_ids)&&head>=0){
      r.short_line={rule:'merged_with_previous_line',from:r.cpu_tags.slice()};r.merged_with_line=head+1;r.cpu_tags=[];return;}
    const kept=r.cpu_tags.filter(c=>ESSENTIAL_CUE.test(c));
    if(kept.length&&kept.length<r.cpu_tags.length){r.short_line={rule:'trimmed_to_essentials',from:r.cpu_tags.slice()};r.cpu_tags=kept;}
  });
  return rows;
}
// v0.2.11 fix7: a section's [Vocal style] pace must not contradict its own lines. Most lines rapid -> quick
// phrasing; most lines spacious -> slow, spacious phrasing; otherwise a pace term that any line contradicts is dropped.
const PACE=/^(slow, spacious phrasing|moderate pace|quick phrasing)$/i;
function reconcileSectionStyle(style, lineCues){
  if(!style||!/^\[Vocal style:/.test(style)) return style;
  const items=style.replace(/^\[Vocal style:\s*/,'').replace(/\]$/,'').split('; ');
  const tagged=lineCues.filter(c=>c&&c.length);
  if(!tagged.length) return style;
  const rapid=tagged.filter(c=>c.includes('rapid phrasing')).length, spacious=tagged.filter(c=>c.includes('slow, spacious phrasing')).length;
  const at=items.findIndex(it=>PACE.test(it));
  let pace=at>=0?items[at]:null;
  if(rapid>tagged.length/2) pace='quick phrasing';
  else if(spacious>tagged.length/2) pace='slow, spacious phrasing';
  else if(pace&&((/slow/i.test(pace)&&rapid)||(/quick/i.test(pace)&&spacious))) pace=null;
  const out=items.filter(it=>!PACE.test(it));
  if(pace) out.splice(at>=0?at:(out[0]==='wordless vocalise'?1:0),0,pace);
  return out.length?'[Vocal style: '+out.join('; ')+']':null;
}
function makeHandoff(map, transfer) {
  const rows=wordProjection(map,transfer);
  const identity=((map.performer&&map.performer.identity)||SS.defaultPerformerIdentity()).replace(/\s+/g,' ').trim();
  const lines=['[Global Vocal Direction: '+identity+']',''];
  // v0.2.9: CPU tags from each line's contour features; repeated lines with the same contour keep the same tags.
  const tagRows=rows.map(r=>{const f=rowFeatures(map,r);return {text:r.text,features:f,cues:f?SS.cpuLineCues(f,r.projected_words):lineCues(r)};});
  if(SS.applyRepeatConsistency) SS.applyRepeatConsistency(tagRows,SS.CPU_TAG_REPEAT_TOLERANCE!=null?SS.CPU_TAG_REPEAT_TOLERANCE:0.7);
  // v0.2.11: a line with no measured contour reuses the tags of the same line sung elsewhere (same words).
  const normText=t=>String(t||'').toLowerCase().replace(/(\w)-(\w)/g,'$1$2').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  tagRows.forEach((t,i)=>{ if(t.cues.length) return; const j=tagRows.findIndex((o,k)=>k!==i&&o.cues.length&&o.features&&normText(o.text)===normText(t.text)); if(j>=0){t.cues=tagRows[j].cues.slice();t.repeat_of=j;} });
  rows.forEach((r,i)=>{r.cpu_tags=tagRows[i].cues.slice();r.contour_features=tagRows[i].features;r.tags_repeat_of_line=tagRows[i].repeat_of;});
  shortLinePolicy(rows);
  // v0.2.11 fix6d: Lift (optional, Step 2): rows of new sections get stepped-up tags; the final line of each most.
  const liftSet=new Set(transfer.lift&&Array.isArray(transfer.lift_sections)?transfer.lift_sections:[]);
  if(liftSet.size&&SS.liftCues&&Array.isArray(transfer.block_section)){
    let bi=-1,ri=0;const rowSec=[];
    for(const ln of transfer.parsed_lyrics.lines){if(ln.kind==='tag'){bi++;continue;}if(ln.kind==='blank')continue;rowSec[ri++]=transfer.block_section[bi];}
    rows.forEach((r,i)=>{const sec=rowSec[i];if(!liftSet.has(sec)||r.merged_with_line!=null)return;
      const final=rowSec[i+1]!==sec;const words=String(r.text||'').split(/\s+/).filter(Boolean);const lastWord=words.length?words[words.length-1]:null;
      const before=r.cpu_tags.slice();r.cpu_tags=SS.liftCues(before,{final,lastWord});r.lift={section_index:sec,final_line:final,from:before,to:r.cpu_tags.slice()};});
  }
  let rowIndex=0,blockIndex=-1;
  // v0.2.11 fix6 (Extend): section headers and per-section style tags from the section map, when given.
  let heads=Array.isArray(transfer.section_headers)?transfer.section_headers:null;
  // v0.2.11 fix7: section style pace agrees with the section's own line tags (header and section_plan both).
  if(heads&&Array.isArray(transfer.block_section)){
    const secRows={};let bi=-1,ri=0;
    for(const ln of transfer.parsed_lyrics.lines){if(ln.kind==='tag'){bi++;continue;}if(ln.kind==='blank')continue;const sec=transfer.block_section[Math.max(0,bi)];(secRows[sec]=secRows[sec]||[]).push(rows[ri++]);}
    heads=heads.map((h,b)=>{if(!h||h.continue||!h.style)return h;const sec=transfer.block_section[b];const st=reconcileSectionStyle(h.style,(secRows[sec]||[]).map(r=>r.cpu_tags));return st===h.style?h:Object.assign({},h,{style:st,style_before_reconcile:h.style});});
    if(Array.isArray(transfer.section_plan)) transfer.section_plan.forEach(p=>{if(!p||!p.style_tag)return;const st=reconcileSectionStyle(p.style_tag,(secRows[p.index]||[]).map(r=>r.cpu_tags));if(st!==p.style_tag){p.style_tag_before_reconcile=p.style_tag;p.style_tag=st;}});
  }
  for(const ln of transfer.parsed_lyrics.lines) {
    if(ln.kind==='blank'){lines.push('');continue;}
    if(ln.kind==='tag'){blockIndex++;const h=heads&&heads[blockIndex];
      if(h&&h.continue){if(lines.length&&lines[lines.length-1]!=='')lines.push('');}
      else if(h){lines.push(h.header);if(h.style)lines.push(h.style);}
      else if(/^\[(Verse|Chorus)\]$/.test(ln.text))lines.push(ln.text);continue;}
    const row=rows[rowIndex++];const cues=row.cpu_tags;
    if(cues.length) lines.push('[Delivery: '+cues.join('; ')+']');
    if(map.groups.some(g=>row.reference_group_ids.includes(g.id)&&g.harmony)) lines.push('[Backing harmonies support the same lead]');
    // v0.2.11 fix6e: a detected (not user-marked) harmony section; the Suno budget keeps it only if there is room left.
    else if(map.groups.some(g=>row.reference_group_ids.includes(g.id)&&(g.detected_harmony||[]).length)) lines.push('[Backing harmony]');
    lines.push(ln.text);
  }
  const warnings=[...new Set([...transfer.warnings,...rows.flatMap(r=>r.warnings)])];
  const nEstimated=rows.filter(r=>r.reference_words_estimated).length;
  const estimateCaveat=nEstimated?'The reference word positions under '+nEstimated+' of '+rows.length+' line(s) are machine estimates (aligner, CPU timing or your taps), not hand-checked. Treat word-level timing as approximate everywhere; lines marked needs_review have a specific problem listed in their warnings.':null;
  const info='Estimated target-word positions are proportional syllable mapping, not word timing from target audio. '
    +'Trace height is perceived delivery; measured-pitch drafts are separate. '
    +'An unmarked gap does not establish a breath or silence. '
    +'The generator may disregard or reinterpret vocal tags. Review before sharing.'+(estimateCaveat?' '+estimateCaveat:'');
  const payload={schema_version:'songshape-visual-handoff-0.2.5',task:'adapt_performance_tags_to_original_lyrics',
    instructions:'Preserve the new lyrics EXACTLY and preserve line breaks. The chart and events show expressive vocal movement, not a melody transcription. Compose concise performance tags for each lyric line and salient words: relative rises, descents, holds, dives and recoveries. Start from each line cpu_tags (the Song Shape vocabulary) and keep that vocabulary; lines sung the same way (same contour, e.g. a repeated chorus) keep the same tags; change tags only where the contour differs. Use one constant, user-selected lead singer. Never infer a singer change from movement or backing harmonies. Do not claim precise syllable alignment; if mismatched, propose alternatives and clearly flag fit issues. Do not invent breaths from unmarked gaps. Do not name or imitate the reference artist. Return two separate blocks: [Tagged lyrics] and [Style prompt], then [Uncertainties].',
    intended_lead_identity:identity,original_new_lyrics:transfer.original_lyrics,
    projected_lines:rows.map(r=>({text:r.text,status:r.status,reference_duration_ms:r.source_duration_ms,cpu_tags:r.cpu_tags,same_tags_as_line:r.tags_repeat_of_line==null?null:r.tags_repeat_of_line+1,
      merged_with_line:r.merged_with_line==null?null:r.merged_with_line,short_line_rule:r.short_line?r.short_line.rule:null,
      projected_words:r.projected_words,events:r.events,warnings:r.warnings})),
    sections:Array.isArray(transfer.section_plan)?transfer.section_plan:null,
    caveats:info,estimate_caveat:estimateCaveat,warnings,contains_reference_audio:false,contains_reference_lyric_text:false,
    contains_source_artist:false,network_transmitted:false};
  const prompt='You are adapting vocal delivery tags for MY ORIGINAL lyrics. This is a visual/structured contour reference, not a request to copy the original voice or melody.\n\n'
    +JSON.stringify(payload,null,2)+'\n\nThe picture (if attached) shows the same contours. If you cannot view it, use the structured events. '
    +'Preserve every lyric word exactly.';
  return {rows,lyrics:lines.join('\n').replace(/\n{3,}/g,'\n\n'),prompt,payload,warnings,caveats:info};
}
function linePath(group, x, y, width, height, provenance) {
  if(!group) return '';
  const segments=(group.stroke_segments||[]).filter(stroke=> provenance === 'machine' ? (stroke.annotations||[]).includes('machine_measured_pitch_draft') : !(stroke.annotations||[]).includes('machine_measured_pitch_draft')); 
  const start=group.start_ms,end=group.end_ms, span=end-start;
  if(!(numeric(start)&&numeric(end)&&span>0)) return '';
  return segments.filter(s=>s.points&&s.points.length).map(s=>{
    const pts=s.points.filter(p=>numeric(p[0])&&numeric(p[1]));
    return pts.map((p,i)=>`${i?'L':'M'}${round(x+clamp((p[0]-start)/span,0,1)*width)} ${round(y+(1-clamp(p[1],-1,1))*height/2)}`).join(' ');
  }).join(' ');
}
function svgPicture(map, handoff, opts) {
  opts=opts||{};
  const maxLines=100;
  const rows=handoff.rows.slice(0,maxLines);
  const width=1200, header=92,rowHeight=176,height=header+rows.length*rowHeight+52;
  const left=82, graphWidth=1050, graphH=90;
  const parts=[`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Song Shape expressive vocal contour for original lyrics">`,
    '<rect width="100%" height="100%" fill="#f8fafc"/>',
    '<text x="40" y="42" font-size="26" font-weight="700" fill="#0f172a">Song Shape · Vocal performance map</text>',
    '<text x="40" y="69" font-size="15" fill="#475569">Replacement lyrics fitted to reference contours · not measured target-note timing</text>'];
  for(let i=0;i<rows.length;i++) {
    const row=rows[i],y=header+i*rowHeight;
    const groups=map.groups.filter(g=>row.reference_group_ids.includes(g.id) &&
      numeric(g.start_ms)&&numeric(g.end_ms)&&g.end_ms>g.start_ms);
    const totalGroupDuration=groups.reduce((sum,g)=>sum+g.end_ms-g.start_ms,0);
    parts.push(`<rect x="22" y="${y}" width="1155" height="${rowHeight-10}" rx="13" fill="white" stroke="#dce5ed"/>`);
    parts.push(`<text x="42" y="${y+27}" font-size="17" font-weight="600" fill="#0f172a">${esc((i+1)+'. '+row.text.slice(0,100))}</text>`);
    const graphTop=y+38,graphMid=graphTop+graphH/2;
    parts.push(`<rect x="${left}" y="${graphTop}" width="${graphWidth}" height="${graphH}" rx="5" fill="#f1f5f9"/>`);
    parts.push(`<path d="M${left} ${graphMid} H${left+graphWidth}" stroke="#94a3b8" stroke-dasharray="5 5"/>`);
    for(const word of row.projected_words){
      const xp=left+word.relative_start*graphWidth;
      parts.push(`<line x1="${round(xp)}" y1="${graphTop}" x2="${round(xp)}" y2="${graphTop+graphH}" stroke="#64748b" stroke-opacity="0.13"/>`);
      if(word.event_kinds.length) parts.push(`<rect x="${round(xp)}" y="${graphTop+2}" width="${round(Math.max(1,(word.relative_end-word.relative_start)*graphWidth))}" height="${graphH-4}" fill="#ccfbf1" opacity="0.55"/>`);
    }
    let anyPath=false, elapsedGroup=0;
    for(const group of groups){
      const startX=left+elapsedGroup/totalGroupDuration*graphWidth;
      const partWidth=(group.end_ms-group.start_ms)/totalGroupDuration*graphWidth;
      const handPath=linePath(group,startX,graphTop,partWidth,graphH,'human');
      const machinePath=linePath(group,startX,graphTop,partWidth,graphH,'machine');
      if(handPath){anyPath=true;parts.push(`<path d="${handPath}" fill="none" stroke="#0f766e" stroke-width="3.5" stroke-linecap="round"/>`);}
      if(machinePath){anyPath=true;parts.push(`<path d="${machinePath}" fill="none" stroke="#7c3aed" stroke-width="3" stroke-dasharray="7 4" stroke-linecap="round"/>`);}
      elapsedGroup+=group.end_ms-group.start_ms;
    }
    if(!anyPath) parts.push(`<text x="${left+10}" y="${graphMid}" font-size="14" fill="#a16207">No trace / no timed source range</text>`);
    for(const word of row.projected_words) {
      const cx=left+(word.relative_start+word.relative_end)/2*graphWidth;
      parts.push(`<text x="${round(cx)}" y="${graphTop+graphH+21}" text-anchor="middle" font-size="${word.word.length>12?10:12}" fill="#334155">${esc(word.word.slice(0,22))}</text>`);
    }
    const info=row.warnings.length?'Review: '+row.warnings.join(', '):'Draft contour · verify delivery by ear';
    parts.push(`<text x="42" y="${y+160}" font-size="11" fill="#64748b">${esc(info.slice(0,175))}</text>`);
  }
  if(handoff.rows.length>maxLines)parts.push(`<text x="40" y="${height-22}" fill="#a16207">Showing first ${maxLines} lines; the JSON handoff contains all lines.</text>`);
  else parts.push(`<text x="40" y="${height-22}" fill="#64748b" font-size="12">Teal = human expressive trace; dashed purple = computer-measured frequency; grey = relative baseline. No source audio.</text>`);
  return parts.join('\n')+'</svg>';
}
function htmlReport(map, handoff) {
  const svg=svgPicture(map,handoff);
  // Everything rendered is escaped static text; no external links, resources, scripts, or audio.
  return '<!DOCTYPE html><html lang="en"><meta charset="utf-8"><title>Song Shape - visual vocal map</title>'+
    '<style>body{font-family:system-ui, sans-serif;background:#edf2f7;color:#0f172a;margin:20px auto;max-width:1240px;padding:10px}'+
    'section{background:white;padding:20px;margin:14px 0;border-radius:12px}svg{width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}'+
    '.note{color:#92400e}</style><main><h1>Song Shape · private offline handoff</h1><p>Generated locally; no uploaded audio, external resources or network connections.</p>'+
    '<section>'+svg+'</section><section><h2>Locally drafted lyric tags</h2><pre>'+esc(handoff.lyrics)+'</pre></section>'+
    '<section><h2>Copy/paste into your chosen AI</h2><p class="note">The AI request contains your replacement lyrics and contour events. Review before transmitting to an outside provider.</p><pre>'+esc(handoff.prompt)+'</pre></section>'+
    '<section><h2>Uncertainty</h2><pre>'+esc(handoff.caveats+'\n'+handoff.warnings.join('\n'))+'</pre></section></main></html>';
}
const api={wordProjection,makeHandoff,svgPicture,htmlReport,reconcileSectionStyle,shortLinePolicy};
root.SongShape=Object.assign(root.SongShape||{},api);
if(typeof module!=='undefined'&&module.exports)module.exports=Object.assign(SS,api);
})(typeof globalThis!=='undefined'?globalThis:this);
