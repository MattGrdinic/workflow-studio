#!/usr/bin/env bash
set -euo pipefail

# Workflow Studio — First-Run Bootstrap
# Creates the required directory structure and validates prerequisites.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WS_BASE="$SCRIPT_DIR/data"

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { printf "${CYAN}%s${NC}\n" "$1"; }
success() { printf "${GREEN}%s${NC}\n" "$1"; }
warn()    { printf "${YELLOW}%s${NC}\n" "$1"; }
fail()    { printf "${RED}%s${NC}\n" "$1"; exit 1; }

echo ""
info "=== Workflow Studio — First-Run Bootstrap ==="
echo ""

# ── Prerequisites ──────────────────────────────────────────────

info "Checking prerequisites..."

# Node.js 20+
if ! command -v node &>/dev/null; then
  fail "Node.js is not installed. Please install Node.js 20+ from https://nodejs.org"
fi
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js 20+ required (found v$(node -v)). Please upgrade."
fi
success "  Node.js v$(node -v | tr -d 'v') — OK"

# npm
if ! command -v npm &>/dev/null; then
  fail "npm is not installed."
fi
success "  npm v$(npm -v) — OK"

# claude CLI (optional but recommended)
if command -v claude &>/dev/null; then
  success "  claude CLI — found"
else
  warn "  claude CLI — not found (optional; needed for AI node execution)"
fi

echo ""

# ── Directory Structure ────────────────────────────────────────

info "Creating directory structure..."

dirs=(
  "$WS_BASE/Jira/config"
  "$WS_BASE/Slack/config"
  "$WS_BASE/Skills/generic"
  "$WS_BASE/Skills/CAT2.0Claims"
  "$WS_BASE/Output"
  "$WS_BASE/workflows"
)

for d in "${dirs[@]}"; do
  mkdir -p "$d"
done

success "  Directories created"

# ── Install Dependencies ───────────────────────────────────────

info "Installing dependencies..."
cd "$SCRIPT_DIR"
if [ ! -d node_modules ]; then
  npm install
  success "  Dependencies installed"
else
  success "  Dependencies already present"
fi

# ── Build ──────────────────────────────────────────────────────

info "Building from source..."
npm run build
success "  Build complete — dist/cli.js ready"

echo ""

# ── Summary ────────────────────────────────────────────────────

success "=== Bootstrap complete ==="
echo ""
info "Next steps:"
echo "  1. Run the setup wizard to configure Jira / Slack credentials:"
echo "       node dist/cli.js --setup"
echo ""
echo "  2. Launch the browser UI:"
echo "       node dist/cli.js"
echo ""
echo "  3. Or run a saved workflow headlessly:"
echo "       node dist/cli.js --run -g data/workflows/my-graph.json"
echo ""
