# Dashboard data path (temporary, removed at cleanup): IoT rule mirrors the latest telemetry
# per component into the state table; an HTTP API with two Lambdas serves the dashboard.
#   GET  /state     -> chaos-room-api-state    (read-only DynamoDB)
#   POST /sabotage  -> chaos-room-api-command  (publishes sabotage commands, sets failure injection)
#   POST /reset     -> chaos-room-api-command
# Every route requires the x-api-key header. The key is only stored in Terraform state, the
# Lambda configuration, and dashboard/.env.local (gitignored), where the Vite dev proxy adds it.

resource "aws_iot_topic_rule" "live_state" {
  name        = "chaos_room_live_state"
  description = "Mirrors the latest telemetry of each component into the state table for the dashboard"
  enabled     = true
  sql_version = "2016-03-23"
  sql         = "SELECT *, concat('LIVE#', topic(3)) AS id, timestamp() AS ingest_ts FROM '${local.telemetry_topic_prefix}/+'"

  dynamodbv2 {
    role_arn = aws_iam_role.iot_rules.arn
    put_item {
      table_name = aws_dynamodb_table.state.name
    }
  }

  error_action {
    cloudwatch_logs {
      log_group_name = aws_cloudwatch_log_group.rule_errors.name
      role_arn       = aws_iam_role.iot_rules.arn
    }
  }

  depends_on = [aws_iam_role_policy.iot_rules]
}

resource "random_password" "api_key" {
  length  = 40
  special = false
}

locals {
  api_functions = {
    api_state = {
      description = "Dashboard read model: live component state, locks, recent incident events"
    }
    api_command = {
      description = "Dashboard commands: sabotage (optionally with a jammed fix) and reset"
    }
  }
}

data "archive_file" "api" {
  for_each    = local.api_functions
  type        = "zip"
  source_dir  = "${path.module}/../../lambdas/${each.key}"
  output_path = "${path.module}/build/${each.key}.zip"
}

resource "aws_iam_role" "api" {
  for_each           = local.api_functions
  name               = "chaos-room-${replace(each.key, "_", "-")}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_cloudwatch_log_group" "api" {
  for_each          = local.api_functions
  name              = "/aws/lambda/chaos-room-${replace(each.key, "_", "-")}"
  retention_in_days = 7
}

data "aws_iam_policy_document" "api_state" {
  statement {
    sid       = "WriteOwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.api["api_state"].arn}:*"]
  }
  statement {
    sid       = "ReadState"
    actions   = ["dynamodb:Scan"]
    resources = [aws_dynamodb_table.state.arn]
  }
  statement {
    sid       = "ReadIncidentLog"
    actions   = ["dynamodb:Query"]
    resources = [aws_dynamodb_table.incident_log.arn]
  }
}

data "aws_iam_policy_document" "api_command" {
  statement {
    sid       = "WriteOwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.api["api_command"].arn}:*"]
  }
  statement {
    sid       = "PublishDeviceCommands"
    actions   = ["iot:Publish"]
    resources = [for c in keys(local.devices) : "arn:aws:iot:${var.region}:${local.account_id}:topic/${local.command_topic_prefix}/${c}"]
  }
  statement {
    sid       = "ManageInjectionAndResetLocks"
    actions   = ["dynamodb:PutItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.state.arn]
    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["INJECT#*", "LOCK#*"]
    }
  }
}

resource "aws_iam_role_policy" "api" {
  for_each = local.api_functions
  name     = "api"
  role     = aws_iam_role.api[each.key].id
  policy   = each.key == "api_state" ? data.aws_iam_policy_document.api_state.json : data.aws_iam_policy_document.api_command.json
}

resource "aws_lambda_function" "api" {
  for_each         = local.api_functions
  function_name    = "chaos-room-${replace(each.key, "_", "-")}"
  description      = each.value.description
  role             = aws_iam_role.api[each.key].arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  memory_size      = 256
  timeout          = 10
  filename         = data.archive_file.api[each.key].output_path
  source_code_hash = data.archive_file.api[each.key].output_base64sha256

  environment {
    variables = {
      API_KEY      = random_password.api_key.result
      IOT_ENDPOINT = data.aws_iot_endpoint.data_ats.endpoint_address
      STATE_TABLE  = aws_dynamodb_table.state.name
      LOG_TABLE    = aws_dynamodb_table.incident_log.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.api, aws_iam_role_policy.api]
}

resource "aws_apigatewayv2_api" "dashboard" {
  name          = "chaos-room-dashboard"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.dashboard.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 20
    throttling_rate_limit  = 10
  }
}

resource "aws_apigatewayv2_integration" "api" {
  for_each               = local.api_functions
  api_id                 = aws_apigatewayv2_api.dashboard.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api[each.key].invoke_arn
  payload_format_version = "2.0"
}

locals {
  api_routes = {
    "GET /state"     = "api_state"
    "POST /sabotage" = "api_command"
    "POST /reset"    = "api_command"
  }
}

resource "aws_apigatewayv2_route" "api" {
  for_each  = local.api_routes
  api_id    = aws_apigatewayv2_api.dashboard.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.api[each.value].id}"
}

resource "aws_lambda_permission" "api" {
  for_each      = local.api_functions
  statement_id  = "AllowDashboardApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api[each.key].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.dashboard.execution_arn}/*/*"
}

# Consumed by the Vite dev proxy (dashboard/vite.config.js). Gitignored.
resource "local_sensitive_file" "dashboard_env" {
  filename        = "${path.module}/../../dashboard/.env.local"
  file_permission = "0600"
  content         = "API_URL=${aws_apigatewayv2_api.dashboard.api_endpoint}\nAPI_KEY=${random_password.api_key.result}\n"
}

output "api_url" {
  value = aws_apigatewayv2_api.dashboard.api_endpoint
}
