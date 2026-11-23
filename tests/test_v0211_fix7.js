'use strict';
// v0.2.11 fix7: guided flow renumbered 1-10, tap anchors, Clear taps, stage guards, needs_review policy,
// section pace vs line tags, very short lines, restrained margin.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const SS=require('../js/extend.js');Object.assign(SS,require('../js/suno-budget.js'),require('../js/performance-json.js'));
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const app=fs.readFileSync(path.join(__dirname,'../js/app.js'),'utf8');
const tests=[];function test(n,f){tests.push([n,f]);}

function session(lines){const s=SS.createSession();SS.setLyrics(s,lines.join('\n'));return s;}
function lyricLines(s){return s.lyrics.lines.filter(l=>l.kind==='lyric');}
function anchor(s,w,t,extra){return Object.assign({id:'anchor-'+(s.anchors.length+1),word_id:w.id,line_id:w.line_id,word_ids:[w.id],kind:'word',start_ms:t,end_ms:t+200,needs_review:true,source:'imported_known_lyrics_alignment'},extra||{});}

test('tap anchors: unplaced words are laid out from the tap; aligner lines within 400 ms are kept, others shifted; hand words never move',()=>{
 const s=session(['one two three','four five six','seven eight nine','ten eleven twelve']);const L=lyricLines(s);const W=id=>s.lyrics.words.filter(w=>w.line_id===id);
 // line 2: aligner words 200 ms after its tap (kept); line 3: aligner words 1.5 s late (shifted); line 4: a hand-checked word
 W(L[1].id).forEach((w,i)=>s.anchors.push(anchor(s,w,5200+i*400)));
 W(L[2].id).forEach((w,i)=>s.anchors.push(anchor(s,w,11500+i*400)));
 s.anchors.push(anchor(s,W(L[3].id)[0],15000,{needs_review:false,source:'next_word'}));
 s.line_taps=[{line_id:L[0].id,t_ms:500,raw_ms:600},{line_id:L[1].id,t_ms:5000,raw_ms:5100},{line_id:L[2].id,t_ms:10000,raw_ms:10100},{line_id:L[3].id,t_ms:14000,raw_ms:14100}];
 const r=SS.applyTapAnchors(s,30000);
 const at=id=>s.anchors.filter(a=>a.line_id===id).sort((a,b)=>a.start_ms-b.start_ms);
 assert.deepEqual(at(L[0].id).map(a=>a.start_ms),[500,1050,1600]);assert(at(L[0].id).every(a=>a.tap_anchored&&a.source==='cpu_tap_anchored_estimate'&&a.needs_review));
 assert.deepEqual(at(L[1].id).map(a=>a.start_ms),[5200,5600,6000],'within 400 ms: aligner positions kept');assert(at(L[1].id).every(a=>a.tap_anchored));
 assert.equal(at(L[2].id)[0].start_ms,10000,'shifted to the tap');assert.match(at(L[2].id)[0].anchor_rule,/^line_tap_/);
 assert.equal(at(L[3].id).length,1);assert.equal(at(L[3].id)[0].start_ms,15000,'hand-checked word not moved');assert(!at(L[3].id)[0].tap_anchored);
 assert.equal(r.laid_out,3);assert.equal(r.shifted,3);assert(r.kept>=4);
 assert.equal(SS.applyTapAnchors(session(['a b']),1000).words,0,'no taps: nothing changes');
});
test('Clear taps removes only the taps; the placed words stay (bug: it also cleared the words)',()=>{
 const s=session(['one two','three four']);s.lyrics.words.forEach((w,i)=>s.anchors.push(anchor(s,w,1000+i*500)));
 s.line_taps=[{line_id:lyricLines(s)[0].id,t_ms:900,raw_ms:1000}];SS.applyTapAnchors(s,9000);
 const before=s.anchors.map(a=>a.word_id+':'+a.start_ms).join();
 assert.equal(SS.clearLineTaps(s),1);assert.equal(s.line_taps.length,0);assert.equal(s.anchors.map(a=>a.word_id+':'+a.start_ms).join(),before);
 // the page handler: clears taps, unmarks tap_anchored, never clears anchors or resets the lyrics
 const fn=app.slice(app.indexOf('function clearTapsOnly'),app.indexOf('document.getElementById("btn-tap-start")',app.indexOf('function clearTapsOnly')));
 assert(/SS\.clearLineTaps\(session\)/.test(fn)&&!/clearAnchors|setLyrics/.test(fn),'clearTapsOnly touches only taps');
 assert.equal((app.match(/\{ clearTapsOnly\(\);/g)||[]).length,2,'both Clear taps buttons use it');
 // the lyrics box: an unchanged (or whitespace-only) edit keeps the words; a real change asks first
 assert(/function lyricsChangeClearsWork/.test(app)&&/if \(changed === false\) \{ lastLyricsInput = this\.value; return; \}/.test(app)&&/window\.confirm\("The original lyrics changed\./.test(app));
 assert(/if \(lyricsChangeClearsWork\(text\) === false\)/.test(app),'Run / tapping do not reset on a whitespace difference');
 // while tapping, Enter/Space inside the lyrics box tap the line instead of typing
 assert(/tappingLines && tag === "TEXTAREA" && \(ev\.code === "Enter" \|\| ev\.code === "Space"\)/.test(app)&&/if \(tappingLines && document\.activeElement && document\.activeElement\.blur\)/.test(app));
 assert(/Paste the original lyrics first \(step 2\)\./.test(app),'no "All lines tapped." without lyrics');
 assert(html.includes('id="btn-clear-words" title="Removes every placed word (not the taps)">Clear all placed words</button>'));
});
test('anchor tap_anchored, confidence and review_flags survive save and load',()=>{
 const s=session(['one two']);const w=s.lyrics.words;
 s.anchors.push(anchor(s,w[0],100,{tap_anchored:true,confidence:0.21,review_flags:['low_alignment_confidence','<b>x']}),anchor(s,w[1],600,{confidence:7}));
 const back=SS.parseSession(SS.sessionToJSON(s)).anchors;
 assert.equal(back[0].tap_anchored,true);assert.equal(back[0].confidence,0.21);assert.equal(back[0].review_flags[0],'low_alignment_confidence');assert.equal(back[0].review_flags.length,2);
 assert.equal(back[1].tap_anchored,false);assert.equal(back[1].confidence,null,'out of range dropped');
});
test('step 7 badge counts tap-anchored words; steps 7 and 8 wait for running jobs; both pipeline buttons mark themselves running',()=>{
 assert(/else if \(a\.tap_anchored\) \{ n\.tap \+= 1;/.test(app)&&/anchored to your taps \(/.test(app));
 const s1=app.slice(app.indexOf('  function stage1() {'),app.indexOf('  function stage2() {'));
 assert(/whenIdle\("Place words"\)/.test(s1)&&/player\.hasAudio\(\)/.test(s1)&&/player\.getWaveform && player\.getWaveform\(\)/.test(s1)&&/SS\.applyTapAnchors\(session/.test(s1));
 assert(/whenIdle\("Draft the shape"\)/.test(app));
 assert(/if \(stemRangeJob\)/.test(app.slice(app.indexOf('function whenIdle'),app.indexOf('function stage1()'))));
 const pipe=id=>app.slice(app.indexOf('getElementById("'+id+'").addEventListener'),app.indexOf('getElementById("'+id+'").addEventListener')+1500);
 assert(/pipelineRunning = true/.test(pipe('btn-pipeline-cpu'))&&/pipelineRunning = false/.test(pipe('btn-pipeline-cpu')));
 assert(/pipelineRunning = true/.test(pipe('btn-pipeline-ai'))&&/pipelineRunning = false/.test(pipe('btn-pipeline-ai')));
 // step 8 feedback: time of the last run, a highlight, live percentage, and what was measured
 assert(/g-when-/.test(app)&&/classList\.add\("g-updated"\)/.test(app)&&/g2\.dataset\.state === "running"/.test(app)&&/contour segment\(s\) on the /.test(app));
 assert(/@keyframes g-flash/.test(fs.readFileSync(path.join(__dirname,'../css/app.css'),'utf8')));
});
test('the guided flow is numbered 1 to 10 with no gaps; the lyrics box is step 2; the step 7 tap hint',()=>{
 const g=html.slice(html.indexOf('<section id="guided"'),html.indexOf('</section>',html.indexOf('<section id="guided"')));
 const nums=[...g.matchAll(/<h3>(\d+)(?:–(\d+))? · /g)].map(m=>+m[1]);assert.deepEqual(nums,[1,2,3,4,5,6,7]);
 const cards=[...g.matchAll(/class="g-name">(\d+) · /g)].map(m=>+m[1]);assert.deepEqual(cards,[7,8,9,10]);
 assert(g.includes('id="lyrics-text"'),'lyrics box is inside the flow');assert(g.indexOf('id="lyrics-text"')<g.indexOf('id="btn-open-stem"'));
 assert(g.indexOf('id="btn-open-stem"')<g.indexOf('id="helper-token"')&&g.indexOf('id="helper-token"')<g.indexOf('id="btn-pipeline-cpu"')&&g.indexOf('id="btn-pipeline-cpu"')<g.indexOf('id="tap-panel"')&&g.indexOf('id="tap-panel"')<g.indexOf('id="g-status-1"'));
 const aside=html.slice(html.indexOf('<aside class="side">'),html.indexOf('</aside>'));assert(!aside.includes('id="lyrics-text"'));
 assert(g.includes('If you did the tapping step, click this once more so it re-places the words using your taps as anchors.'));
 assert(/Skip steps 4 and 5/.test(g)&&/optional · your own PC only/.test(g)&&/6 · Tap line starts <span class="optional-tag">optional/.test(g));
 assert(/no GPU and no helper needed/.test(g),'own stem needs no GPU');
 assert(!/Stage 0|stage 1\b|four stages/.test(g),'old numbering gone');
 assert(/"Paused after step " \+ \(k \+ 6\)/.test(app)&&/getElementById\("btn-flow-open"\)/.test(app));
 assert((html.match(/id="lyrics-text"/g)||[]).length===1&&(html.match(/id="g-status-1"/g)||[]).length===1);
});
function policyMap(o){
 const ref=['There is no time for us','There is no place for us'];const s=session(ref);
 s.lyrics.words.forEach((w,i)=>s.anchors.push(anchor(s,w,1000+i*400+(i>=6?800:0),o&&o.anchor&&o.anchor(i))));
 const pts=[];for(let x=1000;x<=6200;x+=50)pts.push([x,Math.sin(x/500)*0.4]);
 s.strokes=[{id:'stroke-1',start_ms:1000,end_ms:3300,points:pts.filter(p=>p[0]<=3300)},{id:'stroke-2',start_ms:3400,end_ms:6200,points:pts.filter(p=>p[0]>=3400)}];
 return SS.buildPerformanceMap(SS.sessionToJSON(s));
}
test('needs_review only for real problems; machine word estimates are one global caveat',()=>{
 const m=policyMap();const h=SS.makeHandoff(m,SS.buildTransfer(m,'We have no road to walk\nWe have no home to go'));
 assert(h.payload.projected_lines.every(l=>l.status!=='needs_review'),JSON.stringify(h.payload.projected_lines.map(l=>[l.status,l.warnings])));
 assert(!h.warnings.includes('reference_anchor_estimates_need_confirmation'));assert.match(h.payload.estimate_caveat,/2 of 2 line\(s\) are machine estimates/);assert.match(h.caveats,/machine estimates/);
 // a few words more is a fit note, far more is a problem
 const near=SS.makeHandoff(m,SS.buildTransfer(m,'We have no road to walk on now\nWe have no home'));assert(near.payload.projected_lines.every(l=>l.status!=='needs_review'));
 const far=SS.makeHandoff(m,SS.buildTransfer(m,'We have no road to walk on now and never will again\nhome'));
 assert.equal(far.payload.projected_lines[0].status,'needs_review');assert(far.payload.projected_lines[0].warnings.includes('word_or_line_count_mismatch'));
 assert.equal(SS.wordCountTolerance(6),2);assert.equal(SS.wordCountTolerance(2),1);
 // a sung line the user split into short lines is compared as a whole ("What color / is my / honor?")
 const split=SS.makeHandoff(m,SS.buildTransfer(m,'We have\nno road\nto walk\nWe have no home to go'));
 assert.deepEqual(split.payload.projected_lines.map(l=>l.status==='needs_review'),[false,false,false,false],JSON.stringify(split.payload.projected_lines.map(l=>l.warnings)));
 assert.deepEqual(SS.splitRunWords([['g1'],['g1'],['g1'],['g2'],[]],[2,2,2,6,3]),[6,6,6,6,3]);
 // a low-confidence aligner word flags its line only
 const lc=policyMap({anchor:i=>i===2?{confidence:0.1,review_flags:['low_alignment_confidence']}:{}});const hl=SS.makeHandoff(lc,SS.buildTransfer(lc,'We have no road to walk\nWe have no home to go'));
 assert.deepEqual(hl.payload.projected_lines.map(l=>l.status==='needs_review'),[true,false]);assert(hl.payload.projected_lines[0].warnings.includes('reference_group_needs_review'));
 assert(lc.groups[0].review_reasons.includes('low_confidence_word_placement'));
 // hand-checked words: no estimate caveat
 const hc=policyMap({anchor:()=>({needs_review:false,source:'next_word'})});assert.equal(SS.makeHandoff(hc,SS.buildTransfer(hc,'a b c d e f\ng h i j k l')).payload.estimate_caveat,null);
});
test('section [Vocal style] pace agrees with its line tags',()=>{
 const rapid=['falling line','rapid phrasing'],slow=['level line','slow, spacious phrasing'],plain=['level line'];
 assert.equal(SS.reconcileSectionStyle('[Vocal style: slow, spacious phrasing; mid register; steady intensity]',[rapid,rapid,plain]),'[Vocal style: quick phrasing; mid register; steady intensity]');
 assert.equal(SS.reconcileSectionStyle('[Vocal style: quick phrasing; high register]',[slow,slow,slow,rapid]),'[Vocal style: slow, spacious phrasing; high register]');
 assert.equal(SS.reconcileSectionStyle('[Vocal style: slow, spacious phrasing; high register]',[rapid,plain,plain]),'[Vocal style: high register]','a contradicted pace term is dropped');
 assert.equal(SS.reconcileSectionStyle('[Vocal style: moderate pace; high register]',[rapid,plain,plain]),'[Vocal style: moderate pace; high register]');
 assert.equal(SS.reconcileSectionStyle('[Vocal style: wordless vocalise; high register]',[rapid,rapid]),'[Vocal style: wordless vocalise; quick phrasing; high register]');
 assert.equal(SS.reconcileSectionStyle(null,[rapid]),null);
 // end to end: every section style in a real handoff agrees with the section's lines
 const lift='[Verse]\nWe had no road\nWe had no home\n\n[Chorus]\nWhat color is my honor\nWhat color is my honor';
 const map=require('./test_v0211_fixture.js').extendFixture(SS);const e=SS.buildExtendTransfer(map,lift);const h=SS.makeHandoff(map,e.transfer);
 const blocks=h.lyrics.split(/\n\n+/);for(const b of blocks){const st=(b.match(/^\[Vocal style: [^\]]+\]$/m)||[])[0];if(!st)continue;const lines=b.split('\n').filter(l=>/^\[Delivery:/.test(l));
  if(/slow, spacious/.test(st)) assert(!lines.some(l=>/rapid phrasing/.test(l)),b);if(/quick phrasing/.test(st)) assert(!lines.some(l=>/slow, spacious phrasing/.test(l)),b);}
 (e.transfer.section_plan||[]).forEach(p=>{if(p.style_tag_before_reconcile)assert.notEqual(p.style_tag,p.style_tag_before_reconcile);});
});
test('very short lines: a split-off line shares the line before; a lone short line keeps only the essentials',()=>{
 const tags=['rising line','lower-mid register','restrained','long sustained note on "color"','phrase break mid-line','slow, spacious phrasing'];
 const rows=[{text:'What color',reference_group_ids:['g1'],cpu_tags:tags.slice()},{text:'is my',reference_group_ids:['g1'],cpu_tags:tags.slice()},{text:'honor?',reference_group_ids:['g1'],cpu_tags:tags.slice()},
  {text:'When',reference_group_ids:['g2'],cpu_tags:['up-and-down line','high register','powerful','held note on "When"','peak on "When"','falls away at the end','phrase break mid-line']},
  {text:'brothers die young',reference_group_ids:['g2'],cpu_tags:['falling line','mid register']}];
 SS.shortLinePolicy(rows);
 assert.deepEqual(rows[0].cpu_tags,['rising line','lower-mid register','long sustained note on "color"'],'first of the run: essentials only');
 assert.deepEqual(rows[1].cpu_tags,[]);assert.equal(rows[1].merged_with_line,1);assert.deepEqual(rows[2].cpu_tags,[]);assert.equal(rows[2].merged_with_line,1);
 assert.deepEqual(rows[3].cpu_tags,['up-and-down line','high register','held note on "When"','peak on "When"']);assert.equal(rows[3].short_line.rule,'trimmed_to_essentials');
 assert.deepEqual(rows[4].cpu_tags,['falling line','mid register'],'3+ word lines untouched');
 // in the sheet: no [Delivery] above a merged line, and the lyric words are unchanged
 const m=policyMap();const h=SS.makeHandoff(m,SS.buildTransfer(m,'We have no\nroad\nWe have no home to go'));
 const out=h.lyrics.split('\n');const i=out.indexOf('road');assert(i>0&&!/^\[Delivery/.test(out[i-1]),h.lyrics);
 assert.deepEqual(out.filter(l=>l&&!/^\[/.test(l)),['We have no','road','We have no home to go']);
 assert.equal(h.payload.projected_lines[1].merged_with_line,1);
});
test('restrained needs a small margin below the baseline (lines right at E4 do not flip)',()=>{
 const f=max=>({mean:max-0.1,start:max-0.1,end:max-0.1,max,min:max-0.2,range:0.1,peak_pos:.5,min_pos:.5,hold_ms:0,turns:0,breaks:0,segments:1,short_segments:0,voiced_ratio:1,duration_ms:2000,voiced_ms:2000,words_per_s:2});
 assert.equal(SS.CPU_TAG_RESTRAINED_MARGIN,0.04);
 assert.equal(SS.classifyLineFeatures(f(0)).dynamics,'steady');assert.equal(SS.classifyLineFeatures(f(-0.02)).dynamics,'steady');
 assert.equal(SS.classifyLineFeatures(f(-0.05)).dynamics,'restrained');assert.equal(SS.classifyLineFeatures(f(-0.2)).dynamics,'restrained');
});
(async()=>{let n=0;for(const [name,fn]of tests){await fn();n++;console.log('ok v0.2.11 fix7 '+name);}console.log(`\n${n} v0.2.11 fix7 tests passed`);})().catch(e=>{console.error(e);process.exitCode=1;});
