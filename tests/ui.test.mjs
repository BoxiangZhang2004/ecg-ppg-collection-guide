import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {ProtocolEngine,newState,restoreProtocolState,formatTime,PRE_REST,LABELS} from '../engine.mjs';
import {WorkflowSpeaker,workflowPrompt,VOICE_POLICY_VERSION} from '../voice-prompts.mjs';

// Run actual UI handlers against a minimal DOM and an isolated, non-recording
// capture stub. This checks binding and step rendering, not browser audio output.
function appAt(state,seconds){
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const source=readFileSync(new URL('../app.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
 const nodes=new Map(),documentListeners=new Map(),spoken=[];let clock=seconds*1000,interval;
 function element(id){
  let markup='';const listeners=new Map();
  return {id,checked:true,hidden:false,value:'',clientWidth:500,clientHeight:100,
   classList:{toggle(){},remove(){}},setAttribute(){},addEventListener:(type,fn)=>listeners.set(type,fn),
   get innerHTML(){return markup;},set innerHTML(value){markup=value;for(const match of value.matchAll(/id="([^"]+)"/g))if(!nodes.has(match[1]))nodes.set(match[1],element(match[1]));},
   getContext:()=>new Proxy({},{get:()=>()=>{}}),listeners};
 }
 for(const match of html.matchAll(/id="([^"]+)"/g))nodes.set(match[1],element(match[1]));
 const store=new Map([['ecg-ppg-guide-session-v1',JSON.stringify(state)]]);
 class Capture {
  constructor(options){this.context=options.context;this.journal={open:async()=>{}};this.connected=true;this.parser={protocol:'binary'};this.source='serial';this.plot={array:()=>[]};this.monitor={lastReceived:null};this.recorder={recording:false,fault:null,session:null,frames:0,flush(){}};}
  snapshot(){return {ok:false,status:'waiting',reason:'测试未接硬件',ecg:{},ppg:{}};}
  tick(){}
 }
 class ClockDate extends Date{static now(){return clock;}}
 class Utterance{constructor(text){this.text=text;}}
 const synth={cancel(){},getVoices:()=>[],speak(u){spoken.push(u.text);}};
 class Speaker extends WorkflowSpeaker{constructor(options){super({synth,Utterance,...options});}}
 const document={hidden:false,getElementById:id=>nodes.get(id),querySelectorAll:()=>[],body:{classList:{toggle(){}}},documentElement:{},addEventListener:(type,fn)=>documentListeners.set(type,fn)};
 const context=vm.createContext({ProtocolEngine,restoreProtocolState,ft:formatTime,PRE_REST,LABELS,Acquisition:Capture,WorkflowSpeaker:Speaker,workflowPrompt,VOICE_POLICY_VERSION,
  detectSerialSupport:()=>({supported:false,message:'测试环境'}),ONLINE_URL:'https://example.test/',document,navigator:{},localStorage:{getItem:key=>store.get(key),setItem:(key,value)=>store.set(key,value)},
  window:{speechSynthesis:synth,SpeechSynthesisUtterance:Utterance,addEventListener(){}},location:{protocol:'https:'},Date:ClockDate,devicePixelRatio:1,setInterval:fn=>{interval=fn;},setTimeout:()=>1,clearTimeout(){},console});
 vm.runInContext(source,context);
 return {nodes,spoken,state:()=>JSON.parse(store.get('ecg-ppg-guide-session-v1')),
  async click(action){const rendered=[html,...[...nodes.values()].map(n=>n.innerHTML)].join('');assert.ok(rendered.includes(`data-action="${action}"`),`missing action ${action}`);await documentListeners.get('click')({target:{closest:()=>({dataset:{action},disabled:false})}});},
  tick(t){clock=t*1000;interval();}};
}
function phaseState(id,start){const s=newState(0);s.mode='running';s.startAt=0;s.index=s.phases.findIndex(p=>p.id===id);s.phases[s.index].actualStart=start;return s;}
test('UI offers full-deflation confirmation before temperature, carries the input and keeps the 30s timer',async()=>{
 const s=phaseState('bp0',90);s.measurements[0].pressedAt=90;
 const a=appAt(s,95);await a.click('resume');await a.click('deflate');
 assert.equal(a.state().phases[a.state().index].id,'post0');assert.equal(a.state().measurements[0].deflatedAt,95);
 assert.equal(a.nodes.get('remaining').textContent,'00:30');assert.match(a.nodes.get('instruction').textContent,/等待/);
 for(let t=96;t<=100;t++)a.tick(t);
 assert.equal(a.nodes.get('remaining').textContent,'00:25');assert.equal(a.nodes.get('instruction').textContent,'现在测额温');
 a.nodes.get('temperature').value='36.5';await a.click('temperature');await a.click('verify-temp');
 assert.equal(a.nodes.get('remaining').textContent,'00:25');assert.equal(a.state().measurements[0].temperature,36.5);
 for(let t=101;t<=125;t++)a.tick(t);
 assert.equal(a.state().phases[a.state().index].id,'exercise1');assert.ok(a.spoken.some(text=>/等待三十秒/.test(text)));
 assert.ok(a.spoken.some(text=>/现在请测额温/.test(text)));assert.ok(a.spoken.some(text=>/第1次坐姿踏步/.test(text)));
});
test('UI immediately leaves BP on a 40-second completion after forehead entry',async()=>{
 const s=phaseState('bp0',90);Object.assign(s.measurements[0],{pressedAt:90,temperature:36.5,temperatureAt:100,verifiedAt:100});
 const a=appAt(s,130);await a.click('resume');assert.match(a.nodes.get('detail').textContent,/不用等满 60 秒/);await a.click('deflate');
 assert.equal(a.state().phases[a.state().index].id,'post0');assert.equal(a.nodes.get('remaining').textContent,'00:30');
 assert.equal(a.state().measurements[0].deflatedAt,130);
});
test('UI stops exercise at 40s, speaks the 15s posture step and then starts the 80s waveform step',async()=>{
 const s=phaseState('exercise1',0),a=appAt(s,39);await a.click('resume');a.tick(40);
 assert.equal(a.nodes.get('instruction').textContent,'现在停止踏步');assert.equal(a.nodes.get('remaining').textContent,'00:15');
 assert.ok(a.spoken.some(text=>text.includes('用15秒整理姿势')));
 for(let t=41;t<=55;t++)a.tick(t);
 assert.equal(a.nodes.get('remaining').textContent,'01:20');assert.match(a.nodes.get('instruction').textContent,/累计有效波形/);
 assert.ok(a.spoken.some(text=>text.includes('开始采集八十秒有效波形')));
});
