# dsh_ai1net — control-plane orchestrator image.
#
# Runs the Fastify orchestrator (authentication, per-user DSH supervision,
# desktop/domain APIs). It can run standalone against SQLite, or be scaled out
# behind a shared Postgres database plus a shared encryption secret.
#
# Base image: node:22-slim (Node 22 LTS; engines ^22.19.0). For reproducible
# production builds, pin the digest and pass it via --build-arg:
#   docker pull node:22-slim
#   docker images --no-trunc node:22-slim --format '{{.Digest}}'
#   docker build --build-arg NODE_IMAGE=node:22-slim@sha256:<digest> .
ARG NODE_IMAGE=node:22-slim

# --- build stage: compile src/ -> lib/ (needs devDeps + native build tools) ---
FROM ${NODE_IMAGE} AS build
# better-sqlite3 ships prebuilds; keep build tools as a node-gyp fallback.
# Build stage only, so the runtime stage stays slim.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Copy manifests + source before `npm ci`: its `prepare` hook runs `npm run
# build`, which needs src/ present.
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build && npm prune --omit=dev

# --- runtime stage: prod deps + lib + web, non-root ---
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/lib ./lib
COPY web ./web
COPY cordis.patch.yml ./
# npm is build-only: drop it (and its bundled deps) from the runtime image —
# they carry their own CVEs (brace-expansion/tar/sigstore/...) and bloat.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
# Non-root uid 65532, matching manual/architecture.md (PSA restricted-friendly).
RUN groupadd --gid 65532 dsh \
  && useradd --uid 65532 --gid dsh --home-dir /home/dsh --create-home --shell /usr/sbin/nologin dsh
USER dsh
EXPOSE 3080
ENTRYPOINT ["node", "lib/cli.js"]
