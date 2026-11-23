'use strict';
// Optional local helper: loopback, token, origin allowlist, argv-only tools. Uses fake tools; skipped without python3.
const assert=require('node:assert/strict');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {spawn,spawnSync}=require('node:child_process');
const py=['python3','python'].find(p=>spawnSync(p,['--version']).status===0);
if(!py){console.log('skip v0.2.11 helper tests (no python)');process.exit(0);}
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ss-helper-'));
fs.writeFileSync(path.join(dir,'sep.py'),"import sys,shutil,os\nos.makedirs(sys.argv[2],exist_ok=True)\nshutil.copy(sys.argv[1],os.path.join(sys.argv[2],'vocals.wav'))\n");
fs.writeFileSync(path.join(dir,'align.py'),"import sys,json\nw=json.load(open(sys.argv[2]))['words']\njson.dump({'words':[{'text':x['text'],'start':i,'end':i+.5,'chars':[{'c':c,'start':i+.1*k,'end':i+.1*k+.1} for k,c in enumerate(x['text'])]} for i,x in enumerate(w)]},open(sys.argv[3],'w'))\n");
fs.writeFileSync(path.join(dir,'ffmpeg.exe'),'');
const cfg={device:'cpu',tools_home:dir,tools:[{name:'ffmpeg',path:path.join(dir,'ffmpeg.exe')},{name:'Demucs weights',path:path.join(dir,'nope.th')}],separator:[py,path.join(dir,'sep.py'),'{input}','{outdir}'],aligner:[py,path.join(dir,'align.py'),'{input}','{words}','{output}']};
fs.writeFileSync(path.join(dir,'cfg.json'),JSON.stringify(cfg));
const port=18000+Math.floor(Math.random()*2000);
const env=Object.assign({},process.env,{SS_FFMPEG:path.join(dir,'ffmpeg.exe')});
const child=spawn(py,[path.join(__dirname,'../tools/helper/songshape_helper.py'),'--config',path.join(dir,'cfg.json'),'--port',String(port),'--work-dir',path.join(dir,'work')],{env});
const cfg2={device:'cpu',aligner:[path.join(dir,'missing-python.exe'),path.join(dir,'align.py'),'{input}','{words}','{output}'],separator:[py,path.join(dir,'missing_sep.py'),'{input}','{outdir}']};
fs.writeFileSync(path.join(dir,'cfg2.json'),JSON.stringify(cfg2));const port2=port+1;
const child2=spawn(py,[path.join(__dirname,'../tools/helper/songshape_helper.py'),'--config',path.join(dir,'cfg2.json'),'--port',String(port2),'--work-dir',path.join(dir,'work2')],{env});
let out2='';child2.stdout.on('data',d=>out2+=d);
let out='';child.stdout.on('data',d=>out+=d);
function wav(){const n=800,b=Buffer.alloc(44+n*2);b.write('RIFF',0);b.writeUInt32LE(36+n*2,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);return b;}
(async()=>{
 for(let i=0;i<60&&!/Token/.test(out);i++)await new Promise(r=>setTimeout(r,100));
 const token=(out.match(/Token \(paste[^:]*: (\S+)/)||[])[1];assert(token,'helper printed a token');
 const base=`http://127.0.0.1:${port}`;
 assert.equal((await fetch(base+'/health')).status,401,'token required');
 assert.equal((await fetch(base+'/health',{headers:{'X-SongShape-Token':token,Origin:'https://evil.example'}})).status,403,'remote origin rejected');
 const h=await (await fetch(base+'/health',{headers:{'X-SongShape-Token':token,Origin:'null'}})).json();assert(h.separator_configured&&h.aligner_configured);
 assert.equal(h.tools_home,dir);assert.deepEqual(h.tools.map(t=>t.name+':'+t.found),['ffmpeg:true','Demucs weights:false'],'each tool with its path and found flag');
 assert.equal((await fetch(base+'/separate',{method:'POST',headers:{'X-SongShape-Token':token},body:Buffer.from('not audio at all')})).status,400,'non-audio refused');
 const sep=await fetch(base+'/separate',{method:'POST',headers:{'X-SongShape-Token':token,'X-Filename':'song.wav'},body:wav()});assert.equal(sep.status,200);
 const id=sep.headers.get('x-audio-id');assert(id);assert.equal(Buffer.from(await sep.arrayBuffer()).subarray(0,4).toString(),'RIFF');
 const al=await (await fetch(base+'/align',{method:'POST',headers:{'X-SongShape-Token':token,'Content-Type':'application/json'},body:JSON.stringify({audio_id:id,words:[{id:'w1',text:'we'},{id:'w2',text:'our'}]})})).json();
 assert.equal(al.words.length,2);assert.equal(al.words[1].chars[1].c,'u');
 assert.equal((await fetch(base+'/align',{method:'POST',headers:{'X-SongShape-Token':token,'Content-Type':'application/json'},body:JSON.stringify({audio_id:'../../etc/passwd',words:[{text:'x'}]})})).status,400,'only helper-issued audio ids');
 for(let i=0;i<60&&!/Token/.test(out2);i++)await new Promise(r=>setTimeout(r,100));
 const t2=(out2.match(/Token \(paste[^:]*: (\S+)/)||[])[1];const b2=`http://127.0.0.1:${port2}`;
 const h2=await (await fetch(b2+'/health',{headers:{'X-SongShape-Token':t2}})).json();
 assert(h2.tools.some(t=>t.name==='aligner program'&&!t.found&&/missing-python/.test(t.path)),'derived tool list flags a missing program');
 const s2=await fetch(b2+'/separate',{method:'POST',headers:{'X-SongShape-Token':t2,'X-Filename':'song.wav'},body:wav()});assert.equal(s2.status,400);assert(/script not found: .*missing_sep\.py/.test((await s2.json()).error),'clear not-found message');
 const up=await (await fetch(b2+'/upload',{method:'POST',headers:{'X-SongShape-Token':t2,'X-Filename':'song.wav'},body:wav()})).json();
 const a2=await fetch(b2+'/align',{method:'POST',headers:{'X-SongShape-Token':t2,'Content-Type':'application/json'},body:JSON.stringify({audio_id:up.audio_id,words:[{text:'x'}]})});assert(/Aligner not found: .*missing-python/.test((await a2.json()).error));
 console.log('ok v0.2.11 helper: token, origin allowlist, WAV/MP3 only, argv tools, issued ids only, tool paths and clear not-found\n\n1 v0.2.11 helper test passed');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{child.kill();child2.kill();fs.rmSync(dir,{recursive:true,force:true});});
