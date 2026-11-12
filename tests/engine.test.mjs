import test from 'node:test';
import assert from 'node:assert/strict';
import {ProtocolEngine,newState,BASE_PHASES,PRE_REST} from '../engine.mjs';

const origin=1_800_000_000_000;
const at=t=>origin+t*1000;
function started(){
  const e=new ProtocolEngine(newState(origin-PRE_REST*1000));
  assert.equal(e.startPreRest(origin-PRE_REST*1000),true);
  e.tick(origin-1);assert.equal(e.s.mode,'prerest');
  e.tick(origin);assert.equal(e.s.mode,'ready');assert.equal(e.begin(origin),true);return e;
}
function serve(e,t,{deflateAfter=60}={}){
  if(e.s.mode!=='running')return;
  const p=e.current(),now=at(t);
  if(p.kind==='quality'&&e.validSeconds(now)>=80)e.confirmQuality(now);
  if(p.kind==='measure'){
    const m=e.s.measurements[p.round];
    if(m.pressedAt===null)e.pressBp(now);
    if(t>=m.pressedAt+10&&m.verifiedAt===null)e.confirmTemperature(36.5,t,now);
    if(t>=m.pressedAt+deflateAfter&&m.deflatedAt===null)e.deflate(now);
  }
}
function run(e,from,to,options={}){
  for(let t=from;t<=to;t++){
    serve(e,t,options);e.tick(at(t));serve(e,t,options);e.tick(at(t));
  }
}

