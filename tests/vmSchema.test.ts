import fs from 'node:fs';
import { DISCOVERY_POLICIES, RLS_TENANT_TABLES, TABLES_SQL, buildRlsSql, buildSchemaSql } from '../server/schema';
import { validateAssetInput } from '../server/assets';
import {
  VM_CONFIG_RESULTS,
  VM_CONFIG_SEVERITIES,
  VM_FINDING_STATUSES,
  VM_HUMAN_DECISIONS,
  VM_POAM_STATUSES,
  VM_PUSH_ERROR_CODES,
  VM_PUSH_STATUSES,
  VM_RUN_STATUSES,
  VM_SEVERITIES,
  VM_SOURCE_KINDS,
  VM_VULN_SOURCES,
} from '../src/types/vm';

/**
 * Pure checks (no database, no server) on the vulnerability-management schema (docs/VULNERABILITY_MANAGEMENT.md, section 3):
 * tables, tenant isolation (RLS), the two discovery policies, composite tenant keys, enum checks and idempotency.
 * Live enforcement against PostgreSQL itself is covered by `npm run db:verify-rls` (needs a real database).
 */
let passed = 0;
let total = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${name}`);
  } else {
    console.error(`  ✗ FAIL: ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

const rls = buildRlsSql();
const P = "tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')";

