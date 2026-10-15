import { useEffect, useState } from 'react';

const POLL_MS = 1000;

const STATUS = {
  HEALTHY: { label: 'Healthy', cls: 'bg-emerald-600 text-white' },
  QUIET: { label: 'Quiet', cls: 'bg-emerald-600 text-white' },
  FAULT: { label: 'FAULT', cls: 'bg-red-600 text-white' },
  FIXING: { label: 'Fixing...', cls: 'bg-amber-400 text-black' },
  LOCKED_OUT: { label: 'FIX FAILED', cls: 'bg-red-700 text-white' },
  ALARM: { label: 'ALARM', cls: 'bg-red-600 text-white' },
  LOCKDOWN: { label: 'LOCKDOWN', cls: 'bg-red-700 text-white' },
  OFFLINE: { label: 'Offline', cls: 'bg-slate-600 text-white' },
};

const TILES = [
  {
    id: 'cooling',
    name: 'Cooling unit',
    metrics: [
      ['Temperature', (r) => `${r.temp_c.toFixed(1)} °C`],
      ['Coolant flow', (r) => `${r.coolant_flow_lpm.toFixed(1)} L/min`],
      ['Pump', (r) => `${r.pump_rpm} rpm`],
    ],
  },
  {
    id: 'power',
    name: 'Power bus',
    metrics: [
      ['Load', (r) => `${r.load_pct.toFixed(0)} %`],
      ['Voltage', (r) => `${r.voltage_v.toFixed(0)} V`],
      ['Frequency', (r) => `${r.frequency_hz.toFixed(2)} Hz`],
    ],
  },
  {
    id: 'alarm',
    name: 'Alarm system',
    metrics: [
      ['Siren', (r) => (r.siren === 'on' ? 'ON' : 'off')],
      ['Lockdown', (r) => (r.lockdown ? 'ENGAGED' : 'off')],
      ['Armed', (r) => (r.armed ? 'yes' : 'no')],
    ],
  },
];

const ACTION_LABEL = { close_valve: 'Coolant valve closed', reroute_power: 'Load rerouted to backup feed' };
const COMPONENT_LABEL = { cooling: 'Cooling', power: 'Power', alarm: 'Alarm' };

function describe(e) {
  const d = e.detail;
  switch (e.event) {
    case 'DETECTED':
      return e.component === 'cooling'
        ? `Rule flagged ${d.fault_type}: ${d.temp_c} °C`
        : `Rule flagged ${d.fault_type}: load ${d.load_pct} %, ${d.voltage_v} V`;
    case 'REMEDIATED':
      return `${ACTION_LABEL[d.action] ?? d.action} (Lambda ${d.duration_ms} ms)`;
    case 'RESOLVED':
      return 'Incident resolved';
    case 'ACTION_FAILED':
      return `Fix failed: ${d.cause}`;
    case 'ALARM_RAISED':
      return 'Plant alarm raised';
    case 'LOCKDOWN_ENGAGED':
      return 'Lockdown engaged';
    case 'ESCALATED':
      return 'Escalated: manual intervention required';
    default:
      return e.event;
  }
}

const clock = (ms) => new Date(ms).toISOString().slice(11, 23);

