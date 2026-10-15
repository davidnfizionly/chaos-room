# Bootstrap stack: budget alert first, then the remote state bucket used by infra/stack.
# This stack itself keeps its state locally (infra/backend/terraform.tfstate, gitignored).

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project = "chaos-room"
    }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "budget_email" {
  description = "E-mail address that receives budget alerts (set in terraform.tfvars, gitignored)"
  type        = string
}

variable "budget_limit_usd" {
  type    = string
  default = "5"
}

data "aws_caller_identity" "current" {}

# Budget alert. Credits and refunds are excluded so that spend absorbed by
# promotional credits still counts toward the threshold and triggers the alert.
resource "aws_budgets_budget" "monthly" {
  name         = "chaos-room-monthly"
  budget_type  = "COST"
  limit_amount = var.budget_limit_usd
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_types {
    include_credit             = false
    include_refund             = false
    include_discount           = true
    include_tax                = true
    include_subscription       = true
    include_recurring          = true
    include_upfront            = true
    include_other_subscription = true
    include_support            = true
    use_blended                = false
    use_amortized              = false
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_email]
  }
}

# Remote state bucket. Locking uses the S3 native lockfile (use_lockfile), see docs/DECISIONS.md.
resource "aws_s3_bucket" "tfstate" {
  bucket = "chaos-room-tfstate-${data.aws_caller_identity.current.account_id}"

  # Allows the final cleanup (Phase 7) to remove the versioned bucket in one destroy.
  force_destroy = true

  # Enforce "budget alert before any other resource".
  depends_on = [aws_budgets_budget.monthly]
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_policy" "tfstate_tls_only" {
  bucket = aws_s3_bucket.tfstate.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.tfstate.arn, "${aws_s3_bucket.tfstate.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.tfstate]
}

output "state_bucket" {
  value = aws_s3_bucket.tfstate.bucket
}

output "budget_name" {
  value = aws_budgets_budget.monthly.name
}
