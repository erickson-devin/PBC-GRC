import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import apiRouter from './routes/api';
import { initDb, assertDbModeAllowed, getDbMode } from './db';
import { assertAuthConfig, isLocalAuthMode } from './auth/localAuth';
import { errorMessage } from '../src/utils/errors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Security & Middlewares
app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json({ limit: '15mb' }));
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

// Serve Frontend in Production or Single-Container Cloud Run Mode
const distPath = path.resolve(__dirname, '../dist');

// Static assets
app.use(express.static(distPath));

// Clean URLs for Legal Documents
app.get('/privacy', (_req, res) => {
  res.sendFile(path.join(distPath, 'privacy.html'), (err) => {
    if (err) res.sendFile(path.join(distPath, 'index.html'));
  });
});

app.get('/terms', (_req, res) => {
  res.sendFile(path.join(distPath, 'terms.html'), (err) => {
    if (err) res.sendFile(path.join(distPath, 'index.html'));
  });
});

// SPA Fallback for non-API requests (Express 5 compatible)
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
export const server = app.listen(PORT, async () => {
  console.log(`=======================================================`);
  console.log(`🚀 PBC-GRC Cloud SQL Express API Server running on port ${PORT}`);
  console.log(`🔐 RLS Tenant Context: Active (SET LOCAL app.current_tenant_id)`);
  console.log(`📡 Endpoints: /api/v1/auth, /api/v1/tenants, /api/v1/controls, /api/v1/evidence, /api/v1/health`);
  console.log(`=======================================================`);

  // Fail loudly: a server that cannot reach its database (or is misconfigured) must not pretend to be healthy.
  try {
    assertDbModeAllowed();
    assertAuthConfig();
    await initDb();
    console.log(`[Startup] Database mode: ${getDbMode()} | Auth mode: ${isLocalAuthMode() ? 'local (air-gapped)' : 'firebase'}`);
  } catch (err: unknown) {
    console.error('\n[FATAL] Server cannot start:', errorMessage(err));
    console.error('        Set DATABASE_URL / DB_* for PostgreSQL, or DB_MODE=memory for local development only.\n');
    server.close();
    process.exit(1);
  }
});

export default app;
