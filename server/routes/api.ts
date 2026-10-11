import { Router } from 'express';
import authRouter from './auth';
import controlsRouter from './controls';
import evidenceRouter from './evidence';
import tenantsRouter, { createTenantHandler } from './tenants';
import { authMiddleware, authOnlyMiddleware } from '../middleware/authMiddleware';
import { getDatabaseStatus } from '../db';

const router = Router();

// Health Check endpoint (liveness/readiness probe). 503 when PostgreSQL is configured but unreachable.
router.get('/health', async (_req, res) => {
  const database = await getDatabaseStatus();
  const healthy = database !== 'unavailable';
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    service: 'pbc-grc-api',
    version: '1.0.0',
    database, // 'connected' | 'memory' (explicit DB_MODE=memory) | 'unavailable'
  });
});

// Public: identity provider discovery and local (air-gapped) login
router.use('/auth', authRouter);

// Creating a tenant only needs an authenticated user: they have no tenant yet and become its first TENANT_OWNER.
router.post('/tenants', authOnlyMiddleware, createTenantHandler);

// Everything else is protected by authentication AND tenant membership
router.use('/controls', authMiddleware, controlsRouter);
router.use('/evidence', authMiddleware, evidenceRouter);
router.use('/tenants', authMiddleware, tenantsRouter);

export default router;
