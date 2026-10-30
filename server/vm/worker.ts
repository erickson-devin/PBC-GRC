import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { countAssets, createAgentReportedAsset, listAgentAssetCandidates, MAX_ASSETS_PER_TENANT, recordAgentReport } from '../assets';
import { localStorageRoot, resolveTenantLocalPath } from '../evidence/storage';
import { errorMessage } from '../../src/utils/errors';
import { resolveVmTargetProgram } from '../programs';
import type { VmRun } from '../../src/types/vm';
import { normalizeWazuh, type NormalizedHost } from './adapters/wazuh';
import { kindKey, planAssetMatches } from './assetMatch';
import {
  insertMissingVulns,
  insertPoamItems,
  insertSightings,
  listPoamCandidates,
  loadFindingsForAssets,
  loadKevVulnIds,
  loadSightedBySource,
  markRunNormalized,
  saveFindings,
  withVmTenantTx,
} from './findingsStore';
import { VM_SHUTDOWN_MESSAGE } from '../shutdown';
import { validateIngestPayload } from './ingestSchema';
import { getRun, listUnfinishedRuns, updateRun } from './store';
import { applyRun, getVmSlaConfig, isPoamAutocreateEnabled, planPoamItems, staleRunsToRecover, VM_WORKER_ACTOR, type ReportedHost } from './transitions';

/**
 * Normalizes received runs (docs/VULNERABILITY_MANAGEMENT.md, section 6): read the stored payload, verify it, match its hosts to
 * assets, apply the run to the findings and write everything in ONE tenant transaction. Runs are processed one at a time.
 * A failure writes only a generic message to the run (viewers read it): never a payload value.
 */

const active = new Set<string>();
const controllers = new Map<string, { controller: AbortController; tenantId: string }>();
/** Set by the shutdown: nothing new starts, so a run still queued stays RECEIVED and is recovered after the restart. */
let stopping = false;
let chain: Promise<void> = Promise.resolve();
const STALE_AFTER_MS = 2 * 60 * 1000;

/** Test hook: makes the worker throw after the findings and sightings were written, to prove nothing of the run survives. */
let faultForTests: 'after_save' | 'interrupt_after_save' | null = null;

export function __setVmWorkerFaultForTests(fault: 'after_save' | 'interrupt_after_save' | null): void {
  faultForTests = fault;
}

/** Test hook: resolves when every run enqueued so far has been processed. */
export async function __drainVmWorkerForTests(): Promise<void> {
  await chain;
}

export const isVmRunActive = (runId: string): boolean => active.has(runId);

/** The runs queued or running, for the shutdown. */
export function activeVmRuns(): Array<{ id: string; tenantId: string }> {
  return [...controllers].map(([id, c]) => ({ id, tenantId: c.tenantId }));
}

/** Shutdown: stops the runs at their next checkpoint and refuses new ones. */
export function abortVmRuns(): void {
  stopping = true;
  for (const c of controllers.values()) c.controller.abort();
}

/** Test hook: lets the worker accept runs again after abortVmRuns. */
export function __resumeVmWorkerForTests(): void {
  stopping = false;
}

export function enqueueVmRun(tenantId: string, runId: string): void {
  if (stopping || active.has(runId)) return;
  active.add(runId);
  controllers.set(runId, { controller: new AbortController(), tenantId });
  chain = chain
    .then(() => processRun(tenantId, runId))
    .catch((err: unknown) => console.error('[VM Worker]', errorMessage(err)))
    .finally(() => {
      active.delete(runId);
      controllers.delete(runId);
    });
}

/**
 * A run still unfinished with no worker for it (the server restarted while it ran) is started again: its payload is still in
 * the vault. Called lazily on ingest and when a tenant's runs are listed, because on PostgreSQL a run can only be read in its
 * tenant's context.
 */
