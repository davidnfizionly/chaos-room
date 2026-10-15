// CLI driver for the demo scenarios. Injects faults through the same MQTT command topics the
// dashboard uses, then reads the resulting incidents back from the DynamoDB incident log.
//
//   node scenario.mjs reset
//   node scenario.mjs single <cooling|power>
//   node scenario.mjs concurrent
//   node scenario.mjs escalation <cooling|power>
//
// Needs the simulator running (npm start), AWS credentials, and IOT_ENDPOINT (npm run scenario).

import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';
import { DynamoDBClient, DeleteItemCommand, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const LOG_TABLE = 'chaos-room-incident-log';
const STATE_TABLE = 'chaos-room-state';
const LATENCY_LOG = process.env.LATENCY_LOG ?? join(dirname(fileURLToPath(import.meta.url)), 'latency.jsonl');
const REMEDIABLE = ['cooling', 'power'];

const iot = new IoTDataPlaneClient({ endpoint: `https://${process.env.IOT_ENDPOINT}` });
const ddb = new DynamoDBClient({});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const command = (component, body) =>
  iot.send(new PublishCommand({ topic: `chaos-room/cmd/${component}`, qos: 1, payload: Buffer.from(JSON.stringify(body)) }));

async function reset() {
  await Promise.all(['cooling', 'power', 'alarm'].map((c) => command(c, { action: 'reset' })));
  // Let in-flight faulty telemetry drain before the locks are removed.
  await pause(2000);
  const ids = REMEDIABLE.flatMap((c) => [`LOCK#${c}`, `INJECT#${c}`]);
  await Promise.all(ids.map((id) => ddb.send(new DeleteItemCommand({ TableName: STATE_TABLE, Key: { id: { S: id } } }))));
  console.log('reset: devices back to baseline, alarm cleared, locks and failure injections removed');
}

async function eventsSince(sinceMs) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: LOG_TABLE,
      KeyConditionExpression: 'pk = :p AND sk > :s',
      ExpressionAttributeValues: { ':p': { S: 'EVENTS' }, ':s': { S: String(sinceMs) } },
      ConsistentRead: true,
      ExclusiveStartKey,
    }));
    items.push(...r.Items);
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items.map((i) => ({
    incident_id: i.incident_id.S,
    component: i.component.S,
    event: i.event.S,
    at_ms: Number(i.at_ms.N),
    detail: JSON.parse(i.detail.S),
  }));
}

function groupIncidents(events) {
  const byId = new Map();
  for (const e of events) {
    if (!byId.has(e.incident_id)) byId.set(e.incident_id, { incident_id: e.incident_id, component: e.component, events: [] });
    byId.get(e.incident_id).events.push(e);
  }
  return [...byId.values()];
}

async function waitForIncidents(components, finalEvent, sinceMs, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const incidents = groupIncidents(await eventsSince(sinceMs));
    const done = components.map((c) => incidents.find((i) => i.component === c && i.events.some((e) => e.event === finalEvent)));
    if (done.every(Boolean)) return { done, all: incidents };
    await pause(300);
  }
  throw new Error(`timeout waiting for ${finalEvent} on ${components.join(', ')}`);
}

