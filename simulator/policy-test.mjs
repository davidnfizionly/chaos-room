// Negative tests for the IoT device policy, using the cooling unit's certificate.
// AWS IoT Core answers an unauthorized CONNECT with a refusal and an unauthorized
// PUBLISH by closing the connection, so each case checks which of those happens.

import mqtt from 'mqtt';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ENDPOINT = process.env.IOT_ENDPOINT;
const CERT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'certs');
const creds = {
  key: readFileSync(join(CERT_DIR, 'cooling.key.pem')),
  cert: readFileSync(join(CERT_DIR, 'cooling.cert.pem')),
};

function attempt(name, clientId, topic, expectAllowed) {
  return new Promise((resolve) => {
    const client = mqtt.connect({ host: ENDPOINT, port: 8883, protocol: 'mqtts', clientId, ...creds, reconnectPeriod: 0, connectTimeout: 5000 });
    let connected = false;
    let done = false;
    const finish = (outcome) => {
      if (done) return;
      done = true;
      client.end(true);
      const pass = (outcome === 'publish accepted') === expectAllowed;
      console.log(`${pass ? 'PASS' : 'FAIL'} | ${name} | clientId=${clientId} topic=${topic} | ${outcome}`);
      resolve(pass);
    };
    const closed = (reason) => finish(connected ? `publish rejected (${reason})` : `connect refused (${reason})`);
    client.on('connect', () => {
      connected = true;
      // QoS 1: the broker sends PUBACK only if the publish is authorized.
      client.publish(topic, JSON.stringify({ policy_test: true, ts: Date.now() }), { qos: 1 }, (err) => {
        if (err) closed(err.message);
        else finish('publish accepted');
      });
    });
    client.on('error', (err) => closed(err.message));
    client.on('close', () => closed('connection closed by broker'));
    setTimeout(() => closed('timeout'), 6000);
  });
}

const results = [];
// Distinct client ID suffixes are not allowed by the policy, so the positive case reuses the
// thing name; it briefly takes over the running simulator's session, which then reconnects.
results.push(await attempt('own identity, own topic', 'chaos-room-cooling-unit', 'chaos-room/telemetry/cooling', true));
results.push(await attempt('own identity, other device topic', 'chaos-room-cooling-unit', 'chaos-room/telemetry/power', false));
results.push(await attempt('impersonate other thing', 'chaos-room-power-bus', 'chaos-room/telemetry/power', false));
results.push(await attempt('publish on command topic', 'chaos-room-cooling-unit', 'chaos-room/cmd/cooling', false));
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