async function post(path, body) {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${path} failed (${res.status})`);
  return res.json();
}

function usePolledState() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch('/api/state', { cache: 'no-store' });
        if (!res.ok) throw new Error(`API ${res.status}`);
        const body = await res.json();
        if (alive) {
          setData(body);
          setError(null);
        }
      } catch (err) {
        if (alive) setError(err.message);
      }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return { data, error };
}

// Remediation is usually faster than the 1 s poll, so the tile may never be caught in FAULT.
// A recently resolved incident therefore stays visible on its tile for RECENT_FIX_MS.
const RECENT_FIX_MS = 8000;

function Tile({ tile, state, busy, onSabotage, recentFix }) {
  const status = STATUS[state?.status ?? 'OFFLINE'];
  const reading = state?.reading;
  return (
    <section className="rounded-2xl border-2 border-slate-700 bg-slate-900 p-6 flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-2xl font-bold text-white">{tile.name}</h2>
        <span data-testid={`status-${tile.id}`} className={`rounded-lg px-3 py-1 text-lg font-bold ${status.cls}`}>
          {status.label}
        </span>
      </div>
      {recentFix && (
        <p data-testid={`recent-fix-${tile.id}`} className="rounded-lg border-2 border-emerald-500 bg-emerald-950 px-3 py-2 text-lg font-semibold text-emerald-300">
          Fault detected and fixed in {recentFix} ms
        </p>
      )}
      <dl className="grid grid-cols-1 gap-3">
        {tile.metrics.map(([label, fmt]) => (
          <div key={label} className="flex items-baseline justify-between">
            <dt className="text-lg text-slate-300">{label}</dt>
            <dd className="text-3xl font-semibold tabular-nums text-white">{reading ? fmt(reading) : '-'}</dd>
          </div>
        ))}
      </dl>
      {tile.id !== 'alarm' && (
        <div className="mt-auto grid grid-cols-2 gap-3">
          <button
            disabled={busy}
            data-testid={`sabotage-${tile.id}`}
            onClick={() => onSabotage([tile.id], false)}
            className="rounded-xl bg-red-600 px-4 py-3 text-lg font-bold text-white hover:bg-red-500 disabled:opacity-40"
          >
            Sabotage
          </button>
          <button
            disabled={busy}
            data-testid={`jam-${tile.id}`}
            onClick={() => onSabotage([tile.id], true)}
            className="rounded-xl border-2 border-red-500 px-4 py-3 text-lg font-bold text-red-300 hover:bg-red-950 disabled:opacity-40"
            title="Sabotage and make the automated fix fail, to show the escalation path"
          >
            Sabotage + jam the fix
          </button>
        </div>
      )}
    </section>
  );
}

function Trace({ incident }) {
  const detected = incident.events.find((e) => e.event === 'DETECTED');
  if (!detected) return null;
  const ingest = detected.detail.ingest_ts;
  const resolved = incident.events.find((e) => e.event === 'RESOLVED');
  const escalated = incident.events.find((e) => e.event === 'ESCALATED');
  const steps = [
    { label: 'Faulty reading reached AWS IoT Core', at: ingest },
    { label: 'Rule matched, remediation workflow started', at: Date.parse(detected.detail.execution_started) },
    ...incident.events.map((e) => ({ label: describe(e), at: e.at_ms, event: e.event })),
  ];
  let headline = 'Remediation in progress...';
  let headlineCls = 'text-amber-300';
  if (resolved) {
    headline = `Fixed ${resolved.detail.ingest_to_action_done_ms} ms after the fault reached AWS`;
    headlineCls = 'text-emerald-400';
  } else if (escalated) {
    headline = `Fix failed - escalated in ${escalated.detail.ingest_to_escalated_ms} ms`;
    headlineCls = 'text-red-400';
  }
  return (
    <div className="rounded-xl border-2 border-slate-700 bg-slate-900 p-5">
      <p className="text-lg text-slate-300">
        {COMPONENT_LABEL[incident.component]} incident <span className="font-mono text-base text-slate-400">{incident.id.slice(-12)}</span>
      </p>
      <p data-testid={`trace-headline-${incident.component}`} className={`mt-1 text-2xl font-bold ${headlineCls}`}>
        {headline}
      </p>
      <ol className="mt-4 flex flex-col gap-2">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-4 text-lg">
            <span className="w-24 shrink-0 text-right font-mono tabular-nums text-slate-400">+{Math.max(0, s.at - ingest)} ms</span>
            <span className={s.event === 'ACTION_FAILED' || s.event === 'ESCALATED' ? 'text-red-300' : 'text-white'}>{s.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function App() {
  const { data, error } = usePolledState();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const run = async (label, fn) => {
    setBusy(true);
    setMessage(`${label}...`);
    try {
      await fn();
      setMessage(`${label}: sent`);
    } catch (err) {
      setMessage(`${label}: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const sabotage = (components, failFix) =>
    run(`Sabotage ${components.map((c) => COMPONENT_LABEL[c]).join(' + ')}${failFix ? ' (fix jammed)' : ''}`, () =>
      post('/sabotage', { components, fail_fix: failFix }),
    );

  // Group the most recent events into incidents, newest first; show the latest two traces
  // so a concurrent sabotage displays both executions side by side.
  const events = data?.events ?? [];
  const incidents = [];
  for (const e of [...events].reverse()) {
    let inc = incidents.find((i) => i.id === e.incident_id);
    if (!inc) incidents.push((inc = { id: e.incident_id, component: e.component, events: [] }));
    inc.events.push(e);
  }
  incidents.sort((a, b) => b.events[0].at_ms - a.events[0].at_ms);
  const recentFix = (component) => {
    const inc = incidents.find((i) => i.component === component);
    const resolved = inc?.events.find((e) => e.event === 'RESOLVED');
    return resolved && data.now - resolved.at_ms < RECENT_FIX_MS ? resolved.detail.ingest_to_action_done_ms : null;
  };
  const latest = incidents.slice(0, 2).filter((i, idx, arr) => idx === 0 || Math.abs(arr[0].events[0].at_ms - i.events[0].at_ms) < 5000);

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 text-white">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl font-extrabold">Chaos Room</h1>
          <p className="mt-2 text-xl text-slate-300">
            Sabotage a component. AWS detects the fault from its telemetry, runs the fix automatically, and records every step.
          </p>
        </div>
        <p data-testid="connection" className={`text-lg font-semibold ${error ? 'text-red-400' : data ? 'text-emerald-400' : 'text-slate-400'}`}>
          {error ? `API unreachable (${error})` : data ? 'Live - updated every second' : 'Connecting...'}
        </p>
      </header>

      <section className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-3">
        {TILES.map((tile) => (
          <Tile key={tile.id} tile={tile} state={data?.components?.[tile.id]} busy={busy} onSabotage={sabotage} recentFix={recentFix(tile.id)} />
        ))}
      </section>

      <section className="mt-6 flex flex-wrap items-center gap-4">
        <button
          disabled={busy}
          onClick={() => sabotage(['cooling', 'power'], false)}
          className="rounded-xl bg-red-600 px-6 py-3 text-xl font-bold hover:bg-red-500 disabled:opacity-40"
        >
          Sabotage both at once
        </button>
        <button
          disabled={busy}
          onClick={() => run('Reset', () => post('/reset'))}
          className="rounded-xl bg-slate-200 px-6 py-3 text-xl font-bold text-slate-900 hover:bg-white disabled:opacity-40"
        >
          Reset everything
        </button>
        <span data-testid="message" className="text-lg text-slate-300">{message}</span>
      </section>

      <div className="mt-10 grid grid-cols-1 gap-8 lg:grid-cols-2">
        <section>
          <h2 className="text-2xl font-bold">What the automation just did</h2>
          <p className="mt-1 text-lg text-slate-400">Step Functions workflow steps, timed from the moment the faulty reading reached AWS.</p>
          <div className="mt-4 flex flex-col gap-4">
            {latest.length ? latest.map((i) => <Trace key={i.id} incident={i} />) : <p className="text-lg text-slate-400">No incident yet.</p>}
          </div>
        </section>

        <section>
          <h2 className="text-2xl font-bold">Incident log</h2>
          <p className="mt-1 text-lg text-slate-400">Every detection and action, from the append-only DynamoDB audit log (UTC).</p>
          <ol data-testid="timeline" className="mt-4 flex flex-col divide-y divide-slate-800 rounded-xl border-2 border-slate-700 bg-slate-900">
            {events.length === 0 && <li className="p-4 text-lg text-slate-400">Empty.</li>}
            {events.slice(0, 15).map((e) => (
              <li key={`${e.incident_id}-${e.event}`} className="flex gap-4 px-4 py-2 text-lg">
                <span className="shrink-0 font-mono tabular-nums text-slate-400">{clock(e.at_ms)}</span>
                <span className="w-20 shrink-0 font-semibold text-slate-200">{COMPONENT_LABEL[e.component]}</span>
                <span className={e.event === 'ACTION_FAILED' || e.event === 'ESCALATED' ? 'text-red-300' : e.event === 'RESOLVED' ? 'text-emerald-300' : 'text-white'}>
                  {describe(e)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
  );
}
