'use strict';
// Shared synthetic reference (made-up words) for the v0.2.11 tests.
function extendFixture(SS){
 const ref=['We hold the light','We hold the line','Who keeps the lantern burning','Who keeps the lantern burning','Ooh','We have one chance','The road is chosen','Who keeps the lantern burning','Who keeps the lantern burning','Who dares to stay','When light must fade','Burning into the night'];
 const s=SS.createSession();SS.setLyrics(s,ref.join('\n'));s.reference={title:'Song',artist:'Famous Artist'};
 let t=1000;const anchors=[],strokes=[];
 s.lyrics.lines.filter(l=>l.kind==='lyric').forEach((l,li)=>{ if(li===11) t+=20000; const t0=t;
  l.word_ids.forEach(w=>{anchors.push({id:'anchor-'+(anchors.length+1),word_id:w,line_id:l.id,word_ids:[w],kind:'word',start_ms:t,end_ms:t,needs_review:false,source:'next_word'});t+=500;});
  const pts=[];for(let x=t0;x<=t+800;x+=50)pts.push([x,Math.sin((x-t0)/700)*0.5]);strokes.push({id:'stroke-'+(li+1),start_ms:t0,end_ms:t+800,points:pts});t+=2500;});
 s.anchors=anchors;s.strokes=strokes;
 return SS.buildPerformanceMap(SS.sessionToJSON(s));
}
module.exports={extendFixture};