export async function recoverStaleRuns(tenantId: string): Promise<void> {
  try {
    const runs = await listUnfinishedRuns(tenantId);
    for (const run of staleRunsToRecover(runs, Date.now(), isVmRunActive, STALE_AFTER_MS)) enqueueVmRun(tenantId, run.id);
  } catch (err: unknown) {
    console.error('[VM Worker] could not recover stale runs:', errorMessage(err));
  }
}

// ------------------------------------------------------------------------------------------------ the run

/** A failure the operator can read in the run: the message is fixed text or a validation error, never a payload value. */
class RunFailure extends Error {}
/** The shutdown aborted the run at a checkpoint; inside the transaction the throw rolls everything back. */
class RunInterrupted extends Error {}

const UNREADABLE = 'The stored payload could not be read.';
const GENERIC = 'Normalization failed unexpectedly. Check the server log.';

async function fail(tenantId: string, runId: string, message: string): Promise<void> {
  await updateRun(tenantId, runId, { status: 'FAILED', error: message, finishedAt: new Date().toISOString() }).catch(() => undefined);
}

/** The stored file of a run: its recorded path when that is inside the tenant directory, else the canonical location (the vault may have moved). */
function storedPayloadPath(tenantId: string, run: VmRun): string | null {
  const recorded = resolveTenantLocalPath(tenantId, run.rawPath);
  if (recorded && recorded === path.resolve(run.rawPath)) return recorded;
  return resolveTenantLocalPath(tenantId, path.join(localStorageRoot(), 'tenants', tenantId, 'vm', 'runs', run.id + '.json'));
}

interface RunSummary {
  created: number;
  updated: number;
  resolved: number;
  sightings: number;
  poam: number;
}

