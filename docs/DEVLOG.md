# Devlog

Real problems hit during the build: what happened, root cause, fix. Written as they occur.

## Phase 2

### IoT policy test passed for the wrong reason (client ID takeover)

- **What happened:** the first run of `simulator/policy-test.mjs` reported all 4 cases as PASS, but the last case ("publish on own command topic", expected to be denied) logged `connect refused` instead of `publish rejected`. The connection had never reached the publish step.
- **Root cause:** the policy only allows a device to connect with its own thing name as client ID, so the test used `chaos-room-cooling-unit`, the same client ID as the running simulator. AWS IoT Core allows one connection per client ID and drops the older one. The simulator's cooling device then reconnected 2 seconds later and kicked the test client out before its CONNACK. The simulator log shows the matching `connection closed` / `reconnecting` lines on the cooling device.
- **Fix:** stop the simulator before running the policy test. The rerun shows the intended result for every case, including `publish rejected (connection closed by broker)` for the command topic. Lesson: a PASS on a negative test is not proof unless the failure happens at the expected step.

### Policy test script hung on a refused connection

- **What happened:** the first version of the test printed one case twice and never finished the "impersonate other thing" case (Node warned about an unsettled top-level await).
- **Root cause:** both the publish callback and the `close` handler called `finish()`, and a connection refused before CONNACK only emitted `close`, which the handler ignored when the client had never connected.
- **Fix:** a single `done` guard, every `close` / `error` resolves the case, plus a 6-second timeout.

### CloudWatch showed fewer IoT messages than published

- **What happened:** right after the first run, `PublishIn.Success` for the 13:19 UTC minute showed 120, while 3 devices at 1 message/second should give about 180. Only about 3 seconds of reconnection were visible in the simulator log, which could not explain the gap.
- **Root cause:** not a dropped-message problem. CloudWatch was still aggregating that minute. Re-queried 6 minutes later, the same minute showed 180, and every untouched full minute of a second run showed exactly 180.
- **Fix:** none needed in the system. Lesson: never read the most recent 1-2 minutes of a CloudWatch metric as final, and re-query before drawing a conclusion.

## Phase 3

### Every sabotage opened two incidents instead of one

- **What happened:** the first `single cooling` and `single power` runs each reported 2 incidents. Both were remediated, so the second one sent a second `close_valve` to a device that was already healthy (simulator log: `remediate received while healthy`).
- **Root cause:** the dedup lock accepted a new incident for any reading ingested after the previous incident released its lock. The second incident was triggered by reading seq 60, published by the device 469 ms after the fault, i.e. before the remediation command reached it (+567 ms on the device clock), but ingested ~200 ms after the workflow had already released the lock. The design assumed "lock released" meant "device fixed", but the command still has a ~300 ms round trip from us-east-1 to the device in Nairobi.
- **Fix:** on release the workflow writes `reopen_after = now + 1.5 s` and a reading opens a new incident only if it was ingested after that (ADR 008 revised). A fault that genuinely persists is still detected on the next 1 s reading.

### Step Functions definition rejected after an edit (JSON escaping)

- **What happened:** `terraform plan` failed with `INVALID_JSON_DESCRIPTION: Unexpected character ('e')` after adding a JSONata expression to trim Lambda stack traces from the logged failure cause.
- **Root cause:** the expression contained `'"errorMessage"'`; the inner double quotes were not escaped inside the JSON string of the ASL template. The same expression had passed in `aws stepfunctions test-state` because there it was escaped correctly.
- **Fix:** match on `'errorMessage'` without inner quotes. Lesson: validate the rendered template, not just the expression.

### A component in lockdown starts one (suppressed) workflow per second

- **What happened:** after the cooling escalation test, the cooling log group showed 212 executions for about a dozen real incidents, 206 of them ending in `SuppressedDuplicate`.
- **Root cause:** by design, a component in lockdown keeps its lock and the simulated device keeps publishing faulty readings every second. The IoT rule has no knowledge of the lock, so every reading starts an Express execution, which stops at its first state.
- **Fix:** none for now. It is the intended behavior (no retry storm, no duplicate incidents, nothing written to the audit log) and the cost is about 1 USD per million executions. Noted so the execution count is not misread later.