test('PDF schedule totals 18 minutes and includes all 19 phases',()=>{
  assert.equal(BASE_PHASES.reduce((n,p)=>n+p.duration,0),1080);
  assert.deepEqual(BASE_PHASES.filter(p=>p.kind==='exercise').map(p=>p.duration),[40,40,40]);
  const e=new ProtocolEngine();
  assert.deepEqual(e.schedule(origin).filter(p=>p.kind==='measure').map(p=>p.start),[90,390,690,990]);
  assert.deepEqual(e.schedule(origin).filter(p=>p.kind==='exercise').map(p=>p.start),[240,540,840]);
});
test('pre-rest is separate and recording requires explicit start',()=>{
  const e=new ProtocolEngine(newState(0));assert.equal(e.begin(0),false);
  e.startPreRest(0);e.tick(210_000);assert.equal(e.s.mode,'ready');assert.equal(e.s.startAt,null);
  assert.equal(e.begin(211_000),true);assert.equal(e.elapsed(212_000),1);
});
test('complete nominal protocol: 4 BP, 4 temperatures and 80s checks, 3 exercise phases, 18:00',()=>{
  const e=started();run(e,0,1080);
  assert.equal(e.s.mode,'await-finish');
  assert.deepEqual(e.s.measurements.map(m=>m.pressedAt),[90,390,690,990]);
  assert.deepEqual(e.s.measurements.map(m=>m.temperatureAt),[100,400,700,1000]);
  assert.deepEqual(e.s.phases.filter(p=>p.kind==='exercise').map(p=>p.actualEnd-p.actualStart),[40,40,40]);
  assert.equal(e.finish(at(1080)),false);e.s.recovered=true;assert.equal(e.finish(at(1080)),true);
  assert.equal(e.elapsed(at(2000)),1080);assert.equal(e.s.mode,'completed');
});
test('manual extension moves every downstream node, recording clock stays continuous',()=>{
  const e=started();run(e,0,10);assert.equal(e.extend(30,'信号不稳定',at(10)),true);
  assert.equal(e.schedule(at(10)).find(p=>p.id==='bp0').start,120);
  run(e,11,1110);assert.equal(e.s.mode,'await-finish');assert.equal(e.elapsed(at(1110)),1110);
  assert.deepEqual(e.s.measurements.map(m=>m.pressedAt),[120,420,720,1020]);
});
test('unstable signal invalidates confirmation and requires 80 new seconds after recovery',()=>{
  const e=started();run(e,0,80);assert.notEqual(e.s.quality[0].confirmedAt,null);
  e.markUnstable(at(81));assert.equal(e.s.quality[0].confirmedAt,null);
  for(let t=81;t<=99;t++)e.tick(at(t));assert.equal(e.current().id,'baseline');
  e.restartQuality(at(100));assert.equal(e.confirmQuality(at(179)),false);
  for(let t=100;t<=179;t++)e.tick(at(t));
  assert.equal(e.current().id,'baseline');assert.equal(e.confirmQuality(at(180)),true);
  e.tick(at(180));assert.equal(e.current().id,'bp0');assert.equal(e.current().actualStart,180);
});
test('elapsed time alone cannot approve waveform quality',()=>{
  const e=started();for(let t=0;t<=120;t++)e.tick(at(t));
  assert.equal(e.current().id,'baseline');assert.equal(e.pressBp(at(120)),false);
  assert.ok(e.blockers(at(120)).some(x=>x.includes('操作者核验')));
});
test('temperature uses actual BP press plus 10s, duplicate actions rejected',()=>{
  const e=started();run(e,0,89);e.tick(at(90));assert.equal(e.current().id,'bp0');
  for(let t=91;t<=95;t++)e.tick(at(t));
  assert.equal(e.pressBp(at(95),at(97)),true);assert.equal(e.pressBp(at(96)),false);
  assert.equal(e.s.measurements[0].pressedAt,95);assert.equal(e.s.measurements[0].pressConfirmedAt,97);
  assert.equal(e.confirmTemperature(36.7,104,at(104)),false);
  assert.equal(e.confirmTemperature(36.7,105,at(107)),true);
  assert.equal(e.s.measurements[0].temperatureAt,105);assert.equal(e.s.measurements[0].verifiedAt,107);
  assert.equal(e.confirmTemperature(37,108,at(108)),false);assert.equal(e.phaseTarget(),155);
});
test('missing deflation or temperature prevents automatic advance after 60s',()=>{
  const e=started();run(e,0,90);
  for(let t=91;t<=160;t++)e.tick(at(t));
  assert.equal(e.current().id,'bp0');assert.equal(e.s.measurements[0].deflatedAt,null);
  e.deflate(at(160));e.tick(at(160));assert.equal(e.current().id,'bp0');
  e.confirmTemperature(36.5,160,at(160));e.tick(at(160));assert.equal(e.current().id,'post0');
  assert.equal(e.current().actualStart,160);assert.equal(e.phaseTarget(),190);
});
test('overlong BP shifts rest and all future measurements, fully deflated +30s preserved',()=>{
  const e=started();run(e,0,1260,{deflateAfter:90});
  assert.equal(e.s.mode,'await-finish');
  const m=e.s.measurements;
  for(let i=1;i<4;i++)assert.ok(m[i].pressedAt-m[i-1].deflatedAt>=240);
  assert.ok(e.s.phases.at(-1).actualEnd-m[3].deflatedAt>=30);
  assert.ok(e.elapsed(at(1260))>1080);
});
test('stricter device interval holds valid window and shifts downstream nodes',()=>{
  const e=started();e.s.minBpInterval=300;run(e,0,1300);
  assert.equal(e.s.measurements[1].pressedAt,450);
  for(let i=1;i<4;i++)assert.ok(e.s.measurements[i].pressedAt-e.s.measurements[i-1].deflatedAt>=300);
});
test('exercise cannot be extended',()=>{
  const e=started();run(e,0,240);assert.equal(e.current().kind,'exercise');
  assert.equal(e.extend(60,'更多时间',at(240)),false);assert.equal(e.current().duration,40);
});
test('background suspension holds at current stage without silently skipping exercise',()=>{
  const e=started();run(e,0,240);e.tick(at(500));
  assert.equal(e.current().id,'exercise1');assert.equal(e.s.hold.kind,'attention');
  assert.equal(e.s.phases.find(p=>p.id==='exercise2').actualStart,null);
  e.resume(at(501));e.tick(at(501));assert.equal(e.current().id,'settle1');assert.equal(e.current().actualStart,501);
});
test('manual hold leaves elapsed continuous and does not skip phases',()=>{
  const e=started();run(e,0,10);e.hold('manual','等待恢复',at(10));
  for(let t=11;t<=150;t++)e.tick(at(t));assert.equal(e.current().id,'baseline');assert.equal(e.elapsed(at(150)),150);
  e.resume(at(150));e.confirmQuality(at(150));e.tick(at(150));assert.equal(e.current().id,'bp0');
});
test('restored state preserves data and actual clock, reports are JSON serializable',()=>{
  const e=started();run(e,0,400);const restored=new ProtocolEngine(JSON.parse(JSON.stringify(e.s)));
  assert.equal(restored.s.measurements[0].temperature,36.5);assert.equal(restored.elapsed(at(405)),405);
  assert.equal(restored.report(at(405)).startedAt,new Date(origin).toISOString());
  assert.ok(JSON.stringify(restored.report(at(405))).includes('人工'));
});
test('early termination freezes timer and keeps events',()=>{
  const e=started();run(e,0,250);assert.equal(e.abort('设备异常',at(250)),true);
  e.tick(at(500));assert.equal(e.elapsed(at(500)),250);assert.equal(e.s.mode,'aborted');
  assert.equal(e.s.events.at(-1).reason,'设备异常');
});
