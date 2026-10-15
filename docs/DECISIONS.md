# Architecture Decision Records

One line per decision that goes beyond `docs/PROJECT_PLAN.md`: what, why, what was rejected.

| # | Status | Decision | Why | Rejected |
| --- | --- | --- | --- | --- |
| 001 | Accepted | Terraform state locking uses the S3 native lockfile (`use_lockfile = true`, Terraform >= 1.10) instead of a DynamoDB lock table | Same locking guarantee with one fewer resource to create, secure and tear down; DynamoDB-based locking is deprecated in Terraform's S3 backend | DynamoDB lock table (listed in the plan, now deprecated by HashiCorp) |
| 002 | Accepted | Budget alert excludes credits and refunds (`include_credit = false`) | With promotional credits absorbing spend, a credit-inclusive budget reports ~0 USD and would never fire | Default cost types (credits included) |
| 003 | Accepted | The bootstrap stack (`infra/backend`) keeps its own state locally, gitignored | Avoids the chicken-and-egg of storing the state bucket's state in itself; only 7 small resources | Migrating bootstrap state into the bucket it creates |
| 004 | Accepted | Baseline telemetry comes from a local Node.js process acting as 3 registered IoT things over MQTT/mTLS; the "Lambda-driven" sabotage trigger is a Lambda (behind the dashboard API, Phase 4) that publishes a command to the device's command topic | Exercises the real device registration path (thing + X.509 cert + scoped policy), publishes every second, and costs nothing when stopped | A scheduled Lambda publisher (EventBridge's minimum rate is 1 minute, so no continuous stream, and it bypasses device registration) |
| 005 | Accepted | Device certificates are signed from locally generated CSRs (EC P-256) | Private keys never leave the machine and never enter Terraform state | `aws_iot_certificate` without CSR (AWS generates the key and Terraform stores it in state) |
| 006 | Accepted | One IoT policy for all devices, scoped with policy variables (`ThingName`, `Attributes[component]`) | Each device can only connect as itself, publish its own telemetry and receive its own commands, with a single policy to maintain | One policy per device; wildcard `iot:*` |
