// Escalation action: engage plant lockdown through the alarm system after a remediation
// action failed. Lockdown stays engaged until a manual reset.

import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';

const iot = new IoTDataPlaneClient({ endpoint: `https://${process.env.IOT_ENDPOINT}` });

export const handler = async ({ incident_id, component }) => {
  const started_ms = Date.now();

  await iot.send(new PublishCommand({
    topic: process.env.COMMAND_TOPIC,
    qos: 1,
    payload: Buffer.from(JSON.stringify({ action: 'lockdown', source_component: component, incident_id })),
  }));

  const finished_ms = Date.now();
  return { action: 'lockdown', target: 'alarm', result: `lockdown engaged (source: ${component})`, started_ms, finished_ms, duration_ms: finished_ms - started_ms };
};
