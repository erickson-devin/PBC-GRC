import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import apiRouter from './routes/api';
import { initDb, assertDbModeAllowed, getDbMode } from './db';
import { assertAuthConfig } from './auth/localAuth';
import { assertStorageConfig, localStorageRoot } from './evidence/storage';
import { errorMessage } from '../src/utils/errors';
import { parseTrustProxy } from './trustProxy';
import { startVmScheduler } from './vm/scheduler';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// APP_PORT wins; PORT is the older name and stays as the fallback.
const PORT = parseInt(process.env.APP_PORT || process.env.PORT || '', 10) || 3000;
// All interfaces by default so the WebUI is reachable on the LAN (Unraid); set APP_BIND_ADDRESS to restrict it.
const BIND_ADDRESS = (process.env.APP_BIND_ADDRESS || '').trim() || '0.0.0.0';

// Honour X-Forwarded-* only from the named proxy address (never a boolean or hop count, see trustProxy.ts)
try {
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
} catch (err: unknown) {
  console.error('[FATAL] Invalid TRUST_PROXY:', errorMessage(err));
  process.exit(1);
}

// Security & Middlewares
app.use(cors({
  origin: true,
  credentials: true,
}));
// The ingest route hashes the exact request bytes, so it reads its own raw body
const jsonParser = express.json({ limit: '15mb' });
app.use((req, res, next) => (req.path.replace(/\/+$/, '').toLowerCase() === '/api/v1/vm/ingest' ? next() : jsonParser(req, res, next)));
app.use(express.urlencoded({ extended: true }));

// Security Response Headers
app.use((_req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Mount API v1 Routes
app.use('/api/v1', apiRouter);

// Serve the built frontend from this same process (single-container mode)
const distPath = path.resolve(__dirname, '../dist');

// Static assets
app.use(express.static(distPath));

// SPA fallback for every non-API request: the app itself decides (login page or app) what an unknown path shows.
// (Express 5 compatible)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }
  res.sendFile(path.join(distPath, 'index.html'), (err) => {
    if (err) {
      res.status(200).send('PBC-GRC API Server is running. Build frontend with `npm run build` to view web app.');
    }
  });
});

// Server Initialization
export const server = app.listen(PORT, BIND_ADDRESS, async () => {
  console.log(`=======================================================`);
  console.log(`🚀 PBC-GRC API Server running on port ${PORT}`);
  console.log(`🔐 RLS Tenant Context: Active (SET LOCAL app.current_tenant_id)`);
  console.log(`📡 Endpoints: /api/v1/auth, /api/v1/tenants, /api/v1/controls, /api/v1/evidence, /api/v1/health`);
  console.log(`=======================================================`);

  // Fail loudly: a server that cannot reach its database (or is misconfigured) must not pretend to be healthy.
  try {
    assertDbModeAllowed();
    assertAuthConfig();
    assertStorageConfig();
    await initDb();
    console.log(`[Startup] Database mode: ${getDbMode()}`);
    console.log(`[Startup] Auth: local accounts | Storage: local (${localStorageRoot()})`);
    if (BIND_ADDRESS === '0.0.0.0' || BIND_ADDRESS === '::') {
      console.log(`[Startup] Listening on ${BIND_ADDRESS}:${PORT} (all interfaces, so the Unraid WebUI is reachable on the LAN). To restrict access see docs/ON_PREM_DATABASE.md "Network exposure"; multi-factor authentication for 3.5.3 is provided by an external control until Phase 5.9, see docs/VULNERABILITY_MANAGEMENT.md section 2.3.`);
    }
    const vmScheduler = startVmScheduler();
    if (vmScheduler) {
      console.log(`[Startup] VM scheduler: tick every ${vmScheduler.tickMinutes} min, snapshot every ${vmScheduler.snapshotIntervalHours} h`);
    }
    if (process.env.VM_ALLOW_INSECURE_TOKENS === 'true') {
      console.warn('[Startup] VM_ALLOW_INSECURE_TOKENS=true: service tokens may be created over plain HTTP and will cross the network in clear text');
    }
  } catch (err: unknown) {
    console.error('\n[FATAL] Server cannot start:', errorMessage(err));
    console.error('        Set DATABASE_URL / DB_* for PostgreSQL, or DB_MODE=memory for local development only.\n');
    server.close();
    process.exit(1);
  }
});

export default app;
