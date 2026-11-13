import {QUALITY_COLLECTION_RULES, initializeQuality, addGoodSpan, qualitySummary, planQualityExtension} from './quality-progress.mjs?v=4.6';
export const PROTOCOL_VERSION = '2026-11-12.1';
export const PRE_REST = 210;
export const BASE_PHASES = [
  ['baseline', '静息基线', 90, 'quality', 0, '安静坐好，双脚平放，前臂放在支撑面上。'],
  ['bp0', '测量静息血压', 60, 'measure', 0, '操作者按下血压计；受试者保持静坐，不说话、不抬手。'],
  ['post0', '测后安静静坐', 30, 'post', 0, '保持静坐，保留完全放气后至少 30 秒的波形。'],
  ['formal', '正式观察 · 安静静坐', 60, 'rest', null, '继续安静静坐，即将开始第一次坐姿踏步。'],
  ['exercise1', '第 1 次坐姿踏步', 40, 'exercise', 1, '跟随左右提示交替抬脚。上身稳定，不摆臂、不握拳、不憋气。'],
  ['settle1', '停止踏步 · 坐姿恢复', 30, 'settle', 1, '双脚平放，前臂支撑，保持安静。'],
  ['window1', '恢复 1 · 累计有效波形', 80, 'quality', 1, '保持静坐，累计 80 秒通过初筛的波形，并保留完整 20 秒片段。'],
  ['bp1', '测量第 1 次恢复血压', 60, 'measure', 1, '操作者按下血压计；受试者保持静坐。'],
  ['recovery1', '安静恢复 · 等待第 2 轮', 90, 'post', 1, '继续静坐恢复；原始波形持续保存。'],
  ['exercise2', '第 2 次坐姿踏步', 40, 'exercise', 2, '跟随左右提示交替抬脚。上身稳定，不摆臂、不握拳、不憋气。'],
  ['settle2', '停止踏步 · 坐姿恢复', 30, 'settle', 2, '双脚平放，前臂支撑，保持安静。'],
  ['window2', '恢复 2 · 累计有效波形', 80, 'quality', 2, '保持静坐，累计 80 秒通过初筛的波形，并保留完整 20 秒片段。'],
  ['bp2', '测量第 2 次恢复血压', 60, 'measure', 2, '操作者按下血压计；受试者保持静坐。'],
  ['recovery2', '安静恢复 · 等待第 3 轮', 90, 'post', 2, '继续静坐恢复；原始波形持续保存。'],
  ['exercise3', '第 3 次坐姿踏步', 40, 'exercise', 3, '跟随左右提示交替抬脚。上身稳定，不摆臂、不握拳、不憋气。'],
  ['settle3', '停止踏步 · 坐姿恢复', 30, 'settle', 3, '双脚平放，前臂支撑，保持安静。'],
  ['window3', '恢复 3 · 累计有效波形', 80, 'quality', 3, '保持静坐，累计 80 秒通过初筛的波形，并保留完整 20 秒片段。'],
  ['bp3', '测量第 3 次恢复血压', 60, 'measure', 3, '操作者按下血压计；受试者保持静坐。'],
  ['post3', '最后恢复 · 准备结束', 30, 'post', 3, '末次完全放气至少 30 秒，确认本人已经恢复。'],
].map(([id, title, duration, kind, round, instruction]) => ({id, title, duration, kind, round, instruction}));

export const LABELS = ['静息基线', '第 1 次恢复', '第 2 次恢复', '第 3 次恢复'];
export function formatTime(seconds) {
  const n = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}
