#!/usr/bin/env bash
set -euo pipefail

# Resolve the project root (parent of this script's directory)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

IMAGE="${IMAGE:-workflow-studio:latest}"
PORT="${PORT:-4317}"
AWS_PROFILE="${AWS_PROFILE:-default}"
AWS_REGION="${AWS_REGION:-us-east-1}"

if [[ ! -d "${HOME}/.aws" ]]; then
  echo "[run-bedrock-docker] Error: ${HOME}/.aws was not found."
  echo "[run-bedrock-docker] Run 'aws sso login --profile ${AWS_PROFILE}' on host first."
  exit 1
fi

mkdir -p "${PROJECT_ROOT}/data" "${PROJECT_ROOT}/certs"

echo "[run-bedrock-docker] Using AWS_PROFILE=${AWS_PROFILE}, AWS_REGION=${AWS_REGION}"
echo "[run-bedrock-docker] Claude CLI will authenticate via Bedrock (no claude auth login needed)."

docker run --rm -it \
  -p "${PORT}:${PORT}" \
  -e AWS_PROFILE="${AWS_PROFILE}" \
  -e AWS_REGION="${AWS_REGION}" \
  -e CLAUDE_CODE_USE_BEDROCK=1 \
  -v "${HOME}/.aws:/home/node/.aws:ro" \
  -v "${PROJECT_ROOT}/data:/app/data" \
  -v "${PROJECT_ROOT}/certs:/app/certs" \
  "${IMAGE}" \
  node dist/cli.js --host 0.0.0.0 --port "${PORT}" "$@"