function deviceLatency(incidentId) {
  if (!existsSync(LATENCY_LOG)) return null;
  const lines = readFileSync(LATENCY_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return lines.find((l) => l.incident_id === incidentId) ?? null;
}

function printIncident(incident) {
  const detected = incident.events.find((e) => e.event === 'DETECTED');
  const ingest = detected.detail.ingest_ts;
  console.log(`\nIncident ${incident.incident_id} (${incident.component}, ${detected.detail.fault_type})`);
  console.log(`  reading: ${JSON.stringify(detected.detail)}`);
  console.log('  timeline (ms after IoT Core ingested the faulty reading, AWS clocks):');
  for (const e of incident.events) {
    const d = e.detail;
    const info = d.action ? `${d.action}${d.duration_ms != null ? ` (lambda ${d.duration_ms} ms)` : ''}${d.error ? ` ${d.error}: ${d.cause}` : ''}${d.result ? ` -> ${d.result}` : ''}`
      : d.message ?? (e.event === 'DETECTED' ? `rule matched, execution started ${d.execution_started}` : JSON.stringify(d));
    console.log(`    +${String(e.at_ms - ingest).padStart(5)} ms  ${e.event.padEnd(17)} ${info}`);
  }
  const action = incident.events.find((e) => e.event === 'REMEDIATED');
  if (action) console.log(`  AWS side: ingest -> remediation action done = ${action.detail.finished_ms - ingest} ms`);
  return detected;
}

async function printDeviceLatency(incidentId) {
  for (let i = 0; i < 10; i++) {
    const l = deviceLatency(incidentId);
    if (l) return console.log(`  Device clock (${l.component}): fault published -> remediation command received = ${l.latency_ms} ms`);
    await pause(200);
  }
  console.log('  Device clock: no latency record found (is the simulator running?)');
}

async function countIncidentsAfterSettle(sinceMs, component) {
  await pause(3000);
  const n = groupIncidents(await eventsSince(sinceMs)).filter((i) => i.component === component).length;
  console.log(`  Incidents opened for ${component} in this run (3 s after resolution): ${n}${n === 1 ? ' (repeated fault readings deduplicated)' : ''}`);
}

async function single(component) {
  await reset();
  const since = Date.now() - 1000;
  await command(component, { action: 'sabotage' });
  console.log(`sabotage sent to ${component}`);
  const { done } = await waitForIncidents([component], 'RESOLVED', since);
  printIncident(done[0]);
  await printDeviceLatency(done[0].incident_id);
  await countIncidentsAfterSettle(since, component);
}

async function concurrent() {
  await reset();
  const since = Date.now() - 1000;
  await Promise.all(REMEDIABLE.map((c) => command(c, { action: 'sabotage' })));
  console.log(`sabotage sent to ${REMEDIABLE.join(' and ')} at the same time`);
  const { done } = await waitForIncidents(REMEDIABLE, 'RESOLVED', since);
  const spans = done.map((i) => {
    printIncident(i);
    return { id: i.incident_id, start: Math.min(...i.events.map((e) => e.at_ms)), end: Math.max(...i.events.map((e) => e.at_ms)) };
  });
  for (const i of done) await printDeviceLatency(i.incident_id);
  const overlap = Math.min(spans[0].end, spans[1].end) - Math.max(spans[0].start, spans[1].start);
  console.log(`\nConcurrency: ${done.length} independent executions, ${done.map((i) => i.incident_id).join(' / ')}`);
  console.log(`  logged windows overlap by ${overlap} ms (${overlap > 0 ? 'ran concurrently' : 'did not overlap'})`);
  for (const c of REMEDIABLE) await countIncidentsAfterSettle(since, c);
}

async function escalation(component) {
  await reset();
  await ddb.send(new PutItemCommand({ TableName: STATE_TABLE, Item: { id: { S: `INJECT#${component}` }, actuator_stuck: { BOOL: true } } }));
  console.log(`failure injection set: INJECT#${component}.actuator_stuck = true`);
  const since = Date.now() - 1000;
  await command(component, { action: 'sabotage' });
  console.log(`sabotage sent to ${component}`);
  const { done } = await waitForIncidents([component], 'ESCALATED', since);
  printIncident(done[0]);
  await countIncidentsAfterSettle(since, component);
  console.log('  Component lock is kept and the device stays faulty until `node scenario.mjs reset`.');
}

const [scenario, arg] = process.argv.slice(2);
const needsComponent = (c) => {
  if (!REMEDIABLE.includes(c)) throw new Error(`component must be one of ${REMEDIABLE.join(', ')}`);
  return c;
};

try {
  if (scenario === 'reset') await reset();
  else if (scenario === 'single') await single(needsComponent(arg));
  else if (scenario === 'concurrent') await concurrent();
  else if (scenario === 'escalation') await escalation(needsComponent(arg));
  else throw new Error('usage: node scenario.mjs reset | single <cooling|power> | concurrent | escalation <cooling|power>');
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
}