## Phase 4

### Dashboard showed "locked out" during a normal, successful remediation

- **What happened:** polling `GET /state` 400 ms after a sabotage returned `LOCKED_OUT` for both components, then `HEALTHY` 400 ms later. A viewer would have seen "fix failed" flash on every successful incident.
- **Root cause:** the read model treated any lock without `reopen_after` as an escalated incident. But a lock has no `reopen_after` while its workflow is still running too; only the escalation path keeps it that way permanently.
- **Fix:** a component is `LOCKED_OUT` only if its open incident has an `ESCALATED` event in the log; otherwise it is `FIXING`.

### Headless browser could not start in WSL

- **What happened:** Playwright's Chromium headless shell installed but failed to launch (`Target page, context or browser has been closed`).
- **Root cause:** `ldd` showed missing system libraries in the WSL Ubuntu image: `libnss3`, `libnssutil3`, `libnspr4`, `libasound2`. Installing them needs `sudo`, which requires an interactive password.
- **Fix:** install them with `sudo apt-get install -y libnss3 libnspr4 libasound2t64`.

### The fix was faster than the dashboard could show it

- **What happened:** in the browser test, a cooling sabotage was remediated 265 ms after the fault reached AWS. With a 1 s poll, the tile went Healthy -> Healthy: a viewer never saw the fault at all. Another run showed the power tile flash `FAULT` right after `Fixing...`.
- **Root cause:** the poll period is longer than the whole incident. The `FAULT` flash came from the faulty reading mirrored just after the lock was released, i.e. inside the settle window (same root cause as the duplicate incidents in Phase 3).
- **Fix:** a resolved incident stays on its tile for 8 s ("Fault detected and fixed in N ms"), a status message rather than an animation; and a faulty reading inside the settle window is shown as `Fixing...`, not `FAULT`.

## Phase 5

### A component was left in lockdown between sessions

- **What happened:** before the Phase 5 captures, `chaos-room-state` still held `LOCK#cooling` and `INJECT#cooling.actuator_stuck = true` from a dashboard "Sabotage + jam the fix" that was never followed by a reset. The console capture of the cooling executions showed 817 executions of 15-40 ms: suppressed duplicates, one per faulty reading while the simulator was running.
- **Root cause:** by design an escalated component stays locked until a manual reset, and nothing reminds the operator.
- **Fix:** every measurement and capture run now starts with a reset and a check that no `LOCK#` / `INJECT#` item is left.

### My own lock check reported a lock that did not exist

- **What happened:** after the reset, a check said `LOCK#cooling STILL PRESENT` while a table scan showed no lock.
- **Root cause:** `aws dynamodb get-item --query Item --output text` prints `None` when the item is absent, and `grep -q .` matched that text.
- **Fix:** compare the returned id to the expected key. Same lesson as the Phase 2 policy test: a check needs to prove it can fail correctly too.

### A 5-minute wait ended instantly

- **What happened:** the wait for the 5-minute normal-operation window returned immediately.
- **Root cause:** on this Ubuntu 26 image `date +%s%3N` printed nanoseconds, not milliseconds (the `%3N` width was ignored), so the computed deadline was 0.3 ms away.
- **Fix:** timestamps now come from Node (`Date.now()`); the window was completed and re-checked from its real start time.

### Concurrent incidents did not always overlap in time

- **What happened:** in 2 of the 20 concurrent runs, the two Step Functions executions did not overlap (-12 ms and -25 ms). The first estimate, from the incident log's DETECTED -> RESOLVED windows, said 3/20; the execution history (ExecutionStarted -> ExecutionSucceeded) is the accurate measure.
- **Root cause:** the two sabotage commands are two separate MQTT publishes travelling from Nairobi; in those runs they arrived 146 ms and 156 ms apart, while a warm execution only lasts about 100-160 ms. The first was finished before the second started.
- **Fix:** none in the system: each incident still had its own execution, its own lock, and exactly one incident, with no interference. Reported as measured: 18/20 runs overlapped, median overlap 85 ms.
