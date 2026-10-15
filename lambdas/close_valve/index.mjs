// Remediation action: close the cooling loop isolation valve on the cooling unit.
// Escalation scenario: when INJECT#cooling.actuator_stuck is set, the valve's position
// feedback reports it is still open, and the action fails instead of claiming success.

import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

const iot = new IoTDataPlaneClient({ endpoint: `https://${process.env.IOT_ENDPOINT}` });
const ddb = new DynamoDBClient({});

export const handler = async ({ incident_id }) => {
  const started_ms = Date.now();

  const inject = await ddb.send(new GetItemCommand({
    TableName: process.env.STATE_TABLE,
    Key: { id: { S: 'INJECT#cooling' } },
    ConsistentRead: true,
  }));
  if (inject.Item?.actuator_stuck?.BOOL) {
    const err = new Error('Valve position feedback: still OPEN after close command');
    err.name = 'ValveDidNotClose';
    throw err;
  }

  await iot.send(new PublishCommand({
    topic: process.env.COMMAND_TOPIC,
    qos: 1,
    payload: Buffer.from(JSON.stringify({ action: 'remediate', step: 'close_valve', incident_id })),
  }));

  const finished_ms = Date.now();
  return { action: 'close_valve', target: 'cooling', result: 'valve closed', started_ms, finished_ms, duration_ms: finished_ms - started_ms };
};
