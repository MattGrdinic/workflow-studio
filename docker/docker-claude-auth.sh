#!/usr/bin/env bash
set -euo pipefail

# Resolve the project root (parent of this script's directory)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

IMAGE="${IMAGE:-workflow-studio:latest}"
CLAUDE_STATE_DIR="${PROJECT_ROOT}/.docker/claude"
CLAUDE_STATE_FILE="${PROJECT_ROOT}/.docker/claude.json"

mkdir -p "${CLAUDE_STATE_DIR}"
if [[ ! -f "${CLAUDE_STATE_FILE}" ]]; then
  printf '{}\n' > "${CLAUDE_STATE_FILE}"
fi

echo "[docker-claude-auth] Starting containerized Claude login flow..."
echo "[docker-claude-auth] Complete login in browser when prompted."

docker run --rm -it \
  -v "${CLAUDE_STATE_DIR}:/home/node/.claude" \
  -v "${CLAUDE_STATE_FILE}:/home/node/.claude.json" \
  "${IMAGE}" \
  sh -lc 'claude auth login'

echo "[docker-claude-auth] Verifying auth status..."
docker run --rm \
  -v "${CLAUDE_STATE_DIR}:/home/node/.claude" \
  -v "${CLAUDE_STATE_FILE}:/home/node/.claude.json" \
  "${IMAGE}" \
  sh -lc 'claude auth status --text'
