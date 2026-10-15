terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
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

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id

  # component id => IoT thing name (also the MQTT client ID the device must use)
  devices = {
    cooling = "chaos-room-cooling-unit"
    power   = "chaos-room-power-bus"
    alarm   = "chaos-room-alarm-system"
  }

  telemetry_topic_prefix = "chaos-room/telemetry"
  command_topic_prefix   = "chaos-room/cmd"
}
