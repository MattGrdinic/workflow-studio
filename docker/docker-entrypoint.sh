#!/usr/bin/env bash
set -euo pipefail

pick_ca_cert() {
  local cert_file=""
  if [[ -n "${NODE_EXTRA_CA_CERTS:-}" && -f "${NODE_EXTRA_CA_CERTS}" ]]; then
    return 0
  fi

  if [[ -f "/app/certs/ca-cert.pem" ]]; then
    cert_file="/app/certs/ca-cert.pem"
  else
    cert_file="$(find /app/certs -maxdepth 1 -type f \( -name '*.pem' -o -name '*.crt' -o -name '*.cer' \) | head -n 1 || true)"
  fi

  if [[ -n "${cert_file}" ]]; then
    export NODE_EXTRA_CA_CERTS="${cert_file}"
    echo "[entrypoint] Using custom CA certificate: ${NODE_EXTRA_CA_CERTS}"
  fi
}

check_claude_auth() {
  # When using Bedrock, Claude authenticates via AWS credentials — skip Claude auth check
  if [[ -n "${CLAUDE_CODE_USE_BEDROCK:-}" ]]; then
    echo "[entrypoint] Bedrock mode — Claude will authenticate via AWS credentials."
    return 0
  fi

  if ! command -v claude >/dev/null 2>&1; then
    return 0
  fi

  local status
  status="$(claude auth status --output json 2>/dev/null || true)"

  if [[ -n "${status}" && "${status}" != *'"loggedIn":true'* ]]; then
    if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
      echo "[entrypoint] Claude auth status: not logged in, but ANTHROPIC_API_KEY is set."
    else
      echo "[entrypoint] Claude auth status: not logged in."
      echo "[entrypoint] Mount ~/.claude and ~/.claude.json from host, or set ANTHROPIC_API_KEY."
    fi
  fi
}

pick_ca_cert
check_claude_auth

exec "$@"
