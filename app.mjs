import {ProtocolEngine,newState,formatTime as ft,PRE_REST,PROTOCOL_VERSION,LABELS} from './engine.mjs?v=4.4';
import {Acquisition} from './acquisition.mjs?v=4.4';
import {detectSerialSupport,ONLINE_URL} from './serial-support.mjs?v=4.4';
const $=id=>document.getElementById(id),KEY='ecg-ppg-guide-session-v1',PREFS='ecg-ppg-guide-preferences-v1';
const serialSupport=detectSerialSupport();
$('browser-warning').hidden=serialSupport.supported;$('browser-warning-reason').textContent=serialSupport.message;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let engine=new ProtocolEngine(),audio,lock,renderKey='',lastRender=0,lastSave=0,lastBeat=-1,lastTask='',tempReview=null,tempDraft={},dialogCallback,backgroundAt=null;
try{const s=JSON.parse(localStorage.getItem(KEY)||'null');if(s?.version===PROTOCOL_VERSION&&s.phases?.length===19){engine=new ProtocolEngine(s);s.subjectName??='';if(s.mode==='running'){if(!s.hold)engine.hold('attention','页面已恢复，请核对当前状态后继续',Date.now());s.lastTick=Date.now();}}}catch{}
try{const p=JSON.parse(localStorage.getItem(PREFS)||'null');if(p){$('sound').checked=p.sound;$('voice').checked=p.voice;}}catch{}
$('subject-name').value=engine.s.subjectName||'';$('subject-code').value=engine.s.subject||'';
engine.s.qualityAutomatic=true;
let signalState={ok:false,status:'waiting',reason:'等待原始数据',ecg:{ok:false,reason:'判断中'},ppg:{ok:false,reason:'判断中'}},recordingBusy=false,exportBusy=false,lastSignalCheck=0,lastPlot=0,recoveredRaw=null,lastFault='',showRaw=false;
const capture=new Acquisition({context:()=>{const t=engine.elapsed(),s=engine.s;return {phase:engine.current().id,qualityState:signalState.status,interference:s.measurements.some(m=>m.pressedAt!==null&&t>=m.pressedAt&&(m.deflatedAt===null||t<=m.deflatedAt+30))};},onNotice:text=>{$('raw-notice').textContent=text;},onFault:(kind,text)=>{$('raw-notice').textContent=text;if(engine.s.mode==='running'){engine.hold(kind,text,Date.now());if(lastFault!==text){engine.log('acquisition_fault',{kind,reason:text},Date.now());lastFault=text;}}changed();}});
capture.journal.open().then(async()=>{if(engine.s.rawSessionId){recoveredRaw=await capture.journal.get(engine.s.rawSessionId);changed();}}).catch(error=>{$('raw-notice').textContent='本机数据库不可用：'+error.message;});
function save(){try{localStorage.setItem(KEY,JSON.stringify(engine.s));$('storage-warning').hidden=true;}catch{$('storage-warning').hidden=false;}}
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,3000);}
function changed(){renderKey='';save();render(Date.now());}
async function unlock(){try{audio??=new(window.AudioContext||window.webkitAudioContext)();if(audio.state==='suspended')await audio.resume();}catch{}}
function tone(hz=750,duration=.065){if(!$('sound').checked||!audio||audio.state!=='running')return;const t=audio.currentTime,o=audio.createOscillator(),g=audio.createGain();o.frequency.value=hz;g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(.1,t+.006);g.gain.exponentialRampToValueAtTime(.001,t+duration);o.connect(g);g.connect(audio.destination);o.start(t);o.stop(t+duration+.01);}
function speak(text,quick=false){if(!$('voice').checked||!('speechSynthesis'in window)||document.hidden)return;const u=new SpeechSynthesisUtterance(text);u.lang='zh-CN';u.rate=quick?1.7:1.05;const v=speechSynthesis.getVoices().find(v=>/zh[-_]CN/i.test(v.lang));if(v)u.voice=v;speechSynthesis.cancel();speechSynthesis.speak(u);}
async function wake(){try{if('wakeLock'in navigator&&!document.hidden)lock=await navigator.wakeLock.request('screen');}catch{}}
function release(){lock?.release().catch(()=>{});lock=null;if('speechSynthesis'in window)speechSynthesis.cancel();}
function full(){if(!document.fullscreenElement)document.documentElement.requestFullscreen?.().catch(()=>{});}
function ask(title,content,confirm,callback){$('dialog-title').textContent=title;$('dialog-content').innerHTML=content;$('dialog-confirm').textContent=confirm;dialogCallback=callback;$('dialog').returnValue='';$('dialog').showModal();}
$('dialog').addEventListener('close',()=>{const cb=dialogCallback;dialogCallback=null;if($('dialog').returnValue==='confirm'){const result=cb?.();result?.catch?.(error=>toast(error.message));}});
const button=(action,label,disabled=false,minor=false)=>`<button data-action="${action}" class="${minor?'minor':'primary'}" ${disabled?'disabled':''}>${label}</button>`;
function task(now){
 const s=engine.s,p=engine.current(),t=engine.elapsed(now),scheduled=engine.schedule(now),remaining=Math.max(0,scheduled[s.index].end-t);
 const result={key:'',title:'现在安静静坐',phase:p.title,seconds:Math.ceil(remaining),detail:'双脚平放，前臂放在支撑面上。',html:'',hint:''};
 if(s.mode==='prerest')return {...result,key:'pre',phase:'开录前静坐',title:'现在安静静坐',seconds:Math.max(0,Math.ceil(PRE_REST-(now-s.preStart)/1000)),detail:'此段不计入 18 分钟记录。'};
 if(s.mode==='ready'){const canStart=capture.connected&&!!capture.parser.protocol&&!recordingBusy;return {...result,key:'ready:'+canStart+':'+recordingBusy,phase:'开始记录',title:'现在开始原始数据采集',seconds:null,detail:canStart?'点击后同时开始本机保存与 00:00 计时。':'请先连接采集板，等待识别到有效原始帧。',html:button('begin',recordingBusy?'正在准备本机保存…':'开始采集并计时 →',!canStart)};}
 if(s.mode==='await-finish')return {...result,key:'finish',phase:'结束记录',title:'确认恢复，结束本次采集',seconds:null,detail:'确认本人已恢复。点击后停止原始保存并完成本机写入。',html:button('finish','已恢复，停止采集并保存')};
 if(p.kind==='quality'){
  const q=s.quality[p.round],valid=engine.validSeconds(now);
  let intervalReady=true;if(p.round>0){const last=s.measurements[p.round-1].deflatedAt;intervalReady=last!==null&&t-last>=s.minBpInterval;}
  const ready=valid>=80&&t>=engine.phaseTarget()&&intervalReady;
  if(q.unstable&&q.manualUnstable)return {...result,key:'unstable',title:'等待信号稳定',seconds:null,detail:'波形稳定后，重新计满连续 80 秒。',html:button('restart-quality','信号已稳定，重新计 80 秒')};
  if(q.unstable)return {...result,key:'automatic-waiting:'+q.automaticStatus,title:q.automaticStatus==='waiting'?'正在评估信号':'信号不佳，自动延长采集',seconds:null,detail:(q.automaticReason||'质量尚未通过')+'。\n保持静坐，恢复后自动重新累计连续 80 秒。',hint:'有效波形：0 / 80 秒 · 原始保存继续，后续步骤顺延'};
  return {...result,key:'quality:'+ready+':'+(q.confirmedAt!==null),detail:'保持安静。自动初筛通过后计数，确认前请核对波形。',html:button('quality',q.confirmedAt!==null?'已核验，等待进入测量':'连续 80 秒通过，确认测血压 →',!ready||q.confirmedAt!==null),hint:`有效波形：${Math.min(80,Math.floor(valid))} / 80 秒`};
 }
 if(p.kind==='measure'){
  const m=s.measurements[p.round],phase=LABELS[p.round];
  if(m.pressedAt===null&&m.bpSkippedAt==null)return {...result,key:'bp',phase,title:'现在测血压',seconds:null,detail:'请操作者按下血压计测量键。',html:button('bp','已按下血压计，确认 →')};
  const wait=engine.temperatureDueAt()-t;
  if(wait>0)return {...result,key:'wait-temp',phase,title:'现在保持静坐',seconds:Math.ceil(wait),detail:'倒计时结束后测额温。'};
  if(m.verifiedAt===null&&m.temperatureSkippedAt==null){
   if(tempReview?.round===p.round)return {...result,key:'review:'+tempReview.value,phase,title:'核对额温读数',seconds:null,detail:'请对照额温枪，再确认一次。',html:`<div class="reading">${tempReview.value.toFixed(1)} ℃</div>${button('verify-temp','读数正确，进入下一步 →')}${button('edit-temp','重新填写',false,true)}`};
   return {...result,key:'temperature',phase,title:'现在测额温',seconds:null,detail:'由操作者测量，填写额温枪读数。',html:`<div class="temperature-entry"><input id="temperature" type="number" inputmode="decimal" min="25" max="45" step="0.1" value="${esc(tempDraft[p.round]??'')}" aria-label="额温读数"><span>℃</span></div>${button('temperature','已测额温，确认 →')}`};
  }
  if(m.deflatedAt===null&&m.deflationSkippedAt==null&&m.bpSkippedAt==null)return {...result,key:'deflate',phase,title:'等待血压测量结束',seconds:null,detail:'确认本次测量结束，袖带已完全放气。',html:button('deflate','已测完且完全放气，确认 →')};
  const skipped=m.bpSkippedAt!=null||m.temperatureSkippedAt!=null||m.deflationSkippedAt!=null;
  return {...result,key:'measured',phase,title:'现在安静静坐',detail:skipped?'本节点含跳过，静坐到下一时间点。':'本次测量已确认，静坐到下一时间点。'};
 }
 if(p.kind==='settle')return {...result,key:'settle',title:'现在停止踏步',detail:'坐好，双脚平放，前臂支撑。'};
 return {...result,key:'rest'};
}
function render(now){
 const s=engine.s,p=engine.current(),isExercise=s.mode==='running'&&p.kind==='exercise',done=['completed','aborted'].includes(s.mode),t=engine.elapsed(now);
 $('identity').textContent=s.subject?`${s.subjectName||''}　${s.subject}`:'ECG / PPG 采集';
 $('identity').title=$('identity').textContent;
 $('skip-status').hidden=!s.skips.length;
 $('skip-button').hidden=!['prerest','ready','running','await-finish'].includes(s.mode);
 $('elapsed-label').textContent=s.startAt===null?'尚未开录':`采集 ${ft(t)}`;
 $('setup').hidden=s.mode!=='setup';$('current').hidden=s.mode==='setup'||done||isExercise;$('exercise').hidden=!isExercise;$('summary').hidden=!done;
 document.body.classList.toggle('exercise-mode',isExercise);
 $('acquisition-panel').hidden=false;
 const rec=capture.recorder;
 $('capture-state').textContent=capture.source==='synthetic'?'演示：合成数据':capture.connected?'串口已连接':'未连接采集板';
 $('connect-button').textContent=!serialSupport.supported?'需在电脑 Chrome 连接':capture.connecting?'连接中…':capture.port?'断开设备':'连接采集板';$('connect-button').disabled=!serialSupport.supported||capture.connecting||recordingBusy;$('connect-button').title=serialSupport.message;
 $('raw-counter').textContent=rec.fault?'保存失败，原始记录已停止':recordingBusy&&!rec.recording?(s.mode==='ready'?'正在准备本机保存…':'正在完成本机保存…'):rec.recording?`正在保存 · 已写入 ${(rec.savedFrames||0).toLocaleString()} / 已接收 ${rec.frames.toLocaleString()} 帧`:rec.session?`${s.rawSessionId===rec.session.id?'已停止':'上次记录'} · ${(rec.savedFrames||0).toLocaleString()} 帧`:recoveredRaw?`本机保留 ${recoveredRaw.frames.toLocaleString()} 帧，连接后可恢复或导出`:'当前为预览，尚未开始保存';
 $('export-raw-button').disabled=recordingBusy||exportBusy||!(s.rawSessionId||recoveredRaw);$('export-raw-button').textContent=exportBusy?'正在打包…':'导出原始采集包';document.querySelectorAll('[data-action="export-raw"],[data-action="new-session"]').forEach(el=>{if(el.id!=='export-raw-button')el.disabled=recordingBusy||exportBusy;});
 const interference=rec.recording&&capture.context().interference;
 $('quality-overall').textContent=interference&&!rec.fault?'测压干扰期：原始数据保留，不计入有效段':(isExercise?'运动中 · ':'')+signalState.reason+(capture.source==='synthetic'?'（合成数据）':'');$('quality-overall').className=interference?'quality-waiting':'quality-'+signalState.status;
 for(const kind of ['ecg','ppg']){$(kind+'-quality').textContent=signalState[kind]?.reason||'判断中';$(kind+'-quality').className=signalState[kind]?.ok?'quality-pass':signalState.status==='waiting'?'quality-waiting':'quality-fail';}
 for(const kind of ['ecg','ppg']){$(kind+'-plot-label').textContent=kind.toUpperCase()+(showRaw?' 原始 ADC':' 滤波（N=2）');$(kind+'-waveform').setAttribute('aria-label',kind.toUpperCase()+(showRaw?' 原始波形':' 滤波波形'));}
 $('waveform-toggle').textContent=showRaw?'显示滤波':'显示原始';$('waveform-toggle').setAttribute('aria-pressed',String(showRaw));
 $('plot-note').textContent=showRaw?'当前显示原始 ADC；质量初筛继续运行。':'滤波预览：ECG 0.5–40 Hz + 50 Hz 陷波，PPG 0.5–8 Hz；保存原始 ADC。';
 $('receive-info').textContent=`${signalState.rateHz==null?'—':Math.round(signalState.rateHz)} Hz · ${capture.parser.protocol==='text'?'文本帧':capture.parser.protocol==='binary'?'AA BB 帧':'协议识别中'}`;
 $('exercise-recording').textContent=rec.recording?`${capture.source==='synthetic'?'合成数据 · ':''}已写入 ${(rec.savedFrames||0).toLocaleString()} 帧 · 运动中继续保存`:'未保存原始数据 · 当前仅为引导展示';
 const canDelay=s.mode==='running'&&!isExercise;
 $('delay-bar').hidden=!['running','prerest','ready'].includes(s.mode)||isExercise;
 document.querySelectorAll('[data-action="extend"],[data-action="extend-custom"],#extra-seconds').forEach(x=>x.disabled=!canDelay);
 $('hold-button').disabled=!canDelay;$('hold-button').textContent=s.hold?'继续当前':'保持当前';
 $('signal-button').hidden=!canDelay||p.kind!=='quality'||s.quality[p.round]?.unstable;
 const hold=s.hold,blockers=s.mode==='running'&&!isExercise&&t>=engine.phaseTarget()?engine.blockers(now).filter(x=>x!==hold?.reason):[];
 $('attention').hidden=!hold;
 $('attention').innerHTML=hold?`<span>${esc(hold.reason)}；${rec.recording?'原始保存继续':'请连接设备并恢复原始记录'}。</span>${button('resume','已核对，继续',false,true)}`:'';
 if(isExercise){
  const seconds=t-p.actualStart,over=seconds>=40||!!s.hold;
  $('exercise-round').textContent=`第 ${p.round} 次坐姿踏步`;$('exercise-remaining').textContent=Math.max(0,Math.ceil(40-seconds));
  if(over){$('left-panel').classList.remove('active');$('right-panel').classList.remove('active');$('beat-word').textContent='停止踏步，坐好';$('beat-count').textContent='';}
 }else if(!done&&s.mode!=='setup'){
  const view=task(now),key=[s.mode,s.index,view.key,s.events.length].join(':');
  $('phase-label').textContent=view.phase;$('instruction').textContent=view.title;$('remaining').textContent=view.seconds===null?'':ft(view.seconds);$('detail').textContent=view.detail;
  if(key!==renderKey){$('action').innerHTML=view.html;renderKey=key;}
  $('next-hint').textContent=view.hint||'';
  if(blockers.length&&s.mode==='running'&&p.kind==='quality'){
   const interval=blockers.find(x=>x.includes('距上次'));
   if(interval)$('next-hint').textContent=interval;
  }
  const announceKey=s.mode+':'+s.index+':'+view.key;
  if(announceKey!==lastTask){lastTask=announceKey;$('announcer').textContent=view.title;if(view.key==='bp'||view.key==='temperature'||view.key==='settle'||s.mode==='ready'){tone(880,.12);speak(view.title);}}
 }
 if(done){
  $('summary-title').textContent=s.mode==='completed'?(s.skips.length?'流程结束（含跳过）':'采集结束'):'已提前终止';$('summary-identity').textContent=`${s.subjectName||''}　编号 ${s.subject}`;$('summary-time').textContent=`实际计时 ${ft(t)}${s.skips.length?' · 跳过 '+s.skips.length+' 步':''}`;
  $('summary-rows').innerHTML=s.measurements.map(m=>`<tr><td>${m.label}</td><td>${m.pressedAt===null?(m.bpSkippedAt!=null?'已跳过':'未确认'):ft(m.pressedAt)}</td><td>${m.deflatedAt===null?(m.deflationSkippedAt!=null?'已跳过':m.bpSkippedAt!=null?'未测量':'未确认'):ft(m.deflatedAt)}</td><td>${m.verifiedAt===null?(m.temperatureSkippedAt!=null?'已跳过':'未确认'):m.temperature.toFixed(1)+' ℃ · 已复核'}</td></tr>`).join('');
 }
}
function beat(now){
 const s=engine.s,p=engine.current();if(s.mode!=='running'||p.kind!=='exercise'){lastBeat=-1;return;}
 const seconds=engine.elapsed(now)-p.actualStart;if(seconds>=40||s.hold)return;
 const n=Math.floor(seconds*1.5);if(n===lastBeat)return;lastBeat=n;
 $('left-panel').classList.toggle('active',n%2===0);$('right-panel').classList.toggle('active',n%2===1);$('beat-word').textContent=n%2===0?'抬左脚':'抬右脚';$('beat-count').textContent=`${n+1} / 60`;
 tone(n%2===0?660:880);speak(n%2===0?'左':'右',true);
}
async function startRaw(skipped=false){
 if(recordingBusy)return;recordingBusy=true;changed();
 try{
  const session=await capture.start({subjectName:engine.s.subjectName,subjectCode:engine.s.subject,flow:engine.report()});
  engine.s.rawSessionId=session.id;engine.s.qualityAutomatic=true;
  if(skipped)engine.skip(session.startedAt);else engine.begin(session.startedAt);
  recoveredRaw=null;engine.log('raw_recording_started',{sessionId:session.id,source:session.source,protocol:session.protocol},session.startedAt);
  wake();
 }finally{recordingBusy=false;changed();}
}
async function resumeFlow(){
 if(recordingBusy)return;recordingBusy=true;
 try{
  if(capture.recorder.fault)throw new Error('本机保存失败，请先导出原始采集包，再新建记录');
  if(engine.s.rawSessionId){if(!capture.connected||!capture.parser.protocol)throw new Error('请先连接设备并等待有效数据');if(!capture.recorder.recording)await capture.resume(engine.s.rawSessionId);if(capture.monitor.lastReceived===null||Date.now()-capture.monitor.lastReceived>500)throw new Error('数据流尚未恢复，请检查设备');}
  engine.resume(Date.now());wake();
 }finally{recordingBusy=false;changed();}
}
async function stopRaw(){const id=engine.s.rawSessionId;if(!id)return;const flow=engine.report();recordingBusy=true;try{if(capture.recorder.session?.id===id)await capture.finish(flow);else await capture.journal.update(id,{endedAt:flow.endedAt,status:'stopped',flow,hadUnrecordedPageGap:true});}finally{recordingBusy=false;changed();}}
async function downloadRaw(id=engine.s.rawSessionId||recoveredRaw?.id){
 if(!id)throw new Error('当前流程尚无原始记录，上次采集可在“本机原始记录”导出');
 if(exportBusy)return;exportBusy=true;changed();
 try{const result=await capture.export(id,id===engine.s.rawSessionId?engine.report():null);if(id===capture.recorder.session?.id&&capture.recorder.fault)capture.recorder.unsavedExported=true;const url=URL.createObjectURL(result.blob),a=document.createElement('a');a.href=url;a.download=result.filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);toast('已导出原始采集包，请自行备份。');}finally{exportBusy=false;changed();}
}
function drawWaveforms(now){
 if($('acquisition-panel').hidden)return;
 const rows=capture.plot.array().slice(-2500),scale=Math.min(devicePixelRatio||1,2);
 for(const [kind,rawKey,filteredKey,color] of [['ecg','e','ef','#125cbb'],['ppg','p','pf','#16733a']]){
  const id=kind+'-waveform',key=showRaw?rawKey:filteredKey;
  const canvas=$(id),width=Math.max(80,canvas.clientWidth),height=Math.max(80,canvas.clientHeight);
  if(canvas.width!==Math.round(width*scale)||canvas.height!==Math.round(height*scale)){canvas.width=Math.round(width*scale);canvas.height=Math.round(height*scale);}
  const c=canvas.getContext('2d');c.setTransform(scale,0,0,scale,0,0);c.clearRect(0,0,width,height);c.font='10px sans-serif';c.fillStyle='#555';c.strokeStyle='#e4e4e4';c.lineWidth=1;
  const left=35,right=width-7,top=9,bottom=height-18;
  for(let j=0;j<3;j++){const y=top+(bottom-top)*j/2;c.beginPath();c.moveTo(left,y);c.lineTo(right,y);c.stroke();}
  if(!rows.length){c.fillText(showRaw?'等待原始 ADC':'等待信号',left+8,(top+bottom)/2);continue;}
  let low=Infinity,high=-Infinity;for(const row of rows){low=Math.min(low,row[key]);high=Math.max(high,row[key]);}
  const margin=Math.max(showRaw?4:1,(high-low)*.08);low=Math.floor(low-margin);high=Math.ceil(high+margin);
  if(showRaw){low=Math.max(0,low);high=Math.min(1023,high);if(high-low<8)high=Math.min(1023,low+8);if(high===low)low=Math.max(0,high-8);}
  const warming=!showRaw&&!rows.at(-1).warm;
  c.fillText(String(high),2,top+7);c.fillText(String(low),2,bottom);c.fillText('最近 '+rows.length+' 帧 · '+(showRaw?'原始 ADC':warming?'滤波预热中':'滤波，相对幅度'),left,bottom+13);
  const y=v=>bottom-(v-low)/(high-low)*(bottom-top);c.strokeStyle=now-(capture.monitor.lastReceived??0)>500?'#888':color;c.lineWidth=1;c.beginPath();
  const buckets=Math.max(1,Math.floor(right-left));
  for(let x=0;x<buckets;x++){const a=Math.floor(x*rows.length/buckets),b=Math.max(a+1,Math.floor((x+1)*rows.length/buckets));let min=Infinity,max=-Infinity;for(let i=a;i<b&&i<rows.length;i++){min=Math.min(min,rows[i][key]);max=Math.max(max,rows[i][key]);}if(min!==Infinity){c.moveTo(left+x,y(min));c.lineTo(left+x,y(max));}}
  c.stroke();c.beginPath();let previous=null;for(let x=0;x<buckets;x++){const index=Math.min(rows.length-1,Math.floor(x*rows.length/buckets)),row=rows[index],v=y(row[key]);if(!previous||row.segment!==previous.segment||row.at-previous.at>500)c.moveTo(left+x,v);else c.lineTo(left+x,v);previous=row;}c.stroke();
 }
}
function download(kind){
 const r=engine.report(),safe=(engine.s.subject||'session').replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g,'_');let body,type;
 if(kind==='json'){body=JSON.stringify(r,null,2);type='application/json;charset=utf-8';}
 else{
  const rows=[['记录类型','姓名','编号','测量节点','事件','采集时刻','采集秒数','电脑时间_ISO','额温_℃','额温复核时刻','详情']];
  rows.push(['流程状态',r.subjectName,r.subjectCode,'',r.hasSkippedSteps?'含跳过':'未跳过','','','','','',JSON.stringify({hasSkippedSteps:r.hasSkippedSteps,skippedSteps:r.skippedSteps,recordingStartConfirmed:r.recordingStartConfirmed,recordingStopConfirmed:r.recordingStopConfirmed})]);
  r.measurements.forEach(m=>rows.push(['测量',r.subjectName,r.subjectCode,m.label,'血压按键',m.pressedAt===null?'':ft(m.pressedAt),m.pressedAt??'',m.pressedAt===null?'':new Date(engine.s.startAt+m.pressedAt*1000).toISOString(),m.temperature??'',m.verifiedAt===null?'':ft(m.verifiedAt),`完全放气=${m.deflatedAt===null?'未确认':ft(m.deflatedAt)}`]));
  r.events.forEach(e=>rows.push(['操作',r.subjectName,r.subjectCode,e.round===undefined?'':LABELS[e.round],e.type,e.elapsed===null?'':ft(e.elapsed),e.elapsed??'',new Date(e.at).toISOString(),e.value??'','',JSON.stringify(e)]));
  rows.push(['结束',r.subjectName,r.subjectCode,'',r.status,ft(r.recordingSeconds),r.recordingSeconds,r.endedAt||'','','','']);
  const cell=v=>'"'+String(v??'').replace(/^(\s*[=+@\-]|[\t\r])/ ,"'$&").replace(/"/g,'""')+'"';
  body='\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n');type='text/csv;charset=utf-8';
 }
 const url=URL.createObjectURL(new Blob([body],{type})),a=document.createElement('a');a.href=url;a.download=`ECG_PPG_${safe}_${new Date().toISOString().slice(0,10)}.${kind}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('已导出，请与原始波形和血压计结果一起备份。');
}
$('subject-form').addEventListener('submit',async e=>{e.preventDefault();const name=$('subject-name').value.trim(),code=$('subject-code').value.trim();if(!name||!code)return;engine.s.subjectName=name;engine.s.subject=code;full();await unlock();engine.startPreRest(Date.now());wake();changed();});
$('subject-name').addEventListener('input',()=>{engine.s.subjectName=$('subject-name').value;save();});$('subject-code').addEventListener('input',()=>{engine.s.subject=$('subject-code').value;save();});
$('action').addEventListener('input',e=>{if(e.target.id==='temperature')tempDraft[engine.current().round]=e.target.value;});
for(const id of ['sound','voice'])$(id).addEventListener('change',()=>{try{localStorage.setItem(PREFS,JSON.stringify({sound:$('sound').checked,voice:$('voice').checked}));}catch{}if(!$('voice').checked&&'speechSynthesis'in window)speechSynthesis.cancel();});
document.addEventListener('click',async e=>{
 const el=e.target.closest('[data-action]');if(!el||el.disabled)return;const a=el.dataset.action,now=Date.now(),p=engine.current(),s=engine.s;if(recordingBusy&&!['fullscreen','menu','close-menu','copy-online'].includes(a))return;
 try{switch(a){
 case 'copy-online':try{await navigator.clipboard.writeText(ONLINE_URL);toast('已复制，请粘贴到电脑 Chrome 打开。');}catch{ask('用电脑 Chrome 打开','<p>请复制此链接到电脑 Chrome：</p><input readonly aria-label="在线采集网址" value="'+esc(ONLINE_URL)+'">','关闭',()=>{});}break;
 case 'connect':await capture.connect();changed();break;
 case 'demo-signal':$('menu').hidden=true;await capture.demo();changed();break;
 case 'toggle-waveform':showRaw=!showRaw;changed();drawWaveforms(now);break;
 case 'export-raw':await downloadRaw();break;
 case 'export-saved':await downloadRaw(el.dataset.id);break;
 case 'raw-history':{const records=await capture.journal.list();$('menu').hidden=true;ask('本机原始记录',records.length?records.slice(0,20).map(r=>`<div class="history-row"><span>${esc(r.subjectName)} ${esc(r.subjectCode)}${r.synthetic?' · 合成':''}<small>${new Date(r.startedAt).toLocaleString('zh-CN')} · ${r.frames.toLocaleString()} 帧</small></span><button type="button" data-action="export-saved" data-id="${esc(r.id)}">导出</button></div>`).join(''):'<p>尚无本机原始记录。</p>','关闭',()=>{});break;}
 case 'skip':if(s.mode==='ready'&&capture.connected&&capture.parser.protocol){await startRaw(true);break;}if(engine.skip(now)){tempReview=null;lastBeat=-1;if('speechSynthesis'in window)speechSynthesis.cancel();if(engine.s.mode==='completed'){release();await stopRaw();}changed();}break;
 case 'begin':full();await unlock();await startRaw();break;
 case 'quality':engine.confirmQuality(now);engine.tick(now);changed();break;
 case 'bp':engine.pressBp(now);changed();break;
 case 'temperature':{const raw=$('temperature')?.value,v=Number(raw);if(!raw||!Number.isFinite(v)||v<25||v>45||Math.abs(v*10-Math.round(v*10))>.00001){toast('请输入额温枪读数，最多 1 位小数。');return;}tempReview={round:p.round,value:v,measuredAt:engine.elapsed(now)};changed();break;}
 case 'verify-temp':if(tempReview){engine.confirmTemperature(tempReview.value,tempReview.measuredAt,now);tempReview=null;changed();}break;
 case 'edit-temp':tempReview=null;changed();break;
 case 'deflate':engine.deflate(now);engine.tick(now);changed();break;
 case 'unstable':engine.markUnstable(now);changed();break;
 case 'restart-quality':engine.restartQuality(now);changed();break;
 case 'extend':case 'extend-custom':{const sec=Number(a==='extend'?el.dataset.seconds:$('extra-seconds').value);if(engine.extend(sec,'操作者加时',now)){changed();toast(`已加时 ${sec} 秒，后续一起顺延。`);}else toast('请输入 1–3600 秒。');break;}
 case 'hold':if(s.hold)await resumeFlow();else engine.hold('manual','保持当前阶段',now);changed();break;
 case 'resume':await unlock();await resumeFlow();break;
 case 'finish':s.recovered=true;engine.finish(now);release();await stopRaw();changed();break;
 case 'fullscreen':if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});else full();break;
 case 'menu':$('menu').hidden=!$('menu').hidden;break;
 case 'close-menu':$('menu').hidden=true;break;
 case 'test-audio':await unlock();tone(660,.15);speak('左，右，左，右');break;
 case 'export-csv':download('csv');break;
 case 'export-json':download('json');break;
 case 'abort':$('menu').hidden=true;ask('提前终止本次采集？','<p>请停止运动。确认后停止本页原始保存，已有记录保留。</p>','终止并保留记录',async()=>{engine.abort('操作者提前终止',Date.now());release();await stopRaw();changed();});break;
 case 'new-session':$('menu').hidden=true;ask('开始下一位受试者？','<p>请先导出当前采集包。原始记录仍保留在“本机原始记录”中。</p>','开始下一位',async()=>{if(capture.recorder.fault&&capture.recorder.unsaved.length&&!capture.recorder.unsavedExported)throw new Error('请先导出当前采集包，未写入缓冲仍在本页');if(capture.recorder.recording){engine.abort('新建受试者前结束记录',Date.now());await stopRaw();}release();engine=new ProtocolEngine();engine.s.qualityAutomatic=true;tempReview=null;tempDraft={};recoveredRaw=null;$('subject-name').value='';$('subject-code').value='';renderKey='';lastTask='';lastBeat=-1;changed();});break;
 }}catch(error){if(error.name!=='NotFoundError'){toast(error.message);$('raw-notice').textContent=error.message;}changed();}
});
document.addEventListener('visibilitychange',()=>{if(document.hidden){backgroundAt=Date.now();save();if('speechSynthesis'in window)speechSynthesis.cancel();}else{if(engine.s.mode==='running'&&backgroundAt!==null&&Date.now()-backgroundAt>5000)engine.hold('attention','页面离开过前台，请核对当前状态',Date.now());backgroundAt=null;wake();changed();}});
window.addEventListener('pagehide',()=>{save();capture.recorder.flush();});window.addEventListener('beforeunload',e=>{if(['running','prerest','await-finish'].includes(engine.s.mode)){save();capture.recorder.flush();e.preventDefault();e.returnValue='';}});
window.addEventListener('storage',e=>{if(e.key===KEY&&engine.s.mode==='running'&&!engine.s.hold){engine.hold('attention','另一标签页修改了记录，请仅用一个页面',Date.now());changed();}});
render(Date.now());save();
setInterval(()=>{const now=Date.now();if(now-lastSignalCheck>=100){signalState=capture.snapshot(now);engine.applySignalQuality({...signalState,ok:signalState.ok&&capture.recorder.recording&&capture.recorder.frames>0,reason:capture.recorder.recording?signalState.reason:'尚未保存原始数据'},now);lastSignalCheck=now;}capture.tick(now,signalState);if(capture.recorder.recording&&engine.s.mode==='running'&&capture.monitor.lastReceived!==null&&now-capture.monitor.lastReceived>1000)engine.hold('data','数据断流，请检查设备',now);const transition=engine.tick(now);if(transition){lastBeat=-1;save();if(transition==='await-finish'){tone(880,.15);speak('现在确认恢复并停止记录');}}if(now-lastRender>=100||transition){render(now);lastRender=now;}if(now-lastPlot>=100){drawWaveforms(now);lastPlot=now;}beat(now);if(now-lastSave>=1000){save();lastSave=now;}},50);
if(location.protocol!=='file:'&&'serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
