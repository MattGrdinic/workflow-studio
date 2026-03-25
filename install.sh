#!/bin/sh
set -e

REPO="MattGrdinic/workflow-studio"
INSTALL_DIR="${WORKFLOW_STUDIO_INSTALL_DIR:-/usr/local/lib/workflow-studio}"
BIN_LINK="/usr/local/bin/workflow-studio"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()  { printf "\033[1;34m==>\033[0m %s\n" "$1"; }
error() { printf "\033[1;31mError:\033[0m %s\n" "$1" >&2; exit 1; }

need_cmd() {
  if ! command -v "$1" > /dev/null 2>&1; then
    error "'$1' is required but not found. Please install it and try again."
  fi
}

# ---------------------------------------------------------------------------
# Detect OS / arch
# ---------------------------------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) ;;
  Linux)  ;;
  *)      error "Unsupported operating system: $OS. Use install.ps1 for Windows." ;;
esac

# ---------------------------------------------------------------------------
# Check for Node.js >= 20
# ---------------------------------------------------------------------------
check_node() {
  if command -v node > /dev/null 2>&1; then
    NODE_VERSION="$(node -v | sed 's/^v//')"
    NODE_MAJOR="$(echo "$NODE_VERSION" | cut -d. -f1)"
    if [ "$NODE_MAJOR" -ge 20 ]; then
      info "Node.js v$NODE_VERSION detected"
      return 0
    else
      info "Node.js v$NODE_VERSION found, but v20+ is required"
      return 1
    fi
  else
    info "Node.js not found"
    return 1
  fi
}

install_node() {
  info "Installing Node.js 20 via nvm..."

  if ! command -v nvm > /dev/null 2>&1; then
    if [ -s "$HOME/.nvm/nvm.sh" ]; then
      . "$HOME/.nvm/nvm.sh"
    else
      info "Installing nvm..."
      need_cmd curl
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | sh
      export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
      . "$NVM_DIR/nvm.sh"
    fi
  fi

  nvm install 20
  nvm use 20
}

if ! check_node; then
  install_node
  if ! check_node; then
    error "Failed to install Node.js >= 20. Please install it manually: https://nodejs.org"
  fi
fi

need_cmd npm

# ---------------------------------------------------------------------------
# Determine latest release tag
# ---------------------------------------------------------------------------
need_cmd curl

info "Fetching latest release..."
LATEST_TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
  | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"//;s/".*//')" || true

if [ -z "$LATEST_TAG" ]; then
  # No releases yet — fall back to main branch tarball
  info "No releases found, using main branch"
  TARBALL_URL="https://github.com/$REPO/archive/refs/heads/main.tar.gz"
  STRIP_DIR="workflow-studio-main"
else
  info "Latest release: $LATEST_TAG"
  TARBALL_URL="https://github.com/$REPO/releases/download/$LATEST_TAG/workflow-studio-$LATEST_TAG.tar.gz"
  STRIP_DIR="workflow-studio-$LATEST_TAG"

  # If the release asset doesn't exist, fall back to source archive
  if ! curl -fsSL --head "$TARBALL_URL" > /dev/null 2>&1; then
    TARBALL_URL="https://github.com/$REPO/archive/refs/tags/$LATEST_TAG.tar.gz"
    STRIP_DIR="workflow-studio-$(echo "$LATEST_TAG" | sed 's/^v//')"
  fi
fi

# ---------------------------------------------------------------------------
# Download and extract
# ---------------------------------------------------------------------------
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

info "Downloading $TARBALL_URL..."
curl -fsSL "$TARBALL_URL" -o "$TMP_DIR/workflow-studio.tar.gz"

info "Extracting..."
tar -xzf "$TMP_DIR/workflow-studio.tar.gz" -C "$TMP_DIR"

# Find the extracted directory (handles varying strip-components)
SRC_DIR="$(find "$TMP_DIR" -maxdepth 1 -type d ! -name "$(basename "$TMP_DIR")" | head -1)"
if [ -z "$SRC_DIR" ]; then
  error "Failed to extract archive"
fi

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
info "Installing to $INSTALL_DIR..."

if [ -d "$INSTALL_DIR" ]; then
  sudo rm -rf "$INSTALL_DIR"
fi

sudo mkdir -p "$INSTALL_DIR"
sudo cp -R "$SRC_DIR/." "$INSTALL_DIR/"

cd "$INSTALL_DIR"
info "Installing dependencies..."
sudo npm install --production 2>/dev/null || sudo npm install --omit=dev

if [ ! -d "$INSTALL_DIR/dist" ]; then
  info "Building from source..."
  sudo npm install
  sudo npm run build
fi

# Create symlink
sudo mkdir -p "$(dirname "$BIN_LINK")"
sudo ln -sf "$INSTALL_DIR/dist/cli.js" "$BIN_LINK"
sudo chmod +x "$INSTALL_DIR/dist/cli.js"

# ---------------------------------------------------------------------------
# Save version marker (used for update checks)
# ---------------------------------------------------------------------------
VERSION_LABEL="${LATEST_TAG:-main}"
echo "$VERSION_LABEL" | sudo tee "$INSTALL_DIR/.installed-version" > /dev/null

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
printf "\n"
printf "\033[1;32m  Workflow Studio (%s) installed successfully!\033[0m\n" "$VERSION_LABEL"
printf "\n"
printf "  \033[1mGet started:\033[0m\n"
printf "    workflow-studio              Launch the browser UI at http://127.0.0.1:4317\n"
printf "    workflow-studio --help       Show all options\n"
printf "\n"
printf "  Configure Jira, Slack & ADO credentials in the browser UI.\n"
printf "\n"
printf "  \033[1mUpdate to latest version:\033[0m\n"
printf "    curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | sh\n"
printf "\n"
printf "  \033[1mUninstall:\033[0m\n"
printf "    sudo rm -rf $INSTALL_DIR $BIN_LINK\n"
printf "\n"
