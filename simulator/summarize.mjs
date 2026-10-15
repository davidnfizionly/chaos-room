// Summarizes measurements.jsonl (written by `scenario.mjs measure`): min / median / max per
// scenario and metric, plus checks (one incident per sabotage, overlap, escalation errors).
// Usage: node summarize.mjs [measurements.jsonl]

import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? new URL('./measurements.jsonl', import.meta.url).pathname;
const rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

// A handler time above this means the call landed on a fresh Lambda container: the first
// call pays for SDK client and TLS connection setup inside the handler (~500-650 ms observed).
const FRESH_CONTAINER_MS = 300;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const stat = (label, xs) => {
  const v = xs.filter((x) => x != null);
  if (!v.length) return `  ${label.padEnd(46)} n=0`;
  return `  ${label.padEnd(46)} n=${String(v.length).padStart(2)}  min=${String(Math.min(...v)).padStart(5)}  median=${String(median(v)).padStart(5)}  max=${String(Math.max(...v)).padStart(5)} ms`;
};
const under = (xs, limit) => `${xs.filter((x) => x != null && x < limit).length}/${xs.filter((x) => x != null).length}`;

function remediationBlock(title, ms) {
  console.log(`\n${title} (${ms.length} incidents)`);
  console.log(stat('device clock: fault published -> fix received', ms.map((m) => m.device_fault_to_command_ms)));
  console.log(stat('AWS: ingest -> workflow started', ms.map((m) => m.ingest_to_workflow_start_ms)));
  console.log(stat('AWS: ingest -> remediation action done', ms.map((m) => m.ingest_to_action_done_ms)));
  console.log(stat('AWS: ingest -> incident resolved', ms.map((m) => m.ingest_to_resolved_ms)));
  console.log(stat('remediation Lambda handler', ms.map((m) => m.action_lambda_ms)));
  console.log(`  sub-second, device clock: ${under(ms.map((m) => m.device_fault_to_command_ms), 1000)}   sub-second, AWS ingest -> action done: ${under(ms.map((m) => m.ingest_to_action_done_ms), 1000)}`);
  const warm = ms.filter((m) => m.action_lambda_ms <= FRESH_CONTAINER_MS);
  const fresh = ms.filter((m) => m.action_lambda_ms > FRESH_CONTAINER_MS);
  console.log(`  warm Lambda (handler <= ${FRESH_CONTAINER_MS} ms): ${warm.length}   fresh container (handler > ${FRESH_CONTAINER_MS} ms): ${fresh.length}`);
  if (warm.length && fresh.length) {
    console.log(stat('  warm only: device clock fault -> fix', warm.map((m) => m.device_fault_to_command_ms)));
    console.log(stat('  fresh only: device clock fault -> fix', fresh.map((m) => m.device_fault_to_command_ms)));
  }
  const bad = ms.filter((m) => m.incidents_opened !== 1);
  console.log(`  exactly one incident per sabotage: ${ms.length - bad.length}/${ms.length}${bad.length ? `  (exceptions: ${bad.map((m) => `${m.incident_id}=${m.incidents_opened}`).join(', ')})` : ''}`);
}

const single = rows.filter((r) => r.scenario === 'single');
for (const c of ['cooling', 'power']) {
  const ms = single.filter((r) => r.component === c);
  if (ms.length) remediationBlock(`SINGLE SABOTAGE - ${c}`, ms);
}
if (single.length) remediationBlock('SINGLE SABOTAGE - both components combined', single);

const conc = rows.filter((r) => r.scenario === 'concurrent');
if (conc.length) {
  remediationBlock(`CONCURRENT INCIDENTS - ${conc.length} runs, 2 sabotages each`, conc.flatMap((r) => r.incidents));
  console.log(stat('logged execution windows overlap', conc.map((r) => r.overlap_ms)));
  console.log(`  runs where both executions overlapped in time: ${conc.filter((r) => r.overlap_ms > 0).length}/${conc.length}`);
  console.log(`  runs with two distinct incident ids: ${conc.filter((r) => new Set(r.incidents.map((i) => i.incident_id)).size === 2).length}/${conc.length}`);
}

const esc = rows.filter((r) => r.scenario === 'escalation');
if (esc.length) {
  console.log(`\nREMEDIATION FAILURE / ESCALATION (${esc.length} incidents)`);
  console.log(stat('AWS: ingest -> workflow started', esc.map((m) => m.ingest_to_workflow_start_ms)));
  console.log(stat('AWS: ingest -> escalated (alarm + lockdown)', esc.map((m) => m.ingest_to_escalated_ms)));
  const path = esc.filter((m) => ['ACTION_FAILED', 'ALARM_RAISED', 'LOCKDOWN_ENGAGED', 'ESCALATED'].every((e) => m.events.includes(e)) && !m.events.includes('RESOLVED'));
  console.log(`  full escalation path logged, never RESOLVED: ${path.length}/${esc.length}`);
  console.log(`  errors reported by the action: ${[...new Set(esc.map((m) => m.action_error))].join(', ')}`);
  console.log(`  exactly one incident per sabotage: ${esc.filter((m) => m.incidents_opened === 1).length}/${esc.length}`);
}
