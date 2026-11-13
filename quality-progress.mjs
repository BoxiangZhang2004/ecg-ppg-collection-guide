// Acquisition timing targets, based on the current model's 20-second windows.
// These counters describe the browser screen, not offline model validation.
export const QUALITY_COLLECTION_RULES = Object.freeze({
  version: 'cumulative-20s-20261113-v1', targetGoodSeconds: 80,
  modelWindowSeconds: 20, maxAutomaticExtraSeconds: 40, freshnessSeconds: 1,
});
export function initializeQuality(q, phase, events = []) {
  if (q.collectionVersion === QUALITY_COLLECTION_RULES.version) return q;
  const spans = [];
  let start = null;
  for (const event of events) {
    if (event.round !== phase.round || !Number.isFinite(event.elapsed)) continue;
    if (event.type === 'automatic_valid_count_started') start = event.elapsed;
    if (['automatic_quality_rejected', 'signal_unstable'].includes(event.type) && start !== null) {
      if (event.elapsed > start) spans.push([start, event.elapsed]);
      start = null;
    }
  }
  if (q.latestQualityOk && !q.manualUnstable && Number.isFinite(q.since) && Number.isFinite(q.lastQualityCheck) && q.lastQualityCheck > q.since) {
    const left = start ?? q.since;
    if (q.lastQualityCheck > left) spans.push([left, q.lastQualityCheck]);
  }
  Object.assign(q, {collectionVersion: QUALITY_COLLECTION_RULES.version, goodSpans: spans,
    acceptedSeconds: spans.reduce((n, [a, b]) => n + b - a, 0),
    automaticExtraSeconds: null, extensionPlannedAt: null, insufficientAcknowledgedAt: null,
    currentRunSeconds: q.latestQualityOk && spans.length ? spans.at(-1)[1] - spans.at(-1)[0] : 0,
    longestRunSeconds: Math.max(0, ...spans.map(([a, b]) => b - a)),
  });
  // Preserve existing recordings and their clock when upgrading the page.
  return q;
}
export function addGoodSpan(q, from, to) {
  if (!(to > from)) return;
  const last = q.goodSpans.at(-1);
  if (last && Math.abs(last[1] - from) < .001) last[1] = to;
  else q.goodSpans.push([from, to]);
  q.acceptedSeconds += to - from;
  q.currentRunSeconds = q.goodSpans.at(-1)[1] - q.goodSpans.at(-1)[0];
  q.longestRunSeconds = Math.max(q.longestRunSeconds, q.currentRunSeconds);
}
export function qualitySummary(q, phase, elapsed, automatic) {
  const live = !automatic && !q.manualUnstable && Number.isFinite(q.since) ? Math.max(0, elapsed - q.since) : 0;
  const good = q.acceptedSeconds + live;
  const longest = Math.max(q.longestRunSeconds, live);
  const windows = q.goodSpans.reduce((n, [a, b]) => n + Math.floor((b - a + .001) / QUALITY_COLLECTION_RULES.modelWindowSeconds), 0)
    + Math.floor((live + .001) / QUALITY_COLLECTION_RULES.modelWindowSeconds);
  const enough = good + .001 >= QUALITY_COLLECTION_RULES.targetGoodSeconds && longest + .001 >= QUALITY_COLLECTION_RULES.modelWindowSeconds && !q.manualUnstable;
  return {goodSeconds: good, longestGoodRunSeconds: longest, complete20sWindows: windows,
    full80sHistoryAvailable: longest + .001 >= 80, enough,
    automaticExtraSeconds: q.automaticExtraSeconds ?? 0,
    extensionPlanned: q.automaticExtraSeconds !== null,
    deadline: phase.actualStart + phase.duration + phase.extra + (q.automaticExtraSeconds ?? 0),
  };
}
export function planQualityExtension(q, phase, elapsed, automatic) {
  if (q.automaticExtraSeconds !== null || elapsed + .001 < phase.actualStart + phase.duration + phase.extra) return false;
  const progress = qualitySummary(q, phase, elapsed, automatic);
  const deficit = Math.max(0, QUALITY_COLLECTION_RULES.targetGoodSeconds - progress.goodSeconds);
  const run = automatic ? q.currentRunSeconds : (!q.manualUnstable && Number.isFinite(q.since) ? elapsed - q.since : 0);
  const needWindow = progress.longestGoodRunSeconds + .001 >= QUALITY_COLLECTION_RULES.modelWindowSeconds ? 0 : Math.max(0, QUALITY_COLLECTION_RULES.modelWindowSeconds - run);
  q.automaticExtraSeconds = Math.min(QUALITY_COLLECTION_RULES.maxAutomaticExtraSeconds, Math.ceil(Math.max(0, deficit - .001, needWindow - .001)));
  q.extensionPlannedAt = elapsed;
  return true;
}
