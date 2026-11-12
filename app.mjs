import {ProtocolEngine, newState, formatTime as ft, PRE_REST, LABELS, PROTOCOL_VERSION} from './engine.mjs';

const $ = id => document.getElementById(id);
const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const KEY = 'ecg-ppg-guide-session-v1';
const PREFS = 'ecg-ppg-guide-preferences-v1';
const PRECHECKS = [
  '已完成知情同意，核对受试者编号及个人信息',
  '血压计为成人模式，袖带臂围合适；PPG 在袖带对侧拇指',
  'RA、RL 分开贴于右手腕，LA 在左手腕；导线固定',
  'ECG、PPG 试录及保存文件正常，已接入呼吸配置保持不变',
  '背靠椅背、前臂支撑；已告知采集期间静坐、不说话',
];
const FINALCHECKS = [
  'CSV 可打开，包含连续 ECG、PPG 波形',
  '静息基线段及 4 个有效 80 秒核验记录已核对',
  '血压计 4 次结果已导出，并与本人及按键时间对应',
  '原始波形、血压记录及本次操作记录均已备份',
];
const eventNames = {
  pre_rest_started:'开始开录前 3:30 放松',pre_rest_completed:'开录前放松完成',
  recording_start_confirmed:'操作者确认 ECG / PPG 已开始保存 · 00:00',
  phase_completed:'阶段完成',phase_started:'进入阶段',delay_added:'手动延时',
  hold_started:'保持当前阶段',hold_resolved:'已核对，继续流程',
  signal_unstable:'信号不稳定 · 有效段作废',signal_stable_restart_80s:'信号恢复 · 重新计 80 秒',
  valid_80s_manually_verified:'人工核验连续 80 秒有效波形',
  bp_key_press_confirmed:'已按下血压计测量键',bp_finished_and_fully_deflated:'血压测量结束 · 已完全放气',
  temperature_measured_and_verified:'额温已测并完成读数复核',ready_to_stop_recording:'满足结束计时条件，等待操作者停录',
  recording_stopped_by_operator:'操作者确认已停止记录',protocol_terminated:'提前终止本次引导',
  end_verification_completed:'完成结束核对',page_restored:'恢复浏览器中保存的采集记录',
};
let engine = new ProtocolEngine(), restored = false, saveFailed = false;
try {
  const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
  if (saved?.version === PROTOCOL_VERSION && saved.phases?.length === 19) {
    engine = new ProtocolEngine(saved); restored = true;
    if (saved.mode === 'running') {
      if (!saved.hold) engine.hold('attention', '刷新后已恢复记录，请核对当前状态后继续', Date.now());
      engine.s.lastTick = Date.now(); engine.log('page_restored', {}, Date.now());
    }
  }
} catch { saveFailed = true; }
let audioCtx, wakeLock, lastBeat = -1, lastPhase = '', lastTempAnnouncement = -1;
let renderKey = '', tableKey = '', eventKey = '', lastPersist = 0, lastDisplay = 0;
let toastTimer, temperatureDraft = {}, currentView = 'timeline';
let dialogCallback = null;
let backgroundAt = null;

