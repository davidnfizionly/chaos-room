#!/usr/bin/env bash
# Generates one EC P-256 private key + CSR per simulated device.
# Private keys never leave this machine: Terraform only receives the CSRs and
# AWS IoT signs them, so no private key ends up in Terraform state.
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p certs
chmod 700 certs

for component in cooling power alarm; do
  key="certs/${component}.key.pem"
  csr="certs/${component}.csr.pem"
  if [[ -f "$key" ]]; then
    echo "skip ${component}: key already exists"
    continue
  fi
  openssl ecparam -name prime256v1 -genkey -noout -out "$key"
  chmod 600 "$key"
  openssl req -new -key "$key" -out "$csr" -subj "/CN=chaos-room-${component}"
  echo "generated ${key} and ${csr}"
done
