# Workflow Studio (Local)

Local run guide for Workflow Studio.

For Docker usage, see [docker/README.docker.md](docker/README.docker.md).

## Prerequisites

- Node.js 20+
- Claude CLI installed and authenticated (`claude auth login`)

## Start Locally

```bash
npm install
npm run build
node dist/cli.js --setup
node dist/cli.js
```

Open http://127.0.0.1:4317

## Setup Process

Run once (or anytime you want to update settings):

```bash
node dist/cli.js --setup
```

The setup wizard configures:

- Jira base URL, email, and API token
- Slack webhook (optional)
- CA certificate path for corporate proxy environments (optional)

Credentials are stored under `data/` (encrypted env files + keyfile). After setup, launch with `node dist/cli.js`.

## Optional: Bedrock Auth

If your Claude setup uses AWS Bedrock:

```bash
aws sso login --sso-session <AwsProfileName>
```

## Common Commands

```bash
# custom port
node dist/cli.js --port 8080

# headless run
node dist/cli.js --run -g data/workflows/my-graph.json

# debug logs
node dist/cli.js --debug
```
