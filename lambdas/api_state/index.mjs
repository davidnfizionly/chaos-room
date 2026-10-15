// GET /state - read model for the dashboard, polled every second.
// Returns the latest telemetry per component (mirrored by the chaos_room_live_state IoT rule),
// open locks / escalations, and the most recent incident log events.

import { DynamoDBClient, QueryCommand, ScanCommand } from '@aws-sdk/client-dynamodb';
import { timingSafeEqual } from 'node:crypto';

const ddb = new DynamoDBClient({});
const EVENT_LIMIT = 60;
const OFFLINE_AFTER_MS = 5000;

// Same thresholds as the IoT rules (infra/stack/stepfunctions.tf, local.workflows).
const IN_FAULT = {
  cooling: (r) => r.temp_c > 80,
  power: (r) => r.load_pct > 100 || r.voltage_v < 207,
};

const authorized = (headers) => {
  const given = Buffer.from(headers?.['x-api-key'] ?? '');
  const expected = Buffer.from(process.env.API_KEY);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });

// Minimal DynamoDB attribute decoding for the flat items this project stores.
const decode = (item) => Object.fromEntries(Object.entries(item).map(([k, v]) => [k, 'N' in v ? Number(v.N) : 'BOOL' in v ? v.BOOL : v.S]));

export const handler = async (event) => {
  if (!authorized(event.headers)) return json(401, { error: 'missing or invalid x-api-key' });

  const now = Date.now();
  const [state, log] = await Promise.all([
    ddb.send(new ScanCommand({ TableName: process.env.STATE_TABLE, ConsistentRead: true })),
    ddb.send(new QueryCommand({
      TableName: process.env.LOG_TABLE,
      KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': { S: 'EVENTS' } },
      ScanIndexForward: false,
      Limit: EVENT_LIMIT,
    })),
  ]);

  const items = state.Items.map(decode);
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  const events = log.Items.map(decode).map(({ pk, sk, detail, ...e }) => ({ ...e, detail: JSON.parse(detail) }));
  const escalated = new Set(events.filter((e) => e.event === 'ESCALATED').map((e) => e.incident_id));

  const components = {};
  for (const component of ['cooling', 'power', 'alarm']) {
    const live = byId[`LIVE#${component}`] ?? null;
    // A lock without reopen_after is an open incident: either its workflow is still running,
    // or it escalated and the lock is kept until a manual reset.
    const lock = byId[`LOCK#${component}`] ?? null;
    const openIncident = lock && lock.reopen_after == null ? lock.incident_id : null;
    let status = 'OFFLINE';
    if (live && now - live.ingest_ts < OFFLINE_AFTER_MS) {
      if (component === 'alarm') status = live.lockdown ? 'LOCKDOWN' : live.siren === 'on' ? 'ALARM' : 'QUIET';
      else if (openIncident) status = escalated.has(openIncident) ? 'LOCKED_OUT' : 'FIXING';
      // Within the settle window, a faulty reading was sent before the fix reached the device.
      else if (IN_FAULT[component](live)) status = lock && now < lock.reopen_after ? 'FIXING' : 'FAULT';
      else status = 'HEALTHY';
    }
    const { id, ...reading } = live ?? {};
    components[component] = {
      status,
      reading: live ? reading : null,
      open_incident: openIncident,
      fail_next_fix: Boolean(byId[`INJECT#${component}`]?.actuator_stuck),
    };
  }

  return json(200, { now, components, events });
};
