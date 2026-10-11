import { Router } from 'express';
import controlsRouter from './controls';
import evidenceRouter from './evidence';
import tenantsRouter from './tenants';
import { authMiddleware } from '../middleware/authMiddleware';
import { checkDatabaseConnection } from '../db';

const router = Router();

// Health Check endpoint (Cloud Run liveness/readiness probe)
router.get('/health', async (_req, res) => {
  const dbStatus = await checkDatabaseConnection();
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'pbc-grc-api',
    version: '1.0.0',
    database: dbStatus ? 'connected' : 'fallback-mode',
  });
});

// Protect all /controls, /evidence and /tenants routes with Firebase Auth & tenant attachment
router.use('/controls', authMiddleware, controlsRouter);
router.use('/evidence', authMiddleware, evidenceRouter);
router.use('/tenants', authMiddleware, tenantsRouter);

export default router;
