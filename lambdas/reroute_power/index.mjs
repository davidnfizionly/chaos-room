// Remediation action: reroute the power bus load to the backup feed.
// Escalation scenario: when INJECT#power.actuator_stuck is set, the transfer switch reports
// it did not change over, and the action fails instead of claiming success.

import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

const iot = new IoTDataPlaneClient({ endpoint: `https://${process.env.IOT_ENDPOINT}` });
const ddb = new DynamoDBClient({});

export const handler = async ({ incident_id }) => {
  const started_ms = Date.now();

  const inject = await ddb.send(new GetItemCommand({
    TableName: process.env.STATE_TABLE,
    Key: { id: { S: 'INJECT#power' } },
    ConsistentRead: true,
  }));
  if (inject.Item?.actuator_stuck?.BOOL) {
    const err = new Error('Transfer switch feedback: still on primary feed after reroute command');
    err.name = 'TransferSwitchFailed';
    throw err;
  }

  await iot.send(new PublishCommand({
    topic: process.env.COMMAND_TOPIC,
    qos: 1,
    payload: Buffer.from(JSON.stringify({ action: 'remediate', step: 'reroute_power', incident_id })),
  }));

  const finished_ms = Date.now();
  return { action: 'reroute_power', target: 'power', result: 'load moved to backup feed', started_ms, finished_ms, duration_ms: finished_ms - started_ms };
};
