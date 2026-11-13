import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkflowSpeaker,workflowPrompt} from '../voice-prompts.mjs';
import {ProtocolEngine,newState,BASE_PHASES} from '../engine.mjs';

function active(){const e=new ProtocolEngine(newState(0));e.s.mode='running';e.s.startAt=0;return e;}
test('all 18 protocol phases have distinct spoken instructions, including each exercise and post wait',()=>{
 const e=active(),keys=new Set();
 for(let i=0;i<BASE_PHASES.length;i++){
  e.s.index=i;e.current().actualStart=0;
  const cue=workflowPrompt(e,{key:e.current().kind==='measure'?'bp':'rest'},0);
  assert.ok(cue.text.length>20,e.current().id);assert.ok(!keys.has(cue.key));keys.add(cue.key);
  if(e.current().kind==='exercise')assert.match(cue.text,/四十秒/);
  if(e.current().kind==='settle')assert.match(cue.text,/15秒/);
  if(e.current().kind==='post')assert.match(cue.text,/30秒/);
 }
 assert.equal(keys.size,18);
});
test('pre-rest, ready, finish, completed, abort and pause each have spoken instructions',()=>{
 const e=active();const keys=new Set();
 for(const mode of ['setup','prerest','ready','await-finish','completed','aborted']){e.s.mode=mode;const cue=workflowPrompt(e,{},0);assert.ok(cue.text.length>20);keys.add(cue.key);}
 assert.equal(keys.size,6);e.s.mode='running';e.hold('manual','等待核对',0);assert.match(workflowPrompt(e,{},0).text,/等待核对/);
});
test('BP, forehead, review, deflation and carried forehead tasks all have step-specific speech',()=>{
 const e=active();e.s.index=1;e.current().actualStart=0;
 for(const key of ['bp','wait-temp','temperature','review:36.5','deflate']){
  const cue=workflowPrompt(e,{key,temperatureValue:'36.5'},0);assert.ok(cue.key.endsWith(':'+key));assert.ok(cue.text.length>20);
 }
 e.s.index=2;
 for(const key of ['post-wait-temp','post-temperature','post-review:36.5'])assert.match(workflowPrompt(e,{key,temperatureValue:'36.5'},0).text,/等待/);
 assert.match(workflowPrompt(e,{key:'post-review:36.5',temperatureValue:'36.5'},0).text,/36.5/);
});
test('changing only a live countdown does not repeat a phase instruction',()=>{
 const e=active();e.s.index=3;e.current().actualStart=0;
 assert.deepEqual(workflowPrompt(e,{},1000),workflowPrompt(e,{},2000));
});
function mock(){const spoken=[],statuses=[];let cancels=0;class Utterance{constructor(text){this.text=text;}}
 const synth={cancel(){cancels++;},speak(u){spoken.push(u);},getVoices:()=>[{lang:'zh-CN',name:'Chinese'}]};
 const speaker=new WorkflowSpeaker({synth,Utterance,onStatus:(...args)=>statuses.push(args)});
 return {speaker,spoken,statuses,cancels:()=>cancels};
}
test('left-right cues cannot cancel the full phase instruction, and resume after it ends',()=>{
 const m=mock();m.speaker.speak('开始第四十秒踏步说明');const count=m.cancels();
 assert.equal(m.speaker.speak('左',true),false);assert.equal(m.cancels(),count);assert.equal(m.spoken.length,1);
 m.spoken[0].onend();assert.equal(m.speaker.speak('右',true),true);assert.equal(m.spoken.length,2);assert.equal(m.spoken[1].rate,1.7);
});
test('new phase instructions replace outdated speech and stale callbacks do not unlock the new one',()=>{
 const m=mock();m.speaker.speak('踏步');const previous=m.spoken[0];m.speaker.speak('停止踏步');
 previous.onend();assert.equal(m.speaker.speak('左',true),false);
 m.spoken[1].onend();assert.equal(m.speaker.mainBusy,false);assert.equal(m.speaker.lastMain,'停止踏步');
});
test('speech failures are visible and cancelled speech is not reported as an error',()=>{
 const m=mock();m.speaker.speak('测试');m.spoken[0].onerror({error:'not-allowed'});assert.equal(m.statuses.at(-1)[0],'error');
 m.speaker.speak('再试');const count=m.statuses.length;m.spoken[1].onerror({error:'interrupted'});assert.equal(m.statuses.length,count);
});
test('muted or background speech does not play; unavailable synthesis reports an actionable message',()=>{
 const m=mock();m.speaker.enabled=()=>false;assert.equal(m.speaker.speak('测试'),false);assert.equal(m.spoken.length,0);
 m.speaker.enabled=()=>true;m.speaker.hidden=()=>true;assert.equal(m.speaker.speak('测试'),false);
 const status=[];new WorkflowSpeaker({synth:null,Utterance:null,onStatus:(...s)=>status.push(s)}).speak('测试');assert.equal(status[0][0],'unavailable');
});
