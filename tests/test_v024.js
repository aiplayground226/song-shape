'use strict';
const assert=require('assert');
const SS=require('../js/performance-map.js');
let n=0;
function test(name,fn){fn();n++;console.log('ok '+name);}
function example(){
 const s=SS.createSession();
 SS.setLyrics(s,'[Verse]\nlantern rises\nreturns');
 const a=SS.placeNextWord(s,{start_ms:0,end_ms:2200});
 s.strokes=[
  {id:'s1',word_id:a.word_id,start_ms:0,end_ms:800,points:[[0,0],[400,0.8],[800,0.8]],annotations:[]},
  {id:'s2',word_id:a.word_id,start_ms:1100,end_ms:1900,points:[[1100,0.6],[1500,-0.8],[1900,0.0]],annotations:[]}
 ];
 a.stroke_ids=['s1','s2'];
 SS.recomputeGaps(s);return s;
}
test('new engine loaded via composed Node module',()=>assert.equal(SS.PERFORMANCE_MAP_VERSION,'0.2.5'));
test('multiple strokes of one word are kept together',()=>{
 const m=SS.buildPerformanceMap(SS.sessionToJSON(example()));
 assert.equal(m.groups.length,2);assert.deepEqual(m.groups[0].stroke_ids,['s1','s2']);
});
test('line events include dive and return to baseline',()=>{
 const ev=SS.buildPerformanceMap(SS.sessionToJSON(example())).groups[0].events;
 assert(ev.some(e=>e.kind==='fall'));assert(ev.some(e=>e.description==='recover toward baseline'));
});
test('300ms gap is unknown, not breath or silence',()=>{
 const ev=SS.buildPerformanceMap(SS.sessionToJSON(example())).groups[0].events;
 const gap=ev.find(e=>e.kind==='gap');assert(gap);assert.equal(gap.duration_ms,300);assert.equal(gap.meaning,'unknown');
});
test('replacement lyrics do not mutate reference',()=>{
 const s=example(),original=JSON.stringify(SS.sessionToJSON(s));const m=SS.buildPerformanceMap(SS.sessionToJSON(s));
 const t=SS.buildTransfer(m,'[Verse]\ncourage climbs\nreturns');
 assert.equal(t.rows[0].text,'courage climbs');assert.equal(m.groups[0].text,'lantern rises');
 assert.equal(JSON.stringify(SS.sessionToJSON(s)),original);
});
test('global singer locked once and source words not exported as replacement',()=>{
 const s=example(),m=SS.buildPerformanceMap(SS.sessionToJSON(s));
 const lyrics=SS.exportDirections(m,SS.buildTransfer(m,'[Verse]\ncourage climbs\nreturns')).lyrics;
 assert.equal((lyrics.match(/Global Vocal Direction/g)||[]).length,1);
 assert(lyrics.includes('courage climbs'));assert(!lyrics.includes('lantern rises'));
});
test('private AI payload includes no source word strings',()=>{
 const m=SS.buildPerformanceMap(SS.sessionToJSON(example()));const p=SS.aiPayload(m,SS.buildTransfer(m,'new expression'),false);
 assert.equal(p.includes_source_lyric_text,false);assert.equal(p.includes_audio,false);assert.equal(p.network_sent,false);
 assert(!JSON.stringify(p).includes('lantern rises'));
});
test('group-word count mismatch explicitly flagged',()=>{
 const m=SS.buildPerformanceMap(SS.sessionToJSON(example()));
 assert(SS.buildTransfer(m,'[Verse]\none two three four\nreturns').rows[0].status==='needs_review');
});
test('measured y baseline consistent across separate windows',()=>{
 const lo=SS.buildDraft([{t_ms:0,f0:220,voiced:true},{t_ms:40,f0:220,voiced:true}],{baselineHz:220});
 const hi=SS.buildDraft([{t_ms:2000,f0:440,voiced:true},{t_ms:2040,f0:440,voiced:true}],{baselineHz:220});
 assert.equal(lo.baseline_hz,hi.baseline_hz);assert(Math.abs(lo.strokes[0].points[0][1])<0.001);
 assert(hi.strokes[0].points[0][1]>.9);
});
test('invalid baseline rejected instead of silently substituted',()=>{
 assert.throws(()=>SS.buildDraft([], {baselineHz:-5}));
 assert.throws(()=>SS.buildDraft([],{baselineHz:Infinity}));
});
test('unvoiced interval is not automatically called silence',()=>{
 const d=SS.buildDraft([{t_ms:0,f0:220,voiced:true},{t_ms:20,f0:0,voiced:false},
  {t_ms:300,f0:220,voiced:true}],{baselineHz:220});
 assert.equal(d.gaps.length,1);assert.equal(d.gaps[0].label,'unvoiced_interval_unknown_cause');
 assert.equal(d.gaps[0].breath,'unknown');
});
test('accept draft preserves prior human trace and anchors',()=>{
 const s=example();const originalStroke=JSON.stringify(s.strokes[0]);const originalAnchor=JSON.stringify(s.anchors[0]);
 s.draft=SS.buildDraft([{t_ms:3500,f0:220,voiced:true},{t_ms:3540,f0:230,voiced:true}],{baselineHz:220});
 SS.acceptDraft(s);assert.equal(JSON.stringify(s.strokes[0]),originalStroke);
 assert.equal(JSON.stringify(s.anchors[0]),originalAnchor);
 assert.equal(s.strokes.length,3);
 assert(s.strokes[2].annotations.includes('machine_measured_pitch_draft'));
});
test('repeated acceptance is idempotent, no duplicate strokes',()=>{
 const s=example();s.draft=SS.buildDraft([{t_ms:4000,f0:220,voiced:true},{t_ms:4040,f0:230,voiced:true}]);
 SS.acceptDraft(s);const count=s.strokes.length;SS.acceptDraft(s);assert.equal(s.strokes.length,count);
});
test('reanalysis of same measured window does not duplicate after reload',()=>{
 let s=example();const frames=[{t_ms:4000,f0:220,voiced:true},{t_ms:4040,f0:230,voiced:true}];
 s.draft=SS.buildDraft(frames);SS.acceptDraft(s);
 s=SS.parseSession(SS.sessionToJSON(s));const previous=s.strokes.length;
 s.draft=SS.buildDraft(frames);SS.acceptDraft(s);assert.equal(s.strokes.length,previous);
});
test('old sessions without provenance remain readable',()=>{
 const s=example();s.draft={baseline_hz:220,accepted:true,strokes:[],gaps:[]};
 assert(SS.parseSession(SS.sessionToJSON(s)).draft.accepted);
});
test('corrected YIN 440Hz near expected on clean synthesis',()=>{
 const sr=16000,len=16000;const samples=new Float32Array(len);
 for(let i=0;i<len;i++)samples[i]=Math.sin(2*Math.PI*440*i/sr)*.5;
 const rows=SS.analyzePitchLoudness(samples,sr,{winMs:40,hopMs:100,minHz:100,maxHz:800});
 const f0=rows.filter(f=>f.voiced).map(f=>f.f0).sort((a,b)=>a-b);
 assert(f0.length>3);assert(Math.abs(f0[Math.floor(f0.length/2)]-440)<1);
});
test('draft and copied provenance survive export/import',()=>{
 let s=example();s.draft=SS.buildDraft([{t_ms:3900,f0:220,voiced:true},{t_ms:3940,f0:230,voiced:true}],{baselineHz:220});
 SS.acceptDraft(s);s=SS.parseSession(SS.sessionToJSON(s));
 assert.equal(s.draft.baseline_hz,220);assert.equal(s.draft.accepted,true);
 assert(s.strokes.at(-1).annotations.some(a=>a.startsWith('machine-draft-fingerprint:')));
});
test('local map includes original detailed strokes and annotations',()=>{
 const s=example();const m=SS.buildPerformanceMap(SS.sessionToJSON(s));
 assert.deepEqual(m.raw_strokes[0].points,s.strokes[0].points);assert.deepEqual(m.anchors[0].stroke_ids,['s1','s2']);
});
test('machine-measured draft and hand-trace semantics are separate',()=>{
 const s=example();s.draft=SS.buildDraft([{t_ms:3000,f0:220,voiced:true}]);
 const m=SS.buildPerformanceMap(SS.sessionToJSON(s));
 assert(/measured_pitch/.test(m.measured_draft.y_semantics));
 assert(/subjective_vocal_delivery/.test(m.semantics.manual_y));
});
test('exported map excludes audio and API credentials',()=>{
 const s=example();s.apiKey='secret';const m=SS.buildPerformanceMap(SS.sessionToJSON(s));
 const j=JSON.stringify(m);assert(!j.includes('secret'));assert(!j.includes('apiKey'));assert(!j.includes('baseUrl'));
});
test('separate new lyrics survive session save and import',()=>{
 const s=example();s.replacement_lyrics='[Chorus]\nNew line one\nNew line two';
 const loaded=SS.parseSession(SS.sessionToJSON(s));
 assert.equal(loaded.replacement_lyrics,s.replacement_lyrics);
 assert.equal(loaded.lyrics.lines.filter(l=>l.kind==='lyric')[0].text,'lantern rises');
});
test('legacy sessions lacking replacement lyrics stay valid',()=>{
 const obj=SS.sessionToJSON(example());delete obj.replacement_lyrics;
 assert.equal(SS.parseSession(obj).replacement_lyrics,'');
});
test('invalid replacement lyrics rejected',()=>{
 const obj=SS.sessionToJSON(example());obj.replacement_lyrics=123;
 assert.throws(()=>SS.parseSession(obj),/replacement_lyrics/);
});
test('cloud AI endpoint blocked without explicit per-page permission',()=>{
 let called=false;const previous=global.fetch;
 global.fetch=()=>{called=true;throw Error('SHOULD NOT FETCH');};
 try {
  SS.setAiConfig({enabled:true,baseUrl:'https://example.org/v1',model:'example',apiKey:''});
  SS.setAiRemoteAllowed(false);
  let err=null;SS.sendAiChat([{role:'user',content:'sample'}],e=>{err=e;});
  assert(err && /Remote\/LAN/.test(err.message));assert.equal(called,false);
  assert.equal(SS.isAiLoopbackEndpoint('http://localhost:11434/v1'),true);
  assert.equal(SS.isAiLoopbackEndpoint('http://127.0.0.1:1234/v1'),true);
  assert.equal(SS.isAiLoopbackEndpoint('https://example.org/v1'),false);
 } finally {SS.clearAiConfig();global.fetch=previous;}
});
test('pitch worker source includes corrected YIN function',()=>{
 assert(SS.pitchWorkerSource().includes('var denom = s0 - 2 * s1 + s2'));
});
console.log('\n'+n+' v0.2.4 tests passed');
