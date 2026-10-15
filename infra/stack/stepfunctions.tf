# One Express remediation workflow per fault type, rendered from a shared ASL template.

locals {
  workflows = {
    cooling = {
      fault_type = "overheat"
      condition  = "temp_c > 80"
      action     = "close_valve"
    }
    power = {
      fault_type = "overload"
      condition  = "load_pct > 100 OR voltage_v < 207"
      action     = "reroute_power"
    }
  }

  # After a remediation, faulty readings ingested within this window were already in flight
  # before the fix reached the device (device round trip ~300 ms from Nairobi), so they belong
  # to the same incident. A fault that persists past it is detected on the next 1 s reading.
  settle_ms = 1500
}

data "aws_iam_policy_document" "sfn_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_cloudwatch_log_group" "workflow" {
  for_each          = local.workflows
  name              = "/aws/vendedlogs/states/chaos-room-${each.key}-remediation"
  retention_in_days = 7
}

resource "aws_iam_role" "workflow" {
  for_each           = local.workflows
  name               = "chaos-room-${each.key}-remediation-sfn"
  assume_role_policy = data.aws_iam_policy_document.sfn_assume.json
}

data "aws_iam_policy_document" "workflow" {
  for_each = local.workflows

  statement {
    sid     = "InvokeOwnActions"
    actions = ["lambda:InvokeFunction"]
    resources = [
      aws_lambda_function.action[each.value.action].arn,
      aws_lambda_function.action["raise_alarm"].arn,
      aws_lambda_function.action["lockdown"].arn,
    ]
  }

  statement {
    sid       = "AppendToIncidentLog"
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.incident_log.arn]
  }

  statement {
    sid       = "ManageOwnComponentLock"
    actions   = ["dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.state.arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["LOCK#${each.key}"]
    }
  }

  # CloudWatch Logs delivery for Step Functions does not support resource-level
  # permissions, so AWS requires "*" for these actions (documented exception).
  statement {
    sid = "ExecutionLogDelivery"
    actions = [
      "logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery",
      "logs:DeleteLogDelivery", "logs:ListLogDeliveries", "logs:PutResourcePolicy",
      "logs:DescribeResourcePolicies", "logs:DescribeLogGroups",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "workflow" {
  for_each = local.workflows
  name     = "workflow"
  role     = aws_iam_role.workflow[each.key].id
  policy   = data.aws_iam_policy_document.workflow[each.key].json
}

resource "aws_sfn_state_machine" "remediation" {
  for_each = local.workflows
  name     = "chaos-room-${each.key}-remediation"
  type     = "EXPRESS"
  role_arn = aws_iam_role.workflow[each.key].arn

  definition = templatefile("${path.module}/templates/remediation.asl.json", {
    component         = each.key
    action_name       = each.value.action
    action_lambda_arn = aws_lambda_function.action[each.value.action].arn
    raise_alarm_arn   = aws_lambda_function.action["raise_alarm"].arn
    lockdown_arn      = aws_lambda_function.action["lockdown"].arn
    log_table         = aws_dynamodb_table.incident_log.name
    state_table       = aws_dynamodb_table.state.name
    settle_ms         = local.settle_ms
  })

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.workflow[each.key].arn}:*"
    include_execution_data = true
    level                  = "ALL"
  }

  depends_on = [aws_iam_role_policy.workflow]
}

output "state_machines" {
  value = { for k, sm in aws_sfn_state_machine.remediation : k => sm.name }
}
