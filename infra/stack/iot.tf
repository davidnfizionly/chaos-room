# IoT Core device registration: one thing + one X.509 certificate per simulated component,
# and a single least-privilege policy scoped by policy variables, so each device can only
# connect as itself, publish its own telemetry, and receive its own commands.

data "aws_iot_endpoint" "data_ats" {
  endpoint_type = "iot:Data-ATS"
}

resource "aws_iot_thing" "device" {
  for_each = local.devices
  name     = each.value

  attributes = {
    component = each.key
  }
}

# Certificates are signed from locally generated CSRs (simulator/gen-keys.sh):
# the private keys never reach Terraform state.
resource "aws_iot_certificate" "device" {
  for_each = local.devices
  csr      = file("${path.module}/../../simulator/certs/${each.key}.csr.pem")
  active   = true
}

resource "aws_iot_thing_principal_attachment" "device" {
  for_each  = local.devices
  thing     = aws_iot_thing.device[each.key].name
  principal = aws_iot_certificate.device[each.key].arn
}

resource "aws_iot_policy" "device" {
  name = "chaos-room-device"

  # $${...} escapes Terraform interpolation so AWS receives IoT policy variables.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ConnectAsOwnThingOnly"
        Effect   = "Allow"
        Action   = "iot:Connect"
        Resource = "arn:aws:iot:${var.region}:${local.account_id}:client/$${iot:Connection.Thing.ThingName}"
        Condition = {
          Bool = { "iot:Connection.Thing.IsAttached" = "true" }
        }
      },
      {
        Sid      = "PublishOwnTelemetry"
        Effect   = "Allow"
        Action   = "iot:Publish"
        Resource = "arn:aws:iot:${var.region}:${local.account_id}:topic/${local.telemetry_topic_prefix}/$${iot:Connection.Thing.Attributes[component]}"
      },
      {
        Sid      = "SubscribeOwnCommands"
        Effect   = "Allow"
        Action   = "iot:Subscribe"
        Resource = "arn:aws:iot:${var.region}:${local.account_id}:topicfilter/${local.command_topic_prefix}/$${iot:Connection.Thing.Attributes[component]}"
      },
      {
        Sid      = "ReceiveOwnCommands"
        Effect   = "Allow"
        Action   = "iot:Receive"
        Resource = "arn:aws:iot:${var.region}:${local.account_id}:topic/${local.command_topic_prefix}/$${iot:Connection.Thing.Attributes[component]}"
      },
    ]
  })
}

resource "aws_iot_policy_attachment" "device" {
  for_each = local.devices
  policy   = aws_iot_policy.device.name
  target   = aws_iot_certificate.device[each.key].arn
}

# Public certificate written next to the private key for the simulator to use.
resource "local_file" "device_cert" {
  for_each        = local.devices
  filename        = "${path.module}/../../simulator/certs/${each.key}.cert.pem"
  content         = aws_iot_certificate.device[each.key].certificate_pem
  file_permission = "0644"
}

output "iot_endpoint" {
  value = data.aws_iot_endpoint.data_ats.endpoint_address
}

output "things" {
  value = { for k, t in aws_iot_thing.device : k => t.name }
}
