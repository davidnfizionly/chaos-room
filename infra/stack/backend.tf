# Remote state in the bucket created by infra/backend. The bucket name contains the
# account ID, so it is passed via a gitignored partial config:
#   terraform init -backend-config=backend.hcl
# backend.hcl contains: bucket = "chaos-room-tfstate-<account-id>"
terraform {
  backend "s3" {
    key          = "stack/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true # S3 native locking, see docs/DECISIONS.md ADR 001
  }
}
