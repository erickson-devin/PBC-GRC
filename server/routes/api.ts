import { Router } from 'express';
import authRouter from './auth';
import invitesRouter from './invites';
import vmIngestRouter from './vmIngest';
import controlsRouter from './controls';
import evidenceRouter from './evidence';
import objectivesRouter from './objectives';
import sspMetadataRouter from './sspMetadata';
import tenantsRouter, { createTenantHandler, listMyTenantsHandler } from './tenants';
import { authMiddleware, authOnlyMiddleware } from '../middleware/authMiddleware';
import { programContext } from '../middleware/programContext';
import { getDatabaseStatus, isDbReady } from '../db';
import { APP_VERSION } from '../version';
import { isPlatformAdminUser, platformAdminEmails } from '../auth/platformAdmin';
import { listStoredPlatformAdminEmails } from '../platformSetup';
import setupRouter from './setup';
import platformUsersRouter from './platformUsers';
import platformAccountEventsRouter from './platformAccountEvents';

const router = Router();

// Health Check endpoint (liveness/readiness probe). 503 when PostgreSQL is configured but unreachable.
router.get('/health', async (_req, res) => {
  // The server listens before initDb has finished: not ready to serve yet
  if (!isDbReady()) {
    res.status(503).json({ status: 'starting' });
    return;
  }
  const database = await getDatabaseStatus();
  const healthy = database !== 'unavailable';
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    service: 'pbc-grc-api',
    version: APP_VERSION, // package.json "version"; the image tag is v<version> (docs/ON_PREM_DATABASE.md "Releases")
    buildCommit: process.env.BUILD_COMMIT || 'dev', // set by the Docker build (--build-arg BUILD_COMMIT=<git sha>)
    database, // 'connected' | 'memory' (explicit DB_MODE=memory) | 'unavailable'
  });
});

// Public: identity provider discovery and local (air-gapped) login
router.use('/auth', authRouter);

// First-time setup wizard: public, and open only until the first administrator exists (see routes/setup.ts)
router.use('/setup', setupRouter);

// Invitation redemption by the invitee: preview (public, token only) and accept (authenticated)
router.use('/invites', invitesRouter);

// Scanner push (vulnerability management): authenticated by a service token, not a user session, so it sits before authMiddleware
router.use('/vm', vmIngestRouter);

// Who the signed-in user is on this platform. `isPlatformAdmin` is decided by the server (PLATFORM_ADMIN_EMAILS), so the
// UI shows the administration console only to people the server will actually let use it.
router.get('/me', authOnlyMiddleware, async (req, res) => {
  const user = req.user!;
  res.json({ user: { id: user.uid, email: user.email ?? null, name: user.name ?? null }, isPlatformAdmin: await isPlatformAdminUser(user) });
});

// The platform administrators of this installation, for the administration console. Read-only: they are configured on
// the server (PLATFORM_ADMIN_EMAILS) or created by the first-time setup wizard, not through this API. Visible only to administrators.
router.get('/platform/admins', authOnlyMiddleware, async (req, res) => {
  if (!(await isPlatformAdminUser(req.user))) {
    res.status(403).json({ error: 'Forbidden: only a platform administrator can see who the platform administrators are' });
    return;
  }
  const emails = new Set([...platformAdminEmails(), ...(await listStoredPlatformAdminEmails())]);
  res.json({ admins: [...emails].sort().map((email) => ({ email })) });
});

// Local-account administration (reset, disable, enable): platform administrators only, checked inside the router
router.use('/platform/users', authOnlyMiddleware, platformUsersRouter);
// The account event log (password and MFA changes, disable / enable, role changes, sign-out): read-only, platform administrators only
router.use('/platform/account-events', authOnlyMiddleware, platformAccountEventsRouter);

// Listing and creating tenants only need an authenticated user (no tenant context yet): the user discovers the
// tenants they belong to, or creates one and becomes its first TENANT_OWNER.
router.get('/tenants', authOnlyMiddleware, listMyTenantsHandler);
router.post('/tenants', authOnlyMiddleware, createTenantHandler);

// Everything else is protected by authentication AND tenant membership
// Controls and evidence belong to a program (authorization boundary): programContext resolves it from x-program-id (default program without it)
router.use('/controls', authMiddleware, programContext, controlsRouter);
router.use('/objectives', authMiddleware, programContext, objectivesRouter);
router.use('/ssp-metadata', authMiddleware, programContext, sspMetadataRouter);
router.use('/evidence', authMiddleware, programContext, evidenceRouter);
router.use('/tenants', authMiddleware, tenantsRouter);

export default router;
