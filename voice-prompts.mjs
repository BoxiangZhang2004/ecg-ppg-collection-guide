export const VOICE_POLICY_VERSION = 'all-steps-20261113-v1';

// Stable keys avoid repeating instructions whenever a live counter changes.
export function workflowPrompt(engine, view = {}, now = Date.now()) {
  const s = engine.s, p = engine.current(), prefix = `${s.mode}:${p.id}`;
  if (s.hold) return {key:`hold:${s.hold.since}`, text:`请先停止踏步，保持坐姿。${s.hold.reason}。核对后点击继续。`};
  if (s.mode === 'setup') return {key:'setup', text:'请连接采集板，填写受试者姓名和编号，然后开始三分三十秒静坐。'};
  if (s.mode === 'prerest') return {key:'prerest', text:'现在开始开录前三分三十秒静坐。双脚平放，前臂支撑，保持安静。此时尚未开始保存原始数据。'};
  if (s.mode === 'ready') return {key:'ready', text:'开录前静坐结束。请确认设备已连接，点击开始采集并计时，同时开始保存原始数据。'};
  if (s.mode === 'await-finish') return {key:'await-finish', text:'最后等待已结束。请确认本人已经恢复，点击停止采集并保存，再导出原始采集包并备份。'};
  if (s.mode === 'completed') return {key:'completed', text:'本次采集已结束。请导出原始采集包，核对四次血压记录并备份。'};
  if (s.mode === 'aborted') return {key:'aborted', text:'本次采集已提前终止。请停止踏步，保持坐姿，并导出已有记录。'};
  if (s.mode !== 'running') return null;
  if (p.kind === 'exercise') return {key:prefix, text:`现在开始第${p.round}次坐姿踏步，四十秒，每分钟九十步。上身稳定，前臂支撑，跟随左右提示交替抬脚。`};
  if (p.kind === 'settle') return {key:prefix, text:`现在停止踏步，用${p.duration}秒整理姿势。双脚平放，前臂支撑，保持安静。随后采集八十秒有效波形。`};
  if (p.kind === 'quality') {
    const q = s.quality[p.round], progress = engine.qualityProgress(now);
    const ended = engine.elapsed(now) + .001 >= engine.phaseTarget();
    if (progress.extensionPlanned && ended && !progress.enough) return {key:prefix+':insufficient', text:'本段补采结束，质量仍不足。已保留累计时长，不再自动追加。请选择再采二十秒，或记录质量不足后继续测血压。'};
    if (q.manualUnstable) return {key:prefix+':unstable', text:'信号累计已暂停，之前通过的时长保留。请整理传感器，稳定后点击恢复累计。'};
    if (progress.enough && ended && q.confirmedAt === null) return {key:prefix+':ready', text:'累计有效波形条件已满足。请核对波形，点击确认测血压。'};
    if (progress.extensionPlanned && (progress.automaticExtraSeconds > 0 || p.extra > 0) && !ended) return {key:prefix+':compensation:'+p.extra, text:p.extra>0?`本段已由操作者加时${Math.ceil(p.extra)}秒。请继续静坐，已通过的时长保留。`:`有效波形不足，本段一次补采${progress.automaticExtraSeconds}秒。请继续静坐，已通过的时长保留。`};
    return {key:prefix, text:`${p.round===0?'现在开始保存原始数据，静息基线记录九十秒':'现在开始采集八十秒有效波形'}。请保持静坐，双脚平放，前臂支撑。信号短暂不合格不会清零累计。`};
  }
  let text;
  if (view.key === 'bp') text = `${p.title}。请操作者按下血压计，并点击确认。${engine.compactProtocol?'六十秒为预留时间，读数完成且袖带完全放气后，请立即确认放气。':'此记录沿用旧版计时。测量结束并完全放气后，请点击确认。'}`;
  else if (view.key === 'wait-temp') text = '血压测量中，请保持静坐。按下血压计十秒后提醒测额温；读数完成且袖带完全放气后，可立即确认。';
  else if (view.key === 'temperature') text = '现在测额温。请操作者测量，填写额温枪读数并复核。';
  else if (view.key?.startsWith('review:')) text = `请对照额温枪核对读数，${view.temperatureValue}摄氏度。正确后点击确认。`;
  else if (view.key === 'deflate') text = '等待血压测量结束。读数完成且袖带完全放气后，请点击确认。'+(engine.compactProtocol?'不用等满六十秒。':'此记录沿用旧版计时。');
  else if (view.key === 'post-wait-temp') text = '袖带已完全放气，现在安静等待三十秒。稍后在等待期间测额温，等待计时继续。';
  else if (view.key === 'post-temperature') text = '正在放气后三十秒等待。现在请测额温，填写并复核读数，等待计时继续。';
  else if (view.key?.startsWith('post-review:')) text = `正在放气后等待。请核对额温读数，${view.temperatureValue}摄氏度。正确后点击确认，等待计时继续。`;
  else if (p.kind === 'post') text = `${p.title}。请保持静坐，完全放气后安静等待${p.duration}秒。${p.round===3?'结束后确认本人恢复':'随后开始下一轮坐姿踏步'}。`;
  else text = `${p.title}。${p.instruction}`;
  return {key:prefix+':'+(view.key||'phase'), text};
}

export class WorkflowSpeaker {
  constructor({synth = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance, enabled = () => true, hidden = () => false, onStatus = () => {}} = {}) {
    Object.assign(this,{synth,Utterance,enabled,hidden,onStatus});
    this.mainBusy=false; this.token=0; this.lastMain='';
  }
  cancel() { this.token++; this.mainBusy=false; this.synth?.cancel(); }
  speak(text, quick = false) {
    if (!quick) this.lastMain=text;
    if (!this.enabled() || this.hidden()) return false;
    if (!this.synth || !this.Utterance) { if(!quick)this.onStatus('unavailable','当前浏览器没有语音合成，请在电脑 Chrome 打开。'); return false; }
    // The metronome must never cut off a full phase instruction.
    if (quick && this.mainBusy) return false;
    this.cancel();
    const token=this.token, u=new this.Utterance(text);
    u.lang='zh-CN'; u.rate=quick?1.7:1.05;
    const voices=this.synth.getVoices?.()??[];
    const voice=voices.find(v=>/zh[-_]CN/i.test(v.lang))??voices.find(v=>/^zh/i.test(v.lang));
    if(voice)u.voice=voice;
    this.mainBusy=!quick;
    u.onend=()=>{if(token===this.token)this.mainBusy=false;};
    u.onerror=event=>{
      if(token!==this.token)return;
      this.mainBusy=false;
      if(!quick&&!['canceled','interrupted'].includes(event.error))this.onStatus('error',`语音未能播放（${event.error||'未知原因'}），请点击“重播语音”。`);
    };
    try { this.synth.speak(u); if(!quick)this.onStatus('requested',text); return true; }
    catch {this.mainBusy=false;if(!quick)this.onStatus('error','语音未能播放，请点击“重播语音”。');return false;}
  }
}
