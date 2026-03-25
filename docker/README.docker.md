# Workflow Studio (Docker)

Docker run guide for Workflow Studio. Authentication is via AWS Bedrock.

For local Node usage, see [../README.md](../README.md).

All commands below should be run from the project root.

## One-Time Setup

```bash
docker build -t workflow-studio:latest -f docker/Dockerfile .
aws sso login --sso-session <AWSProfileName>
```

## Setup Wizard (Jira + ADO credentials)

```bash
AWS_PROFILE=<AWSProfileName> AWS_REGION=us-west-2 ./docker/run-bedrock-docker.sh --setup
```

This configures Jira and Azure DevOps credentials, encrypted and saved to `data/`.

## Start (Bedrock)

```bash
AWS_PROFILE=<AWSProfileName> AWS_REGION=us-west-2 ./docker/run-bedrock-docker.sh
```

Open http://127.0.0.1:4317

## Start with Docker Compose

```bash
AWS_PROFILE=<AWSProfileName> AWS_REGION=us-west-2 docker compose -f docker/docker-compose.yml up --build
```

Stop:

```bash
docker compose -f docker/docker-compose.yml down
```

## If AI Preflight Fails

Your AWS SSO session has likely expired. Re-authenticate:

```bash
aws sso login --sso-session <AWSProfileName>
AWS_PROFILE=<AWSProfileName> AWS_REGION=us-west-2 ./docker/run-bedrock-docker.sh
```
