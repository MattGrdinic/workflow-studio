# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY data ./data

RUN npm run build \
  && npm prune --omit=dev \
  && mkdir -p certs data/Output data/workflows

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends awscli ca-certificates \
  && npm install -g @anthropic-ai/claude-code \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/data ./data
COPY --from=build /app/certs ./certs
COPY docker/docker-entrypoint.sh /usr/local/bin/workflow-studio-entrypoint

RUN chmod +x /usr/local/bin/workflow-studio-entrypoint

RUN chown -R node:node /app
USER node

EXPOSE 4317

ENTRYPOINT ["/usr/local/bin/workflow-studio-entrypoint"]
CMD ["node", "dist/cli.js", "--host", "0.0.0.0"]
