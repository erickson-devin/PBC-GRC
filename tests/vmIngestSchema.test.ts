import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  INGEST_LIMITS,
  INGEST_PATTERN_SOURCES,
  formatJsonPath,
  ingestExporterSchema,
  ingestFindingSchema,
  ingestHostSchema,
  ingestOsSchema,
  ingestPackageSchema,
  ingestPayloadSchema,
  ingestSourceSchema,
  validateIngestPayload,
  vmIngestMaxBytes,
} from '../server/vm/ingestSchema';
import {
  localStorageRoot,
  resolveTenantLocalPath,
  resolveWithin,
  storageProvider,
  writeTenantFile,
} from '../server/evidence/storage';
import { VM_SEVERITIES, VM_SOURCE_KINDS } from '../src/types/vm';

/**
 * Pure checks (no server): the ingest validator, its parity with server/vm/ingest.schema.json, the tenant storage helper and
 * the in-memory VM store (docs/VULNERABILITY_MANAGEMENT.md, sections 5 and 7.1).
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


const valid = () => ({
  source: { kind: 'WAZUH', label: 'wazuh-prod' },
  exporter: { name: 'pbc-wazuh-exporter', version: '1.0.0' },
  collected_at: '2026-10-18T12:00:00Z',
  hosts: [
    {
      agent_id: '001',
      hostname: 'web-01',
      ip: '10.0.0.5',
      mac: 'aa:bb:cc:dd:ee:ff',
      os: { name: 'Ubuntu', version: '22.04' },
      findings: [
        {
          vuln_id: 'CVE-2024-12345',
          title: 'Example',
          severity: 'HIGH',
          cvss_v3: 7.5,
          package: { name: 'openssl', version: '3.0.1', fixed_version: '3.0.2' },
          detected_at: '2026-10-17T00:00:00.123Z',
          published_at: null,
          refs: ['https://example.com/a', 'http://example.com/b'],
        },
      ],
    },
  ],
});

type Obj = Record<string, any>;
const mutate = (fn: (p: Obj) => void): Obj => {
  const p = valid() as Obj;
  fn(p);
  return p;
};
const errorOf = (raw: unknown): string => {
  const r = validateIngestPayload(raw);
  return r.ok ? '' : r.error;
};

function hostsWith(counts: number[]): Obj[] {
  return counts.map((n, i) => ({
    agent_id: `agent-${i}`,
    findings: Array.from({ length: n }, () => ({ vuln_id: 'CVE-2024-0001', severity: 'LOW' })),
  }));
}

async function main() {
  // ---------------------------------------------------------------------------------------------- validator
  console.log('\n--- validator ---');
  assert(validateIngestPayload(valid()).ok, 'valid payload accepted');
  assert(validateIngestPayload(mutate((p) => (p.hosts = []))).ok, 'hosts [] accepted');
  assert(validateIngestPayload(mutate((p) => (p.schema_version = 1))).ok, 'schema_version 1 accepted');
  assert(errorOf(mutate((p) => (p.schema_version = 2))).startsWith('$.schema_version:'), 'schema_version 2 rejected', errorOf(mutate((p) => (p.schema_version = 2))));
  assert(errorOf([]).startsWith('$:'), 'root [] rejected at $', errorOf([]));
  assert(errorOf(null).startsWith('$:'), 'root null rejected at $', errorOf(null));
  for (const key of ['source', 'exporter', 'collected_at', 'hosts']) {
    const msg = errorOf(mutate((p) => delete p[key]));
    assert(msg.startsWith(`$.${key}:`), `missing ${key} reported at $.${key}`, msg);
  }
  assert(errorOf(mutate((p) => delete p.source.kind)).startsWith('$.source.kind:'), 'missing source.kind path');
  assert(errorOf(mutate((p) => delete p.exporter.version)).startsWith('$.exporter.version:'), 'missing exporter.version path');
  assert(errorOf(mutate((p) => delete p.hosts[0].agent_id)).startsWith('$.hosts[0].agent_id:'), 'missing agent_id path');
  assert(errorOf(mutate((p) => delete p.hosts[0].findings)).startsWith('$.hosts[0].findings:'), 'missing findings path');
  assert(errorOf(mutate((p) => delete p.hosts[0].findings[0].vuln_id)).startsWith('$.hosts[0].findings[0].vuln_id:'), 'missing vuln_id path');
  assert(errorOf(mutate((p) => delete p.hosts[0].findings[0].severity)).startsWith('$.hosts[0].findings[0].severity:'), 'missing severity path');

  assert(errorOf(mutate((p) => (p.extra = 1))) === '$.extra: unknown field', 'unknown root field message', errorOf(mutate((p) => (p.extra = 1))));
  assert(errorOf(mutate((p) => (p.source.x = 1))) === '$.source.x: unknown field', 'unknown source field message');
  assert(errorOf(mutate((p) => (p.exporter.x = 1))) === '$.exporter.x: unknown field', 'unknown exporter field message');
  assert(errorOf(mutate((p) => (p.hosts[0].x = 1))) === '$.hosts[0].x: unknown field', 'unknown host field message');
  assert(errorOf(mutate((p) => (p.hosts[0].os.x = 1))) === '$.hosts[0].os.x: unknown field', 'unknown os field message');
  assert(errorOf(mutate((p) => (p.hosts[0].findings[0].x = 1))) === '$.hosts[0].findings[0].x: unknown field', 'unknown finding field message');
  assert(errorOf(mutate((p) => (p.hosts[0].findings[0].package.x = 1))) === '$.hosts[0].findings[0].package.x: unknown field', 'unknown package field message');
  assert(errorOf(mutate((p) => (p['vendor-field'] = 1))) === '$["vendor-field"]: unknown field', 'unknown non-identifier key uses bracket form', errorOf(mutate((p) => (p['vendor-field'] = 1))));

  assert(errorOf(mutate((p) => (p.source.kind = 'QUALYS'))).startsWith('$.source.kind:'), 'unknown source kind rejected');
  assert(errorOf(mutate((p) => (p.hosts[0].findings[0].severity = 'SEVERE'))).startsWith('$.hosts[0].findings[0].severity:'), 'unknown severity rejected');
  assert(errorOf(mutate((p) => (p.source.label = ''))).startsWith('$.source.label:'), 'empty label rejected');
  assert(errorOf(mutate((p) => (p.source.label = 'a'.repeat(129)))).startsWith('$.source.label:'), 'label of 129 characters rejected');
  assert(validateIngestPayload(mutate((p) => (p.source.label = 'a'.repeat(128)))).ok, 'label of 128 characters accepted');
  assert(errorOf(mutate((p) => (p.source.label = 'a\nb'))).startsWith('$.source.label:'), 'control character in label rejected');
  assert(errorOf(mutate((p) => (p.exporter.name = 'bad name'))).startsWith('$.exporter.name:'), 'exporter name pattern');
  assert(errorOf(mutate((p) => (p.exporter.version = 'v'.repeat(33)))).startsWith('$.exporter.version:'), 'exporter version length');
  assert(errorOf(mutate((p) => (p.hosts[0].ip = 'ten dot zero'))).startsWith('$.hosts[0].ip:'), 'ip pattern');
  assert(errorOf(mutate((p) => (p.hosts[0].mac = 'zz:zz'))).startsWith('$.hosts[0].mac:'), 'mac pattern');
  assert(errorOf(mutate((p) => (p.hosts[0].hostname = 'h'.repeat(256)))).startsWith('$.hosts[0].hostname:'), 'hostname length');
  assert(errorOf(mutate((p) => (p.hosts[0].agent_id = ''))).startsWith('$.hosts[0].agent_id:'), 'empty agent_id rejected');
  assert(errorOf(mutate((p) => (p.hosts[0].os.name = 'o'.repeat(129)))).startsWith('$.hosts[0].os.name:'), 'os name length');
  assert(errorOf(mutate((p) => (p.hosts[0].os.version = 'o'.repeat(65)))).startsWith('$.hosts[0].os.version:'), 'os version length');
  assert(errorOf(mutate((p) => (p.hosts[0].findings[0].vuln_id = 'not a cve!'))).startsWith('$.hosts[0].findings[0].vuln_id:'), 'vuln_id pattern');
  assert(errorOf(mutate((p) => (p.hosts[0].findings[0].title = 't'.repeat(513)))).startsWith('$.hosts[0].findings[0].title:'), 'title length');
  assert(errorOf(mutate((p) => (p.hosts[0].findings[0].package.name = ''))).startsWith('$.hosts[0].findings[0].package.name:'), 'package name required non-empty');
  assert(errorOf(mutate((p) => (p.hosts[0].findings[0].package.fixed_version = 'f'.repeat(129)))).startsWith('$.hosts[0].findings[0].package.fixed_version:'), 'fixed_version length');
  assert(validateIngestPayload(mutate((p) => (p.hosts[0].findings[0].package.fixed_version = null))).ok, 'fixed_version null accepted');

  assert(errorOf(mutate((p) => (p.collected_at = 'yesterday'))) === '$.collected_at: not a valid date-time', 'collected_at "yesterday" message', errorOf(mutate((p) => (p.collected_at = 'yesterday'))));
  assert(errorOf(mutate((p) => (p.collected_at = '2026-10-18'))) === '$.collected_at: not a valid date-time', 'date without time rejected');
  assert(errorOf(mutate((p) => (p.collected_at = '2026-10-18T12:00:00'))) === '$.collected_at: not a valid date-time', 'date-time without offset rejected');
  assert(errorOf(mutate((p) => (p.collected_at = '2026-13-45T99:00:00Z'))) === '$.collected_at: not a valid date-time', 'out-of-range date-time rejected');
  assert(validateIngestPayload(mutate((p) => (p.collected_at = '2026-10-18T12:00:00+02:00'))).ok, 'offset date-time accepted');
  assert(validateIngestPayload(mutate((p) => (p.collected_at = '2026-10-18T12:00:00.123456789Z'))).ok, 'nine fraction digits accepted');
  assert(errorOf(mutate((p) => (p.hosts[0].findings[0].published_at = 'someday'))) === '$.hosts[0].findings[0].published_at: not a valid date-time', 'published_at validated');
  assert(errorOf(mutate((p) => (p.hosts[0].findings[0].detected_at = 'someday'))) === '$.hosts[0].findings[0].detected_at: not a valid date-time', 'detected_at validated');

  assert(errorOf(mutate((p) => (p.hosts[0].findings[0].cvss_v3 = 11))).startsWith('$.hosts[0].findings[0].cvss_v3:'), 'cvss 11 rejected');
  assert(errorOf(mutate((p) => (p.hosts[0].findings[0].cvss_v3 = -0.1))).startsWith('$.hosts[0].findings[0].cvss_v3:'), 'cvss -0.1 rejected');
  assert(validateIngestPayload(mutate((p) => (p.hosts[0].findings[0].cvss_v3 = null))).ok, 'cvss null accepted');
  assert(validateIngestPayload(mutate((p) => (p.hosts[0].findings[0].cvss_v3 = 10))).ok, 'cvss 10 accepted');
  assert(errorOf(mutate((p) => (p.hosts[0].findings[0].refs = ['ftp://example.com/x']))).startsWith('$.hosts[0].findings[0].refs[0]:'), 'ftp ref rejected');
  assert(errorOf(mutate((p) => (p.hosts[0].findings[0].refs = Array.from({ length: 21 }, () => 'https://example.com')))).startsWith('$.hosts[0].findings[0].refs:'), '21 refs rejected');
  assert(validateIngestPayload(mutate((p) => (p.hosts[0].findings[0].refs = Array.from({ length: 20 }, () => 'https://example.com')))).ok, '20 refs accepted');
  assert(errorOf(mutate((p) => (p.hosts[0].findings[0].refs = ['https://a b']))).startsWith('$.hosts[0].findings[0].refs[0]:'), 'ref with whitespace rejected');

  const tooManyHosts = errorOf(mutate((p) => (p.hosts = hostsWith(new Array(1001).fill(0)))));
  assert(tooManyHosts.startsWith('$.hosts:'), '1001 hosts rejected', tooManyHosts);
  assert(validateIngestPayload(mutate((p) => (p.hosts = hostsWith(new Array(1000).fill(0))))).ok, '1000 hosts accepted');
  const tooManyFindings = errorOf(mutate((p) => (p.hosts = hostsWith([5001]))));
  assert(tooManyFindings.startsWith('$.hosts[0].findings:'), '5001 findings on one host rejected', tooManyFindings);
  assert(validateIngestPayload(mutate((p) => (p.hosts = hostsWith([5000])))).ok, '5000 findings on one host accepted');
  const over = errorOf(mutate((p) => (p.hosts = hostsWith(new Array(10).fill(5000).concat([1])))));
  assert(over === '$.hosts: at most 50000 findings in total', '50001 findings in total exact message', over);
  assert(validateIngestPayload(mutate((p) => (p.hosts = hostsWith(new Array(10).fill(5000))))).ok, '50000 findings in total accepted');

  const dup = errorOf(mutate((p) => (p.hosts = [{ agent_id: 'a', findings: [] }, { agent_id: 'b', findings: [] }, { agent_id: 'a', findings: [] }])));
  assert(dup === '$.hosts[2].agent_id: duplicate agent_id (also at $.hosts[0])', 'duplicate agent_id exact message', dup);

  // The first issue follows shape order: source before exporter before collected_at before hosts.
  const order = errorOf({ source: { kind: 'WAZUH', label: 'x' }, exporter: { name: '!', version: '1' }, collected_at: 'bad', hosts: 'nope' });
  assert(order.startsWith('$.exporter.name:'), 'issue order follows shape order (exporter before collected_at)', order);
  const order2 = errorOf({ source: { kind: 'WAZUH', label: 'x' }, exporter: { name: 'ok', version: '1' }, collected_at: 'bad', hosts: 'nope' });
  assert(order2.startsWith('$.collected_at:'), 'issue order follows shape order (collected_at before hosts)', order2);
  const order3 = errorOf({ source: { kind: 'X', label: 'x' }, exporter: { name: '!', version: '1' }, collected_at: 'bad', hosts: 'nope' });
  assert(order3.startsWith('$.source.kind:'), 'issue order follows shape order (source first)', order3);

  // ---------------------------------------------------------------------------------------------- parity with the JSON file
  console.log('\n--- parity with ingest.schema.json ---');
  const schemaFile = fileURLToPath(new URL('../server/vm/ingest.schema.json', import.meta.url));
  const doc = JSON.parse(fs.readFileSync(schemaFile, 'utf8')) as Obj;
  const defs = doc.$defs as Obj;
  const props = (o: Obj) => o.properties as Obj;
  const keys = (o: Obj) => Object.keys(o).sort();
  const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

  assert(doc.$id === 'urn:pbc-grc:vm:ingest:1', '$id is the URN');
  assert(String(doc.description).includes('50000'), 'description states the 50000 total limit');
  const refs: string[] = [];
  (function walk(v: unknown) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Obj)) {
        if (k === '$ref' && typeof x === 'string') refs.push(x);
        else walk(x);
      }
    }
  })(doc);
  assert(refs.length > 0 && refs.every((r) => r.startsWith('#/')), 'every $ref is local', refs);
  assert(refs.every((r) => defs[r.slice('#/$defs/'.length)] !== undefined), 'every $ref resolves');

  const objects: Array<[string, Obj, { shape: Record<string, unknown> }]> = [
    ['root', doc, ingestPayloadSchema],
    ['source', props(doc).source, ingestSourceSchema],
    ['exporter', props(doc).exporter, ingestExporterSchema],
    ['host', defs.host, ingestHostSchema],
    ['os', props(defs.host).os, ingestOsSchema],
    ['finding', defs.finding, ingestFindingSchema],
    ['package', props(defs.finding).package, ingestPackageSchema],
  ];
  for (const [name, obj, zodObj] of objects) {
    assert(obj.additionalProperties === false, `${name}: additionalProperties false`);
    assert(same(keys(props(obj)), Object.keys(zodObj.shape).sort()), `${name}: property keys equal the zod shape`, [keys(props(obj)), Object.keys(zodObj.shape).sort()]);
  }

  assert(same([...props(props(doc).source).kind.enum].sort(), [...VM_SOURCE_KINDS].sort()), 'source kind enum equals VM_SOURCE_KINDS');
  assert(JSON.stringify(props(props(doc).source).kind.enum) === JSON.stringify([...VM_SOURCE_KINDS]), 'source kind enum is in the same order');
  assert(JSON.stringify(props(defs.finding).severity.enum) === JSON.stringify([...VM_SEVERITIES]), 'severity enum equals VM_SEVERITIES');

  assert(props(doc).hosts.maxItems === INGEST_LIMITS.maxHosts, 'maxItems hosts');
  assert(props(defs.host).findings.maxItems === INGEST_LIMITS.maxFindingsPerHost, 'maxItems findings per host');
  assert(props(defs.finding).refs.maxItems === INGEST_LIMITS.maxRefs, 'maxItems refs');
  assert(props(defs.finding).refs.items.maxLength === INGEST_LIMITS.refMax, 'maxLength ref');
  assert(props(props(doc).source).label.maxLength === INGEST_LIMITS.labelMax, 'maxLength label');
  assert(props(defs.host).agent_id.maxLength === INGEST_LIMITS.agentIdMax, 'maxLength agent_id');
  assert(props(defs.host).hostname.maxLength === INGEST_LIMITS.hostnameMax, 'maxLength hostname');
  assert(props(props(defs.host).os).name.maxLength === INGEST_LIMITS.osNameMax, 'maxLength os name');
  assert(props(props(defs.host).os).version.maxLength === INGEST_LIMITS.osVersionMax, 'maxLength os version');
  assert(props(defs.finding).title.maxLength === INGEST_LIMITS.titleMax, 'maxLength title');
  assert(props(props(defs.finding).package).name.maxLength === INGEST_LIMITS.packageNameMax, 'maxLength package name');
  assert(props(props(defs.finding).package).version.maxLength === INGEST_LIMITS.packageVersionMax, 'maxLength package version');
  assert(props(props(defs.finding).package).fixed_version.maxLength === INGEST_LIMITS.fixedVersionMax, 'maxLength fixed_version');
  assert(defs.dateTime.maxLength === INGEST_LIMITS.dateTimeMax, 'maxLength dateTime');
  assert(props(defs.finding).published_at.maxLength === INGEST_LIMITS.dateTimeMax, 'maxLength published_at');
  assert(props(defs.finding).cvss_v3.minimum === 0 && props(defs.finding).cvss_v3.maximum === 10, 'cvss range 0..10');
  assert(INGEST_LIMITS.maxTotalFindings === 50000, 'total findings limit is 50000');

  const p = INGEST_PATTERN_SOURCES;
  assert(defs.line.pattern === p.line, 'pattern line ($defs.line)');
  assert(props(props(doc).source).label.pattern === p.line, 'pattern line (label)');
  assert(props(defs.host).agent_id.pattern === p.line && props(defs.host).hostname.pattern === p.line, 'pattern line (agent_id, hostname)');
  assert(props(props(defs.host).os).name.pattern === p.line && props(props(defs.host).os).version.pattern === p.line, 'pattern line (os)');
  assert(props(defs.finding).title.pattern === p.line, 'pattern line (title)');
  assert(props(props(defs.finding).package).name.pattern === p.line && props(props(defs.finding).package).version.pattern === p.line, 'pattern line (package)');
  assert(props(props(doc).exporter).name.pattern === p.exporterName, 'pattern exporterName');
  assert(props(props(doc).exporter).version.pattern === p.exporterVersion, 'pattern exporterVersion');
  assert(props(defs.host).ip.pattern === p.ip, 'pattern ip');
  assert(props(defs.host).mac.pattern === p.mac, 'pattern mac');
  assert(props(defs.finding).vuln_id.pattern === p.vulnId, 'pattern vulnId');
  assert(props(defs.finding).refs.items.pattern === p.ref, 'pattern ref');
  assert(doc.properties.schema_version.const === 1, 'schema_version const 1');

  // ---------------------------------------------------------------------------------------------- formatJsonPath
  console.log('\n--- formatJsonPath ---');
  assert(formatJsonPath([]) === '$', 'root is $');
  assert(formatJsonPath(['hosts', 3, 'findings', 0, 'vuln_id']) === '$.hosts[3].findings[0].vuln_id', 'indexes and identifier keys');
  assert(formatJsonPath(['a-b']) === '$["a-b"]', 'non-identifier key in brackets');
  assert(formatJsonPath(['a b', 'c']) === '$["a b"].c', 'bracket key then identifier');
  assert(formatJsonPath(['1x']) === '$["1x"]', 'key starting with a digit in brackets');
  assert(formatJsonPath(['q"t']) === '$["q\\"t"]', 'quote in key is escaped');

  // ---------------------------------------------------------------------------------------------- vmIngestMaxBytes
  console.log('\n--- vmIngestMaxBytes ---');
  const table: Array<[NodeJS.ProcessEnv, number]> = [
    [{}, 67108864],
    [{ VM_INGEST_MAX_BYTES: '' }, 67108864],
    [{ VM_INGEST_MAX_BYTES: '0' }, 67108864],
    [{ VM_INGEST_MAX_BYTES: '-5' }, 67108864],
    [{ VM_INGEST_MAX_BYTES: '25mb' }, 67108864],
    [{ VM_INGEST_MAX_BYTES: '1048576' }, 1048576],
    [{ VM_INGEST_MAX_BYTES: '209715200' }, 104857600],
  ];
  for (const [env, expected] of table) {
    assert(vmIngestMaxBytes(env) === expected, `VM_INGEST_MAX_BYTES ${JSON.stringify(env.VM_INGEST_MAX_BYTES)} -> ${expected}`, vmIngestMaxBytes(env));
  }

  // ---------------------------------------------------------------------------------------------- storage helper
  console.log('\n--- storage helper ---');
  const savedEnv = { provider: process.env.STORAGE_PROVIDER, root: process.env.LOCAL_STORAGE_PATH };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-storage-'));
  try {
    process.env.STORAGE_PROVIDER = 'local';
    process.env.LOCAL_STORAGE_PATH = tmp;
    assert(localStorageRoot() === path.resolve(tmp), 'root follows LOCAL_STORAGE_PATH per call');
    const tmp2 = path.join(tmp, 'other');
    process.env.LOCAL_STORAGE_PATH = tmp2;
    assert(localStorageRoot() === path.resolve(tmp2), 'root follows a changed env');
    process.env.LOCAL_STORAGE_PATH = tmp;

    const bytes = Buffer.from('{}');
    const written = await writeTenantFile('tenant-a', 'vm/runs/r1.json', bytes, { exclusive: true });
    assert(path.isAbsolute(written.absPath), 'absPath is absolute', written.absPath);
    assert(written.absPath === path.join(path.resolve(tmp), 'tenants', 'tenant-a', 'vm', 'runs', 'r1.json'), 'absPath under tenants/<tenant>/', written.absPath);
    assert(written.size === 2, 'size is 2');
    assert(written.sha256 === '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', 'sha256 of {}');
    assert(written.sha256 === crypto.createHash('sha256').update(bytes).digest('hex'), 'sha256 matches crypto');
    assert(fs.readFileSync(written.absPath).equals(bytes), 'file bytes identical');

    let code = '';
    try {
      await writeTenantFile('tenant-a', 'vm/runs/r1.json', Buffer.from('{"a":1}'), { exclusive: true });
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code ?? '';
    }
    assert(code === 'EEXIST', 'exclusive rewrite fails with EEXIST', code);
    assert(fs.readFileSync(written.absPath).equals(bytes), 'exclusive rewrite left the file untouched');
    await writeTenantFile('tenant-a', 'vm/runs/r1.json', Buffer.from('{"a":1}'), { exclusive: false });
    assert(fs.readFileSync(written.absPath, 'utf8') === '{"a":1}', 'non-exclusive write overwrites');

    const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
      try {
        await fn();
        return '';
      } catch (err) {
        return (err as Error).message;
      }
    };
    assert((await rejects(() => writeTenantFile('tenant-a', '../../x.json', bytes, { exclusive: true }))) === 'Invalid storage path', 'traversal key rejected');
    assert(!fs.existsSync(path.join(tmp, 'x.json')), 'traversal wrote nothing');
    assert((await rejects(() => writeTenantFile('../x', 'a.json', bytes, { exclusive: true }))) !== '', 'tenant id ../x rejected');
    assert((await rejects(() => writeTenantFile('', 'a.json', bytes, { exclusive: true }))) !== '', 'empty tenant id rejected');
    assert((await rejects(() => writeTenantFile('t'.repeat(65), 'a.json', bytes, { exclusive: true }))) !== '', '65-character tenant id rejected');
    assert((await rejects(() => writeTenantFile('tenant-a', '', bytes, { exclusive: true }))) === 'Invalid storage path', 'empty key rejected');
    assert((await rejects(() => writeTenantFile('tenant-a', 'gs://b/x', bytes, { exclusive: true }))) === 'Invalid storage path', 'gs:// key rejected');

    assert(resolveWithin('/root', '../x') === null, 'resolveWithin rejects escape');
    assert(resolveWithin('/root', '.') === null, 'resolveWithin rejects the root itself');
    assert(resolveWithin('/root', 'a/../../x') === null, 'resolveWithin rejects nested escape');
    assert(resolveWithin('/root', 'a/b') === path.resolve('/root', 'a', 'b'), 'resolveWithin accepts a child');
    assert(resolveWithin('/root', '../rootx/y') === null, 'resolveWithin rejects a sibling with a shared prefix');
    assert(resolveTenantLocalPath('t', 'gs://b/x') === null, 'resolveTenantLocalPath rejects gs://');
    assert(resolveTenantLocalPath('t', 42) === null, 'resolveTenantLocalPath rejects non-string');
    assert(resolveTenantLocalPath('t', '') === null, 'resolveTenantLocalPath rejects empty');
    assert(resolveTenantLocalPath('t', 'a.json') === path.join(path.resolve(tmp), 'tenants', 't', 'a.json'), 'resolveTenantLocalPath resolves under the tenant');
    assert(resolveTenantLocalPath('t', '../u/a.json') === null, 'resolveTenantLocalPath rejects another tenant directory');

    delete process.env.STORAGE_PROVIDER;
    assert(storageProvider() === 'local', 'provider defaults to local');
    process.env.STORAGE_PROVIDER = 'GCS';
    assert(storageProvider() === 'gcs', 'provider GCS (any case) is gcs');
    process.env.STORAGE_PROVIDER = 'gcs';
    assert(storageProvider() === 'gcs', 'provider gcs is gcs');
    process.env.STORAGE_PROVIDER = 's3';
    assert(storageProvider() === 'local', 'unknown provider resolves to local');
    process.env.STORAGE_PROVIDER = 'gcs';
    assert((await rejects(() => writeTenantFile('tenant-a', 'vm/runs/r2.json', bytes, { exclusive: true }))) !== '', 'gcs provider: writeTenantFile rejects');
    assert(!fs.existsSync(path.join(tmp, 'tenants', 'tenant-a', 'vm', 'runs', 'r2.json')), 'gcs provider wrote nothing');
  } finally {
    if (savedEnv.provider === undefined) delete process.env.STORAGE_PROVIDER;
    else process.env.STORAGE_PROVIDER = savedEnv.provider;
    if (savedEnv.root === undefined) delete process.env.LOCAL_STORAGE_PATH;
    else process.env.LOCAL_STORAGE_PATH = savedEnv.root;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  assert(!fs.existsSync(tmp), 'temporary storage directory removed');

  // ---------------------------------------------------------------------------------------------- store (memory mode)
  console.log('\n--- store (memory mode) ---');
  const savedMode = process.env.DB_MODE;
  process.env.DB_MODE = 'memory';
  try {
    const store = await import('../server/vm/store');
    const input = (over: Partial<Parameters<typeof store.recordReceivedRun>[1]> = {}) => ({
      id: crypto.randomUUID(),
      kind: 'WAZUH' as const,
      label: 'Wazuh-Prod',
      collectedAt: '2026-10-18T12:00:00Z',
      exporterName: 'exp',
      exporterVersion: '1.0',
      hostCount: 2,
      findingCount: 5,
      rawPath: '/data/r.json',
      rawSha256: crypto.randomBytes(32).toString('hex'),
      rawBytes: 1234,
      ...over,
    });
    const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
      try {
        await fn();
        return '';
      } catch (err) {
        return err instanceof store.VmStoreError ? err.code : `other:${(err as Error).message}`;
      }
    };

    store.__resetVmStoreForTests();
    const a = input();
    const first = await store.recordReceivedRun('t1', a);
    assert(first.run.status === 'RECEIVED' && first.run.id === a.id && first.run.tenantId === 't1', 'recordReceivedRun creates a RECEIVED run');
    assert(first.run.rawBytes === 1234 && first.run.hostCount === 2 && first.run.findingCount === 5, 'run carries counts and bytes');
    assert(first.run.collectedAt === '2026-10-18T12:00:00.000Z', 'collectedAt is an ISO string');
    assert(first.source.kind === 'WAZUH' && first.source.label === 'Wazuh-Prod' && first.source.enabled && first.source.expectedIntervalMinutes === 1440, 'source created with defaults');
    assert(first.run.sourceId === first.source.id, 'run points at its source');
    assert(first.source.lastRunId === a.id && first.source.lastRunAt === first.run.receivedAt, 'source last_run fields updated');
    assert((await store.listSources('t1')).length === 1, 'one source listed');

    const second = await store.recordReceivedRun('t1', input({ label: 'WAZUH-PROD' }));
    assert(second.source.id === first.source.id, 'same label in another case reuses the source');
    assert(second.source.label === 'Wazuh-Prod', 'reused source keeps its original label');
    assert((await store.listSources('t1')).length === 1, 'still one source');
    assert((await store.listSources('t1'))[0].lastRunId === second.run.id, 'source last_run_id moved to the newest run');

    assert((await codeOf(() => store.recordReceivedRun('t1', input({ rawSha256: a.rawSha256 })))) === 'duplicate', 'same sha in the same tenant is duplicate');
    assert((await store.listRuns('t1')).length === 2, 'duplicate left no run behind');
    const found = await store.findRunBySha('t1', a.rawSha256);
    assert(found !== null && found.id === a.id, 'findRunBySha finds the run');
    assert((await store.findRunBySha('t2', a.rawSha256)) === null, 'findRunBySha is tenant scoped');
    const other = await store.recordReceivedRun('t2', input({ rawSha256: a.rawSha256, label: 'wazuh-prod' }));
    assert(other.run.tenantId === 't2' && other.source.id !== first.source.id, 'same sha and label in another tenant is allowed');

    assert((await codeOf(() => store.recordReceivedRun('t1', input({ kind: 'NMAP', label: 'wazuh-PROD' })))) === 'source_kind_mismatch', 'different kind for an existing label is source_kind_mismatch');
    assert((await store.listRuns('t1')).length === 2, 'kind mismatch left no run behind');

    store.__resetVmStoreForTests();
    const r1 = await store.recordReceivedRun('t1', input({ label: 'one' }));
    await new Promise((r) => setTimeout(r, 5));
    const r2 = await store.recordReceivedRun('t1', input({ label: 'two' }));
    await new Promise((r) => setTimeout(r, 5));
    const r3 = await store.recordReceivedRun('t1', input({ label: 'three' }));
    const listed = await store.listRuns('t1');
    assert(listed.map((r) => r.id).join() === [r3.run.id, r2.run.id, r1.run.id].join(), 'listRuns is newest first');
    assert((await store.listRuns('t1', { limit: 2 })).length === 2, 'listRuns honours limit');
    assert((await store.listRuns('t1', { limit: 2 }))[0].id === r3.run.id, 'listRuns limit keeps the newest');
    assert((await store.listRuns('nobody')).length === 0, 'listRuns is tenant scoped');

    assert((await store.getRun('t1', r1.run.id))?.id === r1.run.id, 'getRun returns the run');
    assert((await store.getRun('t2', r1.run.id)) === null, 'getRun for the wrong tenant is null');
    assert((await store.getRun('t1', 'missing')) === null, 'getRun for an unknown id is null');

    const upd = await store.updateRun('t1', r1.run.id, { status: 'NORMALIZING', startedAt: '2026-10-18T13:00:00Z' });
    assert(upd.status === 'NORMALIZING' && upd.startedAt === '2026-10-18T13:00:00.000Z' && upd.error === null, 'updateRun applies status and startedAt');
    const upd2 = await store.updateRun('t1', r1.run.id, { status: 'FAILED', error: 'boom', finishedAt: '2026-10-18T13:01:00Z' });
    assert(upd2.status === 'FAILED' && upd2.error === 'boom' && upd2.finishedAt === '2026-10-18T13:01:00.000Z' && upd2.startedAt === upd.startedAt, 'updateRun leaves absent fields alone');
    assert((await store.getRun('t1', r1.run.id))?.status === 'FAILED', 'updateRun persisted');
    assert((await codeOf(() => store.updateRun('t2', r1.run.id, { status: 'FAILED' }))) === 'not_found', 'updateRun for the wrong tenant is not_found');
    assert((await codeOf(() => store.updateRun('t1', 'missing', { status: 'FAILED' }))) === 'not_found', 'updateRun for an unknown id is not_found');

    const copy = await store.getRun('t1', r2.run.id);
    if (copy) copy.status = 'FAILED';
    assert((await store.getRun('t1', r2.run.id))?.status === 'RECEIVED', 'returned runs are copies');

    store.__resetVmStoreForTests();
    assert((await store.listRuns('t1')).length === 0 && (await store.listSources('t1')).length === 0, '__resetVmStoreForTests empties runs and sources');
    assert((await store.getRun('t1', r1.run.id)) === null, 'reset removed the run');
    assert((await store.findRunBySha('t1', a.rawSha256)) === null, 'reset removed the sha index');
  } finally {
    if (savedMode === undefined) delete process.env.DB_MODE;
    else process.env.DB_MODE = savedMode;
  }

  console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
  if (passed !== total) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
