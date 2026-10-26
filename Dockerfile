# ==============================================================================
# Event Horizon: Singularity — Air-Gapped & On-Premises Enclave Dockerfile
# Multi-Stage Build: Vite Frontend Builder + Node 22-Alpine Express API Host
# ==============================================================================

# ── Stage 1: Build Frontend Vite Application ──────────────────────────────────
# Node pinned to 22.23.3: 22.23.4 (2026-10-21) segfaults the PDF extraction worker thread, which takes the whole server
# process down. Unpin once PDF extraction runs in a child process (docs/VULNERABILITY_MANAGEMENT.md section 11).
FROM node:22.23.3-alpine AS builder
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
FROM node:22.23.3-alpine AS runner
WORKDIR /app

# Set default production environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV STORAGE_PROVIDER=local
ENV LOCAL_STORAGE_PATH=/app/data/evidence

# Reported by GET /api/v1/health (buildCommit); the ARG must be redeclared because each stage starts clean
ARG BUILD_COMMIT=dev
ENV BUILD_COMMIT=$BUILD_COMMIT

# Create local evidence storage directory
RUN mkdir -p /app/data/evidence

# Copy production package manifests and install production-only dependencies
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

# Install tsx globally for fast, zero-transpile Node ESM execution
RUN npm install -g tsx

# Expose default application port
EXPOSE 3000

# Health check verifying API responsiveness
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/v1/health || exit 1

# Start Event Horizon: Singularity Express Server & Static Host
CMD ["tsx", "server/index.ts"]
