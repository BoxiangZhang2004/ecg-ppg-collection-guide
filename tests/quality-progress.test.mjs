import test from 'node:test';
import assert from 'node:assert/strict';
import {ProtocolEngine,newState,PRE_REST} from '../engine.mjs';
function flow(phase='baseline'){
 const e=new ProtocolEngine(newState(-PRE_REST*1000));e.startPreRest(-PRE_REST*1000);e.tick(0);e.begin(0);e.s.qualityAutomatic=true;
 while(e.current().id!==phase)e.skip(0);
 if(e.current().round>0)e.s.measurements[e.current().round-1].deflatedAt=-240;
 return e;
}
function update(e,second,ok){e.applySignalQuality({ok,status:ok?'pass':'fail',reason:ok?'pass':'artifact'},second*1000);e.tick(second*1000);}
test('ten bad seconds require ten extra seconds in an 80-second recovery window',()=>{
 const e=flow('window1');
 for(let t=0;t<=80;t++)update(e,t,!(t>=30&&t<40));
 assert.equal(e.validSeconds(80000),70);assert.equal(e.current().id,'window1');assert.equal(e.phaseTarget(),90);
 for(let t=81;t<=90;t++)update(e,t,true);
 assert.equal(e.validSeconds(90000),80);assert.equal(e.confirmQuality(90000),true);e.tick(90000);
 assert.equal(e.current().id,'bp1');assert.equal(e.current().actualStart,90);
});
test('baseline uses its existing ten-second margin before adding time',()=>{
 const e=flow();for(let t=0;t<=90;t++)update(e,t,!(t>=30&&t<40));
 assert.equal(e.validSeconds(90000),80);assert.equal(e.phaseTarget(),90);assert.equal(e.s.quality[0].automaticExtraSeconds,0);
});
test('new failures during compensation cannot recursively increase the planned extension',()=>{
 const e=flow('window1');for(let t=0;t<=80;t++)update(e,t,!(t>=30&&t<40));
 for(let t=81;t<=90;t++)update(e,t,false);
 assert.equal(e.phaseTarget(),90);assert.equal(e.s.quality[1].automaticExtraSeconds,10);
 assert.equal(e.confirmQuality(90000),false);assert.equal(e.confirmQuality(90000,{allowInsufficient:true}),true);e.tick(90000);
 assert.equal(e.current().id,'bp1');assert.equal(e.s.quality[1].outcome,'insufficient');
});
test('permanent failure is capped and never reported as valid data',()=>{
 const e=flow();for(let t=0;t<=130;t++)update(e,t,false);
 assert.equal(e.validSeconds(130000),0);assert.equal(e.phaseTarget(),130);assert.equal(e.confirmQuality(130000),false);
 assert.equal(e.s.quality[0].automaticExtraSeconds,40);assert.equal(e.s.hold,null);
 assert.equal(e.confirmQuality(130000,{allowInsufficient:true}),true);e.tick(130000);
 assert.equal(e.current().id,'bp0');assert.equal(e.s.quality[0].outcome,'insufficient');
 assert.equal(e.s.quality[0].latestQualityOk,false);assert.equal(e.report(130000).validWaveformManualChecks[0].insufficientAcknowledgedAt,130);
});
test('insufficient acknowledgement cannot bypass the nominal window or planned compensation',()=>{
 const e=flow();update(e,0,false);
 assert.equal(e.confirmQuality(90000,{allowInsufficient:true}),false);
 for(let t=1;t<=90;t++)update(e,t,false);
 assert.equal(e.confirmQuality(90000,{allowInsufficient:true}),false);
});
test('good seconds on both sides of a gap are never joined into a complete model window',()=>{
 const e=flow();for(let t=0;t<=90;t++)update(e,t,t%16!==15);
 const p=e.qualityProgress(90000);assert.ok(p.goodSeconds>=80);assert.ok(p.longestGoodRunSeconds<20);
 assert.equal(p.complete20sWindows,0);assert.equal(p.enough,false);assert.ok(e.phaseTarget()>90);
});
test('separate complete windows are not labelled continuous 80-second history',()=>{
 const e=flow();for(let t=0;t<=90;t++)update(e,t,!(t>=40&&t<50));
 const p=e.qualityProgress(90000);assert.equal(p.goodSeconds,80);assert.equal(p.enough,true);assert.equal(p.complete20sWindows,4);assert.equal(p.full80sHistoryAvailable,false);assert.equal(e.report(90000).qualityWindowSummary[0].full80sHistoryAvailable,false);
});
test('stale snapshots do not credit a missing stream or fill a gap',()=>{
 const e=flow();update(e,0,true);update(e,10,true);assert.equal(e.validSeconds(10000),0);e.resume(10000);
 for(let t=11;t<=30;t++)update(e,t,true);
 assert.equal(e.validSeconds(30000),20);assert.equal(e.qualityProgress(30000).complete20sWindows,1);
});
test('manual additional collection preserves all earlier accepted time',()=>{
 const e=flow();for(let t=0;t<=130;t++)update(e,t,false);
 assert.equal(e.extend(20,'extra collection',130000),true);assert.equal(e.phaseTarget(),150);
 for(let t=131;t<=150;t++)update(e,t,true);
 assert.equal(e.s.quality[0].automaticExtraSeconds,40);assert.equal(e.validSeconds(150000),19);
});
test('upgrade reconstructs accepted intervals and retains identity and raw session',()=>{
 const s=newState(0);s.subject='KEEP';s.rawSessionId='RAW_KEEP';s.mode='running';s.startAt=0;s.phases[0].actualStart=0;
 Object.assign(s.quality[0],{automatic:true,latestQualityOk:true,since:30,lastQualityCheck:40});
 s.events=[{type:'automatic_valid_count_started',round:0,elapsed:5},{type:'automatic_quality_rejected',round:0,elapsed:25},{type:'automatic_valid_count_started',round:0,elapsed:30}];
 const e=new ProtocolEngine(s);e.s.qualityAutomatic=true;assert.equal(e.validSeconds(40000),30);assert.equal(e.qualityProgress(40000).complete20sWindows,1);
 assert.equal(e.s.subject,'KEEP');assert.equal(e.s.rawSessionId,'RAW_KEEP');assert.equal(e.elapsed(40000),40);
 const restored=new ProtocolEngine(JSON.parse(JSON.stringify(e.s)));assert.equal(restored.validSeconds(40000),30);
});
test('credit stops at the collection deadline and resumes only after explicit extra collection',()=>{
 const e=flow();for(let t=0;t<=130;t++)update(e,t,false);
 for(let t=131;t<=160;t++)update(e,t,true);
 assert.equal(e.validSeconds(160000),0);assert.equal(e.phaseTarget(),130);
 assert.equal(e.extend(20,'explicit extra collection',160000),true);
 for(let t=161;t<=180;t++)update(e,t,true);
 assert.equal(e.validSeconds(180000),20);assert.equal(e.qualityProgress(180000).complete20sWindows,1);
});