async function processRun(tenantId: string, runId: string): Promise<void> {
  const signal = controllers.get(runId)?.controller.signal;
  if (signal?.aborted) return; // still queued at shutdown: the run stays RECEIVED
  const checkpoint = (): void => {
    if (signal?.aborted) throw new RunInterrupted();
  };
  const run = await getRun(tenantId, runId);
  if (!run || run.status === 'NORMALIZED' || run.status === 'FAILED') return;

  try {
    await updateRun(tenantId, runId, { status: 'NORMALIZING', startedAt: new Date().toISOString(), error: null });

    const file = storedPayloadPath(tenantId, run);
    if (!file) throw new RunFailure(UNREADABLE);
    let bytes: Buffer;
    try {
      bytes = await fs.promises.readFile(file);
    } catch {
      throw new RunFailure(UNREADABLE);
    }
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== run.rawSha256) {
      throw new RunFailure('The stored payload does not match its recorded checksum.');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new RunFailure('$: body is not valid JSON');
    }
    const validation = validateIngestPayload(parsed);
    if (!validation.ok) throw new RunFailure(validation.error);
    const payload = validation.value;
    checkpoint();

    const kind = payload.source.kind;
    let hosts: NormalizedHost[];
    if (kind === 'WAZUH') hosts = normalizeWazuh(payload);
    else throw new RunFailure(`No normalizer for ${kind} yet.`);

    const now = new Date().toISOString();
    // The scanner data is tenant-wide; the automatic POA&M items belong to the tenant's VM target program (the default program when none is set, decision 6).
    const programId = (await resolveVmTargetProgram(tenantId)).program.id;
    checkpoint();
    const summary = await withVmTenantTx(tenantId, async (client): Promise<RunSummary> => {
      const pgClient = client ?? undefined;
      let candidates = await listAgentAssetCandidates(tenantId, pgClient);
      const remainingCapacity = MAX_ASSETS_PER_TENANT - (await countAssets(tenantId, pgClient));
      const plan = planAssetMatches(hosts, candidates, kind, remainingCapacity);
      checkpoint();

      const assetOf = new Map<string, string>(); // agent id -> asset id
      for (const m of plan.matched) assetOf.set(m.agentId, m.assetId);

      const raced: Array<{ agentId: string; hostName: string }> = [];
      for (const draft of plan.toCreate) {
        const created = await createAgentReportedAsset(tenantId, draft, run.receivedAt, VM_WORKER_ACTOR, pgClient);
        if (created) assetOf.set(draft.agentId, created.id);
        else raced.push({ agentId: draft.agentId, hostName: draft.hostName });
      }
      if (raced.length > 0) {
        // The name was taken between the listing and the insert: it is that host's asset, matched by name.
        candidates = await listAgentAssetCandidates(tenantId, pgClient);
        for (const r of raced) {
          const hit = candidates.find((c) => c.hostName.trim().toLowerCase() === r.hostName.trim().toLowerCase());
          if (!hit) throw new Error('An asset name was taken but the asset could not be found');
          assetOf.set(r.agentId, hit.id);
          await recordAgentReport(tenantId, hit.id, kindKey(kind), r.agentId, run.receivedAt, VM_WORKER_ACTOR, pgClient);
        }
      }
      for (const m of plan.matched) {
        await recordAgentReport(tenantId, m.assetId, kindKey(kind), m.agentId, run.receivedAt, VM_WORKER_ACTOR, pgClient);
      }

      const reported: ReportedHost[] = [];
      for (const host of hosts) {
        const assetId = assetOf.get(host.agentId);
        if (assetId) reported.push({ assetId, host });
      }

      const existing = await loadFindingsForAssets(tenantId, [...new Set(reported.map((r) => r.assetId))], client);
      const sightedBySource = await loadSightedBySource(tenantId, run.sourceId, existing.map((f) => f.id), run.id, client);
      const vulnIds = [...new Set(reported.flatMap((r) => r.host.findings.map((f) => f.vulnId)))];
      const kev = await loadKevVulnIds(vulnIds, client);

      const result = applyRun({
        tenantId,
        run: { id: run.id, sourceId: run.sourceId, receivedAt: run.receivedAt, collectedAt: run.collectedAt },
        hosts: reported,
        existing,
        sightedBySource,
        kev,
        sla: getVmSlaConfig(),
        newId: () => crypto.randomUUID(),
      });

      await insertMissingVulns(result.vulnIds, client); // before the findings: vm_findings.vuln_id references vm_vulns
      await saveFindings(tenantId, result, client);
      await insertSightings(tenantId, result.sightings, client);
      if (faultForTests === 'after_save') throw new Error('fault injected for tests');
      if (faultForTests === 'interrupt_after_save') controllers.get(runId)?.controller.abort();
      checkpoint();

      let poam = 0;
      if (isPoamAutocreateEnabled()) {
        const { candidates: overdue, linked } = await listPoamCandidates(tenantId, now, client, programId);
        const drafts = planPoamItems(overdue, linked, now);
        await insertPoamItems(tenantId, drafts, client, programId);
        poam = drafts.length;
      }

      const warning = plan.skipped.length > 0 ? `${plan.skipped.length} host(s) skipped: asset limit reached.` : null;
      await markRunNormalized(tenantId, run.id, now, warning, client);
      return { created: result.created.length, updated: result.updated.length, resolved: result.resolved.length, sightings: result.sightings.length, poam };
    }, programId);

    console.log(
      `[VM Worker] run ${run.id} in ${tenantId}: NORMALIZED (${summary.created}/${summary.updated}/${summary.resolved} findings, ${summary.sightings} sightings, ${summary.poam} POA&M)`,
    );
  } catch (err: unknown) {
    // The transaction (if any) rolled back; the run's status is written on its own.
    if (err instanceof RunInterrupted) {
      console.log('[VM Worker] a run was interrupted by the shutdown');
      await fail(tenantId, runId, VM_SHUTDOWN_MESSAGE);
      return;
    }
    if (err instanceof RunFailure) {
      console.log(`[VM Worker] run ${runId} in ${tenantId}: FAILED (${err.message})`);
      await fail(tenantId, runId, err.message);
      return;
    }
    console.error('[VM Worker]', errorMessage(err));
    console.log(`[VM Worker] run ${runId} in ${tenantId}: FAILED (0/0/0 findings, 0 sightings, 0 POA&M)`);
    await fail(tenantId, runId, GENERIC);
  }
}
