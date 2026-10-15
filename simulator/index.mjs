// Simulated control room devices. Each component connects to AWS IoT Core as its own
// registered thing (mTLS, X.509 cert), publishes telemetry every second, and listens on
// its own command topic for sabotage / reset commands.
//
// Telemetry never self-reports a fault: detection must come from the values alone.

import mqtt from 'mqtt';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ENDPOINT = process.env.IOT_ENDPOINT;
const INTERVAL_MS = Number(process.env.TELEMETRY_INTERVAL_MS ?? 1000);
const CERT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'certs');

if (!ENDPOINT) {
  console.error('IOT_ENDPOINT is not set (use `npm start`)');
  process.exit(1);
}

const jitter = (base, amp, digits = 2) => +(base + (Math.random() * 2 - 1) * amp).toFixed(digits);

const COMPONENTS = {
  cooling: {
    thing: 'chaos-room-cooling-unit',
    baseline: () => ({ temp_c: jitter(22, 0.4), coolant_flow_lpm: jitter(40, 0.8), pump_rpm: Math.round(jitter(1450, 10)) }),
    faults: {
      overheat: () => ({ temp_c: jitter(92, 1.5), coolant_flow_lpm: jitter(6, 1), pump_rpm: Math.round(jitter(1450, 10)) }),
    },
  },
  power: {
    thing: 'chaos-room-power-bus',
    baseline: () => ({ voltage_v: jitter(230, 1), load_pct: jitter(55, 3), frequency_hz: jitter(50, 0.02, 3) }),
    faults: {
      overload: () => ({ voltage_v: jitter(196, 2), load_pct: jitter(108, 2), frequency_hz: jitter(49.6, 0.05, 3) }),
    },
  },
  alarm: {
    thing: 'chaos-room-alarm-system',
    baseline: () => ({ armed: true, siren: 'off', lockdown: false, panel_ok: true, battery_pct: 98 }),
    faults: {},
  },
};

const log = (component, msg) => console.log(`${new Date().toISOString()} [${component}] ${msg}`);

function startDevice(component, spec) {
  const state = { fault: null, seq: 0, published: 0 };
  const telemetryTopic = `chaos-room/telemetry/${component}`;
  const commandTopic = `chaos-room/cmd/${component}`;

  const client = mqtt.connect({
    host: ENDPOINT,
    port: 8883,
    protocol: 'mqtts',
    clientId: spec.thing,
    key: readFileSync(join(CERT_DIR, `${component}.key.pem`)),
    cert: readFileSync(join(CERT_DIR, `${component}.cert.pem`)),
    clean: true,
    reconnectPeriod: 2000,
  });

  const publish = (qos = 0) => {
    const metrics = state.fault ? spec.faults[state.fault]() : spec.baseline();
    const payload = { component, device: spec.thing, seq: ++state.seq, ts: Date.now(), ...metrics };
    client.publish(telemetryTopic, JSON.stringify(payload), { qos });
    state.published++;
    return payload;
  };

  client.on('connect', () => {
    log(component, `connected as ${spec.thing}`);
    client.subscribe(commandTopic, { qos: 1 }, (err, granted) => {
      if (err || granted?.[0]?.qos === 128) log(component, `subscribe to ${commandTopic} FAILED`);
      else log(component, `subscribed to ${commandTopic}`);
    });
  });
  client.on('reconnect', () => log(component, 'reconnecting'));
  client.on('close', () => log(component, 'connection closed'));
  client.on('error', (err) => log(component, `error: ${err.message}`));

  client.on('message', (_topic, buf) => {
    let cmd;
    try {
      cmd = JSON.parse(buf.toString());
    } catch {
      return log(component, `ignored non-JSON command: ${buf}`);
    }
    if (cmd.action === 'sabotage') {
      const fault = cmd.fault ?? Object.keys(spec.faults)[0];
      if (!spec.faults[fault]) return log(component, `ignored sabotage: no fault "${fault}" for this component`);
      state.fault = fault;
      // Publish immediately so the fault timestamp is the injection time, not the next tick.
      const p = publish(1);
      log(component, `SABOTAGE ${fault} -> ${JSON.stringify(p)}`);
    } else if (cmd.action === 'reset') {
      state.fault = null;
      const p = publish(1);
      log(component, `RESET -> ${JSON.stringify(p)}`);
    } else {
      log(component, `ignored unknown command: ${JSON.stringify(cmd)}`);
    }
  });

  const timer = setInterval(() => {
    if (!client.connected) return;
    const p = publish();
    if (state.seq % 10 === 0) log(component, `${state.published} published, last: ${JSON.stringify(p)}`);
  }, INTERVAL_MS);

  return () => {
    clearInterval(timer);
    client.end();
  };
}

const stops = Object.entries(COMPONENTS).map(([c, spec]) => startDevice(c, spec));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`${sig} received, disconnecting`);
    stops.forEach((stop) => stop());
    setTimeout(() => process.exit(0), 500);
  });
}