/** Body of `CREATE TABLE IF NOT EXISTS <name> (` up to the closing `\n  );`. */
function block(name: string): string {
  const head = `CREATE TABLE IF NOT EXISTS ${name} (`;
  const start = TABLES_SQL.indexOf(head);
  if (start < 0) return '';
  const end = TABLES_SQL.indexOf('\n  );', start);
  return TABLES_SQL.slice(start + head.length, end);
}
/** The rendered tenant-isolation policy for a table, up to the next END IF. */
function policy(t: string): string {
  const start = rls.indexOf(`CREATE POLICY rls_${t}_tenant_isolation`);
  if (start < 0) return '';
  return rls.slice(start, rls.indexOf('END IF;', start));
}
/** Quoted values of `<constraintName> CHECK (<col> IN ('A', 'B'))`. */
function parseEnum(body: string, constraintName: string): string[] {
  const m = new RegExp(`${constraintName} CHECK \\(\\w+ IN \\(([^)]*)\\)\\)`).exec(body);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

const TENANT_TABLES = ['vm_service_tokens', 'vm_sources', 'vm_runs', 'vm_findings', 'vm_sightings', 'vm_run_assets', 'vm_poam_items', 'vm_config_scans', 'vm_config_results', 'vm_host_inventory', 'vm_host_software'];
const ALL_TABLES = [...TENANT_TABLES, 'vm_vulns'];
const NL = String.fromCharCode(10);
const at = (t: string) => TABLES_SQL.indexOf(`CREATE TABLE IF NOT EXISTS ${t}`);

console.log('--- Tables exist ---');
for (const t of ALL_TABLES) assert(TABLES_SQL.includes(`CREATE TABLE IF NOT EXISTS ${t} (`), `${t} is created`);

console.log('\n--- Tenant isolation (RLS) ---');
for (const t of TENANT_TABLES) {
  assert(RLS_TENANT_TABLES.some((r) => r.table === t && r.tenantColumn === 'tenant_id'), `${t} is in RLS_TENANT_TABLES on tenant_id`);
  assert(rls.includes(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`) && rls.includes(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`), `${t}: ENABLE + FORCE ROW LEVEL SECURITY`);
  const pol = policy(t);
  assert(pol.includes('FOR ALL') && pol.includes(`USING (${P})`) && pol.includes(`WITH CHECK (${P})`), `${t}: policy is FOR ALL with USING and WITH CHECK on the tenant (a write for another tenant is refused)`);
  assert(rls.includes(`policyname = 'rls_${t}_tenant_isolation'`), `${t}: policy is created idempotently`);
}
assert(!RLS_TENANT_TABLES.some((r) => r.table === 'vm_vulns'), 'vm_vulns (global reference data) is not in RLS_TENANT_TABLES');
assert(!rls.includes('ALTER TABLE vm_vulns'), 'vm_vulns gets no RLS statements');
assert(!/\btenant_id\b/.test(block('vm_vulns')), 'vm_vulns has no tenant_id column');
const protectedTables = new Set(RLS_TENANT_TABLES.map((r) => r.table));
const missing = ALL_TABLES.filter((t) => /\btenant_id\b/.test(block(t)) && !protectedTables.has(t));
assert(missing.length === 0, 'every vm_ table with a tenant_id column is covered by RLS', missing);

console.log('\n--- Discovery policies ---');
const vmPolicies = DISCOVERY_POLICIES.filter((p) => p.table.startsWith('vm_'));
assert(vmPolicies.length === 2, 'exactly two vm_ discovery policies', vmPolicies.map((p) => p.name));
const tokenLookup = DISCOVERY_POLICIES.find((p) => p.name === 'rls_vm_service_tokens_lookup');
const schedulerPolicy = DISCOVERY_POLICIES.find((p) => p.name === 'rls_vm_sources_scheduler');
assert(tokenLookup?.table === 'vm_service_tokens' && tokenLookup.using === "token_hash = NULLIF(current_setting('app.vm_token_hash', true), '')", 'token lookup: one row by hash, an unset or empty GUC matches nothing', tokenLookup);
assert(schedulerPolicy?.table === 'vm_sources' && schedulerPolicy.using === "NULLIF(current_setting('app.vm_scheduler', true), '') = 'on'", "scheduler: visible only while app.vm_scheduler = 'on'", schedulerPolicy);
for (const p of vmPolicies) {
  const start = rls.indexOf(`CREATE POLICY ${p.name}`);
  const rendered = rls.slice(start, rls.indexOf('END IF;', start));
  assert(start > 0 && /FOR SELECT/.test(rendered) && !/FOR ALL|FOR INSERT|FOR UPDATE|FOR DELETE/.test(rendered), `${p.name} is SELECT-only`);
  assert(!/WITH CHECK/.test(rendered), `${p.name} has no WITH CHECK`);
  assert(rls.includes(`policyname = '${p.name}'`), `${p.name} is created idempotently`);
}

console.log('\n--- vm_service_tokens ---');
const tokens = block('vm_service_tokens');
assert(/token_hash CHAR\(64\) NOT NULL/.test(tokens) && !/\btoken (VARCHAR|TEXT|CHAR)/i.test(tokens), 'only a SHA-256 hash of the token is stored, never the token');
assert(tokens.includes('CONSTRAINT unq_vm_service_token_hash UNIQUE (token_hash)'), 'token hashes are unique');
assert(tokens.includes('token_prefix VARCHAR(16)'), 'a non-secret display prefix is stored');
assert(tokens.includes('scopes TEXT[] NOT NULL') && tokens.includes("'vm:ingest'"), 'scopes are required and limited to vm:ingest');
assert(tokens.includes('expires_at TIMESTAMPTZ NOT NULL') && tokens.includes('last_used_at TIMESTAMPTZ') && tokens.includes('revoked_at TIMESTAMPTZ'), 'expiry (required), last-used and revocation columns exist');
for (const col of ['last_push_at TIMESTAMPTZ', 'last_push_status VARCHAR(16)', 'last_push_error_code VARCHAR(32)']) {
  const stmt = `ALTER TABLE vm_service_tokens ADD COLUMN IF NOT EXISTS ${col}`;
  assert(TABLES_SQL.indexOf(stmt) > at('vm_service_tokens'), `the push outcome column is added idempotently: ${col}`);
}
for (const name of ['vm_service_tokens_push_status_check', 'vm_service_tokens_push_error_code_check']) {
  const drop = TABLES_SQL.indexOf(`DROP CONSTRAINT IF EXISTS ${name}`);
  assert(drop > 0 && TABLES_SQL.indexOf(`ADD CONSTRAINT ${name}`) > drop, `${name} is dropped then re-added`);
}
assert(same(parseEnum(TABLES_SQL, 'vm_service_tokens_push_status_check'), VM_PUSH_STATUSES), 'push status list equals VM_PUSH_STATUSES');
assert(same(parseEnum(TABLES_SQL, 'vm_service_tokens_push_error_code_check'), VM_PUSH_ERROR_CODES), 'push error code list equals VM_PUSH_ERROR_CODES');
assert(same(VM_PUSH_ERROR_CODES, ['validation', 'kind_mismatch', 'too_large', 'media_type', 'insecure', 'storage']), 'the push error codes are the fixed set');
assert(!/last_push_(message|error)\b(?!_code)/.test(TABLES_SQL), 'no push message is ever stored (a validation message can echo payload content)');

console.log('\n--- vm_sources ---');
const sources = block('vm_sources');
assert(sources.includes('stale_since TIMESTAMPTZ'), 'sources track when they went stale');
assert(sources.includes('expected_interval_minutes INTEGER NOT NULL DEFAULT 1440'), 'expected interval defaults to daily');
assert(sources.includes('CONSTRAINT unq_vm_sources_tenant_id UNIQUE (tenant_id, id)'), 'sources are a composite foreign-key target');
const kindDrop = TABLES_SQL.indexOf('DROP CONSTRAINT IF EXISTS vm_sources_kind_check');
const kindAdd = TABLES_SQL.indexOf('ADD CONSTRAINT vm_sources_kind_check');
assert(kindDrop > 0 && kindAdd > kindDrop, 'the kind check is dropped then re-added (the list grows)');
const kinds = parseEnum(TABLES_SQL, 'vm_sources_kind_check');
assert(same(kinds, VM_SOURCE_KINDS) && kinds.includes('WAZUH'), 'kind list equals VM_SOURCE_KINDS and includes WAZUH', kinds);
assert(TABLES_SQL.includes('CREATE UNIQUE INDEX IF NOT EXISTS unq_vm_sources_label ON vm_sources(tenant_id, lower(label))'), 'source labels are unique per tenant, case-insensitively');

console.log('\n--- vm_runs ---');
const runs = block('vm_runs');
assert(same(parseEnum(runs, 'vm_runs_status_check'), VM_RUN_STATUSES), 'run status list equals VM_RUN_STATUSES');
assert(runs.includes('raw_sha256 VARCHAR(64) NOT NULL') && runs.includes('raw_path TEXT NOT NULL'), 'raw path and hash are required');
assert(runs.includes('CONSTRAINT unq_vm_runs_raw_sha256 UNIQUE (tenant_id, raw_sha256)'), 'a payload is accepted once per tenant');
assert(runs.includes('FOREIGN KEY (tenant_id, source_id) REFERENCES vm_sources (tenant_id, id)'), 'run -> source key is composite');
assert(TABLES_SQL.indexOf('ALTER TABLE vm_runs ADD COLUMN IF NOT EXISTS token_id VARCHAR(64)') > at('vm_runs'), 'the pushing token id is added to vm_runs idempotently (no foreign key: tokens are deleted by cleanup scripts)');

console.log('\n--- vm_findings ---');
const findings = block('vm_findings');
assert(findings.includes('CONSTRAINT unq_vm_finding UNIQUE (tenant_id, asset_id, vuln_id)'), 'one finding per (tenant, asset, vulnerability)');
assert(findings.includes('FOREIGN KEY (tenant_id, asset_id) REFERENCES enclave_assets (tenant_id, id) ON DELETE CASCADE'), 'finding -> asset key is composite');
assert(!/asset_id VARCHAR\(64\)[^,\n]*REFERENCES/.test(findings), 'no single-column asset key (it would accept another tenant\'s asset)');
assert(same(parseEnum(findings, 'vm_findings_status_check'), VM_FINDING_STATUSES), 'finding status list equals VM_FINDING_STATUSES');
assert(same(parseEnum(findings, 'vm_findings_severity_check'), VM_SEVERITIES), 'finding severity list equals VM_SEVERITIES');
assert(findings.includes('resolved_run_id VARCHAR(64)') && findings.includes('FOREIGN KEY (tenant_id, resolved_run_id) REFERENCES vm_runs (tenant_id, id)'), 'the closing run is recorded with a composite key');
const resolvedCheck = findings.slice(findings.indexOf('vm_findings_resolved_check'));
assert(resolvedCheck.split(NL)[0].includes('resolved_at IS NOT NULL') && resolvedCheck.split(NL)[0].includes('resolved_run_id IS NOT NULL'), 'RESOLVED requires both resolved_at and resolved_run_id');
const decisionCheck = findings.slice(findings.indexOf('vm_findings_decision_check'));
const decisionLine = decisionCheck.split(NL)[0];
assert(decisionLine.includes("'RISK_ACCEPTED'") && decisionLine.includes("'FALSE_POSITIVE'") && decisionLine.includes('justification IS NOT NULL'), 'a human decision requires a justification');
assert(findings.includes('vm_findings_seen_check'), 'last_seen_at cannot precede first_seen_at');

console.log('\n--- Human decisions ---');
assert(!VM_HUMAN_DECISIONS.includes('RESOLVED' as any), 'RESOLVED is not a human decision (closure is machine-confirmed)');
assert(VM_HUMAN_DECISIONS.every((d) => (VM_FINDING_STATUSES as readonly string[]).includes(d)), 'every human decision is a finding status');

console.log('\n--- vm_sightings, vm_poam_items, vm_vulns ---');
const sightings = block('vm_sightings');
assert(sightings.includes('FOREIGN KEY (tenant_id, finding_id)') && sightings.includes('FOREIGN KEY (tenant_id, run_id)') && sightings.includes('FOREIGN KEY (tenant_id, source_id)'), 'every sighting key is composite');
assert(sightings.includes('CONSTRAINT unq_vm_sighting UNIQUE (tenant_id, run_id, finding_id)'), 'a run sights a finding once (tenant-qualified, so a unique violation is never a cross-tenant oracle)');
const runAssets = block('vm_run_assets');
assert(runAssets.includes('PRIMARY KEY (tenant_id, run_id, asset_id)'), 'a run reports an asset once (primary key)');
assert(runAssets.includes('FOREIGN KEY (tenant_id, run_id) REFERENCES vm_runs (tenant_id, id) ON DELETE CASCADE'), 'vm_run_assets rows go with their run (composite key, cascade)');
assert(runAssets.includes('FOREIGN KEY (tenant_id, asset_id) REFERENCES enclave_assets (tenant_id, id) ON DELETE CASCADE'), 'vm_run_assets rows go with their asset (composite key, cascade)');
assert(TABLES_SQL.includes('idx_vm_run_assets_asset ON vm_run_assets (tenant_id, asset_id)'), 'vm_run_assets is indexed by (tenant_id, asset_id)');
const poam = block('vm_poam_items');
assert(!/finding_id VARCHAR\(64\) NOT NULL/.test(poam), 'a POA&M item may exist without a finding');
assert(same(parseEnum(poam, 'vm_poam_items_status_check'), VM_POAM_STATUSES), 'POA&M status list equals VM_POAM_STATUSES');
assert(poam.includes('ON DELETE SET NULL (finding_id)'), 'deleting a finding clears only finding_id (tenant_id is NOT NULL)');
const vulns = block('vm_vulns');
assert(vulns.includes('epss NUMERIC(5,4)') && vulns.includes('kev BOOLEAN NOT NULL DEFAULT FALSE') && vulns.includes('refs JSONB') && vulns.includes('cvss_v3 NUMERIC(3,1)'), 'vulnerability reference columns exist');
assert(!vulns.includes('uuid_generate_v4'), 'vuln_id is the natural key, not a generated id');
const vulnSources = parseEnum(vulns, 'vm_vulns_source_check');
assert(vulns.includes("source VARCHAR(16) NOT NULL DEFAULT 'INGEST'"), 'vm_vulns.source is an inline column, NOT NULL DEFAULT INGEST');
assert(same(vulnSources, VM_VULN_SOURCES) && same(vulnSources, ['INGEST', 'FEED', 'ADMIN']), 'vm_vulns source list equals VM_VULN_SOURCES (INGEST, FEED, ADMIN)', vulnSources);
assert(!TABLES_SQL.includes('ALTER TABLE vm_vulns'), 'vm_vulns is never ALTERed on boot: an inline CHECK avoids rescanning the global CVE table under an exclusive lock at every start');

console.log('\n--- vm_config_scans, vm_config_results (issue #103) ---');
const configScans = block('vm_config_scans');
assert(
  configScans.includes('FOREIGN KEY (tenant_id, run_id) REFERENCES vm_runs (tenant_id, id) ON DELETE CASCADE') &&
    configScans.includes('FOREIGN KEY (tenant_id, source_id) REFERENCES vm_sources (tenant_id, id)') &&
    configScans.includes('FOREIGN KEY (tenant_id, asset_id) REFERENCES enclave_assets (tenant_id, id) ON DELETE CASCADE'),
  'every configuration scan key is composite (run and asset cascade)',
);
assert((configScans.match(/FOREIGN KEY \(tenant_id, /g) || []).length === 3, 'vm_config_scans has exactly three foreign keys, all composite on tenant_id');
assert(!/_id VARCHAR\(64\)[^,\n]*REFERENCES/.test(configScans), 'no single-column key on vm_config_scans (it would accept another tenant\'s row)');
assert(configScans.includes('CONSTRAINT unq_vm_config_scans_tenant_id UNIQUE (tenant_id, id)'), 'vm_config_scans is a composite foreign-key target');
assert(configScans.includes('CONSTRAINT unq_vm_config_scan UNIQUE (tenant_id, run_id, asset_id, benchmark_id, profile_id, scanned_at)'), 'a run stores one scan per asset, benchmark, profile and time');
assert(configScans.includes('scanned_at TIMESTAMPTZ NOT NULL') && configScans.includes('received_at TIMESTAMPTZ NOT NULL'), 'scan and receipt times are required');
assert(TABLES_SQL.includes('idx_vm_config_scans_asset ON vm_config_scans (tenant_id, asset_id, scanned_at DESC)'), 'vm_config_scans is indexed for the latest scan per asset');
const configResults = block('vm_config_results');
assert(configResults.includes('PRIMARY KEY (tenant_id, scan_id, rule_id)'), 'a scan stores a rule once (primary key)');
assert(configResults.includes('FOREIGN KEY (tenant_id, scan_id) REFERENCES vm_config_scans (tenant_id, id) ON DELETE CASCADE'), 'vm_config_results rows go with their scan (composite key, cascade)');
assert(same(parseEnum(configResults, 'vm_config_results_result_check'), VM_CONFIG_RESULTS), 'result list equals VM_CONFIG_RESULTS');
const severityMatch = /vm_config_results_severity_check CHECK \(severity IS NULL OR severity IN \(([^)]*)\)\)/.exec(configResults);
const severityValues = severityMatch ? [...severityMatch[1].matchAll(/'([^']*)'/g)].map((x) => x[1]) : [];
assert(same(severityValues, VM_CONFIG_SEVERITIES), 'severity list equals VM_CONFIG_SEVERITIES (null allowed)', severityValues);
assert(!configScans.includes('program_id') && !configResults.includes('program_id'), 'configuration results are tenant-wide: no program_id');
assert(TABLES_SQL.includes('ALTER TABLE vm_runs ADD COLUMN IF NOT EXISTS config_result_count INTEGER NOT NULL DEFAULT 0'), 'vm_runs.config_result_count is added idempotently');
assert(at('vm_runs') < at('vm_config_scans') && at('vm_config_scans') < at('vm_config_results') && at('vm_config_results') < TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS platform_admins'), 'the configuration tables sit in the VM block, after vm_runs');

console.log('\n--- vm_host_inventory, vm_host_software (issue #229) ---');
const hostInv = block('vm_host_inventory');
const hostSw = block('vm_host_software');
assert(hostInv.includes('PRIMARY KEY (tenant_id, asset_id, source_id)'), 'vm_host_inventory: one row per asset and source (primary key)');
assert(hostInv.includes('CONSTRAINT fk_vm_host_inventory_asset FOREIGN KEY (tenant_id, asset_id) REFERENCES enclave_assets (tenant_id, id) ON DELETE CASCADE'), 'vm_host_inventory goes with its asset (composite key, cascade)');
assert(hostInv.includes('CONSTRAINT fk_vm_host_inventory_source FOREIGN KEY (tenant_id, source_id) REFERENCES vm_sources (tenant_id, id)'), 'vm_host_inventory: composite key to the source');
assert((hostInv.match(/FOREIGN KEY \(tenant_id, /g) || []).length === 2 && !/_id VARCHAR\(64\)[^,\n]*REFERENCES/.test(hostInv), 'vm_host_inventory has exactly two foreign keys, both composite on tenant_id');
assert(/last_run_id VARCHAR\(64\) NOT NULL,/.test(hostInv) && !/last_run_id[^\n]*REFERENCES/.test(hostInv), 'vm_host_inventory.last_run_id has no foreign key (pruning a run keeps the inventory)');
assert(hostInv.includes('memory_bytes BIGINT,') && hostInv.includes('cpu_cores INTEGER,') && hostInv.includes('cpu_mhz INTEGER,'), 'vm_host_inventory: nullable numbers, memory as BIGINT');
assert(hostSw.includes('PRIMARY KEY (tenant_id, asset_id, source_id, name, version, architecture)'), 'vm_host_software: one row per package, version and architecture (primary key)');
assert(hostSw.includes('FOREIGN KEY (tenant_id, asset_id, source_id) REFERENCES vm_host_inventory (tenant_id, asset_id, source_id) ON DELETE CASCADE'), 'vm_host_software goes with its host view (composite key, cascade)');
assert(TABLES_SQL.includes('idx_vm_host_software_name ON vm_host_software (tenant_id, lower(name))'), 'vm_host_software is indexed by lower-case name');
assert(!hostInv.includes('program_id') && !hostSw.includes('program_id'), 'the inventory is tenant-wide: no program_id');
assert(at('vm_config_results') < at('vm_host_inventory') && at('vm_host_inventory') < at('vm_host_software') && at('vm_host_software') < TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS platform_admins'), 'the inventory tables sit in the VM block, after vm_config_results');

console.log('\n--- enclave_assets additions and ordering ---');
assert(TABLES_SQL.includes("ALTER TABLE enclave_assets ADD COLUMN IF NOT EXISTS agent_ids JSONB NOT NULL DEFAULT '{}'::jsonb"), 'enclave_assets.agent_ids is added');
assert(TABLES_SQL.includes('ALTER TABLE enclave_assets ADD COLUMN IF NOT EXISTS last_vuln_seen_at TIMESTAMPTZ'), 'enclave_assets.last_vuln_seen_at is added');
const assetKey = TABLES_SQL.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS unq_enclave_assets_tenant_id ON enclave_assets(tenant_id, id)');
const findingsAt = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS vm_findings');
assert(assetKey > 0 && assetKey < findingsAt, 'the enclave_assets (tenant_id, id) key exists before vm_findings references it');
assert(at('vm_vulns') < at('vm_findings') && at('vm_sources') < at('vm_findings') && at('vm_runs') < at('vm_findings'), 'vm_vulns, vm_sources and vm_runs are created before vm_findings');
assert(at('vm_findings') < at('vm_sightings') && at('vm_findings') < at('vm_poam_items'), 'vm_findings is created before vm_sightings and vm_poam_items');
assert(at('vm_runs') < at('vm_run_assets') && at('vm_run_assets') < at('vm_poam_items'), 'vm_run_assets is created after vm_runs and before vm_poam_items');
const placeStart =TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS vm_service_tokens');
assert(TABLES_SQL.indexOf('ssp_import_jobs_baseline_check') < placeStart && placeStart < TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS platform_admins'), 'the VM block sits between the SSP import block and platform_admins');

console.log('\n--- Idempotency of the VM block ---');
const vmBlock = TABLES_SQL.slice(placeStart, TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS platform_admins'));
assert(!/CREATE TABLE (?!IF NOT EXISTS)/.test(vmBlock), 'every CREATE TABLE is IF NOT EXISTS');
assert(!/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/.test(vmBlock), 'every CREATE INDEX is IF NOT EXISTS');
assert((vmBlock.match(/ADD COLUMN/g) || []).length === (vmBlock.match(/ADD COLUMN IF NOT EXISTS/g) || []).length, 'every ADD COLUMN is IF NOT EXISTS');
assert(TABLES_SQL.includes('ALTER TABLE vm_runs ADD COLUMN IF NOT EXISTS warning TEXT'), 'vm_runs.warning is added idempotently');
{
  // #59: staleness follows the newest NORMALIZED run; the backfill runs per tenant under that tenant's own setting.
  const colAt = TABLES_SQL.indexOf('ALTER TABLE vm_sources ADD COLUMN IF NOT EXISTS last_normalized_at TIMESTAMPTZ');
  const runsAt = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS vm_runs');
  const doStart = TABLES_SQL.lastIndexOf('DO $$', colAt);
  const doEnd = TABLES_SQL.indexOf('$$;', colAt);
  const doBlock = colAt > 0 && doStart > 0 && doEnd > colAt ? TABLES_SQL.slice(doStart, doEnd) : '';
  assert(colAt > runsAt && runsAt > 0, 'vm_sources.last_normalized_at is added idempotently, after vm_runs exists (the backfill reads it)');
  const updateAt = doBlock.indexOf('UPDATE vm_sources');
  assert(doBlock.includes("status = 'NORMALIZED'") && doBlock.includes('max(received_at)') && updateAt > 0, 'the backfill takes the newest NORMALIZED received_at per source');
  assert(
    doBlock.indexOf("set_config('app.vm_scheduler', '', true)") > updateAt && doBlock.indexOf("set_config('app.current_tenant_id', '', true)") > updateAt,
    'both transaction-local settings are reset after the backfill UPDATE',
  );
  assert(
    doBlock.indexOf("set_config('app.current_tenant_id', tid, true)") > 0 && doBlock.indexOf("set_config('app.current_tenant_id', tid, true)") < updateAt && !doBlock.includes('NO FORCE'),
    'every backfill write runs under the tenant own setting, and the block never lifts FORCE (D3)',
  );
}
assert(TABLES_SQL.includes("unq_vm_poam_items_auto ON vm_poam_items (tenant_id, finding_id) WHERE created_by = 'system:vm-worker' AND finding_id IS NOT NULL"), 'the auto-created POA&M item is unique per finding');
const adds = [...vmBlock.matchAll(/ADD CONSTRAINT (\w+)/g)].map((m) => m[1]);
assert(adds.every((n) => vmBlock.includes(`DROP CONSTRAINT IF EXISTS ${n}`) && vmBlock.indexOf(`DROP CONSTRAINT IF EXISTS ${n}`) < vmBlock.indexOf(`ADD CONSTRAINT ${n}`)), 'every ADD CONSTRAINT is preceded by DROP CONSTRAINT IF EXISTS of the same name', adds);
assert(!/ADD CONSTRAINT (fk_|unq_)/.test(vmBlock), 'foreign and unique keys are inline only (dropping a referenced key would need CASCADE)');
assert(!vmBlock.includes('program_id'), 'the VM block does not mention program_id (the program column is added after the block, at the end of TABLES_SQL)');
assert(!TABLES_SQL.includes('undefined'), 'no unresolved interpolation in TABLES_SQL');
const full = buildSchemaSql();
assert(full.includes('vm_findings') && full.includes('rls_vm_findings_tenant_isolation'), 'buildSchemaSql() includes the VM tables and their RLS');

console.log('\n--- AGENT_REPORT asset origin ---');
const ok = validateAssetInput({ hostName: 'vm-h1', cmmcAssetCategory: 'CUI_ASSET', sourceOrigin: 'AGENT_REPORT' }, false);
assert(ok.ok === true && ok.value.sourceOrigin === 'AGENT_REPORT', 'the asset validator accepts sourceOrigin AGENT_REPORT', ok);
const bad = validateAssetInput({ hostName: 'vm-h1', cmmcAssetCategory: 'CUI_ASSET', sourceOrigin: 'BOGUS' }, false);
assert(bad.ok === false && bad.error.includes('AGENT_REPORT'), 'an unknown origin is rejected and the error lists AGENT_REPORT', bad);
const telemetryText = fs.readFileSync(new URL('../src/types/telemetry.ts', import.meta.url), 'utf8');
assert(telemetryText.includes("'AGENT_REPORT'"), "AssetSourceOrigin includes 'AGENT_REPORT'");

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
if (passed !== total) process.exit(1);
