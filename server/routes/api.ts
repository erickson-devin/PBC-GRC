import { Router } from 'express';
import authRouter from './auth';
import invitesRouter from './invites';
import controlsRouter from './controls';
import evidenceRouter from './evidence';
import tenantsRouter, { createTenantHandler, listMyTenantsHandler } from './tenants';
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

// Invitation redemption by the invitee: preview (public, token only) and accept (authenticated)
router.use('/invites', invitesRouter);

// Listing and creating tenants only need an authenticated user (no tenant context yet): the user discovers the
// tenants they belong to, or creates one and becomes its first TENANT_OWNER.
router.get('/tenants', authOnlyMiddleware, listMyTenantsHandler);
router.post('/tenants', authOnlyMiddleware, createTenantHandler);

// Everything else is protected by authentication AND tenant membership
router.use('/controls', authMiddleware, controlsRouter);
router.use('/evidence', authMiddleware, evidenceRouter);
router.use('/tenants', authMiddleware, tenantsRouter);

export default router;
