'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const SS=require('../js/extend.js');Object.assign(SS,require('../js/suno-budget.js'),require('../js/performance-json.js'),require('../js/harmony-detect.js'),require('../js/vocal-range.js'));require('../js/ai.js');require('../js/ai-chain.js');
Object.assign(SS,require('../js/contour-clean.js'),require('../js/word-onset.js'),require('../js/ai-tools.js'),require('../js/helper-client.js'));
const tests=[];function test(n,f){tests.push([n,f]);}
const hz=m=>440*Math.pow(2,(m-69)/12);
const frames=arr=>arr.map((m,i)=>({t_ms:i*30,f0:m==null?0:hz(m),voiced:m!=null,rms:m==null?0:.05}));

test('quiet stem uses an adaptive RMS gate; silence has a floor',()=>{
 const quiet=new Float32Array(16000).fill(.03);assert(SS.adaptiveSilenceRms(quiet,16000)<.02);assert.equal(SS.adaptiveSilenceRms(new Float32Array(1000),16000),.002);
});
test('one-frame octave spike folds to the local pitch',()=>{
 const a=frames([60,60,60,60,72,60,60,60,60]);const r=SS.cleanPitchFrames(a,{minRunMs:0});assert(r.stats.octave_folded>=1);assert(Math.abs(r.frames[4].f0-hz(60))<1);assert.equal(a[4].f0,hz(72),'input kept intact');
});
test('short gaps join dots into strokes; long gaps remain unknown',()=>{
 const a=frames([60,60,60,null,null,60,60,60,...Array(9).fill(null),60,60,60]);const r=SS.cleanPitchFrames(a);assert.equal(r.stats.frames_bridged,2);assert(r.frames[4].voiced);assert(!r.frames[12].voiced);
 const d=SS.buildDraft(a,{cleanup:true});assert.equal(d.strokes.length,2);assert.equal(d.gaps[0].breath,'unknown');
});
test('isolated dots are removed; real sustained octave leaps stay',()=>{
 const r=SS.cleanPitchFrames(frames([null,60,...Array(8).fill(null),...Array(20).fill(60),...Array(20).fill(72),null]));assert(!r.frames[1].voiced);assert(r.frames[46].f0>hz(70));
});
test('vowel target: first vowel, second of double, y not at start',()=>{
 assert.equal(SS.vowelTarget('we').index,1);assert.equal(SS.vowelTarget('our').index,1);assert.equal(SS.vowelTarget('dreams').index,3);assert.equal(SS.vowelTarget('my').index,1);assert.equal(SS.vowelTarget('you').index,2);
});
test('letter vowel target and signal time are different, with roundtrip export',()=>{
 const s=SS.createSession();SS.setLyrics(s,'we our');
 const data={words:[{text:'we',start:1,end:2,chars:[{c:'w',start:1,end:1.1},{c:'e',start:1.1,end:2}]},{text:'our',start:2.5,end:3.3,chars:[{c:'o',start:2.5,end:2.7},{c:'u',start:2.7,end:3},{c:'r',start:3,end:3.3}]}]};
 const p=SS.proposeImportedAlignment(s,data);assert.equal(p.proposals[0].start_ms,1100);assert.equal(p.proposals[1].start_ms,2700);assert.equal(p.proposals[1].signal_ms,2500);
 SS.applyProposals(s,p);const rt=SS.parseSession(SS.sessionToJSON(s));assert.equal(rt.anchors[0].signal_ms,1000);assert.match(rt.anchors[1].anchor_rule,/second_vowel/);
});
test('CPU energy vowel moves off a quiet consonant into the vowel energy',()=>{
 const sr=16000,x=new Float32Array(sr);for(let i=0;i<sr;i++)x[i]=(i<1600?.01:.2)*Math.sin(i*2*Math.PI*220/sr);
 const v=SS.vowelOnsetFromAudio(x,sr,0);assert(v>=80&&v<=115,v);
});
test('replace CPU layer preserves hand/AI and word-linked machine strokes',()=>{
 const s={strokes:[{id:'h',annotations:[]},{id:'a',annotations:['ai_drafted_trace']},{id:'m',annotations:['machine_measured_pitch_draft']},{id:'linked',annotations:['machine_measured_pitch_draft']}],anchors:[{stroke_ids:['linked']}]};
 assert.equal(SS.removeUnlinkedMachineDraft(s),1);assert.deepEqual(s.strokes.map(x=>x.id),['h','a','linked']);
});
test('new chorus detection matches ho-nor and split lines without changing words',()=>{
 const r=SS.cleanLyricInput('What color is my honor?\nWhat color is my... ho-nor...\n\nWhat color\nis my\nhonor?\nWhat color is my honor?');
 assert(r.sections.every(s=>s.name==='Chorus'));assert(r.text.includes('ho-nor'));assert(r.text.includes('What color\nis my\nhonor?'));
});
test('a peak on a function word names the next content word',()=>{
 const f={mean:.2,start:0,end:0,max:.9,min:0,range:.9,turns:0,peak_pos:.5,min_pos:0,hold_ms:0,peak_rel:.05};
 const c=SS.cpuLineCues(f,[{word:'A',relative_start:0,relative_end:.2},{word:'badge',relative_start:.2,relative_end:1}]);assert(c.some(s=>s.includes('"badge"')));assert(!c.some(s=>s.includes('"A"')));
});
test('helper client refuses remote hosts and credentials',()=>{
 for(const b of ['https://example.com','http://127.0.0.1.evil:8766','http://user:pw@127.0.0.1:8766'])assert.throws(()=>SS.helperUrl(b,'/health'));
 assert.equal(SS.helperUrl('http://127.0.0.1:8766','/health'),'http://127.0.0.1:8766/health');
});
test('CPU pipeline fixed order stops when separation is unavailable',async()=>{
 const seen=[];const t={};for(const n of SS.AI_PIPELINE_ORDER)t[n]=()=>{seen.push(n);return n==='separate_vocals'?{ok:false,error:'Open a stem'}:{ok:true};};
 const r=await SS.runPipelineWithoutAi(t);assert(!r.ok);assert.equal(r.stoppedAt,'separate_vocals');assert.deepEqual(seen,['load_song','separate_vocals']);
});
test('AI tool-calling roundtrip uses standard OpenAI wire format through sendAiChat',async()=>{
 const seen=[];let i=0;
 const srv=http.createServer((req,res)=>{let b='';req.on('data',d=>b+=d);req.on('end',()=>{const q=JSON.parse(b);seen.push(q);
  const name=SS.AI_PIPELINE_ORDER[i++];const m=name?{role:'assistant',content:null,tool_calls:[{id:'call-'+i,type:'function',function:{name,arguments:'{}'}}]}:{role:'assistant',content:'The map is ready; check the flagged words.'};
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:m}]}));});});
 await new Promise(r=>srv.listen(0,'127.0.0.1',r));
 try{SS.setAiConfig({enabled:true,baseUrl:`http://127.0.0.1:${srv.address().port}/v1`,model:'mock-local'});
  const t={};for(const n of SS.AI_PIPELINE_ORDER)t[n]=()=>({ok:true,summary:n+' done'});
  const r=await SS.runPipelineWithAi(t,(ms,opts)=>SS.sendAiChatAsync(ms,opts));
  assert(r.ok);assert.equal(r.log.length,5);assert.match(r.summary,/ready/);assert.equal(seen.length,6);assert(Array.isArray(seen[0].tools));assert(seen[1].messages.some(m=>m.role==='tool'&&m.tool_call_id==='call-1'));
  assert(seen[1].messages.some(m=>m.role==='assistant'&&m.tool_calls[0].function.name==='load_song'));assert.match(seen[0].messages[0].content,/Song Shape/);
 }finally{srv.close();SS.clearAiConfig();}
});
test('new UI paths have explicit buttons, separate outputs and no third-party requests at startup',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');for(const id of ['btn-save-top','btn-clear-loop','file-stem','btn-pipeline-ai','btn-pipeline-cpu','map-style','map-notes','stage-result','btn-copy-lyrics'])assert(html.includes(`id="${id}"`),id);
 assert(!/<script[^>]+src="https?:/.test(html));assert(!/<link[^>]+href="https?:/.test(html));
});
test('a held note on a function word names the nearest content word',()=>{
 const f={mean:0,start:0,end:0,max:.1,min:0,range:.1,turns:0,peak_pos:.5,min_pos:0,hold_ms:1600,hold_rel:.1};
 const c=SS.cpuLineCues(f,[{word:'The',relative_start:0,relative_end:.3},{word:'men',relative_start:.3,relative_end:1}]);assert(c.some(s=>s==='long sustained note on "men"'),c.join('|'));
});
test('version label is 0.2.11-dev',()=>{assert.equal(SS.APP_VERSION,'0.2.11-dev');});
test('an AI sheet that fails the check never replaces the CPU sheet',()=>{
 const src=fs.readFileSync(path.join(__dirname,'../js/app.js'),'utf8');const i=src.indexOf('function stage4');const body=src.slice(i,src.indexOf('var STAGES',i));
 assert(/if \(res\.check\.ok\) \{\s*putSheet\(res\.text, \"AI sheet\"\);/.test(body));assert(/showSheet\(localSheet\(mine\)\);\s*var notes/.test(body));
});
test('Demucs adapter: argv only, no shell, saves with soundfile, seeded',()=>{
 const py=fs.readFileSync(path.join(__dirname,'../tools/helper/separate_demucs.py'),'utf8');assert(!/shell\s*=\s*True|os\.system|subprocess/.test(py));assert(/soundfile/.test(py));assert(/random\.seed\(0\)/.test(py));
 const cfg=JSON.parse(fs.readFileSync(path.join(__dirname,'../tools/helper/helper-config.example.json'),'utf8'));assert(Array.isArray(cfg.separator)&&cfg.separator.some(a=>a.endsWith('separate_demucs.py')));assert.equal(cfg.device,'cpu');
});
test('place words never falls back silently to the whole-song CPU estimate; tools check the helper themselves',()=>{
 const src=fs.readFileSync(path.join(__dirname,'../js/app.js'),'utf8');const i=src.indexOf('place_words: function');const body=src.slice(i,src.indexOf('review: function',i));
 assert(!/proposeWordPositions\(/.test(body));assert(/ensureHelper\(\)/.test(body));assert(/the local aligner is not connected/.test(body));
 assert(/function ensureHelper\(\)/.test(src));
});
test('fix2: words the aligner put on silence stay unplaced and are named; weak lines are listed',()=>{
 const s=SS.createSession();SS.setLyrics(s,'a b\nc d\ne f\ng h\ni j');const L=s.lyrics.words;
 const data={words:L.map((w,i)=>({text:w.text,start:i,end:i+.5,score:i>=8?.05:.3,in_silence:i===9}))};
 const p=SS.proposeImportedAlignment(s,data,{vowelTarget:false});assert.equal(p.proposals.length,9);assert.deepEqual(p.not_heard,['j']);
 assert.equal(p.weak_lines.length,1);assert.equal(p.weak_lines[0].text,'i j');assert(p.warnings.some(x=>/fell on silence/.test(x)));
 SS.applyProposals(s,p);assert(!s.anchors.some(a=>a.word_id===L[9].id));
 const src=fs.readFileSync(path.join(__dirname,'../js/app.js'),'utf8');assert(/not heard in the audio, left unplaced/.test(src));assert(/check by ear \(weak match\)/.test(src));
});
test('fix2: the page sends line ids; the aligner adds between-line star tokens and flags silent words',()=>{
 assert(/line_id: w\.line_id/.test(fs.readFileSync(path.join(__dirname,'../js/helper-client.js'),'utf8')));
 const py=fs.readFileSync(path.join(__dirname,'../tools/helper/align_ctc.py'),'utf8');assert(/star = emission\.shape\[1\]/.test(py));assert(/'in_silence': not heard/.test(py));assert(!/shell\s*=\s*True|os\.system/.test(py));
});
test('fix3: a line start in the fading tail before a pause moves to the vocal onset; on-onset starts stay',()=>{
 const sr=8000,x=new Float32Array(sr*6);const tone=(a,b,amp)=>{for(let i=Math.round(a*sr);i<Math.round(b*sr);i++)x[i]=amp*Math.sin(i*0.3);};
 tone(0.5,1.5,.5);tone(1.5,2,.03);tone(3.5,5,.5);
 const rows=[{start_ms:500,end_ms:1400},{start_ms:1700,end_ms:1800},{start_ms:3700,end_ms:4200}];
 const m=SS.snapLineStarts(rows,['l1','l2','l2'],x,sr);assert.equal(m.length,1);assert(Math.abs(rows[1].start_ms-3500)<=40,'moved to the onset after the quiet stretch: '+rows[1].start_ms);assert(rows[2].start_ms>rows[1].start_ms);assert.equal(rows[0].start_ms,500);
 const again=SS.snapLineStarts(rows,['l1','l2','l2'],x,sr);assert.equal(again.length,0,'idempotent');
});
test('fix3: vocalise words are named as loosely placed; who is not vocalise; studio-master guidance is shown',()=>{
 const s=SS.createSession();SS.setLyrics(s,'Oh ooo oh\nWho goes whoa');const p=SS.proposeImportedAlignment(s,{words:s.lyrics.words.map((w,i)=>({text:w.text,start:i,end:i+.5}))},{vowelTarget:false});
 assert.deepEqual(p.vocalise,['Oh','ooo','oh','whoa']);assert(/^vocalise_loose_/.test(p.proposals[0].anchor_rule));
 const app=fs.readFileSync(path.join(__dirname,'../js/app.js'),'utf8');assert(/For best results use the studio master recording, not a live performance/.test(app));
 assert(/studio master recording/.test(fs.readFileSync(path.join(__dirname,'../index.html'),'utf8')));assert(/studio master recording/.test(fs.readFileSync(path.join(__dirname,'../README.md'),'utf8')));
});
test('fix4: ellipses are pauses, not words; hyphenated or stretched words stay one word; punctuation kept for display',()=>{
 const s=SS.createSession();SS.setLyrics(s,"What color is my... ho-nor...\nWho dares to stand for ... ho-nooor\u2026\nstand for\u2026honor\nWhat color\nis my\nhonor?");
 assert.deepEqual(s.lyrics.words.map(w=>w.text),['What','color','is','my...','ho-nor...','Who','dares','to','stand','for...','ho-nooor\u2026','stand','for\u2026','honor','What','color','is','my','honor?']);
 assert.equal(s.lyrics.lines[1].text,'Who dares to stand for ... ho-nooor\u2026','line text kept as typed');
 const p=SS.proposeImportedAlignment(s,{words:s.lyrics.words.map((w,i)=>({text:w.text,start:i,end:i+.5}))},{vowelTarget:false});assert.equal(p.proposals.length,19,'no letterless-word error');
 assert(/pause_after: \/\(\\\.\{2,\}\|\\u2026\)\$\//.test(fs.readFileSync(path.join(__dirname,'../js/helper-client.js'),'utf8')));
 const py=fs.readFileSync(path.join(__dirname,'../tools/helper/align_ctc.py'),'utf8');assert(/\(\[a-z\]\)\\1\{2,\}/.test(py));assert(/w\.get\('pause_after'\) is True/.test(py));
});
test('fix4: a stretched word is placed on the vowel and ends where the held note stops',()=>{
 const sr=8000,x=new Float32Array(sr*6);for(let i=sr*1;i<sr*4;i++)x[i]=.5*Math.sin(i*.3);for(let i=sr*4.5;i<sr*5;i++)x[i]=.5*Math.sin(i*.3);
 const s=SS.createSession();SS.setLyrics(s,'ho-nooor... die');
 const p=SS.proposeImportedAlignment(s,{words:[{text:'ho-nooor...',start:1,end:1.3},{text:'die',start:4.5,end:4.8}]},{vowelTarget:true,samples:x,sampleRate:sr});
 assert(Math.abs(p.proposals[0].end_ms-4000)<=60,'held to the end of the note: '+p.proposals[0].end_ms);assert(/^held_/.test(p.proposals[0].anchor_rule));assert.deepEqual(p.held,['ho-nooor...']);
});
test('fix4: an unplaced word is estimated between its placed neighbours, never parked at 0:00; stage 1 counts by source',()=>{
 const s=SS.createSession();SS.setLyrics(s,'a b c d');
 SS.applyProposals(s,{proposals:[{word_id:'word-1',start_ms:1000,end_ms:1000,needs_review:true,source:'imported_known_lyrics_alignment'},{word_id:'word-3',start_ms:3000,end_ms:3000,needs_review:true,source:'imported_known_lyrics_alignment'},{word_id:'word-4',start_ms:4000,end_ms:4000,needs_review:true,source:'imported_known_lyrics_alignment'}]});
 const r=SS.estimateWordTimes(s,{duration:10000,peaks:new Float32Array(2000).fill(.2)},{});assert.equal(r.proposals.length,1);assert(r.proposals[0].start_ms>1000&&r.proposals[0].start_ms<3000,'between neighbours: '+r.proposals[0].start_ms);
 const app=fs.readFileSync(path.join(__dirname,'../js/app.js'),'utf8');const i=app.indexOf('function stage1()');const body=app.slice(i,app.indexOf('function stage2',i));
 assert(/!aligned\) proposeWordPositions\(false\)/.test(body));assert(/by the aligner \(check by ear\)/.test(app));assert(/left unplaced \(/.test(app));
});
test('fix4: a plain word spread over a long gap is listed; the studio hint needs many flags',()=>{
 const s=SS.createSession();SS.setLyrics(s,'When\nbrothers\ndie\nho-nooor');
 const p=SS.proposeImportedAlignment(s,{words:[{text:'When',start:1,end:19},{text:'brothers',start:20,end:21},{text:'die',start:22,end:23},{text:'ho-nooor',start:24,end:30}]},{vowelTarget:false});
 assert.deepEqual(p.spread.map(w=>w.text),['When']);assert.equal(p.studio_hint,false);
 assert(/word spread over a long gap/.test(fs.readFileSync(path.join(__dirname,'../js/app.js'),'utf8')));
});
test('fix5: line taps go to lines in order with a latency correction; skip, undo and clear; saved with the project',()=>{
 const s=SS.createSession();SS.setLyrics(s,'one two\n\n[Chorus]\nthree four\nfive');
 assert.equal(SS.nextTapLine(s).text,'one two');
 const t1=SS.addLineTap(s,10000,-120);assert.equal(t1.t_ms,9880);assert.equal(t1.raw_ms,10000);
 SS.skipLineTap(s);assert.equal(SS.nextTapLine(s).text,'five','tags and blank lines are not tappable');
 const t3=SS.addLineTap(s,9000,-120);assert(t3.t_ms>t1.t_ms,'taps stay in time order');assert.equal(SS.nextTapLine(s),null);assert.equal(SS.addLineTap(s,20000,0),null);
 const starts=SS.lineTapStarts(s);assert.deepEqual(Object.keys(starts),['word-1','word-5']);
 const rt=SS.parseSession(SS.sessionToJSON(s));assert.equal(rt.line_taps.length,3);assert.equal(rt.line_taps[1].skipped,true);assert.equal(rt.line_taps[2].t_ms,t3.t_ms);
 assert.equal(SS.undoLineTap(s).line_id,t3.line_id);assert.equal(SS.nextTapLine(s).text,'five');assert.equal(SS.clearLineTaps(s),2);assert.equal(SS.nextTapLine(s).text,'one two');
 SS.addLineTap(s,500,-120);SS.setLyrics(s,'other words');assert.equal(s.line_taps.length,0,'new lyrics clear taps');
 assert.throws(()=>SS.parseSession({schema_version:'songshape-live-0.1',line_taps:[{line_id:'line-1',t_ms:-5}]}),/line_taps/);
});
test('fix5: tapped starts reach the aligner as hard anchors; tapped lines are not snapped; far-off first words move to the tap',()=>{
 assert(/o\.line_start = w\.line_start_ms \/ 1000/.test(fs.readFileSync(path.join(__dirname,'../js/helper-client.js'),'utf8')));
 const py=fs.readFileSync(path.join(__dirname,'../tools/helper/align_ctc.py'),'utf8');assert(/w\.get\('line_start'\)/.test(py));assert(/'line_taps_used'/.test(py));
 const s=SS.createSession();SS.setLyrics(s,'a b\nc d');
 const p=SS.proposeImportedAlignment(s,{words:[{text:'a',start:1,end:1.2},{text:'b',start:1.5,end:1.7},{text:'c',start:2,end:2.2},{text:'d',start:2.3,end:2.5}]},{vowelTarget:false,lineTaps:{'word-3':5000}});
 assert.equal(p.proposals[2].start_ms,5000);assert(p.proposals[3].start_ms>5000);assert(/^line_tap_/.test(p.proposals[2].anchor_rule));assert.equal(p.taps_used,1);
 const app=fs.readFileSync(path.join(__dirname,'../js/app.js'),'utf8');assert(/lineTaps: SS\.lineTapStarts\(session\)/.test(app));assert(/tap line starts to help/.test(app));
 assert(/!a\.needs_review \|\| !\/\^\(imported_known_lyrics_alignment\|cpu_energy_timing_estimate(\|cpu_tap_anchored_estimate)?\)\$\//.test(app),'reruns replace only unconfirmed machine words');
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');['btn-tap-start','btn-tap-mark','btn-tap-skip','btn-tap-undo','btn-tap-clear','tap-latency'].forEach(id=>assert(html.includes('id="'+id+'"'),id));
});
test('fix5: the vowel target never moves a word onto the next word',()=>{
 const sr=8000,x=new Float32Array(sr*3);for(let i=Math.round(sr*1.25);i<sr*3;i++)x[i]=.5*Math.sin(i*.3);
 const s=SS.createSession();SS.setLyrics(s,'I heard');
 const p=SS.proposeImportedAlignment(s,{words:[{text:'I',start:1.0,end:1.1},{text:'heard',start:1.2,end:1.6}]},{vowelTarget:true,samples:x,sampleRate:sr,snapLines:false});
 assert(p.proposals[0].start_ms<1200,'kept before the next word: '+p.proposals[0].start_ms);
});
function extendFixture(){
 const ref=['We hold the light','We hold the line','Who keeps the lantern burning','Who keeps the lantern burning','Ooh','We have one chance','The road is chosen','Who keeps the lantern burning','Who keeps the lantern burning','Who dares to stay','When light must fade','Burning into the night'];
 const s=SS.createSession();SS.setLyrics(s,ref.join('\n'));s.reference={title:'Song',artist:'Famous Artist'};
 let t=1000;const anchors=[],strokes=[];
 s.lyrics.lines.filter(l=>l.kind==='lyric').forEach((l,li)=>{ if(li===11) t+=20000; const t0=t;
  l.word_ids.forEach(w=>{anchors.push({id:'anchor-'+(anchors.length+1),word_id:w,line_id:l.id,word_ids:[w],kind:'word',start_ms:t,end_ms:t,needs_review:false,source:'next_word'});t+=500;});
  const pts=[];for(let x=t0;x<=t+800;x+=50)pts.push([x,Math.sin((x-t0)/700)*0.5]);strokes.push({id:'stroke-'+(li+1),start_ms:t0,end_ms:t+800,points:pts});t+=2500;});
 s.anchors=anchors;s.strokes=strokes;
 return SS.buildPerformanceMap(SS.sessionToJSON(s));
}
test('fix6 Extend: [New ...] marks are kept as block headers but never written; section types come from tags',()=>{
 const c=SS.cleanLyricInput('a b\nc d\n\n[New Verse]\ne f\n\n[Bridge]\ng h');
 assert.deepEqual(c.sections.map(x=>x.header),[null,'[New Verse]','[Bridge]']);assert(!/New|Bridge/.test(c.text));
 assert.equal(SS.cleanLyricInput(c.text).text,c.text,'cleaning stays idempotent');
 assert.equal(SS.headerType('[New Chorus]'),'Chorus');assert.equal(SS.headerType('[Hook]'),'Chorus');assert.equal(SS.headerType('[extra outro]'),'Outro');assert.equal(SS.headerType('[New]'),null);
});
test('fix6 Extend: reference sections are detected from repeats, wordless lines and long breaks',()=>{
 const refs=SS.referenceSections(extendFixture());
 assert.deepEqual(refs.map(r=>r.label+':'+r.lines),['Verse 1:2','Chorus 1:2','Vocalise 1:1','Verse 2:2','Chorus 2:2','Bridge 1:2','Outro 1:1']);
 refs.forEach(r=>assert(/^\[Vocal style: [^\]]+\]$/.test(r.style.tag),r.style.tag));
 assert(/wordless vocalise/.test(refs[2].style.tag));assert(refs[0].style.syllables_per_s>0);
});
test('fix6 Extend: your sections map in order; marked and left-over sections inherit the same type; words unchanged',()=>{
 const map=extendFixture();
 const mine='We had no road\nWe had no home\n\nWhat color is my honor\nWhat color is my honor\n\nWe lost the light\nWe paid the price\n\n[New Verse]\nI heard them cry\nWe stood and fought\n\nWhat color is my honor\nWhat color is my honor\n\nWho dares to stand\nWhen brothers die\n\nI wear the red\nMy honor now';
 const r=SS.buildExtendTransfer(map,mine);
 const plan=r.transfer.section_plan;
 assert.deepEqual(plan.map(p=>p.label+(p.mapped?'':'*')),['Verse 1','Chorus 1','Verse 2','Verse 3*','Chorus 2','Bridge 1','Outro 1']);
 assert.equal(plan[3].new_reason,'marked_new');assert.equal(plan[3].inherits_from_section,'Verse 2');assert.equal(plan[3].style_tag,plan[2].style_tag);
 const h=SS.makeHandoff(map,r.transfer);
 const sheetLines=h.lyrics.split('\n');const lyricOut=sheetLines.filter(l=>l&&!/^\[/.test(l));
 assert.deepEqual(lyricOut,mine.split('\n').filter(l=>l&&!/^\[/.test(l)),'every lyric line kept, unchanged and in order');
 assert.equal(sheetLines.filter(l=>/^\[Vocal style:/.test(l)).length,7);assert(sheetLines.includes('[Bridge]')&&sheetLines.includes('[Outro]'));
 assert(!/Famous Artist|\[New/.test(h.lyrics+r.notes),'no artist name and no [New] mark in the output');
 const vi=sheetLines.indexOf('I heard them cry'),vj=sheetLines.indexOf('We lost the light');const noWords=x=>x.replace(/ on "[^"]*"| "[^"]*"/g,'');assert.equal(noWords(sheetLines[vi-1]),noWords(sheetLines[vj-1]),'the new verse repeats the delivery tag of the verse it inherits');
 const left=SS.buildExtendTransfer(map,mine.replace('[New Verse]\n','')).transfer.section_plan;assert(left.some(p=>!p.mapped&&p.new_reason==='no_reference_section_left'),'a left-over section is detected as new');
 assert(/syllables\/s/.test(r.notes)&&/no BPM|not measure BPM/.test(r.notes));
});
test('fix6 Extend: the page wires the panel and the AI keeps section style lines',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');['extend-panel','chk-extend','extend-notes','btn-copy-extend'].forEach(id=>assert(html.includes('id="'+id+'"'),id));assert(html.includes('js/extend.js'));
 const app=fs.readFileSync(path.join(__dirname,'../js/app.js'),'utf8');assert(/SS\.buildExtendTransfer\(performanceMap, newLyrics, opts \|\| \{\}\)/.test(app));
 assert(/Vocal style/.test(fs.readFileSync(path.join(__dirname,'../js/ai-chain.js'),'utf8')));
});
test('fix6: one launcher uses the shared SongShape_Tools config and lists each tool',()=>{
 const cmd=fs.readFileSync(path.join(__dirname,'../Start-SongShape.cmd'),'utf8');assert(/tools\\launch\\Start-SongShape\.ps1/.test(cmd));
 const ps=fs.readFileSync(path.join(__dirname,'../tools/launch/Start-SongShape.ps1'),'utf8');assert(/^[\x00-\x7f]*$/.test(ps),'ASCII only for Windows PowerShell 5.1');
 ['SongShape_Tools','songshape-tools.json','NOT FOUND','TORCH_HOME','SS_FFMPEG','955717e8-8726e21a.th','wav2vec2_fairseq_base_ls960_asr_ls960.pth','CheckOnly','127.0.0.1'].forEach(k=>assert(ps.includes(k),k));
 const ex=JSON.parse(fs.readFileSync(path.join(__dirname,'../tools/launch/songshape-tools.example.json'),'utf8'));['python','ffmpeg','torch_home','work_dir'].forEach(k=>assert(k in ex,k));
 const app=fs.readFileSync(path.join(__dirname,'../js/app.js'),'utf8');assert(/NOT FOUND: /.test(app)&&/helper-tools/.test(app));
});
test('fix6b Extend two-pass: map the song incl. its ending, then insert marked-new sections anywhere; mapping unchanged',()=>{
 const map=extendFixture();
 const pass1='[Verse]\nWe had no road\nWe had no home\n\n[Chorus]\nWhat color is my honor\nWhat color is my honor\n\n[Verse]\nWe lost the light\nWe paid the price\n\n[Chorus]\nWhat color is my honor\nWhat color is my honor\n\n[Bridge]\nWho dares to stand for... ho-nooor...\n\nWhen\nbrothers\ndie...\n\n[Outro]\nI wear the red with honor.';
 const insert='[New Verse]\nI heard brothers cry\nWe stood and fought\n\n[New Chorus]\nWhat color is my honor\nWhat color is my honor\n\n[New Bridge]\nWho dares to die for... ho-nooor...\n\nSo\nothers\nlive...\n\n';
 const pass2=pass1.replace('[Outro]',insert+'[Outro]');
 const p1=SS.buildExtendTransfer(map,pass1).transfer.section_plan, r2=SS.buildExtendTransfer(map,pass2), p2=r2.transfer.section_plan;
 assert.deepEqual(p1.map(p=>p.label+'<'+p.reference_section),['Verse 1<Verse 1','Chorus 1<Chorus 1','Verse 2<Verse 2','Chorus 2<Chorus 2','Bridge 1<Bridge 1','Outro 1<Outro 1'],'pass 1 maps every section, ending included');
 assert.equal(p1[4].lines,4,'a section you start with a [tag] keeps its blank-line phrasing gaps');
 assert.deepEqual(p2.map(p=>p.label+(p.mapped?'':'*')+'<'+(p.inherits_from_section||p.reference_section)),['Verse 1<Verse 1','Chorus 1<Chorus 1','Verse 2<Verse 2','Chorus 2<Chorus 2','Bridge 1<Bridge 1','Verse 3*<Verse 2','Chorus 3*<Chorus 2','Bridge 2*<Bridge 1','Outro 1<Outro 1']);
 const mapped2=p2.filter(p=>p.mapped);mapped2.forEach((p,i)=>{assert.equal(p.reference_section,p1[i].reference_section);assert.equal(p.style_tag,p1[i].style_tag);});
 assert.equal(p2[5].style_tag,p2[2].style_tag);assert.equal(p2[6].style_tag,p2[3].style_tag);assert.equal(p2[7].style_tag,p2[4].style_tag);
 const h=SS.makeHandoff(map,r2.transfer).lyrics.split('\n');
 assert.deepEqual(h.filter(l=>l&&!/^\[/.test(l)),pass2.split('\n').filter(l=>l&&!/^\[/.test(l)),'lyrics unchanged, in order');
 assert.equal(h.filter(l=>l==='[Bridge]').length,2,'one tag per section, not per blank-line block');
 assert.equal(h[h.indexOf('When')-2],'','the phrasing gap stays a blank line');
});
test('fix6b Extend: a section you name keeps your name when it follows a different reference type',()=>{
 const map=extendFixture();
 const r=SS.buildExtendTransfer(map,'[Verse]\na b c\nd e f\n\n[Chorus]\ng h\ni j\n\n[Verse]\nk l\nm n\n\n[Chorus]\no p\nq r\n\n[Verse]\ns t\nu v\n\n[Outro]\nw x');
 const v3=r.transfer.section_plan[4];assert.equal(v3.label,'Verse 3');assert.equal(v3.reference_section,'Bridge 1');assert(v3.mapped);
});
test('fix6b: the page reads as two steps; Step 2 text is saved with the project',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
 assert(html.includes('Step 1 · Map my lyrics to the reference performance')&&html.includes('Step 2 · Extend in that style'));
 assert(html.indexOf('step1-title')<html.indexOf('step2-title'));['btn-step1-sheet','extend-lyrics','btn-extend-from-step1','btn-step2-sheet','extend-check'].forEach(id=>assert(html.includes('id="'+id+'"'),id));
 const s=SS.createSession();s.extend_lyrics='a\n\n[New Verse]\nb';const rt=SS.parseSession(SS.sessionToJSON(s));assert.equal(rt.extend_lyrics,s.extend_lyrics);
 assert.throws(()=>SS.parseSession({schema_version:'songshape-live-0.1',extend_lyrics:5}),/extend_lyrics/);
 const app=fs.readFileSync(path.join(__dirname,'../js/app.js'),'utf8');assert(/btn-step2-sheet/.test(app)&&/differ from Step 1/.test(app));
});
// ---- fix6d: Suno character budget ----
const GLOBAL_FULL='[Global Vocal Direction: One consistent lead singer for all sung passages; same vocal timbre, character, and diction throughout. Intensity, register, sustain, dynamics, and expression may vary naturally. No unexpected additional singer, duet, choir handoff, or voice-character change.]';
function fakeSheet(nSections){ // the shape of a real Step 1/2 sheet, with made-up words
 const out=[GLOBAL_FULL,''];
 const dl=(w,extra)=>'[Delivery: up-and-down line; mid register; steady intensity; long sustained note on "'+w+'"; peak on "'+w+'"; dip below baseline; settles to baseline; phrase break mid-line; slow, spacious phrasing'+(extra||'')+']';
 for(let k=0;k<nSections;k++){const chorus=k%2===1;
  out.push(chorus?'[Chorus]':'[Verse]','[Vocal style: slow, spacious phrasing; lower-mid register; steady intensity; long held notes; mostly up-and-down lines]');
  const lines=chorus?['Bright lantern over water','Bright lantern over... wa-ter...']:['Walking the line number '+k,'Under the grey sky '+k,'Holding the rope '+k,'Calling the name '+k];
  lines.forEach(l=>{out.push(dl(l.split(' ')[1]));out.push(l);});
  if(k===3){out.push('');['Hold','me','now'].forEach(w=>{out.push('[Delivery: falling line; high register; steady intensity; long sustained note on "'+w+'"; settles to baseline; phrase break mid-line]');out.push(w);});}
  out.push('');}
 return out.join('\n').trim();
}
const lyr=t=>t.split('\n').filter(l=>l.trim()&&!/^\[.*\]$/.test(l.trim()));
test('fix6d budget: a sheet that fits is left exactly as it is',()=>{
 const t=fakeSheet(3);assert(t.length<5000);const r=SS.fitSunoBudget(t,{budget:5000});assert.equal(r.text,t);assert.equal(r.shortened,false);assert.match(SS.sunoBudgetNote(r),/nothing shortened/);
});
test('fix6d budget: always within the limit, lyric lines unchanged',()=>{
 for(const n of [8,14,24])for(const b of [5000,3000,1500]){const t=fakeSheet(n);const r=SS.fitSunoBudget(t,{budget:b});
  if(r.lyrics_over_budget)continue;assert(r.length<=b,n+' '+b+' '+r.length);assert.deepEqual(lyr(r.text),lyr(t));assert.equal(SS.sheetChars(r.text),r.length);assert.equal(r.remaining,b-r.length);}
});
const dels=t=>t.split('\n').filter(l=>/^\[Delivery:/.test(l));
test('fix6d budget order: lyrics + line tags first, then the global description sized to what is left',()=>{
 let t=fakeSheet(5);while(t.length<5100)t=t.replace('[Verse]\n','[Verse]\n[Delivery: rising line]\nExtra line\n');
 const r=SS.fitSunoBudget(t,{budget:5000});
 assert(r.length<=5000);assert.deepEqual(r.steps,[]);assert.equal(r.line_tags_shortened,false);
 assert.deepEqual(dels(r.text),dels(t),'every per-line tag kept in full');assert.equal(r.core_length,r.core_full_length);
 assert.equal(r.global_length,r.length-r.core_length);assert(r.length>4800,'uses the budget: '+r.length);
 const fullG=GLOBAL_FULL.length-'[Global: one consistent lead singer throughout; same timbre and diction. No duet, choir handoff, or voice change.]'.length;
 assert(/short global vocal direction/.test(r.global_choice),r.global_choice);assert(r.remaining<fullG,'the full global line would not have fit');
 assert.match(SS.sunoBudgetNote(r),/left for the global description/);assert.doesNotMatch(SS.sunoBudgetNote(r),/Warning/);
});
test('fix6d budget: line tags are shortened only when lyrics + line tags alone are over; holds, peaks, dips, register kept; warns',()=>{
 const t=fakeSheet(14);const r=SS.fitSunoBudget(t,{budget:3000});assert(r.length<=3000&&r.length>2850,String(r.length));
 assert(r.core_full_length>3000&&r.line_tags_shortened);assert.match(SS.sunoBudgetNote(r),/Warning: lyrics and line tags alone were over/);
 const tag=r.text.split('\n').find(l=>/^\[/.test(l)&&/hold/i.test(l));assert(tag&&/hold/i.test(tag)&&/peak/i.test(tag)&&/dip/i.test(tag)&&/mid/.test(tag),tag);
 assert(!/phrase break mid-line/.test(r.text));assert.deepEqual(lyr(r.text),lyr(t));
});
test('fix6d budget: one-word runs share one tag; repeated choruses reuse the first; lyrics alone over the limit warn',()=>{
 const t=fakeSheet(24);const r=SS.fitSunoBudget(t,{budget:2500});assert(r.length<=2500&&r.line_tags_shortened);assert(/long hold each word/.test(r.text)||r.steps.some(s=>/removed/.test(s)));
 assert.deepEqual(lyr(r.text),lyr(t));
 const huge=Array.from({length:300},(_,i)=>'[Delivery: rising line]\nA long lyric line that keeps going number '+i).join('\n');
 const h=SS.fitSunoBudget(huge,{budget:5000});assert.equal(h.lyrics_over_budget,true);assert.deepEqual(lyr(h.text),lyr(huge));assert(!/\[Delivery/.test(h.text));assert.equal(h.fits,false);assert.match(SS.sunoBudgetNote(h),/never cuts lyric words/);
});
test('fix6d budget: the page shows a live counter and limit; copy takes the fitted sheet',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');['suno-budget','suno-count','suno-count-step2','suno-fit-note'].forEach(id=>assert(html.includes('id="'+id+'"'),id));
 assert(html.indexOf('js/suno-budget.js')>html.indexOf('js/extend.js')&&html.indexOf('js/suno-budget.js')<html.indexOf('js/app.js'));
 const app=fs.readFileSync(path.join(__dirname,'../js/app.js'),'utf8');assert(/function showSheet\(r, label\) \{\s*r\.fit = putSheet\(r\.lyrics/.test(app));assert(/copyFrom\("map-output", "lyrics"\)/.test(app));
});
// Private, not in the repo: Ben's own lyrics and the reference session (set SONGSHAPE_PRIVATE_FIXTURES to run).
test('fix6d budget: Ben\'s Honor sheet, Step 1 and Step 2, fits 5,000 with every lyric word (private fixtures)',()=>{
 const dir=process.env.SONGSHAPE_PRIVATE_FIXTURES;if(!dir||!fs.existsSync(path.join(dir,'base_session.json'))){console.log('  (skipped: no private fixtures)');return;}
 const map=SS.buildPerformanceMap(JSON.parse(fs.readFileSync(path.join(dir,'base_session.json'),'utf8')));
 for(const f of ['ben_pass1.txt','ben_split.txt']){const text=fs.readFileSync(path.join(dir,f),'utf8');const h=SS.makeHandoff(map,SS.buildExtendTransfer(map,text).transfer);
  const r=SS.fitSunoBudget(h.lyrics,{budget:5000});assert(r.length<=5000&&r.length>=4850,f+' '+r.length);assert.deepEqual(lyr(r.text),lyr(h.lyrics));
  const words=t=>lyr(t).join(' ');assert.equal(words(r.text),words(h.lyrics));
  const mine=SS.cleanLyricInput?SS.cleanLyricInput(text):null;if(mine&&mine.text)assert.equal(lyr(r.text).length,lyr(mine.text).length);
  console.log('  '+f+': '+r.original_length+' -> '+r.length);}
});
// ---- fix6d: Lift (optional) and the vocal performance JSON ----
const LIFT_P1='[Verse]\nWe had no road\nWe had no home\n\n[Chorus]\nWhat color is my honor\nWhat color is my honor\n\n[Verse]\nWe lost the light\nWe paid the price\n\n[Chorus]\nWhat color is my honor\nWhat color is my honor\n\n[Bridge]\nWho dares to stand for... ho-nooor...\n\nWhen\nbrothers\ndie...\n\n[Outro]\nI wear the red with honor.';
const LIFT_P2=LIFT_P1.replace('[Outro]','[New Verse]\nI heard brothers cry\nWe stood and fought\n\n[Outro]');
test('fix6d Lift off (default): new sections inherit the source tags exactly; nothing marked lifted',()=>{
 const map=extendFixture();const e=SS.buildExtendTransfer(map,LIFT_P2);const h=SS.makeHandoff(map,e.transfer);
 const e0=SS.buildExtendTransfer(map,LIFT_P2,{lift:false});assert.equal(SS.makeHandoff(map,e0.transfer).lyrics,h.lyrics,'default = off');
 assert.equal(e.transfer.lift,false);assert(!h.rows.some(r=>r.lift));const p=e.transfer.section_plan;const nv=p.find(x=>!x.mapped);
 assert.equal(nv.lift,false);assert.equal(nv.style_tag,p.find(x=>x.label===nv.inherits_from_section).style_tag);
 assert(!/lifted/.test(h.lyrics));
});
test('fix6d Lift on: only new sections step up (register, holds, power), the final line most; mapped sections unchanged',()=>{
 const map=extendFixture();const off=SS.makeHandoff(map,SS.buildExtendTransfer(map,LIFT_P2).transfer);
 const e=SS.buildExtendTransfer(map,LIFT_P2,{lift:true});const on=SS.makeHandoff(map,e.transfer);
 const lifted=on.rows.filter(r=>r.lift);assert.equal(lifted.length,2);assert.deepEqual(lifted.map(r=>r.text),['I heard brothers cry','We stood and fought']);
 on.rows.forEach((r,i)=>{if(!r.lift)assert.deepEqual(r.cpu_tags,off.rows[i].cpu_tags,'mapped line unchanged: '+r.text);});
 const fin=lifted[1];assert.equal(fin.lift.final_line,true);assert(fin.cpu_tags.includes('lifted ending')&&fin.cpu_tags.includes('powerful'));
 assert(fin.cpu_tags.some(c=>/^long sustained note on "fought"$/.test(c)));assert(!fin.cpu_tags.some(c=>/falls away at the end|dive at the end/.test(c)));
 // register one step up, never lower
 const ord=['low','lower-mid','mid','upper-mid','high'],reg=t=>ord.indexOf((t.find(c=>/ register$/.test(c))||'').replace(/ register$/,''));
 lifted.forEach(r=>{const b=reg(r.lift.from),a=reg(r.lift.to);assert(a>=b&&(b<0||a===Math.min(4,b+1)),r.text);assert(!r.cpu_tags.some(c=>/^held note on /.test(c)));});
 assert.deepEqual(SS.liftCues(['falling line','lower-mid register','soft','held note on "x"','falls away at the end'],{final:true,lastWord:'x'}),['falling line','mid register','long sustained note on "x"','powerful','lifted ending']);
 const nv=e.transfer.section_plan.find(x=>!x.mapped);assert.equal(nv.lift,true);assert.match(nv.style_tag,/lifted/);assert.notEqual(nv.style_tag,nv.source_style_tag);
 assert(on.lyrics.split('\n').some(l=>/^\[Vocal style: .*lifted/.test(l)));
 const lyrOnly=t=>t.split('\n').filter(l=>l&&!/^\[/.test(l));assert.deepEqual(lyrOnly(on.lyrics),lyrOnly(off.lyrics),'lyric words unchanged');
 const fit=SS.fitSunoBudget(on.lyrics,{budget:5000});assert(fit.length<=5000);
});
test('fix6d vocal performance JSON: Step 1 and Step 2 (faithful and Lift), per section/line/word, no reference text by default',()=>{
 const map=extendFixture();
 const mk=(text,step,lift,ref)=>{const e=SS.buildExtendTransfer(map,text,{lift});const h=SS.makeHandoff(map,e.transfer);
  return SS.buildPerformanceJson({map,transfer:e.transfer,handoff:h,refs:e.refs,step,sheet:SS.fitSunoBudget(h.lyrics,{budget:5000}),includeReferenceText:ref,appVersion:'0.2.11-dev',created:'2026-11-22T00:00:00Z'});};
 const j1=mk(LIFT_P1,1,false),j2=mk(LIFT_P2,2,false),j3=mk(LIFT_P2,2,true);
 [j1,j2,j3].forEach(j=>{assert.equal(j.schema_version,'songshape-vocal-performance-0.1');assert.equal(j.contains_reference_audio,false);assert.equal(j.contains_reference_lyric_text,false);
  assert(j.suno_sheet.characters<=5000);const s=JSON.stringify(j);map.groups.forEach(g=>assert(!s.includes(JSON.stringify(g.text)),'no reference line text'));
  j.sections.forEach(sec=>sec.lines.forEach(l=>{assert(typeof l.lyric==='string'&&Array.isArray(l.delivery_tags)&&l.maps_to_reference&&Array.isArray(l.words)&&Array.isArray(l.contour));
   assert.equal(l.words.map(w=>w.word).join(' '),l.lyric.split(/\s+/).filter(Boolean).join(' '),'every lyric word');
   l.contour.forEach(c=>c.points.forEach(p=>assert(p[1]>=-1&&p[1]<=1)));}));});
 assert.equal(j1.step,1);assert(j1.sections.every(x=>x.status==='mapped'));assert.equal(j1.lift,false);
 const nv=j2.sections.find(x=>x.status==='new');assert(nv&&nv.source_section&&nv.lift===false&&nv.new_reason==='marked_new');assert.equal(j2.step,2);
 const nl=j3.sections.find(x=>x.status==='new');assert.equal(j3.lift,true);assert.equal(nl.lift,true);assert(nl.lift_changes.style_before&&nl.lift_changes.style_after);
 assert(nl.lines.every(l=>l.lift&&Array.isArray(l.lift.tags_before)&&Array.isArray(l.lift.tags_after)));assert(j3.sections.filter(x=>x.status==='mapped').every(x=>x.lines.every(l=>!l.lift)));
 const line=j1.sections[0].lines[0];assert(line.maps_to_reference.line_numbers.length&&line.maps_to_reference.start_ms!=null&&line.performance);
 const jr=mk(LIFT_P1,1,false,true);assert.equal(jr.contains_reference_lyric_text,true);assert(jr.sections[0].lines[0].maps_to_reference.text);
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');['btn-step1-json','btn-step2-json','chk-extend-lift','chk-json-ref-text'].forEach(id=>assert(html.includes('id="'+id+'"'),id));
 assert(!/id="chk-extend-lift" checked/.test(html),'Lift is off by default');assert(html.includes('js/performance-json.js'));
 assert(fs.existsSync(path.join(__dirname,'../docs/vocal_json_schema.md')));
});
// ---- fix6e: lead singer only; harmony hints ----
function tone(sr,sec,f0s,amp){const n=Math.round(sr*sec),x=new Float32Array(n);for(let i=0;i<n;i++){let v=0;for(const f of f0s)for(let h=1;h<=6;h++)v+=Math.sin(2*Math.PI*f*h*i/sr)/h;x[i]=amp*v/f0s.length;}return x;}
function cat(...a){const n=a.reduce((s,x)=>s+x.length,0),o=new Float32Array(n);let k=0;for(const x of a){o.set(x,k);k+=x.length;}return o;}
test('fix6e harmony detector: one voice is lead only; two simultaneous voices are flagged; silence is not',()=>{
 const sr=22050;const solo=tone(sr,4,[220],.3),duo=tone(sr,3,[220,277.2],.3),sil=new Float32Array(sr*2);
 const x=cat(solo,sil,duo,sil,solo);const r=SS.detectHarmony(x,sr);
 assert.equal(r.length,1,JSON.stringify(r));assert(r[0].start_ms>=5500&&r[0].start_ms<=7000&&r[0].end_ms>=8000&&r[0].end_ms<=9500,JSON.stringify(r[0]));
 assert(r[0].reasons.includes('two pitches at once'));assert.equal(r[0].source,'stem');
 assert.deepEqual(SS.detectHarmony(cat(solo,sil,solo),sr),[]);
 const oct=tone(sr,3,[220,440],.3);assert.deepEqual(SS.detectHarmony(cat(solo,oct),sr).filter(q=>q.start_ms>4000),[],'octave doubling is one voice');
});
test('fix6e harmony: lines placed on top of each other are flagged; unplaced words near a region get a hint',()=>{
 const r=SS.detectHarmony(null,0,{frames:[],lineSpans:[{start_ms:1000,end_ms:5000,text:'Who keeps the lantern burning'},{start_ms:4000,end_ms:8000,text:'who keeps the lantern burning'},{start_ms:9000,end_ms:9500,text:'x'}]});
 assert.equal(r.length,1);assert.equal(r[0].start_ms,4000);assert.equal(r[0].end_ms,5000);assert.match(r[0].reasons[0],/repeated line/);assert.equal(r[0].source,'words');
 const s={lyrics:{words:[{id:'w1',text:'Who'},{id:'w2',text:'the'},{id:'w3',text:'lantern'},{id:'w4',text:'burning'},{id:'w5',text:'Who'}]},anchors:[{word_id:'w1',start_ms:70400},{word_id:'w5',start_ms:77200}]};
 const h=SS.unplacedHarmonyHints(s,[{id:'auto-harmony-5',start_ms:72400,end_ms:74100}]);
 assert.deepEqual(h.map(x=>x.text),['the','lantern','burning']);assert(h.every(x=>x.harmony_region==='auto-harmony-5'));assert.equal(SS.formatMmSs(h[0].near_ms),'1:12');
 assert(SS.unplacedHarmonyHints(s,[]).every(x=>x.harmony_region===null));
 const sess=SS.createSession();sess.detected_harmony=[{id:'auto-harmony-1',start_ms:72400,end_ms:74100,score:.77,reasons:['two pitches at once'],source:'stem'}];
 assert.deepEqual(SS.parseSession(SS.sessionToJSON(sess)).detected_harmony,sess.detected_harmony);
 assert.throws(()=>SS.parseSession({schema_version:'songshape-live-0.1',detected_harmony:'x'}),/detected_harmony/);
});
test('fix6e harmony: sheet note only if the budget allows (lowest priority); vocal JSON flags word, line and section',()=>{
 const map=extendFixture();const g=map.groups[0];
 map.detected_harmony=[{id:'auto-harmony-1',start_ms:g.start_ms,end_ms:g.end_ms,score:.8,reasons:['two pitches at once'],source:'stem'}];
 g.detected_harmony=['auto-harmony-1'];g.harmony_word_ids=[g.word_ids[0]];
 const e=SS.buildExtendTransfer(map,LIFT_P1);const h=SS.makeHandoff(map,e.transfer);
 assert.equal(h.lyrics.split('\n').filter(l=>l==='[Backing harmony]').length>=1,true);
 const roomy=SS.fitSunoBudget(h.lyrics,{budget:5000});assert(roomy.text.includes('[Backing harmony]'));
 const core=SS.fitSunoBudget(h.lyrics.split('\n').filter(l=>l!=='[Backing harmony]').join('\n'),{budget:5000});
 const tight=SS.fitSunoBudget(h.lyrics,{budget:core.core_length+5});assert(!tight.text.includes('[Backing harmony]'),'dropped first when tight');assert(tight.length<=core.core_length+5);
 const lyr2=t=>t.split('\n').filter(l=>l&&!/^\[/.test(l));assert.deepEqual(lyr2(tight.text),lyr2(h.lyrics));
 const j=SS.buildPerformanceJson({map,transfer:e.transfer,handoff:h,refs:e.refs,step:1,sheet:roomy});
 assert.equal(j.harmony_regions.length,1);assert.match(j.lead_singer_only,/single lead singer/);
 const lines=j.sections.flatMap(x=>x.lines);const hl=lines.filter(l=>l.harmony.detected);assert(hl.length>=1);
 assert(hl[0].maps_to_reference.words.some(w=>w.harmony));assert(hl[0].words.some(w=>w.harmony));
 assert(j.sections.some(x=>x.harmony));assert(j.sections.some(x=>!x.harmony));
});
test('fix6e: lead-singer disclaimer near stage 1, in About; stage 1 says unplaced words may be in a harmony section',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
 assert(html.indexOf('id="lead-disclaimer"')<html.indexOf('id="g-status-1"'));assert.match(html,/designed to track a single lead singer performance/);
 assert.match(html,/id="about-lead-only"[^>]*>[^<]*single lead singer/);['harmony-panel','harmony-list','harmony-count'].forEach(id=>assert(html.includes('id="'+id+'"'),id));
 assert(html.indexOf('js/harmony-detect.js')<html.indexOf('js/app.js'));
 const app=fs.readFileSync(path.join(__dirname,'../js/app.js'),'utf8');assert(app.includes('" - may be in a harmony section near "')&&app.includes('; check by ear"'));
 const rd=fs.readFileSync(path.join(__dirname,'../js/render.js'),'utf8');assert(/function drawHarmony/.test(rd)&&/"H"/.test(rd));
 const readme=fs.readFileSync(path.join(__dirname,'../README.md'),'utf8');assert.match(readme,/single lead singer/);
 assert.match(fs.readFileSync(path.join(__dirname,'../docs/vocal_json_schema.md'),'utf8'),/harmony/);
});
test('fix6e tap dock: compact controls beside the graph while tapping, synced correction, next line on the plot',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
 ['tap-dock','tap-dock-current','tap-dock-next','tap-dock-play','tap-dock-mark','tap-dock-skip','tap-dock-undo','tap-dock-count','tap-dock-latency','tap-dock-stop'].forEach(id=>assert(html.includes('id="'+id+'"'),id));
 assert(/id="tap-dock" class="tap-dock" hidden/.test(html),'hidden until tapping');
 const css=fs.readFileSync(path.join(__dirname,'../css/app.css'),'utf8');assert(/\.tap-dock\{position:fixed/.test(css));
 const app=fs.readFileSync(path.join(__dirname,'../js/app.js'),'utf8');assert(/dock\.hidden = !tappingLines/.test(app)&&/function positionTapDock/.test(app)&&/addEventListener\("scroll", positionTapDock/.test(app));
 assert(/renderer\.view\.tapNext = tappingLines/.test(app));assert(/function drawTapCue/.test(fs.readFileSync(path.join(__dirname,'../js/render.js'),'utf8')));
});
test('fix6e tapping: one tap per line, said in the tap panel and the dock; start+end tapping is warned with Clear taps',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
 assert(html.includes("<strong>One tap per line:</strong> tap once at the first sound of each lyric line. Don't tap line ends — the next line's tap marks where this one ends."));
 assert(/id="tap-dock"[\s\S]*One tap per line[\s\S]*Next to tap:/.test(html));['tap-next-big','tap-warn','tap-dock-warn','tap-dock-clear'].forEach(id=>assert(html.includes('id="'+id+'"'),id));
 const app=fs.readFileSync(path.join(__dirname,'../js/app.js'),'utf8');
 assert(/taps\[i\]\.t_ms - taps\[i - 1\]\.t_ms < 800/.test(app)&&/More taps than lyric lines/.test(app)&&/checkTapPattern\(!tap\)/.test(app));
 // the session side: once every line is tapped, a further tap is refused (that is the "more taps than lines" case)
 const s=SS.createSession();SS.setLyrics(s,'one line\nsecond line');assert(SS.addLineTap(s,1000,0));assert(SS.addLineTap(s,5000,0));assert.equal(SS.addLineTap(s,5600,0),null);
});
test('fix6f vocal range: 2nd/98th percentiles of confident lead frames; glitches, quiet frames and harmony left out; baseline is the semitone midpoint',()=>{
 const f=[];let t=0;const push=(m,n,o)=>{for(let i=0;i<n;i++){f.push({t_ms:t,f0:hz(m+(i%3)*0.1),voiced:true,rms:(o&&o.rms)||.05});t+=30;}t+=300;};
 for(let k=0;k<10;k++) for(const m of [50,52,53,55,57,59,60,62]) push(m,12);   // body D3..D4
 push(74,8);push(75,8);                // glitch cluster far above (bleed / octave error), past an empty pitch gap
 const hStart=t;push(66,30);const hEnd=t; // a stacked high note inside a harmony region
 push(40,10,{rms:.001});               // quiet rumble
 const r=SS.measureVocalRange(f,{harmonyRegions:[{start_ms:hStart,end_ms:hEnd}],cleanup:false});
 assert.equal(r.low_note,'D3');assert.equal(r.high_note,'D4');assert(Math.abs(r.baseline_midi-(r.low_midi+r.high_midi)/2)<0.01);
 assert.equal(r.baseline_note,SS.noteName(Math.sqrt(r.low_hz*r.high_hz)));assert(Math.abs(r.baseline_hz-Math.sqrt(r.low_hz*r.high_hz))<0.05,'midpoint in log pitch');
 assert.equal(r.excluded.harmony_regions,30);assert(r.excluded.outlier_clusters>=16);assert(r.excluded.quiet>=10);assert.deepEqual(r.percentiles,[2,98]);
 assert.equal(SS.vocalRangeLabel(r),'Range D3–D4, baseline '+r.baseline_note);
 assert.equal(SS.noteName(185),'F#3');assert.equal(SS.noteName(440),'A4');assert.equal(SS.measureVocalRange(f.slice(0,10)),null,'too little voice');
 const d=SS.buildDraft(f,{range:r});assert.equal(d.baseline_hz,r.baseline_hz);assert.equal(d.baseline_from,'vocal_range_midpoint');
 assert.equal(SS.buildDraft(f,{range:r,baselineHz:200}).baseline_from,'fixed');assert.equal(SS.buildDraft(f,{}).baseline_from,'median_f0');
});
test('fix6f register labels are fifths of the singer range; without a range the old thresholds stay',()=>{
 const feat=mean=>({mean,start:mean,end:mean,max:mean,min:mean,range:0,peak_pos:.5,min_pos:.5,hold_ms:0,turns:0,breaks:0,segments:1,short_segments:0,voiced_ratio:1,duration_ms:2000,voiced_ms:2000,words_per_s:2});
 const wide={half_span_octaves:1},narrow={half_span_octaves:0.4};
 const reg=(m,r)=>SS.cpuLineCues(r?SS.applyVocalRange(feat(m),r):feat(m),[]).find(c=>/ register$/.test(c));
 assert.equal(reg(0.3),'upper-mid register');assert.equal(reg(0.3,wide),'upper-mid register');assert.equal(reg(0.3,narrow),'high register');
 assert.equal(reg(-0.05,narrow),'mid register');assert.equal(reg(-0.1,{half_span_octaves:0.3}),'lower-mid register');assert.equal(reg(-0.35,narrow),'low register');assert.equal(reg(0.5,wide),'upper-mid register');assert.equal(reg(0.7,wide),'high register');
 const map=extendFixture();map.vocal_range={half_span_octaves:0.1,baseline_hz:300,low_note:'G#3',high_note:'C5',baseline_note:'E4'};
 const e=SS.buildExtendTransfer(map,LIFT_P1);const tagsNarrow=SS.makeHandoff(map,e.transfer).lyrics;
 map.vocal_range=null;const tagsNone=SS.makeHandoff(map,SS.buildExtendTransfer(map,LIFT_P1).transfer).lyrics;
 const regs=t=>(t.match(/(high|upper-mid|mid|lower-mid|low) register/g)||[]);assert(regs(tagsNarrow).length&&regs(tagsNarrow).join()!==regs(tagsNone).join(),'the range changes register tags');
 const lyr=t=>t.split('\n').filter(l=>l&&!/^\[/.test(l));assert.deepEqual(lyr(tagsNarrow),lyr(tagsNone),'lyrics untouched');
});
test('fix6f vocal range is saved with the project, shown in the UI and written to the vocal JSON',()=>{
 const s=SS.createSession();assert.equal(s.vocal_range,null);
 s.vocal_range={method:'percentiles_of_confident_lead_frames',percentiles:[2,98],low_hz:207.65,high_hz:523.25,baseline_hz:329.63,low_note:'G#3',high_note:'C5',baseline_note:'E4',low_midi:56,high_midi:72,baseline_midi:64,span_semitones:16,half_span_octaves:0.6,median_hz:330.1,frames_used:1500,frames_voiced:2200,excluded:{harmony_regions:40,quiet:500,unstable_or_isolated:12,outlier_clusters:99},harmony_regions_excluded:5,source:'vocal_stem'};
 const back=SS.parseSession(SS.sessionToJSON(s)).vocal_range;assert.equal(back.baseline_note,'E4');assert.equal(back.half_span_octaves,0.6);assert.equal(back.excluded.outlier_clusters,99);
 assert.throws(()=>SS.parseSession({schema_version:'songshape-live-0.1',vocal_range:[1]}),/vocal_range/);
 assert.equal(SS.parseSession({schema_version:'songshape-live-0.1',vocal_range:{low_hz:'x'}}).vocal_range,null,'bad numbers are dropped');
 const map=extendFixture();map.vocal_range=back;const e=SS.buildExtendTransfer(map,LIFT_P1);const h=SS.makeHandoff(map,e.transfer);
 const j=SS.buildPerformanceJson({map,transfer:e.transfer,handoff:h,refs:e.refs,step:1});assert.equal(j.vocal_range.baseline_note,'E4');assert.match(j.semantics.register,/fifths of the confident lead range/);
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');assert(html.includes('id="vocal-range-label"'));assert(html.indexOf('js/vocal-range.js')<html.indexOf('js/app.js'));
 const app=fs.readFileSync(path.join(__dirname,'../js/app.js'),'utf8');assert(/SS\.measureVocalRange\(frames, \{ harmonyRegions: session\.detected_harmony/.test(app)&&/range:session\.vocal_range,cleanup:true/.test(app)&&/if \(stemRangeJob\) return stemRangeJob\.then/.test(app));
 assert(/Singer baseline" \+ \(view\.vocalRange/.test(fs.readFileSync(path.join(__dirname,'../js/render.js'),'utf8')));
});
(async()=>{let n=0;for(const [name,fn]of tests){await fn();n++;console.log('ok v0.2.11 '+name);}console.log(`\n${n} v0.2.11 tests passed`);})().catch(e=>{console.error(e);process.exitCode=1;});
