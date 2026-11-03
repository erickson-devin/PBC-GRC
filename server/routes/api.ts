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
import { ProgramError } from '../programs';
import { errorMessage } from '../../src/utils/errors';
import { getUserDefaultProgramId, resolveLandingProgramId, setUserDefaultProgram } from '../userProgramDefaults';
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

// The signed-in user's personal default program in the active tenant (x-tenant-id, membership checked by authMiddleware). A preference
// of the user, not a change to the tenant's data: every role may set it, so it does not go through the write guard.
// GET -> { programId, landingProgramId } (the picked default, and the program they land in: own default, else the organization default,
// else the oldest active program, else null). PUT { programId: string | null } sets or clears it; 404 program_not_found (unknown, or
// another tenant's), 409 program_archived.
router.get('/me/default-program', authMiddleware, async (req, res) => {
  const tenantId = req.tenantId!;
  const userId = req.user!.uid;
  try {
    res.json({ programId: await getUserDefaultProgramId(tenantId, userId), landingProgramId: await resolveLandingProgramId(tenantId, userId) });
  } catch (err: unknown) {
    console.error('[Me API] Failed to read the default program:', errorMessage(err));
    res.status(500).json({ error: 'Failed to read the default program' });
  }
});
router.put('/me/default-program', authMiddleware, async (req, res) => {
  const tenantId = req.tenantId!;
  const userId = req.user!.uid;
  const programId: unknown = (req.body ?? {}).programId;
  if (programId !== null && typeof programId !== 'string') {
    res.status(400).json({ error: 'Invalid programId: expected a program id or null' });
    return;
  }
  try {
    await setUserDefaultProgram(tenantId, userId, programId);
    res.json({ programId, landingProgramId: await resolveLandingProgramId(tenantId, userId) });
  } catch (err: unknown) {
    if (err instanceof ProgramError && (err.code === 'program_not_found' || err.code === 'program_archived')) {
      res.status(err.code === 'program_not_found' ? 404 : 409).json({ error: err.message, code: err.code });
      return;
    }
    console.error('[Me API] Failed to set the default program:', errorMessage(err));
    res.status(500).json({ error: 'Failed to set the default program' });
  }
});

// Everything else is protected by authentication AND tenant membership
// Controls and evidence belong to a program (authorization boundary): programContext resolves it from x-program-id (the organization default
// program without it; 409 program_required when the tenant has no program yet)
router.use('/controls', authMiddleware, programContext, controlsRouter);
router.use('/objectives', authMiddleware, programContext, objectivesRouter);
router.use('/ssp-metadata', authMiddleware, programContext, sspMetadataRouter);
router.use('/evidence', authMiddleware, programContext, evidenceRouter);
router.use('/tenants', authMiddleware, tenantsRouter);

export default router;