export function newState(now = Date.now()) {
  return {
    version: PROTOCOL_VERSION, createdAt: now, mode: 'setup', subject: '', subjectName: '', operator: '',
    preStart: null, preEnd: null, startAt: null, endAt: null, index: 0, lastTick: null,
    recordingStartConfirmed: null, recordingStopConfirmed: null, skips: [], rawSessionId: null, qualityAutomatic: false,
    phases: BASE_PHASES.map(p => ({...p, extra: 0, actualStart: null, actualEnd: null})),
    quality: LABELS.map(() => ({since: null, confirmedAt: null, unstable: false})),
    measurements: LABELS.map(label => ({label, pressedAt: null, pressConfirmedAt: null, deflatedAt: null, temperature: null, temperatureAt: null, verifiedAt: null, bpSkippedAt: null, temperatureSkippedAt: null, deflationSkippedAt: null, temperaturePromptAt: null})),
    hold: null, events: [], prechecks: [], finalChecks: [], minBpInterval: 240,
    notes: '', recovered: false, completedVerification: false,
  };
}

export class ProtocolEngine {
  constructor(state = newState()) {
    this.s = state; this.s.skips ??= [];
    for (const phase of this.s.phases.filter(p => p.kind === 'quality')) initializeQuality(this.s.quality[phase.round], phase, this.s.events);
  }
  elapsed(now = Date.now()) { return this.s.startAt === null ? 0 : ((this.s.endAt ?? now) - this.s.startAt) / 1000; }
  current() { return this.s.phases[this.s.index]; }
  log(type, detail = {}, now = Date.now()) {
    this.s.events.push({type, at: now, elapsed: this.s.startAt === null ? null : this.elapsed(now), ...detail});
  }
  startPreRest(now) {
    if (this.s.mode !== 'setup') return false;
    this.s.mode = 'prerest'; this.s.preStart = now;
    this.log('pre_rest_started', {duration: PRE_REST}, now); return true;
  }
  begin(now, {confirmed = true} = {}) {
    if (this.s.mode !== 'ready') return false;
    this.s.mode = 'running'; this.s.startAt = now; this.s.lastTick = now;
    this.s.phases[0].actualStart = 0; this.s.quality[0].since = 0;
    this.s.recordingStartConfirmed = confirmed;
    this.log(confirmed ? 'recording_start_confirmed' : 'recording_timer_started_for_demo', {}, now); return true;
  }
  temperatureDueAt() {
    const m = this.s.measurements[this.current().round];
    return m.temperaturePromptAt ?? (m.pressedAt === null ? null : m.pressedAt + 10);
  }
  phaseTarget() {
    const p = this.current();
    let target = p.actualStart + p.duration + (p.kind === 'exercise' ? 0 : p.extra);
    if (p.kind === 'quality') target += this.s.quality[p.round].automaticExtraSeconds ?? 0;
    if (p.kind === 'measure') {
      const m = this.s.measurements[p.round];
      if (m.pressedAt !== null) target = Math.max(target, m.pressedAt + 60);
    }
    if (p.kind === 'post') {
      const m = this.s.measurements[p.round];
      if (m.deflatedAt !== null) target = Math.max(target, m.deflatedAt + 30);
    }
    return target;
  }
  validSeconds(now) {
    return this.current().kind === 'quality' ? this.qualityProgress(now).goodSeconds : 0;
  }
  qualityProgress(now) {
    const p = this.current();
    return qualitySummary(this.s.quality[p.round], p, this.elapsed(now), this.s.qualityAutomatic);
  }
  applySignalQuality(result, now) {
    if(!this.s.qualityAutomatic||this.s.mode!=='running'||this.current().kind!=='quality')return;
    const q=this.s.quality[this.current().round],t=this.elapsed(now);
    const previous=q.lastQualityCheck,dt=Number.isFinite(previous)?Math.max(0,t-previous):0;
    const creditEnd=q.automaticExtraSeconds!==null?Math.min(t,this.phaseTarget()):t;
    if(dt>0&&dt<=QUALITY_COLLECTION_RULES.freshnessSeconds&&q.latestQualityOk&&!q.manualUnstable&&!this.s.hold)addGoodSpan(q,previous,creditEnd);
    else if(!Number.isFinite(previous)&&result.ok&&!q.manualUnstable&&!this.s.hold&&t-this.current().actualStart<=QUALITY_COLLECTION_RULES.freshnessSeconds)addGoodSpan(q,this.current().actualStart,creditEnd);
    if(!result.ok||dt>QUALITY_COLLECTION_RULES.freshnessSeconds||q.manualUnstable||this.s.hold)q.currentRunSeconds=0;
    q.automatic=true;q.latestQualityOk=!!result.ok;q.lastQualityCheck=t;q.automaticReason=result.reason;q.automaticStatus=result.status??(result.ok?'pass':'fail');
    if(q.manualUnstable)return;
    if(!result.ok){
      if(q.since!==null||!q.unstable||q.confirmedAt!==null){q.since=null;q.unstable=true;q.confirmedAt=null;this.log('automatic_quality_rejected',{round:this.current().round,reason:result.reason},now);}
    }else if(q.since===null||q.unstable){q.since=t;q.unstable=false;q.confirmedAt=null;this.log('automatic_valid_count_started',{round:this.current().round},now);}
  }
  blockers(now) {
    const p = this.current(), t = this.elapsed(now), reasons = [];
    if (this.s.hold) reasons.push(this.s.hold.reason);
    if (p.kind === 'quality') {
      const q = this.s.quality[p.round];
      const progress = this.qualityProgress(now);
      if (!progress.enough && q.insufficientAcknowledgedAt === null) reasons.push('候选有效时长或完整 20 秒片段不足，请核验采集结果');
      if (q.confirmedAt === null) reasons.push('等待操作者核验累计有效波形');
      if (p.round > 0) {
        const previous = this.s.measurements[p.round - 1];
        if (previous.deflatedAt === null) reasons.push('上次袖带完全放气尚未确认');
        else if (t - previous.deflatedAt < this.s.minBpInterval) reasons.push(`距上次完全放气仍需等待 ${Math.ceil(this.s.minBpInterval - (t - previous.deflatedAt))} 秒`);
      }
    }
    if (p.kind === 'measure') {
      const m = this.s.measurements[p.round];
      if (m.pressedAt === null && m.bpSkippedAt == null) reasons.push('等待确认已按下血压计测量键');
      if (m.deflatedAt === null && m.deflationSkippedAt == null && m.bpSkippedAt == null) reasons.push('等待确认血压测量完成、袖带完全放气');
      if (m.verifiedAt === null && m.temperatureSkippedAt == null) reasons.push('等待额温测量及读数复核');
    }
    return reasons;
  }
  tick(now) {
    if (this.s.mode === 'prerest' && now - this.s.preStart >= PRE_REST * 1000) {
      this.s.mode = 'ready'; this.s.preEnd = now; this.log('pre_rest_completed', {}, now); return 'ready';
    }
    if (this.s.mode !== 'running') return null;
    if (this.s.lastTick !== null && now - this.s.lastTick > 5000 && !this.s.hold) {
      this.hold('attention', '页面离开或计时中断，请核对当前状态后继续', now);
    }
    this.s.lastTick = now;
    const p = this.current(), t = this.elapsed(now);
    if (p.kind === 'quality' && planQualityExtension(this.s.quality[p.round], p, t, this.s.qualityAutomatic)) {
      const q=this.s.quality[p.round];
      this.log('quality_compensation_planned',{round:p.round,seconds:q.automaticExtraSeconds,goodSeconds:this.validSeconds(now),maximumSeconds:QUALITY_COLLECTION_RULES.maxAutomaticExtraSeconds},now);
    }
    if (t + 0.001 < this.phaseTarget() || this.blockers(now).length) return null;
    return this.advance(now);
  }
  advance(now, {skipped = false} = {}) {
    const p = this.current(), t = this.elapsed(now);
    p.actualEnd = t;
    if (skipped) p.skippedAt = t;
    this.log(skipped ? 'phase_skipped' : 'phase_completed', {phase: p.id, actualDuration: t - p.actualStart}, now);
    if (this.s.index === this.s.phases.length - 1) {
      this.s.mode = 'await-finish'; this.log('ready_to_stop_recording', {}, now); return 'await-finish';
    }
    this.s.index += 1;
    const next = this.current(); next.actualStart = t;
    if (next.kind === 'quality') this.s.quality[next.round].since = t;
    this.log('phase_started', {phase: next.id}, now);
    return 'phase';
  }
  skip(now) {
    const s = this.s;
    if (!['prerest', 'ready', 'running', 'await-finish'].includes(s.mode)) return false;
    const p = this.current(), t = this.elapsed(now);
    let step;
    if (s.mode === 'prerest') {
      step = 'pre_rest'; s.preEnd = now;
    } else if (s.mode === 'ready') step = 'recording_start';
    else if (s.mode === 'await-finish') step = 'recording_stop';
    else if (p.kind === 'measure') {
      const m = s.measurements[p.round], due = this.temperatureDueAt();
      if (m.pressedAt === null && m.bpSkippedAt == null) {
        step = 'bp'; m.bpSkippedAt = t; m.temperaturePromptAt = t;
      } else if (m.verifiedAt === null && m.temperatureSkippedAt == null && due !== null && t < due) {
        step = 'temperature_wait'; m.temperaturePromptAt = t;
      } else if (m.verifiedAt === null && m.temperatureSkippedAt == null) {
        step = 'temperature'; m.temperatureSkippedAt = t;
      } else if (m.pressedAt !== null && m.deflatedAt === null && m.deflationSkippedAt == null) {
        step = 'deflation'; m.deflationSkippedAt = t;
      } else step = 'phase';
    } else step = 'phase';
    const skipped = {step, phase: s.mode === 'running' ? p.id : s.mode, at: now, elapsed: s.startAt === null ? null : t};
    if (step === 'pre_rest') skipped.remainingSeconds = Math.max(0, PRE_REST - (now - s.preStart) / 1000);
    else if (step === 'phase') skipped.remainingSeconds = Math.max(0, this.phaseTarget() - t);
    s.skips.push(skipped);
    this.log('step_skipped', {step, phase: skipped.phase, remainingSeconds: skipped.remainingSeconds}, now);
    if (s.hold) { this.log('hold_resolved', {via: 'skip', kind: s.hold.kind}, now); s.hold = null; }
    s.lastTick = now;
    if (step === 'pre_rest') s.mode = 'ready';
    else if (step === 'recording_start') this.begin(now, {confirmed: false});
    else if (step === 'recording_stop') {
      s.mode = 'completed'; s.endAt = now; s.recordingStopConfirmed = false;
    } else if (step === 'phase') this.advance(now, {skipped: true});
    return step;
  }
  extend(seconds, reason, now) {
    if (this.s.mode !== 'running' || this.current().kind === 'exercise' || !Number.isFinite(seconds) || seconds < 1 || seconds > 3600) return false;
    const p = this.current(), overdue = Math.max(0, this.elapsed(now) - this.phaseTarget());
    if(p.kind==='quality'&&this.elapsed(now)>=this.phaseTarget()){this.s.quality[p.round].lastQualityCheck=this.elapsed(now);this.s.quality[p.round].currentRunSeconds=0;}
    p.extra += overdue + seconds;
    this.log('delay_added', {phase: p.id, seconds, reason}, now); return true;
  }
  hold(kind, reason, now) {
    if (this.s.mode !== 'running' || this.s.hold) return false;
    const p = this.current();
    if (['exercise', 'quality'].includes(p.kind) && ['data', 'connection', 'signal', 'quality'].includes(kind)) {
      // Exercise stays fixed; quality phases use their bounded compensation.
      // Faults remain visible and auditable instead of causing an endless hold.
      p.signalWarnings ??= [];
      if (!p.signalWarnings.some(w => w.kind === kind && w.reason === reason)) {
        const warning = {kind, reason, elapsed: this.elapsed(now)};
        p.signalWarnings.push(warning);
        this.log(p.kind==='exercise'?'exercise_signal_warning_no_extension':'quality_signal_warning_compensated', {phase: p.id, ...warning}, now);
      }
      return false;
    }
    this.s.hold = {kind, reason, since: this.elapsed(now)};
    this.log('hold_started', {kind, reason}, now); return true;
  }
  resume(now) {
    if (!this.s.hold) return false;
    const p = this.current(), t = this.elapsed(now), hold = this.s.hold;
    // Keep actual recording time continuous. Never replay or lengthen exercise.
    if (p.kind !== 'exercise') p.extra += Math.max(0, t - Math.max(hold.since, this.phaseTarget()));
    this.log('hold_resolved', {kind: hold.kind, duration: t - hold.since}, now);
    this.s.hold = null; this.s.lastTick = now; return true;
  }
  markUnstable(now) {
    if (this.s.mode !== 'running' || this.current().kind !== 'quality') return false;
    const q = this.s.quality[this.current().round];
    if(!this.s.qualityAutomatic&&q.since!==null)addGoodSpan(q,q.since,this.elapsed(now));
    q.unstable = true; q.since = null; q.confirmedAt = null; q.manualUnstable = true;
    this.log('signal_unstable', {round: this.current().round}, now); return true;
  }
  restartQuality(now) {
    if (this.s.mode !== 'running' || this.current().kind !== 'quality') return false;
    const q = this.s.quality[this.current().round];
    q.unstable = false; q.since = this.elapsed(now); q.confirmedAt = null; q.manualUnstable = false;
    if(this.s.qualityAutomatic){q.latestQualityOk=false;q.lastQualityCheck=this.elapsed(now);q.currentRunSeconds=0;}
    this.log('signal_stable_resume_accumulation', {round: this.current().round,retainedSeconds:this.validSeconds(now)}, now); return true;
  }
  confirmQuality(now, {allowInsufficient = false} = {}) {
    if (this.s.mode !== 'running' || this.current().kind !== 'quality') return false;
    const q = this.s.quality[this.current().round];
    const progress=this.qualityProgress(now);
    if (allowInsufficient && (!progress.extensionPlanned || this.elapsed(now)+.001<this.phaseTarget())) return false;
    if (!progress.enough && !allowInsufficient) return false;
    if (q.confirmedAt !== null) return false;
    if(!progress.enough)q.insufficientAcknowledgedAt=this.elapsed(now);
    q.outcome=progress.enough?'screened_enough':'insufficient';
    q.summaryOnConfirm=progress;
    q.confirmedAt = this.elapsed(now); this.log(progress.enough?'cumulative_quality_manually_verified':'quality_insufficient_acknowledged', {round:this.current().round,...progress}, now); return true;
  }
  pressBp(now, confirmedNow = now) {
    const p = this.current(), m = this.s.measurements[p.round];
    if (this.s.mode !== 'running' || p.kind !== 'measure' || m.pressedAt !== null || this.s.hold) return false;
    m.pressedAt = this.elapsed(now); m.pressConfirmedAt = this.elapsed(confirmedNow);
    this.log('bp_key_press_confirmed', {round: p.round, pressedAt: m.pressedAt}, confirmedNow); return true;
  }
  deflate(now) {
    const p = this.current(), m = this.s.measurements[p.round];
    if (this.s.mode !== 'running' || p.kind !== 'measure' || m.pressedAt === null || m.deflatedAt !== null) return false;
    m.deflatedAt = this.elapsed(now); this.log('bp_finished_and_fully_deflated', {round: p.round}, now); return true;
  }
  confirmTemperature(value, measuredAt, now) {
    const p = this.current(), m = this.s.measurements[p.round];
    const due = p.kind === 'measure' ? this.temperatureDueAt() : null;
    if (this.s.mode !== 'running' || p.kind !== 'measure' || due === null || measuredAt < due || m.verifiedAt !== null || m.temperatureSkippedAt != null || !Number.isFinite(value) || value < 25 || value > 45) return false;
    m.temperature = value; m.temperatureAt = measuredAt; m.verifiedAt = this.elapsed(now);
    this.log('temperature_measured_and_verified', {round: p.round, value, measuredAt}, now); return true;
  }
  finish(now) {
    if (this.s.mode !== 'await-finish' || !this.s.recovered) return false;
    this.s.mode = 'completed'; this.s.endAt = now; this.s.recordingStopConfirmed = true;
    this.log('recording_stopped_by_operator', {}, now); return true;
  }
  abort(reason, now) {
    if (!['running', 'await-finish', 'prerest', 'ready'].includes(this.s.mode)) return false;
    this.s.endAt = now; this.s.mode = 'aborted'; this.log('protocol_terminated', {reason}, now); return true;
  }
  schedule(now) {
    let cursor = 0;
    const active = ['running', 'await-finish', 'completed', 'aborted'].includes(this.s.mode);
    return this.s.phases.map((p, i) => {
      const start = p.actualStart ?? cursor;
      let end = p.actualEnd ?? (start + p.duration + (p.kind === 'exercise' ? 0 : p.extra));
      if (active && i === this.s.index && p.actualEnd === null) {
        end = Math.max(end, this.phaseTarget(), this.elapsed(now));
        if (p.kind === 'quality') {
          const q = this.s.quality[p.round];
          end = Math.max(end, start + p.duration + p.extra + (q.automaticExtraSeconds ?? 0));
          if (p.round > 0) {
            const last = this.s.measurements[p.round - 1].deflatedAt;
            if (last !== null) end = Math.max(end, last + this.s.minBpInterval);
          }
        }
      }
      cursor = end; return {...p, start, end};
    });
  }
  report(now = Date.now()) {
    const s = this.s;
    return {
      protocol: 'ECG 与 PPG 血压预测采集流程', version: s.version,
      subjectCode: s.subject, subjectName: s.subjectName || '', operator: s.operator, status: s.mode,
      startedAt: s.startAt === null ? null : new Date(s.startAt).toISOString(),
      endedAt: s.endAt === null ? null : new Date(s.endAt).toISOString(),
      recordingSeconds: this.elapsed(now), preRestSeconds: PRE_REST,
      preRestActualSeconds: s.preStart != null && s.preEnd != null ? (s.preEnd - s.preStart) / 1000 : null,
      recordingStartConfirmed: s.recordingStartConfirmed ?? null,
      recordingStopConfirmed: s.recordingStopConfirmed ?? null,
      hasSkippedSteps: s.skips.length > 0, skippedSteps: s.skips,
      rawSessionId: s.rawSessionId ?? null, qualityAutomatic: s.qualityAutomatic,
      exerciseSignalPolicy: {qualityAction: 'mark_and_save', extendOnPoorQuality: false, extendOnDataLoss: false},
      qualityCollectionPolicy: QUALITY_COLLECTION_RULES,
      qualityWindowSummary: s.phases.filter(p=>p.kind==='quality'&&p.actualStart!==null).map(p=>({round:p.round,phase:p.id,...qualitySummary(s.quality[p.round],p,p.actualEnd??this.elapsed(now),s.qualityAutomatic)})),
      minimumBpIntervalSeconds: s.minBpInterval,
      prechecks: s.prechecks, measurements: s.measurements,
      validWaveformManualChecks: s.quality, phases: this.schedule(now),
      finalChecks: s.finalChecks, completedVerification: s.completedVerification,
      notes: s.notes, events: s.events,
      scope: s.qualityAutomatic ? '保存全部原始数据；静止阶段累计 80 秒通过工程初筛的时长并要求至少一个连续 20 秒片段；按缺口一次追加，自动追加最多 40 秒，不清零累计。仍不足时须人工选择补采或带不足标记继续。分散片段不拼接为连续 80 秒历史；离线还须按模型逐窗验证。血压结果以血压计保存记录为准。' : '网页记录计时及人工操作；自动质量初筛未启用，血压结果以血压计保存记录为准。',
    };
  }
}
