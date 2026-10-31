# ==============================================================================
# Event Horizon: Singularity — Air-Gapped & On-Premises Enclave Dockerfile
# Multi-Stage Build: Vite Frontend Builder + Node 22-Alpine Express API Host
# ==============================================================================

# ── Stage 1: Build Frontend Vite Application ──────────────────────────────────
# Base image pinned by digest (the multi-arch index of node:22-alpine, resolved 2026-10-30). Refreshed deliberately in a pull request: docs/ON_PREM_DATABASE.md "Releases".
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS builder
WORKDIR /app

# Copy dependency manifests and install full development dependencies
COPY package*.json ./
RUN npm ci

# Copy full repository source and build production static bundle
COPY . .
# The git commit of this build, stamped into the UI bundle (docker build --build-arg BUILD_COMMIT=$(git rev-parse HEAD))
ARG BUILD_COMMIT=dev
ENV BUILD_COMMIT=$BUILD_COMMIT
RUN npm run build

# ── Stage 2: Production Air-Gapped / On-Premises Runtime ──────────────────────
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runner
WORKDIR /app

# Set default production environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV STORAGE_PROVIDER=local
ENV LOCAL_STORAGE_PATH=/app/data/evidence

# Reported by GET /api/v1/health (buildCommit); the ARG must be redeclared because each stage starts clean
ARG BUILD_COMMIT=dev
ENV BUILD_COMMIT=$BUILD_COMMIT

# Copy production package manifests and install production-only dependencies. tsx (and the esbuild it uses) is a production dependency, installed here from package-lock.json by integrity hash; there is no global npm install (tests/onPremOnly.test.ts checks this).
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled frontend distribution from builder
COPY --from=builder /app/dist ./dist

# Copy backend server code, TypeScript configuration, and source definitions
COPY --from=builder /app/server ./server
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig*.json ./

# Operational scripts (e.g. `npm run auth:create-user` for the air-gapped local accounts)
COPY --from=builder /app/scripts ./scripts

# Run as the unprivileged node user (uid 1000) from here on (#146). A bind-mounted EVIDENCE_DIR must be writable by uid 1000: docs/ON_PREM_DATABASE.md "Host paths".
RUN mkdir -p /app/data/evidence && chown -R node:node /app/data
USER node

# Expose default application port
EXPOSE 3000

# Health check verifying API responsiveness
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/v1/health || exit 1

# Start Event Horizon: Singularity Express Server & Static Host. tsx comes from node_modules (package-lock.json), not a global install;
# its loader is passed to the server (and to the forked SSP extraction child) through execArgv.
CMD ["node_modules/.bin/tsx", "server/index.ts"]
