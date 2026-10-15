# Incident log: append-only. Every writer uses PutItem with attribute_not_exists(sk) and no
# principal in this stack is granted UpdateItem or DeleteItem on it.
#   pk = "EVENTS" (single partition, low volume), sk = "<epoch ms>#<incident id>#<step>"
resource "aws_dynamodb_table" "incident_log" {
  name         = "chaos-room-incident-log"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
}

# Mutable operational state, kept apart from the immutable log:
#   LOCK#<component>   one open incident per component (dedup of repeated fault telemetry)
#   INJECT#<component> failure injection for the escalation scenario
resource "aws_dynamodb_table" "state" {
  name         = "chaos-room-state"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }
}
