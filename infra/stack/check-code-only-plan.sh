#!/usr/bin/env bash
# Exit 0 only if a saved plan may be auto-applied under the Phase 4-5 auto-apply rule:
# 0 create, 0 destroy, and every update is a chaos-room Lambda whose only changed
# arguments are source_code_hash (plus last_modified, which AWS recomputes).
# Usage: ./check-code-only-plan.sh tfplan
set -euo pipefail

plan="${1:-tfplan}"
terraform show -json "$plan" | jq -e '
  [.resource_changes[] | select(.change.actions != ["no-op"] and .change.actions != ["read"])] as $changes
  | ($changes | length) > 0
  and all($changes[];
      .change.actions == ["update"]
      and .type == "aws_lambda_function"
      and (.change.after.function_name | startswith("chaos-room-"))
      and ([.change.before as $b | .change.after as $a | $a | keys[]
            | select($b[.] != $a[.])] - ["source_code_hash", "last_modified"] | length) == 0
      and ((.change.after_unknown // {}) | to_entries | map(select(.value == true) | .key)
            - ["last_modified", "version", "qualified_arn", "qualified_invoke_arn", "code_sha256"] | length) == 0)
' >/dev/null && echo "AUTO-APPLY OK: Lambda code-only change" || { echo "NEEDS MANUAL APPROVAL: plan is not a Lambda code-only change"; exit 1; }
