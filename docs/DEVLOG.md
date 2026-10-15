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
