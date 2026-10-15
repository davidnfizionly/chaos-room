# Detection at ingestion: one IoT rule per fault condition, each starting its Express workflow.
# The rule adds the broker ingest timestamp so every stage can be timed on AWS clocks.

data "aws_iam_policy_document" "iot_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["iot.amazonaws.com"]
    }
  }
}

resource "aws_cloudwatch_log_group" "rule_errors" {
  name              = "/chaos-room/iot-rule-errors"
  retention_in_days = 7
}

resource "aws_iam_role" "iot_rules" {
  name               = "chaos-room-iot-rules"
  assume_role_policy = data.aws_iam_policy_document.iot_assume.json
}

data "aws_iam_policy_document" "iot_rules" {
  statement {
    sid       = "StartRemediationWorkflows"
    actions   = ["states:StartExecution"]
    resources = [for sm in aws_sfn_state_machine.remediation : sm.arn]
  }
  statement {
    sid       = "WriteRuleErrors"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.rule_errors.arn}:*"]
  }
}

resource "aws_iam_role_policy" "iot_rules" {
  name   = "iot-rules"
  role   = aws_iam_role.iot_rules.id
  policy = data.aws_iam_policy_document.iot_rules.json
}

resource "aws_iot_topic_rule" "fault" {
  for_each    = local.workflows
  name        = "chaos_room_${each.key}_${each.value.fault_type}"
  description = "Detects ${each.value.fault_type} on ${each.key} (${each.value.condition})"
  enabled     = true
  sql_version = "2016-03-23"
  sql         = "SELECT *, timestamp() AS ingest_ts, '${each.value.fault_type}' AS fault_type FROM '${local.telemetry_topic_prefix}/${each.key}' WHERE ${each.value.condition}"

  step_functions {
    state_machine_name    = aws_sfn_state_machine.remediation[each.key].name
    execution_name_prefix = "${each.key}-${each.value.fault_type}"
    role_arn              = aws_iam_role.iot_rules.arn
  }

  error_action {
    cloudwatch_logs {
      log_group_name = aws_cloudwatch_log_group.rule_errors.name
      role_arn       = aws_iam_role.iot_rules.arn
    }
  }

  depends_on = [aws_iam_role_policy.iot_rules]
}
