# Chaos Room Simulator - Reactive Event-Driven Orchestration for Industrial IoT on AWS

---

## Project Description

Industrial control systems, and increasingly cloud-connected IoT deployments in general, face a problem that has nothing to do with request/response APIs: sensor telemetry arrives disordered, asynchronously, from many independent sources, and some of it demands an automated response within a sub-second budget - a valve closed, power rerouted, an alarm raised - with no human in the loop fast enough to do it manually. Designing that detect-and-react pipeline correctly, so it is fast, auditable, and doesn't silently fail, is a distinct architectural skill from anything the rest of this portfolio demonstrates.

This project builds a simulated control room - a small set of components (a cooling unit, a power bus, an alarm system) represented on a live dashboard - fed by simulated telemetry over MQTT. A rule engine evaluates that telemetry the instant it arrives, and a sub-second orchestration layer carries out the correct remediation automatically. The demo is interactive and visibly dramatic: a user deliberately sabotages a component on the dashboard and watches the system detect the fault and fix it in real time, with every step of that automated response recorded for audit.

---

## Technologies & Services Used

| Layer | Technology | Purpose |
| --- | --- | --- |
| IaC | **Terraform** | IoT Core resources, Step Functions state machines, Lambda, DynamoDB - single source of truth |
| Telemetry ingestion | **AWS IoT Core** | MQTT broker receiving telemetry from simulated devices |
| Inline detection | **AWS IoT Rules Engine** | Evaluates telemetry against SQL-based rules the instant it arrives - detection happens at ingestion, not in a later batch job |
| Reactive orchestration | **AWS Step Functions (Express Workflows)** | Executes the remediation sequence for a detected fault in well under a second, built for exactly this high-volume, short-duration pattern |
| Remediation actions | **AWS Lambda** | The individual actions a workflow invokes (close a valve, reroute power, raise an alarm) and the simulated device telemetry publisher |
| Incident record | **Amazon DynamoDB** | Immutable, queryable log of every detected fault and every remediation action taken |
| Observability | **Amazon CloudWatch** | Step Functions execution history, Lambda logs and metrics |
| Frontend | **React** | Control room dashboard - component tiles, sabotage controls, live incident timeline |

---

## Architecture Patterns Actually Demonstrated

- **Detection at the edge of ingestion, not after storage** - the IoT Rules Engine evaluates telemetry the moment it arrives, rather than writing everything to a database first and scanning for anomalies later.
- **Sub-second reactive orchestration as a distinct workload shape** - Step Functions Express Workflows are built specifically for high-volume, short-duration executions, a materially different tool than a long-running Standard workflow and a materially different pattern than anything else in this portfolio.
- **Detection and remediation as two separately testable systems** - the rule that flags a fault and the workflow that fixes it are two different AWS services, so either can be changed, tested, or audited independently, mirroring how production safety-relevant systems are actually structured.
- **A full automated loop with no human in it for the base case** - sense, detect, decide, act, and confirm, all without manual intervention, with manual intervention reserved for the explicit escalation path when a remediation action itself fails.
- **Concurrent incident handling** - multiple simultaneous faults are each orchestrated independently, proving the architecture doesn't serialize or interfere between unrelated incidents.

---

## Demo Scenarios

| Scenario | What Happens | What It Proves |
| --- | --- | --- |
| **Normal operation** | Simulated sensors publish baseline telemetry continuously | The dashboard reflects a calm, healthy control room with live, unremarkable data flowing through the full pipeline |
| **Single sabotage event** | The user clicks "sabotage" on the cooling unit, simulating a temperature spike | The Rules Engine flags the threshold breach instantly; Step Functions executes the remediation sequence and the dashboard shows the fix applied in well under a second, logged to DynamoDB |
| **Concurrent incidents** | Two components are sabotaged at the same time | Two independent Step Functions executions run concurrently without interfering with each other |
| **Remediation failure / escalation** | A simulated remediation action itself fails (e.g. a valve reports it did not close) | The workflow follows a distinct escalation path - alarm plus lockdown - rather than silently reporting success |

---

## UI Details

- **Control room dashboard** - a handful of component tiles (cooling, power, alarm) showing live state
- **Sabotage controls** - buttons that trigger a fault on a specific component, on demand, for the live demo
- **Live incident timeline** - every detected fault and every remediation action, pulled from the DynamoDB incident log, in the order it happened
- **Simplified execution trace** - a readable view of what the Step Functions workflow actually did for a given incident, without requiring the viewer to read AWS console JSON
- **Non-technical framing** - a recruiter with zero IoT background can click "sabotage," watch the dashboard react within a second, and immediately understand what just happened and why it matters

---

## Use Case Simulation