function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4200);
}
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(engine.s)); saveFailed = false; }
  catch { saveFailed = true; }
  $('save-status').innerHTML = `<span class="dot"></span>${saveFailed ? '本机保存不可用' : '本机自动保存'}`;
  $('storage-warning').hidden = !saveFailed;
  $('storage-warning').textContent = '浏览器本机保存不可用。请保持页面打开，并在结束时导出操作记录。';
}
function changed() { renderKey = ''; tableKey = ''; persist(); render(Date.now(), true); }
function initChecks() {
  $('prechecks').innerHTML = PRECHECKS.map((text,i) => `<label><input type="checkbox" data-precheck="${i}" ${engine.s.prechecks.includes(i) ? 'checked' : ''}><span>${text}</span></label>`).join('') + '<details class="device-interval"><summary>血压计说明书要求更长的间隔？</summary><label class="control-label">上次完全放气至下次按键的最小间隔（秒，至少 240）<input id="min-interval" type="number" min="240" max="3600" step="1" value="'+engine.s.minBpInterval+'"></label></details>';
  $('final-checks').innerHTML = FINALCHECKS.map((text,i) => `<label><input type="checkbox" data-finalcheck="${i}" ${engine.s.finalChecks.includes(i) ? 'checked' : ''}><span>${text}</span></label>`).join('');
  $('subject').value = engine.s.subject; $('operator').value = engine.s.operator;
  $('notes').value = engine.s.notes;
}
function playTone(frequency = 750, duration = .065, at) {
  if (!$('sound').checked || !audioCtx || audioCtx.state !== 'running') return;
  const t = at ?? audioCtx.currentTime, osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
  osc.type = 'sine'; osc.frequency.value = frequency; gain.gain.setValueAtTime(0,t);
  gain.gain.linearRampToValueAtTime(.1,t+.006); gain.gain.exponentialRampToValueAtTime(.001,t+duration);
  osc.connect(gain); gain.connect(audioCtx.destination); osc.start(t); osc.stop(t+duration+.01);
}
async function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
  } catch { toast('当前浏览器无法播放提示音，请跟随屏幕提示。'); }
}
function speak(text, quick = false) {
  if (!$('voice').checked || !('speechSynthesis' in window) || document.hidden) return;
  const item = new SpeechSynthesisUtterance(text); item.lang = 'zh-CN'; item.rate = quick ? 1.7 : 1.05;
  const voice = speechSynthesis.getVoices().find(v => /zh[-_]CN/i.test(v.lang)); if (voice) item.voice = voice;
  speechSynthesis.cancel(); speechSynthesis.speak(item);
}
function announce(text) { $('announcer').textContent = text; playTone(880,.12); speak(text); }
async function requestWake() {
  try { if ('wakeLock' in navigator && !document.hidden) wakeLock = await navigator.wakeLock.request('screen'); }
  catch { /* Timing continues using wall time; keep foreground notice stays visible. */ }
}
function releaseWake() { wakeLock?.release().catch(()=>{}); wakeLock = null; }
function showDialog(title, html, label, callback) {
  $('modal-content').innerHTML = `<h2>${title}</h2>${html}`;
  $('modal-confirm').textContent = label; $('modal-confirm').hidden = !callback;
  dialogCallback = callback; $('modal').returnValue = ''; $('modal').showModal();
}
$('modal').addEventListener('close', () => {
  const callback = dialogCallback; dialogCallback = null;
  if ($('modal').returnValue === 'confirm' && callback) callback();
});
function timestamp(t) { return t === null ? '—' : ft(t); }
function phaseDescription(p) { return p.kind === 'exercise' ? '90 步/分 · 40 秒' : p.kind === 'measure' ? '按键后 10 秒测温' : p.kind === 'quality' ? '连续 80 秒人工核验' : '静坐 · 持续保存波形'; }
function renderTables(now, schedule) {
  const s = engine.s;
  const html = s.measurements.map((m,i) => {
    const phase = schedule.find(p=>p.id===`bp${i}`), active = s.mode === 'running' && engine.current().id === phase.id;
    const pressed = m.pressedAt !== null, deflated = m.deflatedAt !== null, verified = m.verifiedAt !== null;
    return `<tr class="${active?'current-row':''}"><td>${m.label}${i === 0 ? '<small>第 1 次测量</small>' : `<small>第 ${i+1} 次测量</small>`}</td><td>${ft(phase.start)}${pressed ? `<small>实际 ${ft(m.pressedAt)}</small>` : ''}</td><td><span class="table-status ${pressed?'done':active?'pending':''}">${pressed ? '✓ 已按下 · '+ft(m.pressedAt) : active?'等待按键确认':'○ 待测量'}</span></td><td><span class="table-status ${deflated?'done':''}">${deflated ? '✓ 已放气 · '+ft(m.deflatedAt) : '○ 待确认'}</span></td><td><span class="table-status ${verified?'done':active&&pressed?'pending':''}">${verified ? '✓ '+Number(m.temperature).toFixed(1)+' ℃ · 已复核' : active&&pressed ? '测温提醒 '+ft(m.pressedAt+10) : '○ 待测温'}</span>${verified?`<small>测量 ${ft(m.temperatureAt)} · 复核 ${ft(m.verifiedAt)}</small>`:''}</td></tr>`;
  }).join('');
  if (html !== tableKey) { $('measurement-rows').innerHTML = html; tableKey = html; }
  const count = s.measurements.filter(m=>m.pressedAt!==null&&m.deflatedAt!==null&&m.verifiedAt!==null).length;
  $('measurement-count').textContent = `${count} / 4 已完成`;
  const timeline = schedule.map((p,i)=>`<div class="timeline-row ${p.actualEnd!==null?'done':s.mode==='running'&&i===s.index?'current':''}"><span class="timeline-time">${ft(p.start)}–${ft(p.end)}</span><span class="timeline-node"></span><span class="timeline-title">${p.title}</span><span class="phase-type ${p.kind}">${p.kind==='exercise'?'踏步':p.kind==='measure'?'测量':p.kind==='quality'?'有效波形':'静坐'}</span></div>`).join('');
  if ($('timeline').innerHTML !== timeline) $('timeline').innerHTML = timeline;
  $('event-count').textContent = s.events.length;
  if (eventKey !== String(s.events.length)) {
    eventKey = String(s.events.length);
    $('events').innerHTML = s.events.length ? s.events.slice().reverse().map(e=>{
      const details = [e.phase ? s.phases.find(p=>p.id===e.phase)?.title : '',e.round===undefined?'':LABELS[e.round],e.seconds?`+${e.seconds} 秒`:'',e.value?`${e.value.toFixed(1)} ℃`:'',e.reason||''].filter(Boolean).join(' · ');
      return `<div class="event-row"><time>${e.elapsed===null?'计时前':ft(e.elapsed)}<br>${new Date(e.at).toLocaleTimeString('zh-CN',{hour12:false})}</time><span>${escapeHtml(eventNames[e.type]||e.type)}${details?'<br>'+escapeHtml(details):''}</span></div>`;
    }).join('') : '<div class="empty-state">开始后，这里会记录每次操作的实际时间。</div>';
  }
}
function qualityActions(now) {
  const p = engine.current(), q = engine.s.quality[p.round], valid = engine.validSeconds(now);
  return `<div class="action-box ${q.unstable?'amber-box':''}"><h3>${q.unstable?'信号暂不稳定，等待恢复':'连续有效波形 · 80 秒'}</h3><p>请在采集软件查看 ECG、PPG。此处由操作者人工判断，不自动检测信号。</p><div class="quality-meter"><div class="quality-track"><div id="quality-progress" style="width:${Math.min(100,valid/80*100)}%"></div></div><strong id="quality-value">${Math.min(80,Math.floor(valid))} / 80 秒</strong></div><div class="quality-buttons">${q.unstable?'<button class="button primary" data-action="restart-quality">信号已稳定，重新计 80 秒</button>':`<button class="button primary" data-action="confirm-quality" ${valid<80||q.confirmedAt!==null?'disabled':''}>${q.confirmedAt!==null?'✓ 80 秒有效波形已核验':'核验：连续 80 秒波形有效'}</button><button class="button secondary" data-action="unstable">信号不稳，重置有效段</button>`}</div><p class="hint">掉线或明显伪差后，恢复稳定时重新计满 80 秒；确认后才能进入测压。</p></div>`;
}
function measurementActions(now) {
  const p = engine.current(), m = engine.s.measurements[p.round], t = engine.elapsed(now);
  const due = m.pressedAt !== null && t >= m.pressedAt+10;
  return `<div class="action-box"><h3>① 血压测量 · ${m.label}</h3>${m.pressedAt===null?'<p>先实际按下设备的测量键，再点击下方按钮核验。</p><button class="button primary" data-action="press-bp">我已按下血压计测量键</button>':`<p class="status-good">✓ 实际按键 ${ft(m.pressedAt)} · ${new Date(engine.s.startAt+m.pressedAt*1000).toLocaleTimeString('zh-CN',{hour12:false})}</p>${m.deflatedAt===null?'<button class="button secondary" data-action="deflate">测量已完成，袖带已完全放气</button>':`<div class="status-good">✓ 完全放气已确认 · ${ft(m.deflatedAt)}</div>`}`}</div><div class="action-box ${due&&m.verifiedAt===null?'amber-box':''}"><h3>② 额温测量与读数复核</h3>${m.verifiedAt!==null?`<p class="status-good">✓ ${Number(m.temperature).toFixed(1)} ℃ · 已测量、已复核<br>测量 ${ft(m.temperatureAt)} · 复核 ${ft(m.verifiedAt)}</p>`:m.pressedAt===null?'<p>确认已按下血压计后，10 秒开始提示测温。</p>':!due?'<p>请由操作者测温，受试者不自行抬手。</p><div class="status-good" id="temperature-countdown"></div>':`<p>现在由操作者测额温，输入额温枪显示的读数，再核对一次。</p><div class="temperature-form"><input id="temperature-input" inputmode="decimal" type="number" min="25" max="45" step="0.1" placeholder="36.5" aria-label="本次额温摄氏度" value="${escapeHtml(temperatureDraft[p.round]??'')}"><span>℃</span><button class="button primary" data-action="temperature">额温已测，核对读数</button></div>`}</div>`;
}
function renderStageActions(now) {
  const s = engine.s, p = engine.current(), t = engine.elapsed(now);
  if (s.mode==='prerest') return '<p>请保持安静坐姿。放松结束后会提示在采集软件开始保存。</p>';
  if (s.mode==='ready') return '<div class="action-box"><h3>放松完成，可以开始保存 ECG、PPG</h3><p>请先在采集软件点击开始保存，再同步点击这里。网页计时不会启动或停止硬件。</p><button class="button primary" data-action="begin">已开始保存 ECG / PPG，启动 00:00 →</button></div>';
  if (s.mode==='await-finish') return `<div class="action-box"><h3>结束前，再确认一次</h3><p>已到结束节点，末次完全放气已满 30 秒。确认本人已经恢复，再停止采集软件保存。</p><label class="recovered-check"><input type="checkbox" id="recovered" ${s.recovered?'checked':''}> 受试者本人已经恢复</label><br><button class="button primary" data-action="finish" ${!s.recovered?'disabled':''}>已在采集软件停止记录，结束计时</button></div>`;
  if (s.mode==='completed') return '<div class="action-box"><h3>本次记录计时已结束</h3><p>请核对下方四次测量、原始波形与血压计导出结果，填写异常备注，并导出本次记录。</p><button data-action="go-final" class="button primary">前往结束核对 ↓</button></div>';
  if (s.mode==='aborted') return '<div class="action-box amber-box"><h3>本次引导已提前终止</h3><p>请停止运动、照看受试者，并在采集软件停止记录。已保留的操作记录可以导出。</p></div>';
  if (s.mode!=='running') return '';
  if (p.kind==='quality') return qualityActions(now);
  if (p.kind==='measure') return measurementActions(now);
  if (p.kind==='exercise') return '<p>踏步固定 40 秒，不延长运动。需要更多恢复时间时，可在下一静坐阶段延时。</p>';
  return `<div class="action-box"><h3>${p.kind==='settle'?'恢复坐姿，保持安静':'保持静坐，波形持续保存'}</h3><p>${p.kind==='settle'?'稍后开始连续 80 秒有效波形核验。':'需要更长时间时，使用右侧延时或保持当前阶段。'}</p></div>`;
}
function render(now, force = false) {
  const s = engine.s, p = engine.current(), t = engine.elapsed(now), schedule = engine.schedule(now);
  const running = s.mode==='running', pre = s.mode==='prerest', ready = s.mode==='ready';
  $('setup').hidden = s.mode!=='setup'; $('workspace').hidden = s.mode==='setup';
  $('subject-label').textContent = s.subject ? `受试者 ${s.subject}${s.operator?' · 操作者 '+s.operator:''}`:'未设置受试者编号';
  $('wall-clock').textContent = new Date(now).toLocaleTimeString('zh-CN',{hour12:false});
  $('session-status').textContent = ({setup:'准备开始',prerest:'开录前放松',ready:'等待开录确认',running:s.hold?'连续计时 · 等待核对':'连续计时中', 'await-finish':'等待停录确认',completed:'计时已结束',aborted:'已提前终止'})[s.mode];
  $('record-dot').style.background = running||s.mode==='await-finish'?'#378d6c':'#91a48e';
  $('start-pre').disabled = s.prechecks.length!==PRECHECKS.length || !s.subject.trim();
  const total = schedule.at(-1).end;
  $('timeline-caption').textContent = `预计 ${ft(total)} 完成${total>1081?' · 后续节点已顺延':''}。按键、放气及测温均记录实际时刻；等待人工确认时继续计时。`;
  if (s.mode!=='setup') {
    const rem = pre ? Math.max(0,PRE_REST-(now-s.preStart)/1000) : ready?0:running?Math.max(0,schedule[s.index].end-t):0;
    $('main-clock').textContent = pre?ft(Math.ceil(rem)):ready?'00:00':ft(t);
    $('timer-label').textContent = pre?'开录前放松倒计时':ready?'准备启动连续记录':'采集已进行 · 分钟 : 秒';
    $('clock-caption').textContent = pre?'此段不计入 18 分钟连续记录':ready?'请与采集软件的保存操作同步启动':s.startAt!==null?`开录电脑时间 ${new Date(s.startAt).toLocaleTimeString('zh-CN',{hour12:false})} · 计时始终不归零`:'';
    $('stage-tag').textContent = pre?'开录前放松':ready?'放松已完成':s.mode==='completed'?'本次采集完成':s.mode==='aborted'?'已提前终止':s.mode==='await-finish'?'结束前确认':p.kind==='exercise'?'坐姿踏步 · 跟随节奏':p.kind==='measure'?'测量节点 · 需要确认':'安静静坐 · 保持记录';
    $('stage-count').textContent = pre||ready?'PREPARATION':`${String(s.index+1).padStart(2,'0')} / 19 STAGES`;
    const exerciseOver = running&&p.kind==='exercise'&&t-p.actualStart>=40;
    $('stage-title').textContent = pre?'安静坐好，放松身体':ready?'放松完成，准备开录':s.mode==='completed'?'本次计时已完成':s.mode==='aborted'?'引导已停止，请照看受试者':s.mode==='await-finish'?'保持静坐，准备结束':exerciseOver?'停止踏步，保持静坐':p.title;
    $('stage-instruction').textContent = pre?'背靠椅背，双脚平放，前臂放在支撑面上。':ready?'先开始保存 ECG、PPG，再同步启动网页计时。':s.mode==='completed'?'核对文件、设备结果及操作记录，然后备份。':s.mode==='aborted'?'停止运动，并在采集软件停止保存。':s.mode==='await-finish'?'确认本人已经恢复，停止采集软件保存后点击下方确认。':exerciseOver?'双脚平放，前臂支撑。核对页面提示后继续。':p.instruction;
    const pct = pre?(1-rem/PRE_REST)*100:ready?100:p.actualStart===null?0:Math.min(100,(t-p.actualStart)/(p.duration+p.extra)*100);
    $('stage-progress').style.width = `${Math.max(0,pct)}%`;
    $('phase-countdown').textContent = pre?`本阶段剩余 ${ft(Math.ceil(rem))}`:ready?'等待手动启动':running?rem>0?`本阶段剩余 ${ft(Math.ceil(rem))}`:'等待确认 / 后续自动顺延':s.mode==='await-finish'?'等待确认停止保存':'实际结束 '+ft(t);
    $('end-estimate').textContent = pre||ready?'正式记录默认 18:00':`预计结束 ${ft(total)}`;
    $('metronome').hidden = !running || p.kind!=='exercise';
    $('stage-card').classList.toggle('exercise-stage',running&&p.kind==='exercise');
    $('next-action').innerHTML = pre||ready?'<b>下一步</b>　开始连续保存 ECG、PPG，启动 00:00。':s.mode==='completed'||s.mode==='aborted'?'<b>请导出</b>　本页记录不会随网站发布，也不会自动上传。':s.index<18?`<b>下一步</b>　${escapeHtml(schedule[s.index+1].title)} · 预计 ${ft(schedule[s.index+1].start)}`:'<b>最后一步</b>　确认恢复，停止记录并备份。';
    const upcoming = schedule.slice(s.index+(running?1:0)).find(x=>x.kind==='measure'||x.kind==='exercise');
    $('up-next-title').textContent = pre||ready?'开始连续记录':upcoming?.title||'结束核对与备份';
    $('up-next-time').textContent = pre||ready?'放松结束后，确认采集软件正在保存':upcoming?`预计 ${ft(upcoming.start)} · ${phaseDescription(upcoming)}`:'核对波形、血压计结果和备份';
    const m=p.kind==='measure'?s.measurements[p.round]:null;
    const signature = [s.mode,s.index,s.events.length,s.recovered,p.kind==='quality'&&engine.validSeconds(now)>=80,m?.pressedAt!==null&&m&&t>=m.pressedAt+10,s.completedVerification].join(':');
    if (force || signature!==renderKey) { $('stage-actions').innerHTML = renderStageActions(now); renderKey=signature; }
    if ($('quality-value')) {
      const valid=engine.validSeconds(now); $('quality-value').textContent=`${Math.min(80,Math.floor(valid))} / 80 秒`; $('quality-progress').style.width=`${Math.min(100,valid/80*100)}%`;
    }
    if ($('temperature-countdown')&&m?.pressedAt!==null) $('temperature-countdown').textContent=`距离测温 ${Math.max(0,Math.ceil(m.pressedAt+10-t))} 秒 · 提醒时刻 ${ft(m.pressedAt+10)}`;
    const canDelay=running&&p.kind!=='exercise';
    document.querySelectorAll('[data-action="extend"],[data-action="extend-custom"],#custom-seconds,#delay-reason').forEach(el=>el.disabled=!canDelay);
    $('hold-button').disabled=!running||p.kind==='exercise'||!!s.hold;
    $('delay-hint').textContent=running&&p.kind==='exercise'?'本段运动固定 40 秒，结束后可延长恢复时间。':'后续时间一起顺延，采集时钟始终向前。';
    document.querySelector('[data-action="abort"]').disabled=!['prerest','ready','running','await-finish'].includes(s.mode);
    const reasons=running&&rem<=0?engine.blockers(now).filter(x=>x!==s.hold?.reason):[];
    $('attention').hidden=!s.hold&&!reasons.length;
    $('attention').innerHTML=s.hold?`<span><b>连续记录仍在进行。</b> ${escapeHtml(s.hold.reason)}${p.kind==='exercise'?'。若已到 40 秒，请停止踏步。':''}</span><button data-action="resume" class="button secondary">已核对，继续流程</button>`:reasons.length?`<span><b>当前节点等待确认，后续时间自动顺延。</b><br>${reasons.map(escapeHtml).join('；')}</span>`:'';
  }
  $('completion').hidden=!['completed','aborted'].includes(s.mode);
  $('completion-status').textContent=s.completedVerification?'✓ 已完成核对':s.mode==='aborted'?'提前终止 · 保留记录':'待核对';
  $('verify-finish').disabled=s.mode!=='completed'||s.finalChecks.length!==4||s.completedVerification;
  renderTables(now,schedule);
}
function metronome(now) {
  const s=engine.s,p=engine.current();
  if (s.mode!=='running'||p.kind!=='exercise') {lastBeat=-1;return;}
  const elapsed=engine.elapsed(now)-p.actualStart;
  if (elapsed>=40) {
    $('left-foot').classList.remove('active');$('right-foot').classList.remove('active');
    $('step-word').textContent='停止踏步';$('step-count').textContent='40 秒已到 · 双脚平放';return;
  }
  if (s.hold) { $('step-word').textContent='停止踏步';$('step-count').textContent='先核对页面状态';return; }
  const beat=Math.floor(elapsed*1.5);
  if (beat===lastBeat) return;
  lastBeat=beat;
  $('left-foot').classList.toggle('active',beat%2===0);$('right-foot').classList.toggle('active',beat%2===1);
  $('step-word').textContent=beat%2===0?'左脚抬起':'右脚抬起';$('step-count').textContent=`${beat+1} / 60 步`;
  document.querySelectorAll('.beat-lights i').forEach((el,i)=>el.classList.toggle('on',i===beat%4));
  playTone(beat%2===0?660:880,.065); speak(beat%2===0?'左':'右',true);
}
function checkAnnouncements(now) {
  const s=engine.s,p=engine.current(),key=s.mode+':'+s.index;
  if (lastPhase!==key) {
    lastPhase=key; lastBeat=-1;
    if (s.mode==='ready') announce('放松完成，请开始保存 ECG 和 PPG，再启动网页计时。');
    else if (s.mode==='running'&&p.kind!=='exercise') announce(p.title+'。'+p.instruction);
    else if (s.mode==='await-finish') announce('计时条件已满足，确认受试者恢复后，停止记录。');
    if (s.mode==='completed'||s.mode==='aborted') { releaseWake(); if('speechSynthesis' in window) speechSynthesis.cancel(); }
  }
  if (s.mode==='running'&&p.kind==='measure') {
    const m=s.measurements[p.round];
    if (m.pressedAt!==null&&m.verifiedAt===null&&engine.elapsed(now)>=m.pressedAt+10&&lastTempAnnouncement!==p.round) {
      lastTempAnnouncement=p.round;announce('现在由操作者测量额温，并核对读数。');
    }
  }
}
function download(kind) {
  const report=engine.report(Date.now()), safe=(engine.s.subject||'session').replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g,'_');
  let body,type;
  if(kind==='json'){body=JSON.stringify(report,null,2);type='application/json;charset=utf-8';}
  else {
    const rows=[['record_type','subject_code','operator','checkpoint','event','recording_time_mmss','recording_seconds','computer_time_iso','temperature_c','verified_time_mmss','detail']];
    engine.s.measurements.forEach((m,i)=>rows.push(['measurement',engine.s.subject,engine.s.operator,m.label,'bp_key_press',timestamp(m.pressedAt),m.pressedAt??'',m.pressedAt===null?'':new Date(engine.s.startAt+m.pressedAt*1000).toISOString(),m.temperature??'',timestamp(m.verifiedAt),`deflated=${timestamp(m.deflatedAt)}; temperature_measured=${timestamp(m.temperatureAt)}`]));
    engine.s.events.forEach(e=>rows.push(['event',engine.s.subject,engine.s.operator,e.round===undefined?'':LABELS[e.round],eventNames[e.type]||e.type,e.elapsed===null?'':ft(e.elapsed),e.elapsed??'',new Date(e.at).toISOString(),e.value??'','',JSON.stringify(e)]));
    rows.push(['summary',engine.s.subject,engine.s.operator,'',engine.s.mode,ft(report.recordingSeconds),report.recordingSeconds,report.endedAt||'', '', '',JSON.stringify({finalChecks:engine.s.finalChecks,notes:engine.s.notes,verified:engine.s.completedVerification})]);
    const cell=v=>`"${String(v??'').replace(/^[=+@\-\t\r]/,"'$&").replace(/"/g,'""')}"`;
    body='\uFEFF'+rows.map(r=>r.map(cell).join(',')).join('\r\n'); type='text/csv;charset=utf-8';
  }
  const url=URL.createObjectURL(new Blob([body],{type})),a=document.createElement('a');
  a.href=url;a.download=`ECG_PPG_${safe}_${new Date().toISOString().slice(0,10)}.${kind}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast('已导出本次记录，请与原始波形和血压计结果一起备份。');
}
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-action],[data-view]'); if(!button||button.disabled)return;
  if(button.dataset.view){currentView=button.dataset.view;$('timeline').hidden=currentView!=='timeline';$('events').hidden=currentView!=='events';document.querySelectorAll('[data-view]').forEach(x=>x.classList.toggle('active',x.dataset.view===currentView));return;}
  const action=button.dataset.action,now=Date.now(),s=engine.s,p=engine.current();
  switch(action){
    case 'start-pre':
      if(s.prechecks.length!==PRECHECKS.length||!s.subject.trim())return;
      await unlockAudio(); engine.startPreRest(Date.now()); await requestWake();changed();$('workspace').scrollIntoView({behavior:'smooth',block:'start'});break;
    case 'begin':
      await unlockAudio();engine.begin(Date.now());await requestWake();changed();break;
    case 'extend': case 'extend-custom': {
      const seconds=Number(action==='extend'?button.dataset.seconds:$('custom-seconds').value);
      if(engine.extend(seconds,$('delay-reason').value,now)){const unstable=$('delay-reason').value==='信号不稳定'&&p.kind==='quality';if(unstable)engine.markUnstable(now);changed();toast(unstable?`已延长 ${seconds} 秒并重置有效段；信号稳定后请重新计 80 秒。`:`当前静坐延长 ${seconds} 秒，后续安排同步顺延。`);}else toast('请输入 1–3600 秒；运动段不能延长。');break;
    }
    case 'hold':if($('delay-reason').value==='信号不稳定'&&p.kind==='quality')engine.markUnstable(now);engine.hold('manual',$('delay-reason').value,now);changed();break;
    case 'resume':await unlockAudio();engine.resume(Date.now());await requestWake();changed();break;
    case 'unstable':engine.markUnstable(now);changed();toast('有效段已重置；波形稳定后点击重新计 80 秒。');break;
    case 'restart-quality':engine.restartQuality(now);changed();break;
    case 'confirm-quality':showDialog('核验连续 80 秒有效波形','<p>请确认：采集软件中的 ECG、PPG 在刚才连续 80 秒内没有掉线或明显伪差，原始波形正在保存。</p>','确认波形有效',()=>{engine.confirmQuality(Date.now());changed();});break;
    case 'press-bp':showDialog('确认已按下血压计？',`<p>本次：<b>${LABELS[p.round]}</b>。请确认已实际按下血压计的测量键。</p><p>按键时间记录为刚才点击“我已按下”按钮的时刻，10 秒后提示测额温；本次复核不改变该时刻。此操作不代表血压已测量成功。</p>`,'已按下，确认记录',()=>{engine.pressBp(now,Date.now());changed();});break;
    case 'deflate':showDialog('确认袖带已完全放气？','<p>请确认本次血压测量已经结束，袖带已经完全放气。网页会从确认时刻计算测后缓冲和下次测压间隔。</p>','已完全放气',()=>{engine.deflate(Date.now());changed();});break;
    case 'temperature': {
      const raw=$('temperature-input')?.value,value=Number(raw),measuredAt=engine.elapsed(now);
      if(!raw||!Number.isFinite(value)||value<25||value>45||Math.abs(value*10-Math.round(value*10))>0.00001){toast('请填写额温枪实际读数，保留至多 1 位小数（25–45 ℃）。');return;}
      showDialog('再次核对额温读数',`<p>${LABELS[p.round]} · 请对照额温枪显示值。</p><div class="confirm-reading">${value.toFixed(1)} <small>℃</small></div><p>点击确认表示已测量，并核对了显示读数。</p>`,'读数正确，确认记录',()=>{engine.confirmTemperature(value,measuredAt,Date.now());changed();});break;
    }
    case 'finish':engine.finish(now);changed();break;
    case 'go-final':$('completion').scrollIntoView({behavior:'smooth'});break;
    case 'verify-finish':
      if(s.mode==='completed'&&s.finalChecks.length===4){s.completedVerification=true;engine.log('end_verification_completed',{},now);changed();toast('结束核对已完成，请导出 CSV 或完整 JSON。');}break;
    case 'export-csv':download('csv');break;
    case 'export-json':download('json');break;
    case 'test-sound':await unlockAudio();playTone(660,.13);speak('提示音正常。左，右，左，右。');break;
    case 'abort':showDialog('提前终止本次引导','<p>确认后立即停止网页节拍和引导计时。请同时停止运动，并在采集软件停止保存。</p><label class="control-label">终止原因<input id="abort-reason" placeholder="例如：不适、设备异常、操作终止" maxlength="300"></label>','终止并保留记录',()=>{engine.abort($('abort-reason')?.value.trim()||'操作者提前终止',Date.now());changed();});break;
    case 'new-session':showDialog('开始新的受试者记录','<p>请先导出本次记录。新建后会清空当前浏览器中的本次采集记录。</p>','新建并清空本次记录',()=>{releaseWake();if('speechSynthesis' in window)speechSynthesis.cancel();engine=new ProtocolEngine();temperatureDraft={};lastTempAnnouncement=-1;lastBeat=-1;lastPhase='';renderKey='';tableKey='';eventKey='';initChecks();changed();window.scrollTo({top:0,behavior:'smooth'});});break;
    case 'help':showDialog('按最终版流程执行',`<p>开录前放松 <b>3:30</b>；正式连续记录默认 <b>18:00</b>。测压节点 01:30、06:30、11:30、16:30；踏步节点 04:00、09:00、14:00。</p><ul><li>每次测压前，人工核验连续 80 秒有效 ECG / PPG。信号恢复稳定后重新计 80 秒。</li><li>按键与完全放气分别确认；保留充放气及放气后至少 30 秒波形，并标记为干扰区间。</li><li>两次测压之间，从上次完全放气到下次按键至少 4 分钟；设备说明书更严格时，在准备页设置更长间隔。</li><li>测温以实际按键后 10 秒提示；读数需要再次核验。</li><li>全程保持采集软件连续保存，网页本身不控制设备。</li><li>保持页面在前台并避免锁屏；重新打开时需核对状态后继续。</li></ul><p>流程来源：ECG与PPG血压预测采集流程_最终版.pdf（2026.11.12）。</p>`,null,null);break;
  }
});
document.addEventListener('input',event=>{
  const el=event.target;
  if(el.id==='subject'||el.id==='operator'){engine.s[el.id]=el.value;changed();}
  if(el.id==='notes'){engine.s.notes=el.value;engine.s.completedVerification=false;persist();}
  if(el.id==='temperature-input')temperatureDraft[engine.current().round]=el.value;
});
document.addEventListener('change',event=>{
  const el=event.target,s=engine.s;
  if(el.dataset.precheck!==undefined){const n=Number(el.dataset.precheck);s.prechecks=el.checked?[...new Set([...s.prechecks,n])]:s.prechecks.filter(x=>x!==n);changed();}
  if(el.dataset.finalcheck!==undefined){const n=Number(el.dataset.finalcheck);s.finalChecks=el.checked?[...new Set([...s.finalChecks,n])]:s.finalChecks.filter(x=>x!==n);s.completedVerification=false;changed();}
  if(el.id==='min-interval'){const n=Number(el.value);if(Number.isFinite(n)&&n>=240&&n<=3600){s.minBpInterval=Math.ceil(n);changed();}else{el.value=s.minBpInterval;toast('最小间隔请输入 240–3600 秒。');}}
  if(el.id==='recovered'){s.recovered=el.checked;changed();}
  if(el.id==='sound'||el.id==='voice'){try{localStorage.setItem(PREFS,JSON.stringify({sound:$('sound').checked,voice:$('voice').checked}));}catch{} if(el.id==='voice'&&!el.checked&&'speechSynthesis'in window)speechSynthesis.cancel();}
});
$('fullscreen').addEventListener('click',async()=>{
  try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}
  catch{toast('当前浏览器不支持全屏，可手动放大页面。');}
});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden){backgroundAt=Date.now();persist();if('speechSynthesis'in window)speechSynthesis.cancel();}
  else{
    if(engine.s.mode==='running'&&backgroundAt!==null&&Date.now()-backgroundAt>5000)engine.hold('attention','页面曾离开前台，请核对当前状态后继续',Date.now());
    backgroundAt=null;requestWake();changed();
  }
});
window.addEventListener('pagehide',persist);
window.addEventListener('beforeunload',event=>{if(['running','prerest','await-finish'].includes(engine.s.mode)){persist();event.preventDefault();event.returnValue='';}});
window.addEventListener('offline',()=>toast('当前离线，已打开的计时和操作功能可继续使用。'));
window.addEventListener('storage',event=>{if(event.key===KEY&&engine.s.mode==='running')engine.hold('attention','另一个标签页修改了本机记录，请仅在一个标签页操作',Date.now());});

initChecks();
try{const prefs=JSON.parse(localStorage.getItem(PREFS)||'null');if(prefs){$('sound').checked=prefs.sound;$('voice').checked=prefs.voice;}}catch{}
render(Date.now(),true);persist();
lastPhase=engine.s.mode+':'+engine.s.index;
if(restored&&engine.s.mode!=='setup')toast('已恢复本机保存的记录。请核对当前状态；采集时钟保持实际时间。');
setInterval(()=>{
  const now=Date.now(),transition=engine.tick(now);
  if(transition){renderKey='';persist();}
  if(now-lastDisplay>=200||transition){render(now);checkAnnouncements(now);lastDisplay=now;}
  metronome(now);
  if(now-lastPersist>=1000){persist();lastPersist=now;}
},50);
if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
