// POST /sabotage {components: ["cooling"|"power", ...], fail_fix?: boolean}
//   The "Lambda-driven" sabotage trigger (ADR 004): publishes a sabotage command to each
//   device's command topic. fail_fix=true first sets the failure injection flag, so the
//   remediation action reports a stuck actuator and the workflow escalates.
// POST /reset
//   Returns devices to baseline, clears alarm/lockdown, then removes locks and injections.

import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';
import { DynamoDBClient, DeleteItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { timingSafeEqual } from 'node:crypto';

const iot = new IoTDataPlaneClient({ endpoint: `https://${process.env.IOT_ENDPOINT}` });
const ddb = new DynamoDBClient({});
const REMEDIABLE = ['cooling', 'power'];
const TABLE = process.env.STATE_TABLE;

const authorized = (headers) => {
  const given = Buffer.from(headers?.['x-api-key'] ?? '');
  const expected = Buffer.from(process.env.API_KEY);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const command = (component, body) =>
  iot.send(new PublishCommand({ topic: `chaos-room/cmd/${component}`, qos: 1, payload: Buffer.from(JSON.stringify(body)) }));

async function sabotage(body) {
  const components = body.components ?? (body.component ? [body.component] : []);
  if (!components.length || !components.every((c) => REMEDIABLE.includes(c))) {
    return json(400, { error: `components must be a non-empty subset of ${REMEDIABLE.join(', ')}` });
  }
  if (body.fail_fix) {
    await Promise.all(components.map((c) => ddb.send(new PutItemCommand({
      TableName: TABLE,
      Item: { id: { S: `INJECT#${c}` }, actuator_stuck: { BOOL: true } },
    }))));
  }
  const sent_at = Date.now();
  await Promise.all(components.map((c) => command(c, { action: 'sabotage' })));
  return json(202, { sabotaged: components, fail_fix: Boolean(body.fail_fix), sent_at });
}

async function reset() {
  await Promise.all(['cooling', 'power', 'alarm'].map((c) => command(c, { action: 'reset' })));
  // Let in-flight faulty telemetry drain before the locks are removed.
  await new Promise((r) => setTimeout(r, 2000));
  const ids = REMEDIABLE.flatMap((c) => [`LOCK#${c}`, `INJECT#${c}`]);
  await Promise.all(ids.map((id) => ddb.send(new DeleteItemCommand({ TableName: TABLE, Key: { id: { S: id } } }))));
  return json(200, { reset: true });
}

export const handler = async (event) => {
  if (!authorized(event.headers)) return json(401, { error: 'missing or invalid x-api-key' });

  let body = {};
  try {
    body = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) : {};
  } catch {
    return json(400, { error: 'body must be JSON' });
  }

  if (event.routeKey === 'POST /sabotage') return sabotage(body);
  if (event.routeKey === 'POST /reset') return reset();
  return json(404, { error: 'not found' });
};
