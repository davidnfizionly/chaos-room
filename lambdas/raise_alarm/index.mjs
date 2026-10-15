// Escalation action: sound the plant alarm after a remediation action failed.

import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';

const iot = new IoTDataPlaneClient({ endpoint: `https://${process.env.IOT_ENDPOINT}` });

export const handler = async ({ incident_id, component }) => {
  const started_ms = Date.now();

  await iot.send(new PublishCommand({
    topic: process.env.COMMAND_TOPIC,
    qos: 1,
    payload: Buffer.from(JSON.stringify({ action: 'raise_alarm', source_component: component, incident_id })),
  }));

  const finished_ms = Date.now();
  return { action: 'raise_alarm', target: 'alarm', result: `siren on (source: ${component})`, started_ms, finished_ms, duration_ms: finished_ms - started_ms };
};