| Role | What They'd See/Do in This System |
| --- | --- |
| **Plant/operations engineer** | Watches the dashboard during normal operation and during an incident, confirming remediation happens correctly and fast |
| **SRE/platform engineer** | Reviews the Step Functions execution history to confirm exactly what ran, in what order, and how long it took |
| **Auditor/compliance reviewer** | Confirms every automated remediation action has an immutable record in the incident log, not just an assumption that "the system handled it" |
| **Simulated saboteur** | Triggers a fault on demand through the dashboard controls, driving the live demo |

---

## Deployment Strategy

1. **Terraform backend** - S3 state, DynamoDB lock table
2. **AWS IoT Core setup** - device registration for the simulated telemetry publishers
3. **Simulated device publisher** - a Lambda-driven script generating realistic telemetry for each component, with a sabotage trigger
4. **IoT Rules Engine rules** - one rule per fault condition (e.g. temperature threshold breach), each targeting the matching remediation workflow
5. **Step Functions Express Workflows** - one remediation state machine per fault type, including the escalation path for a failed remediation action
6. **Lambda remediation actions** - the individual steps each workflow invokes
7. **DynamoDB incident log** - every detection and every remediation action recorded
8. **Control room dashboard** - React, Vite, Tailwind
9. **Demo scenario validation** - all 4 scenarios run and recorded live, including the concurrent-incident case
10. **Documentation & proof capture** - screenshots, Step Functions execution traces, architecture diagram
11. **Clean-up** - IoT Core resources, Step Functions, and any other billable resource torn down and cost-verified

---

## What This Actually Demonstrates to a Hiring Manager

- A genuinely different architectural skill from the rest of this portfolio: reactive, sub-second, event-driven orchestration, rather than request/response systems or batch pipelines
- Correct tool selection under a specific constraint (Express over Standard Step Functions) based on the actual workload shape, not a default choice
- The same "proof over assertion" standard applied throughout this portfolio, extended to an automated remediation action rather than a financial transaction or a network control
- A deliberately interactive, visibly dramatic demo that still maps directly onto a real enterprise problem (industrial IoT, reactive automation) rather than being excitement for its own sake
- Zero technology overlap with the rest of the portfolio, showing breadth across event-driven, geospatial, ML, network security, compliance, and now reactive IoT orchestration

---

## Considered and Rejected

- **Real IoT hardware** - the problem being proven is the ingestion, detection, and orchestration pipeline on the AWS side, not physical sensor integration. Simulated publishers exercise the identical architecture without the cost, risk, or time of real devices.
- **Standard Step Functions workflows instead of Express** - Standard is priced and designed for longer-running, lower-volume, highly auditable workflows. This project's actual requirement - high-volume, sub-second reactive executions - is exactly what Express is built for; using Standard here would misrepresent the real workload.
- **AI-based anomaly detection (e.g. via Amazon Bedrock)** - deliberately left out. Rule-based thresholds in the IoT Rules Engine keep every detection transparent and explainable, consistent with the same reasoning already applied to fraud detection in Project 1. An AI-assisted triage layer belongs to a separate project already in progress elsewhere and would duplicate that work rather than add something new here.
- **A full building/factory digital twin** - a handful of simulated components is enough to prove the detection-and-orchestration pattern. A complete simulation engine would be scope creep against a problem that doesn't need it.

---

## Time Budget

| Phase | Estimated Duration |
| --- | --- |
| Setup (tools, Terraform backend, IoT Core device registration) | Half day |
| Simulated telemetry publisher, with sabotage trigger | Half day |
| IoT Rules Engine rules per fault condition | Half day |
| Step Functions Express Workflows (remediation + escalation paths) | 1 day |
| Lambda remediation actions + DynamoDB incident log | Half day |
| Control room dashboard (iterative) | 1-1.5 days |
| Demo scenario validation, all 4 scenarios including concurrency | Half day |
| Documentation, diagram, proof capture, GitHub push | Half day |
| Clean-up + cost verification | Minimal (near free-tier) |

**Total: roughly 5 focused days**

---

## Architecture Decisions Worth Documenting

- **Why Step Functions Express instead of Standard**: the actual requirement is high-volume, sub-second reactive execution, which is precisely the workload Express is priced and designed for; Standard would be the wrong tool for a problem that isn't long-running or low-volume.
- **Why rule-based detection instead of ML-based anomaly detection**: transparency and auditability matter more than sophistication for an automated remediation path, the same reasoning already applied to Project 1's fraud detection. An AI-assisted layer is deliberately kept out of this project rather than duplicated from elsewhere.
- **Why simulated devices instead of real IoT hardware**: the architecture being proven lives entirely on the AWS side of the ingestion pipeline; simulated publishers exercise that architecture identically without hardware cost or risk.
- **Why detection (Rules Engine) and remediation (Step Functions) are kept as two separate services rather than one Lambda doing both**: each piece stays independently testable and auditable, and the split mirrors how production safety-relevant systems are actually architected.
- **Why DynamoDB for the incident log**: every automated action needs an immutable, queryable record, the same audit-trail standard already established in Projects 1, 5, and 6 - proof of what the system did, not an assertion that it worked.
