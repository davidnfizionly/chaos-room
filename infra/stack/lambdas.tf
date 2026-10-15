# Remediation actions invoked by the Express workflows. One function per action, each with
# its own role that can only publish to the one command topic it drives.

locals {
  actions = {
    close_valve = {
      description   = "Closes the cooling loop isolation valve"
      command_topic = "${local.command_topic_prefix}/cooling"
      inject_key    = "INJECT#cooling"
    }
    reroute_power = {
      description   = "Reroutes the power bus load to the backup feed"
      command_topic = "${local.command_topic_prefix}/power"
      inject_key    = "INJECT#power"
    }
    raise_alarm = {
      description   = "Escalation: sounds the plant alarm"
      command_topic = "${local.command_topic_prefix}/alarm"
      inject_key    = null
    }
    lockdown = {
      description   = "Escalation: engages plant lockdown through the alarm system"
      command_topic = "${local.command_topic_prefix}/alarm"
      inject_key    = null
    }
  }
}

data "archive_file" "action" {
  for_each    = local.actions
  type        = "zip"
  source_dir  = "${path.module}/../../lambdas/${each.key}"
  output_path = "${path.module}/build/${each.key}.zip"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "action" {
  for_each           = local.actions
  name               = "chaos-room-action-${replace(each.key, "_", "-")}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_cloudwatch_log_group" "action" {
  for_each          = local.actions
  name              = "/aws/lambda/chaos-room-${replace(each.key, "_", "-")}"
  retention_in_days = 7
}

data "aws_iam_policy_document" "action" {
  for_each = local.actions

  statement {
    sid       = "WriteOwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.action[each.key].arn}:*"]
  }

  statement {
    sid       = "PublishOwnCommandTopic"
    actions   = ["iot:Publish"]
    resources = ["arn:aws:iot:${var.region}:${local.account_id}:topic/${each.value.command_topic}"]
  }

  dynamic "statement" {
    for_each = each.value.inject_key == null ? [] : [each.value.inject_key]
    content {
      sid       = "ReadOwnFailureInjectionFlag"
      actions   = ["dynamodb:GetItem"]
      resources = [aws_dynamodb_table.state.arn]
      condition {
        test     = "ForAllValues:StringEquals"
        variable = "dynamodb:LeadingKeys"
        values   = [statement.value]
      }
    }
  }
}

resource "aws_iam_role_policy" "action" {
  for_each = local.actions
  name     = "action"
  role     = aws_iam_role.action[each.key].id
  policy   = data.aws_iam_policy_document.action[each.key].json
}

resource "aws_lambda_function" "action" {
  for_each         = local.actions
  function_name    = "chaos-room-${replace(each.key, "_", "-")}"
  description      = each.value.description
  role             = aws_iam_role.action[each.key].arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  memory_size      = 256
  timeout          = 5
  filename         = data.archive_file.action[each.key].output_path
  source_code_hash = data.archive_file.action[each.key].output_base64sha256

  environment {
    variables = {
      IOT_ENDPOINT  = data.aws_iot_endpoint.data_ats.endpoint_address
      COMMAND_TOPIC = each.value.command_topic
      STATE_TABLE   = aws_dynamodb_table.state.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.action, aws_iam_role_policy.action]
}
