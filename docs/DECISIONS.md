# Architecture Decision Records

One line per decision that goes beyond `docs/PROJECT_PLAN.md`: what, why, what was rejected.

| # | Status | Decision | Why | Rejected |
| --- | --- | --- | --- | --- |
| 001 | Accepted | Terraform state locking uses the S3 native lockfile (`use_lockfile = true`, Terraform >= 1.10) instead of a DynamoDB lock table | Same locking guarantee with one fewer resource to create, secure and tear down; DynamoDB-based locking is deprecated in Terraform's S3 backend | DynamoDB lock table (listed in the plan, now deprecated by HashiCorp) |
| 002 | Accepted | Budget alert excludes credits and refunds (`include_credit = false`) | With promotional credits absorbing spend, a credit-inclusive budget reports ~0 USD and would never fire | Default cost types (credits included) |
| 003 | Accepted | The bootstrap stack (`infra/backend`) keeps its own state locally, gitignored | Avoids the chicken-and-egg of storing the state bucket's state in itself; only 7 small resources | Migrating bootstrap state into the bucket it creates |
