import test from 'node:test';
import assert from 'node:assert/strict';
import {AutoFrameParser,encodeBinary,encodeText} from '../serial-protocol.mjs';
import {QualityMonitor} from '../signal-quality.mjs';
import {Acquisition,syntheticSample} from '../acquisition.mjs';
import {ProtocolEngine,newState,PRE_REST} from '../engine.mjs';
import {RawRecorder,CSV_HEADER} from '../raw-storage.mjs';
import {crc32,zipStore} from '../zip-store.mjs';
import {writeFile} from 'node:fs/promises';

for(const [name,encode] of [['binary',encodeBinary],['text',encodeText]])test(`${name}: auto detection, arbitrary byte boundaries and exact raw ADC`,()=>{
 const expected=Array.from({length:100},(_,i)=>[i*7%1024,i*13%1024]),bytes=Uint8Array.from(expected.flatMap(([p,e])=>[...encode(p,e)])),actual=[],parser=new AutoFrameParser((p,e)=>actual.push([p,e]));
 for(let i=0;i<bytes.length;){const n=(i%13)+1;parser.push(bytes.slice(i,i+n));i+=n;}
 assert.equal(parser.protocol,name);assert.deepEqual(actual,expected);assert.ok(parser.pending.length<6);
});
test('bounded detection does not manufacture samples from unknown or out-of-range text',()=>{
 const rows=[],p=new AutoFrameParser((...v)=>rows.push(v));p.push(new Uint8Array(100000).fill(33));assert.ok(p.pending.length<=16384);assert.equal(rows.length,0);
 p.push(new TextEncoder().encode('PPG:9999\tECG:511\r\n'.repeat(10)));assert.equal(rows.length,0);
});
test('binary corruption is marked and the next complete frame is recovered',()=>{
 const rows=[],faults=[],p=new AutoFrameParser((a,b)=>rows.push([a,b]),s=>faults.push(s));
 p.push(Uint8Array.from([...[...encodeBinary(400,500),...encodeBinary(401,501),...encodeBinary(402,502)],170,187,255,255,0,1,7,...encodeBinary(403,503)]));
 assert.deepEqual(rows,[[400,500],[401,501],[402,502],[403,503]]);assert.ok(faults.length);assert.ok(p.invalid);
});
function feed(m,from,to,transform=(p,e)=>[p,e],nowShift=0){for(let n=from;n<to;n++){const [p,e]=transform(...syntheticSample(n));m.accept(p,e,Math.floor(n/10)*20+20+nowShift);}}
test('clean synthetic signal passes after warmup; raw samples stay unchanged',()=>{
 const m=new QualityMonitor();feed(m,0,8000);const s=m.snapshot(16000);assert.equal(s.ok,true,JSON.stringify(s));assert.equal(s.ecg.ok,true);assert.equal(s.ppg.ok,true);assert.ok(Math.abs(s.rateHz-500)<1);const raw=m.raw.array().at(-1);assert.deepEqual([raw.p,raw.e],syntheticSample(7999));
});
test('PPG removal rejects PPG promptly while ECG remains independently available',()=>{
 const m=new QualityMonitor();feed(m,0,8000);assert.equal(m.snapshot(16000).ok,true);
 feed(m,8000,8500,(_,e)=>[0,e]);const s=m.snapshot(17000);assert.equal(s.ok,false);assert.equal(s.ppg.ok,false);assert.equal(s.ecg.ok,true);assert.ok(s.ppg.reason.includes('饱和'));
 assert.equal(m.raw.array().length,1000);assert.ok(m.raw.array().some(r=>r.e>600));
});
test('flat channels, missing data and wrong reception rate are not accepted',()=>{
 const flat=new QualityMonitor();feed(flat,0,8000,()=>[500,500]);assert.equal(flat.snapshot(16000).ok,false);
 const m=new QualityMonitor();feed(m,0,8000);assert.equal(m.snapshot(17000).ok,false);assert.ok(m.snapshot(17000).reason.includes('断流'));
 const slow=new QualityMonitor();for(let n=0;n<8000;n++){const [p,e]=syntheticSample(n);slow.accept(p,e,n*4+4);}assert.equal(slow.snapshot(32000).ok,false);assert.ok(slow.snapshot(32000).reason.includes('速率'));
});
function engine(){const e=new ProtocolEngine(newState(-PRE_REST*1000));e.startPreRest(-PRE_REST*1000);e.tick(0);e.begin(0);e.s.qualityAutomatic=true;return e;}
test('automatic quality must stay good for 80s; failures reset and cannot be manually overridden',()=>{
 const e=engine();for(let t=0;t<=79;t++){e.applySignalQuality({ok:true,reason:'pass'},t*1000);e.tick(t*1000);}assert.equal(e.confirmQuality(79000),false);
 e.applySignalQuality({ok:false,reason:'PPG 平线'},80000);e.tick(80000);assert.equal(e.s.quality[0].since,null);assert.equal(e.confirmQuality(90000),false);
 for(let t=81;t<90;t++){e.applySignalQuality({ok:false,reason:'PPG 平线'},t*1000);e.tick(t*1000);}
 for(let t=90;t<170;t++){e.applySignalQuality({ok:true,reason:'pass'},t*1000);e.tick(t*1000);}
 assert.equal(e.confirmQuality(169000),false);e.applySignalQuality({ok:true,reason:'pass'},170000);assert.equal(e.confirmQuality(170000),true);e.tick(170000);assert.equal(e.current().id,'bp0');
});
test('operator invalidation is respected even if the algorithm currently passes',()=>{
 const e=engine();e.applySignalQuality({ok:true,reason:'pass'},0);e.markUnstable(10000);e.applySignalQuality({ok:true,reason:'pass'},20000);assert.equal(e.s.quality[0].since,null);
 e.restartQuality(21000);e.applySignalQuality({ok:true,reason:'pass'},21000);assert.equal(e.s.quality[0].since,21);
 e.applySignalQuality({ok:false,reason:'fail'},22000);assert.equal(e.validSeconds(22000),0);
});
test('signal rejection automatically delays BP and later steps until 80 new good seconds',()=>{
 const e=engine(),m=new QualityMonitor();let n=0,firstRecovery=null,bpAt=null;
 for(let t=1;t<=185;t++){
  for(let i=0;i<500;i++,n++){const [p,ecg]=syntheticSample(n);m.accept(t>=60&&t<76?500:p,ecg,(t-1)*1000+Math.floor(i/10)*20+20);}
  const q=m.snapshot(t*1000);e.applySignalQuality(q,t*1000);
  if(t===70){assert.equal(q.ok,false);assert.equal(e.validSeconds(t*1000),0);assert.equal(e.current().id,'baseline');}
  if(t>=76&&q.ok&&firstRecovery===null)firstRecovery=t;
  if(e.validSeconds(t*1000)>=80)e.confirmQuality(t*1000);
  e.tick(t*1000);
  if(e.current().id==='bp0'){bpAt=t;break;}
 }
 assert.ok(firstRecovery>76);assert.equal(bpAt,firstRecovery+80);assert.ok(bpAt>90);
 assert.ok(e.s.events.some(v=>v.type==='automatic_quality_rejected'&&v.reason.includes('PPG')));
 const schedule=e.schedule(bpAt*1000),exercise=schedule.find(p=>p.id==='exercise1');
 assert.equal(exercise.start,240+bpAt-90);assert.equal(exercise.duration,40);
 assert.match(e.report(bpAt*1000).scope,/重新累计连续 80 秒/);
});
class MemoryJournal{
 constructor(){this.s=null;this.chunks=[];this.fail=false;}
 async create(meta){return this.s={...meta,id:'session',frames:0,rawBytes:0,chunks:0};}
 async append(c){if(this.fail)throw new Error('quota');assert.equal(c.index,this.s.chunks);this.chunks.push(c);this.s.frames+=c.frames;this.s.rawBytes+=c.rawBytes;this.s.chunks++;}
 async update(_,p){Object.assign(this.s,p);}
 async get(){return this.s;}
 async parts(){return {metadata:this.s,csv:this.chunks.map(c=>new Blob([c.csv])),raw:this.chunks.flatMap(c=>c.bytes),quality:this.chunks.flatMap(c=>c.quality)};}
}
test('filtered preview removes DC but retains exact raw ADC and cannot approve flat signals',async()=>{
 const a=new Acquisition();a.journal=new MemoryJournal();a.recorder=new RawRecorder(a.journal);a.source='serial';a.connected=true;a.parser.protocol='binary';
 await a.start({subjectCode:'DISPLAY_TEST'});
 const bytes=Uint8Array.from(Array.from({length:6000},()=>[...encodeBinary(450,512)]).flat());a.ingest(bytes,12000);
 const plot=a.plot.array(),last=plot.at(-1);assert.equal(last.p,450);assert.equal(last.e,512);assert.ok(last.warm);
 assert.ok(Math.abs(last.pf)<1e-5);assert.ok(Math.abs(last.ef)<1e-5);assert.equal(a.snapshot(12000).ok,false);
 assert.ok(plot.every(v=>Number.isFinite(v.pf)&&Number.isFinite(v.ef)));
 await a.recorder.stop();const parts=await a.recorder.packageParts(),csv=await new Blob(parts.csv).text();
 assert.equal(csv.trim().split('\r\n').length,6000);assert.ok(csv.trim().split('\r\n').every(line=>line.split(',')[5]==='450'&&line.split(',')[6]==='512'));
 assert.deepEqual(new Uint8Array(await new Blob(parts.raw).arrayBuffer()),bytes);
 const segment=last.segment;a.ingest(Uint8Array.from(Array.from({length:5},()=>[...encodeBinary(700,800)]).flat()),13000);
 const restarted=a.plot.array().at(-1);assert.ok(restarted.segment>segment);assert.equal(restarted.warm,false);assert.ok(Math.abs(restarted.pf)<1e-5);assert.ok(Math.abs(restarted.ef)<1e-5);
});
test('raw recorder preserves bytes and ADC through chunk flush and final partial block',async()=>{
 const j=new MemoryJournal(),r=new RawRecorder(j);await r.start({startedAt:1000,source:'serial'});const expected=[];
 for(let n=0;n<1100;n++){const [p,e]=syntheticSample(n),b=encodeBinary(p,e);expected.push(...b);r.addBytes(b);b.fill(0);r.addSample(p,e,1000+n*2,{phase:n<500?'baseline':'exercise1',interference:n>900,qualityState:'fail'},1);if(n===500)await r.flush();}
 await r.stop({status:'stopped'});assert.equal(r.savedFrames,1100);const parts=await r.packageParts(),raw=new Uint8Array(await new Blob(parts.raw).arrayBuffer()),csv=await new Blob([CSV_HEADER,...parts.csv]).text();assert.deepEqual([...raw],expected);assert.equal(csv.trim().split('\r\n').length,1101);assert.ok(csv.includes('exercise1,1,fail'));assert.equal(j.s.frames,1100);
});
test('storage failure is visible, stops recording and keeps the unsaved chunk exportable',async()=>{
 const j=new MemoryJournal(),faults=[],r=new RawRecorder(j,e=>faults.push(e));await r.start({startedAt:0,source:'serial'});r.addBytes(encodeBinary(123,456));r.addSample(123,456,2,{phase:'baseline',interference:false,qualityState:'pass'},1);j.fail=true;await r.flush();assert.equal(r.recording,false);assert.equal(faults.length,1);const p=await r.packageParts();assert.equal(p.metadata.unsavedChunksIncluded,1);assert.ok((await new Blob(p.csv).text()).includes(',123,456,'));assert.equal(new Blob(p.raw).size,6);
});
test('a pending final write cannot stop or overwrite the next participant session',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve),sessions=new Map();let n=0;
 const journal={async create(meta){const s={...meta,id:String(++n),frames:0,status:'recording'};sessions.set(s.id,s);return s;},async append(c){await gate;sessions.get(c.sessionId).frames+=c.frames;},async update(id,patch){await Promise.resolve();Object.assign(sessions.get(id),patch);}};
 const r=new RawRecorder(journal),a=await r.start({startedAt:0,subjectCode:'A'});
 r.addSample(123,456,2,{phase:'baseline',interference:false,qualityState:'pass'},1);
 const stopping=r.stop({flow:{subjectCode:'A'}}),starting=r.start({startedAt:10,subjectCode:'B'});
 await Promise.resolve();assert.equal(r.session.id,a.id);release();await stopping;const b=await starting;
 assert.equal(sessions.get(a.id).status,'stopped');assert.equal(sessions.get(a.id).frames,1);assert.equal(sessions.get(a.id).flow.subjectCode,'A');
 assert.equal(sessions.get(b.id).status,'recording');assert.equal(sessions.get(b.id).flow,undefined);assert.equal(r.frames,0);
});
test('switching preview sources after stopping cannot relabel a saved raw recording',async()=>{
 const a=new Acquisition();a.journal=new MemoryJournal();a.recorder=new RawRecorder(a.journal);a.source='serial';a.connected=true;a.parser.protocol='text';
 const session=await a.start({subjectName:'A',subjectCode:'A001'});
 a.ingest(new TextEncoder().encode('PPG:123\tECG:456\r\n'.repeat(3)),session.startedAt+20);
 const flow={endedAt:new Date(session.startedAt+20).toISOString()};await a.finish(flow);
 a.source='synthetic';a.parser.protocol='binary';
 const exported=await a.export(session.id,flow);assert.equal(exported.metadata.protocol,'text');assert.equal(exported.metadata.source,'serial');assert.equal(exported.metadata.subjectCode,'A001');assert.equal(exported.metadata.frames,3);
});
test('a changed protocol during recording stops capture instead of mixing decoded formats',async()=>{
 const faults=[],a=new Acquisition({onFault:(...v)=>faults.push(v)});a.journal=new MemoryJournal();a.recorder=new RawRecorder(a.journal);a.connected=true;a.source='serial';a.parser.protocol='binary';
 await a.start({subjectCode:'A001'});a.makeParser();a.ingest(new TextEncoder().encode('PPG:123\tECG:456\r\n'.repeat(3)));
 assert.equal(a.recorder.recording,false);assert.equal(a.recorder.frames,0);assert.equal(faults[0][0],'protocol');assert.ok(a.recorder.fault);
 const p=await a.recorder.packageParts();assert.ok(new Blob(p.raw).size>0);assert.equal(p.quality[0].event,'protocol_changed');
});
test('ZIP store uses standard CRC32 and preserves contents for external readers',async()=>{
 assert.equal(await crc32(new Blob(['123456789'])),0xcbf43926);const zip=await zipStore([{name:'samples.csv',blob:new Blob(['ppg_adc,ecg_adc\r\n123,456\r\n'])},{name:'raw.bin',blob:new Blob([Uint8Array.of(170,187,0,123,1,200)])}]);assert.equal(new DataView(await zip.slice(0,4).arrayBuffer()).getUint32(0,true),0x04034b50);await writeFile('../qa/zip-unit-test.zip',new Uint8Array(await zip.arrayBuffer()));
});
