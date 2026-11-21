'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const SS = require('../js/vocal-handoff.js');
let total = 0;
function test(n,fn){fn();total++;console.log('ok  '+n);}
function make() {
 const s=SS.createSession();SS.setLyrics(s,'[Verse]\nThe fire rises\nThen we return');
 s.audio={name:'reference.wav',duration_ms:6000,included_in_export:false};
 s.performer.identity='One fixed imaginary lead singer';
 return s;
}
function wave() {
 const n=650,peaks=new Float32Array(n);
 for(let i=0;i<n;i++)peaks[i]=(i<30||i>610)?0.001:0.05+(i%60<10?0.4:0.01);
 return {duration:6.5,peaks};
}
test('heuristic estimates every unplaced word and clearly flags uncertainty',()=>{
 const s=make(); const e=SS.estimateWordTimes(s,wave());
 assert.equal(e.proposals.length,6);assert(e.proposals.every(p=>p.needs_review));
 assert(e.warnings.some(w=>/NOT recognition|NOT forced alignment/i.test(w)));
 for(let i=1;i<e.proposals.length;i++)assert(e.proposals[i].start_ms>e.proposals[i-1].start_ms);
});
test('short selected range for next lyric line only',()=>{
 const x=SS.estimateWordTimes(make(),wave(),{nextLineOnly:true,start_ms:500,end_ms:2500});
 assert.equal(x.proposals.length,3);assert(x.proposals.every(p=>p.start_ms>=500&&p.start_ms<=2500));
});
test('manual anchors survive proposal adoption unchanged',()=>{
 const s=make(),a=SS.placeNextWord(s,{start_ms:580,end_ms:610,source:'human'});
 const saved=JSON.stringify(a);const est=SS.estimateWordTimes(s,wave());
 const result=SS.applyProposals(s,est);
 assert.equal(result.added,5);assert.equal(JSON.stringify(s.anchors.find(k=>k.id===a.id)),saved);
 assert.equal(s.anchors.length,6);
});
test('repeated proposal acceptance is idempotent',()=>{
 const s=make();let e=SS.estimateWordTimes(s,wave());SS.applyProposals(s,e);const c=s.anchors.length;
 assert.equal(SS.applyProposals(s,e).added,0);assert.equal(s.anchors.length,c);
});
test('invalid proposal is rejected atomically before touching session',()=>{
 const s=make(),e=SS.estimateWordTimes(s,wave());e.proposals[5].end_ms=-2;
 assert.throws(()=>SS.applyProposals(s,e));assert.equal(s.anchors.length,0);
});
test('strict word alignment imports known lyrics without silently skipping',()=>{
 const s=make();const words=s.lyrics.words.map((w,i)=>({text:w.text,start:i*.4,end:i*.4+.2,score:.97}));
 const e=SS.proposeImportedAlignment(s,{segments:[{words}]});assert.equal(e.proposals.length,6);
 assert.equal(e.proposals[1].start_ms,400);assert(e.proposals.every(p=>p.needs_review===true));
});
test('misaligned text/count and untrusted time rejected',()=>{
 const s=make(),words=s.lyrics.words.map((w,i)=>({word:w.text,start:i*.4,end:i*.4+.2}));
 assert.throws(()=>SS.proposeImportedAlignment(s,{words:words.slice(1)}),/count mismatch/);
 words[2].word='different';assert.throws(()=>SS.proposeImportedAlignment(s,{words}),/Word mismatch/);
 words[2].word=s.lyrics.words[2].text;words[3].end=-1;
 assert.throws(()=>SS.proposeImportedAlignment(s,{words}),/Invalid times/);
});
test('zero-length estimated line anchors yield timed groups after pitch draft',()=>{
 const s=make();SS.applyProposals(s,SS.estimateWordTimes(s,wave()));
 s.strokes=[{id:'stroke-1',word_id:null,start_ms:250,end_ms:4400,points:[[250,0],[1500,.8],[3000,-.7],[4400,0]],annotations:['machine_measured_pitch_draft']}];
 const m=SS.buildPerformanceMap(SS.sessionToJSON(s));
 assert(m.groups[0].end_ms>m.groups[0].start_ms);assert(m.groups[0].events.length>0);
 assert(m.groups.some(g=>g.events.some(e=>e.evidence==='machine_measured_pitch_draft')));
});
test('target words receive ordered expressive events as suggestions, never target timestamps',()=>{
 const s=make();SS.applyProposals(s,SS.estimateWordTimes(s,wave()));
 s.strokes=[{id:'stroke-1',word_id:null,start_ms:200,end_ms:5900,points:[[200,-.5],[2300,.8],[3900,-.7],[5900,0]],annotations:[]}];
 const m=SS.buildPerformanceMap(SS.sessionToJSON(s));
 const t=SS.buildTransfer(m,'[Verse]\nThe river calls me\nHome through the storm');
 const h=SS.makeHandoff(m,t);
 assert.equal(h.rows.length,2);assert.deepEqual(h.rows[0].projected_words.map(w=>w.word),['The','river','calls','me']);
 assert.equal((h.lyrics.match(/Global Vocal Direction/g)||[]).length,1);
 assert(!JSON.stringify(h.payload).includes('The fire rises'));
 assert(h.payload.caveats.includes('not word timing'));
 assert(h.rows.some(r=>r.events.some(e=>e.kind==='rise')));
 assert(h.payload.projected_lines.every(l=>l.projected_words.every(w=>!('target_start_ms' in w))));
});
test('visual SVG escapes malicious user text and contains no script or remote resources',()=>{
 const s=make();SS.applyProposals(s,SS.estimateWordTimes(s,wave()));
 const m=SS.buildPerformanceMap(SS.sessionToJSON(s));
 const h=SS.makeHandoff(m,SS.buildTransfer(m,'[Verse]\n<svg/onload=alert(1)> and mine\nnew line'));
 const svg=SS.svgPicture(m,h),html=SS.htmlReport(m,h);
 assert(svg.startsWith('<svg'));assert(svg.includes('&lt;svg/onload='));assert(!svg.includes('<script'));
 assert(!html.includes('<script'));assert(!html.includes('https://'));assert(!/\s(?:src|href)\s*=/.test(html));
});
test('full local CLI analyzes original audio + two sets of lyrics into all artifacts',()=>{
 const root=path.resolve(__dirname,'..'),work=fs.mkdtempSync(path.join(os.tmpdir(),'songshape-v025-'));
 try {
  const ref=path.join(work,'ref.txt'),mine=path.join(work,'mine.txt'),out=path.join(work,'outputs');
  fs.writeFileSync(ref,'[Verse]\nThe fire rises\nThen we return');fs.writeFileSync(mine,'[Verse]\nThe river calls\nHome again');
  const res=cp.spawnSync(process.execPath,[path.join(root,'cli','songshape.js'),'analyze',path.join(root,'demo','fictional_tone.wav'),ref,mine,'-o',out],{encoding:'utf8',timeout:30000});
  assert.equal(res.status,0,res.stderr);
  for(const f of ['project.json','performance-map.json','ai-handoff.json','ai-request.txt','tagged-lyrics.txt','visual-map.svg','visual-handoff.html','QUALITY_CHECK.json'])assert(fs.existsSync(path.join(out,f)),f);
  const data=JSON.parse(fs.readFileSync(path.join(out,'ai-handoff.json'),'utf8'));
  assert.equal(data.contains_reference_audio,false);assert.equal(data.contains_reference_lyric_text,false);
  assert(!JSON.stringify(data).includes('The fire rises'));
  const retry=cp.spawnSync(process.execPath,[path.join(root,'cli','songshape.js'),'analyze',path.join(root,'demo','fictional_tone.wav'),ref,mine,'-o',out],{encoding:'utf8',timeout:30000});
  assert.notEqual(retry.status,0);assert.match(retry.stderr,/already contains files/);
 } finally {fs.rmSync(work,{recursive:true,force:true});}
});
test('human labeled gap remains intact after machine draft acceptance',()=>{
 const s=make();s.strokes=[
  {id:'s1',start_ms:0,end_ms:500,points:[[0,0],[500,0]],annotations:[]},
  {id:'s2',start_ms:1300,end_ms:1800,points:[[1300,0],[1800,0]],annotations:[]}
 ];SS.recomputeGaps(s);SS.setGapLabel(s,500,1300,'human_marked_break','unknown');
 s.draft=SS.buildDraft([{t_ms:800,f0:220,voiced:true},{t_ms:840,f0:225,voiced:true}],{baselineHz:220});
 SS.acceptDraft(s);
 assert(s.gaps.some(g=>g.start_ms===500&&g.end_ms===1300&&g.label==='human_marked_break'));
});
console.log('\n'+total+' v0.2.5 tests passed');
