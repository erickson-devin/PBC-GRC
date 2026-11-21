import { listTenantMembers, queryWithProgram, type ProgramScope } from './db';
import { readControlAssessments } from './controlAssessments';
import { readControlPoam } from './controlPoam';
import { readSspReviews } from './sspReviews';
import { summarizeOpenVmPoamDates } from './vm/findingsStore';
import { programCatalogControls } from './programCatalog';
import { programCatalogIds, type Program } from './programs';
import { listTools } from './inventory/registerStore';
import { readDataInventory, readProgramInventory } from './inventory/programInventoryStore';
import { listDocuments } from './documents/registerStore';
import { readProgramDocuments } from './documents/programDocumentsStore';
import { EXPECTED_CATALOG, expectedFor } from './documents/expectedCatalog';
import { applicableExpected, expectedStatus, presentCounts } from '../src/data/documents/expectedDocuments';
import { buildSspDocumentsCompletenessInput, buildSspDocumentsSnapshot } from '../src/data/documents/sspDocuments';
import { buildSspInventoryCompletenessInput } from '../src/data/inventory/sspInventory';
import { poamTargetSummary } from '../src/data/dashboard/poamTarget';
import { SSP_SIGNABLE_SECTION_IDS } from '../src/data/ssp/sspSections';
import { membershipExpired } from '../src/utils/memberProfile';
import { OWNER_LEVEL_ROLES } from '../src/utils/roles';
import type { ControlStatus } from '../src/types/cmmc';
import type { ProgramSummary } from '../src/types/programSummary';

/**
 * What the program journey bar and the dashboard need of the server (#251, #252): counts, flags and dates only, never a note, a name, a file name or any
 * text a person typed. SSP completeness, the assessment figures and the export gaps are NOT computed here: they need the tenant's fallbacks and the live
 * session, so the client computes them from the same registry as the SSP builder (the two would otherwise disagree). Read-only.
 */

const CONTROL_STATUSES: readonly string[] = ['NOT_STARTED', 'IN_PROGRESS', 'MET', 'NOT_MET'];

/** `now` as YYYY-MM-DD in UTC. */
const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

export async function buildProgramSummary(program: Program, now: Date): Promise<ProgramSummary> {
  const scope: ProgramScope = { tenantId: program.tenantId, programId: program.id };
  const today = utcDay(now);

  // People: owner-level members whose access has not ended, and whether one of the members whose access has not ended is the primary contact
  const members = (await listTenantMembers(program.tenantId)).filter((m) => !membershipExpired(m.profile.accessExpiresOn, now.getTime()));
  const people = {
    ownerLevelMembers: members.filter((m) => (OWNER_LEVEL_ROLES as readonly string[]).includes(m.role)).length,
    primaryContactSet: members.some((m) => m.profile.primaryContact === true),
  };

  // Tools and the data inventory (sections 1.3 and 1.4)
  const [tools, programInventory, data] = await Promise.all([listTools(program.tenantId), readProgramInventory(scope), readDataInventory(scope)]);
  const inventory = buildSspInventoryCompletenessInput({ supported: true, tools, program: programInventory, data, registry: null });

  // Documents (section 1.3.2): the expected documents present, with the shared "present" rule; null for a framework with no catalog
  let documents: ProgramSummary['documents'] = null;
  if (expectedFor(program.frameworkId).length > 0) {
    const [registered, programDocuments, evidence] = await Promise.all([listDocuments(program.tenantId), readProgramDocuments(scope), liveEvidence(scope)]);
    const entries = applicableExpected(EXPECTED_CATALOG, program.frameworkId, programCatalogIds(program));
    const counts = presentCounts(expectedStatus(entries, registered, programDocuments, new Set(evidence.map((e) => e.id)), today));
    const snapshot = buildSspDocumentsSnapshot({
      supported: true,
      documents: registered,
      program: programDocuments,
      evidence,
      today,
      expected: { present: counts.present, total: counts.total },
    });
    documents = { ...buildSspDocumentsCompletenessInput(snapshot), recommendedPresent: counts.recommendedPresent, recommendedTotal: counts.recommendedTotal };
  }

  // Sign-offs: the signable sections whose newest sign-off is current
  const reviews = await readSspReviews(scope);
  const reviewed = reviews.sections.filter((s) => s.reviewed).length;

  // POA&M: every control not recorded as Met (with the date of its entry) plus the open vulnerability items
  const [assessments, controlPoam, vm] = await Promise.all([readControlAssessments(scope), readControlPoam(scope), summarizeOpenVmPoamDates(scope, today)]);
  const dateOf = new Map(controlPoam.map((e) => [e.controlId, e.scheduledCompletion] as const));
  const controls = programCatalogControls(program).map((c) => {
    const stored = assessments.get(c.id)?.status ?? 'NOT_STARTED';
    return { status: (CONTROL_STATUSES.includes(stored) ? stored : 'NOT_STARTED') as ControlStatus, scheduledCompletion: dateOf.get(c.id) ?? null };
  });

  return {
    programId: program.id,
    generatedAt: now.toISOString(),
    people,
    inventory,
    documents,
    reviews: { reviewed, total: SSP_SIGNABLE_SECTION_IDS.length },
    poam: poamTargetSummary(controls, vm, today),
  };
}

/** The program's own evidence files (id and file name: the file name only resolves a primary copy, it is never returned), the inherited copies left out. */
async function liveEvidence(scope: ProgramScope): Promise<{ id: string; name: string }[]> {
  const res = await queryWithProgram(scope, 'SELECT id, file_name, tenant_id, program_id FROM evidence_metadata WHERE tenant_id = $1 AND (program_id = $2 OR program_id IS NULL)', [scope.tenantId, scope.programId]);
  return res.rows
    .filter((r) => r.tenant_id === scope.tenantId && !String(r.id).includes('__inh_'))
    .map((r) => ({ id: String(r.id), name: String(r.file_name ?? '') }));
}
