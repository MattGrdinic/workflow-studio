# Workflow Studio

A node-based workflow studio for AI-powered Jira, Slack, and process composition.

## Quick Start

```bash
npm install
npm run build
npm start
```

Open http://127.0.0.1:4317 and configure your credentials (Jira, Slack, ADO) in the browser UI.

## Development

```bash
git checkout -b my-feature    # 1. Create a branch
npm run build && npm start    # 2. Build and test locally
git add . && git commit       # 3. Commit your changes
git push origin my-feature    # 4. Push and open a PR
```

## Releasing

Releases are fully automated. When you merge to `main`:

1. Bump the `version` in `package.json` (e.g., `1.0.1`)
2. Merge your PR to `main`
3. GitHub Actions automatically builds Mac + Windows desktop apps and publishes a GitHub Release

That's it. No manual build steps, no tagging, no uploading.

### App Icon

Drop your design as `assets/icon-source.png` (square, at least 1024x1024). The build generates macOS and Windows icons from it automatically.

## Installing (End Users)

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/MattGrdinic/workflow-studio/main/install.sh | sh
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/MattGrdinic/workflow-studio/main/install.ps1 | iex
```

Or download the desktop app directly from [Releases](https://github.com/MattGrdinic/workflow-studio/releases).

## Other Commands

```bash
npm run build && npm run electron:dev   # Build and run the desktop app locally
npm run build && npm start              # Build and run in the browser
npm start -- --port 8080                # Custom port
npm start -- --debug                    # Verbose logging
npm start -- --run -g plan.json         # Run a workflow without the UI
```

## Prerequisites

- Node.js 20+
- Claude CLI installed and authenticated (`claude auth login`)
- For Bedrock auth: `aws sso login --sso-session <profile>`
