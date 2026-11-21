/* Song Shape v0.2.5: visual and text handoff of manually/locally mapped vocal contours.
   Entirely offline and deterministic. No source audio embedded. */
(function(root){
'use strict';
const SS = (typeof module !== 'undefined' && module.exports) ? require('./align-assist.js') : (root.SongShape || {});
if (typeof module !== 'undefined' && module.exports) Object.assign(SS, require('./cpu-tags.js'));
const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const numeric=x=>typeof x==='number' && Number.isFinite(x);
const round=x=>Math.round(x * 1000)/1000;
function wordProjection(map, transfer) {
  const anchors = new Map(map.anchors.map(a=>[a.word_id,a]));
  return transfer.rows.map(row => {
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
    if(refWords.length!==targetWords.length) warnings.push('target_word_count_differs_from_reference');
    if(knownRefs<refWords.length) warnings.push('reference_word_timing_incomplete');
    if(groups.some(g=>g.anchor_ids.some(id=>map.anchors.some(a=>a.id===id && a.needs_review)))) warnings.push('reference_anchor_estimates_need_confirmation');
    // Explicitly no target audio time: projected locations are a songwriting suggestion.
    return {line_id:row.line_id,text:row.text,status:warnings.length?'needs_review':row.status,
      reference_group_ids:row.reference_group_ids,reference_word_count:refWords.length,
      reference_words_timed:knownRefs,source_duration_ms:round(duration),
      projected_words:spans,events:events,
      warnings:[...new Set(warnings)],
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
  f.peak_rel=round(clamp(f.peak_ms/offset,0,1));f.hold_rel=round(clamp(f.hold_at_ms/offset,0,1));
  return f;
}
function makeHandoff(map, transfer) {
  const rows=wordProjection(map,transfer);
  const identity=((map.performer&&map.performer.identity)||SS.defaultPerformerIdentity()).replace(/\s+/g,' ').trim();
  const lines=['[Global Vocal Direction: '+identity+']',''];
  // v0.2.9: CPU tags from each line's contour features; repeated lines with the same contour keep the same tags.
  const tagRows=rows.map(r=>{const f=rowFeatures(map,r);return {text:r.text,features:f,cues:f?SS.cpuLineCues(f,r.projected_words):lineCues(r)};});
  if(SS.applyRepeatConsistency) SS.applyRepeatConsistency(tagRows,0.15);
  rows.forEach((r,i)=>{r.cpu_tags=tagRows[i].cues.slice();r.contour_features=tagRows[i].features;r.tags_repeat_of_line=tagRows[i].repeat_of;});
  let rowIndex=0;
  for(const ln of transfer.parsed_lyrics.lines) {
    if(ln.kind==='blank'){lines.push('');continue;}
    if(ln.kind==='tag'){if(/^\[(Verse|Chorus)\]$/.test(ln.text))lines.push(ln.text);continue;}
    const row=rows[rowIndex++];const cues=row.cpu_tags;
    if(cues.length) lines.push('[Delivery: '+cues.join('; ')+']');
    if(map.groups.some(g=>row.reference_group_ids.includes(g.id)&&g.harmony)) lines.push('[Backing harmonies support the same lead]');
    lines.push(ln.text);
  }
  const warnings=[...new Set([...transfer.warnings,...rows.flatMap(r=>r.warnings)])];
  const info='Estimated target-word positions are proportional syllable mapping, not word timing from target audio. '
    +'Trace height is perceived delivery; measured-pitch drafts are separate. '
    +'An unmarked gap does not establish a breath or silence. '
    +'The generator may disregard or reinterpret vocal tags. Review before sharing.';
  const payload={schema_version:'songshape-visual-handoff-0.2.5',task:'adapt_performance_tags_to_original_lyrics',
    instructions:'Preserve the new lyrics EXACTLY and preserve line breaks. The chart and events show expressive vocal movement, not a melody transcription. Compose concise performance tags for each lyric line and salient words: relative rises, descents, holds, dives and recoveries. Start from each line cpu_tags (the Song Shape vocabulary) and keep that vocabulary; lines sung the same way (same contour, e.g. a repeated chorus) keep the same tags; change tags only where the contour differs. Use one constant, user-selected lead singer. Never infer a singer change from movement or backing harmonies. Do not claim precise syllable alignment; if mismatched, propose alternatives and clearly flag fit issues. Do not invent breaths from unmarked gaps. Do not name or imitate the reference artist. Return two separate blocks: [Tagged lyrics] and [Style prompt], then [Uncertainties].',
    intended_lead_identity:identity,original_new_lyrics:transfer.original_lyrics,
    projected_lines:rows.map(r=>({text:r.text,status:r.status,reference_duration_ms:r.source_duration_ms,cpu_tags:r.cpu_tags,same_tags_as_line:r.tags_repeat_of_line==null?null:r.tags_repeat_of_line+1,
      projected_words:r.projected_words,events:r.events,warnings:r.warnings})),
    caveats:info,warnings,contains_reference_audio:false,contains_reference_lyric_text:false,
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
const api={wordProjection,makeHandoff,svgPicture,htmlReport};
root.SongShape=Object.assign(root.SongShape||{},api);
if(typeof module!=='undefined'&&module.exports)module.exports=Object.assign(SS,api);
})(typeof globalThis!=='undefined'?globalThis:this);
