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
test('all three exercise phases end after 40 seconds despite bad quality and signal loss',()=>{
  for(let round=1;round<=3;round++){
    const e=started();e.s.qualityAutomatic=true;
    while(e.current().id!==`exercise${round}`)e.skip(at(0));
    for(let t=1;t<=40;t++){
      e.applySignalQuality({ok:false,status:'fail',reason:'ECG 触底，PPG 运动伪迹'},at(t));
      for(const kind of ['data','connection','signal','quality'])assert.equal(e.hold(kind,'信号不可用',at(t)),false);
      assert.equal(e.extend(30,'信号不佳',at(t)),false);
      assert.equal(e.markUnstable(at(t)),false);
      e.tick(at(t));
      if(t<40)assert.equal(e.current().id,`exercise${round}`);
    }
    const p=e.s.phases.find(p=>p.id===`exercise${round}`);
    assert.equal(p.actualEnd-p.actualStart,40);assert.equal(p.extra,0);
    assert.equal(e.current().id,`settle${round}`);assert.equal(e.s.hold,null);
    assert.equal(p.signalWarnings.length,4);
    assert.equal(e.s.events.filter(v=>v.type==='exercise_signal_warning_no_extension').length,4);
    assert.equal(e.s.quality[round].since,null);
    assert.equal(e.report(at(40)).exerciseSignalPolicy.extendOnPoorQuality,false);
  }
});
test('restored exercise ignores a stale extension in both countdown and schedule',()=>{
  const e=started();while(e.current().id!=='exercise1')e.skip(at(0));
  e.current().extra=120;
  assert.equal(e.phaseTarget(),40);assert.equal(e.schedule(at(0)).find(p=>p.id==='exercise1').end,40);
  for(let t=1;t<=40;t++)e.tick(at(t));
  assert.equal(e.current().id,'settle1');assert.equal(e.current().actualStart,40);
});
test('signal faults still hold a resting quality phase',()=>{
  const e=started();assert.equal(e.hold('data','数据断流',at(1)),true);
  for(let t=1;t<=100;t++)e.tick(at(t));
  assert.equal(e.current().id,'baseline');assert.equal(e.s.hold.kind,'data');
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

test('skip pre-rest immediately, retaining actual duration and no completed-rest claim',()=>{
  const e=new ProtocolEngine(newState(origin));e.startPreRest(origin);
  assert.equal(e.skip(at(3)),'pre_rest');assert.equal(e.s.mode,'ready');assert.equal(e.s.startAt,null);
  const report=e.report(at(3));assert.equal(report.preRestActualSeconds,3);assert.equal(report.hasSkippedSteps,true);
  assert.equal(report.skippedSteps[0].remainingSeconds,207);
  assert.equal(e.s.events.some(x=>x.type==='pre_rest_completed'),false);
});
test('skipping start does not claim hardware recording was started',()=>{
  const e=new ProtocolEngine(newState(origin));e.startPreRest(origin);e.skip(origin);
  assert.equal(e.skip(at(1)),'recording_start');assert.equal(e.s.mode,'running');assert.equal(e.elapsed(at(2)),1);
  assert.equal(e.s.recordingStartConfirmed,false);assert.equal(e.s.events.some(x=>x.type==='recording_start_confirmed'),false);
});
test('skip waveform phase without fabricating quality verification or time',()=>{
  const e=started();assert.equal(e.skip(at(2)),'phase');assert.equal(e.current().id,'bp0');
  assert.equal(e.elapsed(at(2)),2);assert.equal(e.s.quality[0].confirmedAt,null);
  assert.equal(e.s.phases[0].skippedAt,2);assert.equal(e.s.phases[0].actualEnd,2);
  assert.equal(e.s.events.some(x=>x.type==='valid_80s_manually_verified'),false);
});
test('skip BP prompt to show temperature without inventing a BP press',()=>{
  const e=started();e.skip(at(1));assert.equal(e.skip(at(2)),'bp');
  const m=e.s.measurements[0];assert.equal(m.pressedAt,null);assert.equal(m.bpSkippedAt,2);assert.equal(e.temperatureDueAt(),2);
  assert.equal(e.confirmTemperature(36.4,3,at(3)),true);assert.equal(m.temperature,36.4);assert.equal(m.deflatedAt,null);
});
test('skip the 10-second wait preserves actual BP time and logs the exception',()=>{
  const e=started();e.skip(at(1));e.pressBp(at(2));
  assert.equal(e.confirmTemperature(36.4,3,at(3)),false);
  assert.equal(e.skip(at(3)),'temperature_wait');assert.equal(e.temperatureDueAt(),3);
  assert.equal(e.confirmTemperature(36.4,3,at(3)),true);assert.equal(e.s.measurements[0].pressedAt,2);
  assert.equal(e.s.skips.at(-1).step,'temperature_wait');
});
test('skip temperature and deflation without marking either as measured',()=>{
  const e=started();e.skip(at(1));e.pressBp(at(2));e.skip(at(3));
  assert.equal(e.skip(at(4)),'temperature');assert.equal(e.skip(at(5)),'deflation');
  const m=e.s.measurements[0];assert.equal(m.temperature,null);assert.equal(m.verifiedAt,null);assert.equal(m.deflatedAt,null);
  assert.equal(e.confirmTemperature(36.4,6,at(6)),false);
  assert.equal(e.skip(at(6)),'phase');assert.equal(e.current().id,'post0');
});
test('exercise skip stops the exercise phase and starts seated recovery',()=>{
  const e=started();run(e,0,240);assert.equal(e.skip(at(245)),'phase');
  assert.equal(e.current().id,'settle1');assert.equal(e.current().actualStart,245);
  assert.equal(e.s.phases.find(p=>p.id==='exercise1').actualEnd,245);
});
test('all steps can be demonstrated quickly, and skipped measurements remain unconfirmed',()=>{
  const e=new ProtocolEngine(newState(origin));e.startPreRest(origin);
  let count=0;while(e.s.mode!=='completed'&&count<60){assert.ok(e.skip(at(count)));count++;}
  assert.equal(e.s.mode,'completed');assert.ok(count<60);assert.ok(e.elapsed(at(count))<60);
  assert.equal(e.s.recovered,false);assert.equal(e.s.recordingStopConfirmed,false);
  for(const m of e.s.measurements){assert.equal(m.pressedAt,null);assert.equal(m.temperature,null);assert.equal(m.verifiedAt,null);assert.equal(m.deflatedAt,null);}
  const restored=new ProtocolEngine(JSON.parse(JSON.stringify(e.s))),report=restored.report();
  assert.equal(report.hasSkippedSteps,true);assert.equal(report.skippedSteps.length,count);
  assert.equal(restored.skip(at(100)),false);
});
