# Workflow Studio

A node-based workflow studio for AI-powered Jira, Slack, and process composition.

## Quick Start

```bash
npm install
npm run build
npm start
```

Open http://127.0.0.1:4317 and configure your credentials (Jira, Slack, ADO) in the browser UI.

## Day-to-Day Development

```bash
# 1. Create a feature branch
git checkout -b my-feature

# 2. Make your changes, then build and run locally
npm run build
npm start

# 3. When happy, commit and push
git add .
git commit -m "Description of changes"
git push origin my-feature
```

## Releasing a Desktop App

When you're ready to distribute a new version:

```bash
# 1. Build the desktop app (generates icons + bundles everything)
npm run electron:dist:mac    # macOS .dmg
npm run electron:dist:win    # Windows installer

# 2. Tag the release
git tag v1.x.x
git push origin main --tags

# 3. Create a GitHub Release and attach the files from release/
```

The built installers will be in the `release/` folder.

### App Icon

Drop your icon as `assets/icon-source.png` (square, at least 1024x1024). The build automatically generates the macOS and Windows icon formats from it.

## Other Useful Commands

```bash
npm run electron:dev          # Launch the desktop app locally (no packaging)
npm start -- --port 8080      # Custom port
npm start -- --debug          # Verbose logging
npm start -- --run -g plan.json  # Run a workflow without the UI
```

## Prerequisites

- Node.js 20+
- Claude CLI installed and authenticated (`claude auth login`)
- For Bedrock auth: `aws sso login --sso-session <profile>`
