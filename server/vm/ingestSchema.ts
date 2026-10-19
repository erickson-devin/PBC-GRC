import { z } from 'zod';
import type { Validation } from '../assets';
import { VM_SEVERITIES, VM_SOURCE_KINDS } from '../../src/types/vm';

/**
 * Validator for the vulnerability ingest payload (docs/VULNERABILITY_MANAGEMENT.md, section 5). server/vm/ingest.schema.json
 * is the published contract; this zod schema enforces it, plus what JSON Schema cannot express (total findings, unique
 * agent_id, date-times that parse). tests/vmIngestSchema.test.ts compares the two so they cannot drift.
 */

/** Pattern sources in JSON Schema syntax, exactly as they appear in ingest.schema.json (the parity test compares the strings). */
export const INGEST_PATTERN_SOURCES = {
  line: '^[^\\u0000-\\u001f\\u007f]*$',
  exporterName: '^[A-Za-z0-9._-]{1,64}$',
  exporterVersion: '^[A-Za-z0-9.+_-]{1,32}$',
  ip: '^[A-Za-z0-9.:_/%-]{0,64}$',
  mac: '^[0-9A-Fa-f:.-]{0,32}$',
  vulnId: '^(CVE-[0-9]{4}-[0-9]{4,7}|[A-Za-z0-9][A-Za-z0-9._:-]{0,63})$',
  ref: '^https?://[^\\s]+$',
} as const;

export const INGEST_LIMITS = {
  maxHosts: 1000,
  maxFindingsPerHost: 5000,
  maxTotalFindings: 50000,
  maxRefs: 20,
  labelMax: 128,
  agentIdMax: 128,
  hostnameMax: 255,
  osNameMax: 128,
  osVersionMax: 64,
  titleMax: 512,
  packageNameMax: 255,
  packageVersionMax: 128,
  fixedVersionMax: 128,
  refMax: 2048,
  dateTimeMax: 40,
} as const;

const RE = {
  line: new RegExp(INGEST_PATTERN_SOURCES.line),
  exporterName: new RegExp(INGEST_PATTERN_SOURCES.exporterName),
  exporterVersion: new RegExp(INGEST_PATTERN_SOURCES.exporterVersion),
  ip: new RegExp(INGEST_PATTERN_SOURCES.ip),
  mac: new RegExp(INGEST_PATTERN_SOURCES.mac),
  vulnId: new RegExp(INGEST_PATTERN_SOURCES.vulnId),
  ref: new RegExp(INGEST_PATTERN_SOURCES.ref),
};

/** RFC 3339 date-time. Date.parse alone is too lenient ("yesterday"-like and locale forms), so the shape is checked first. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const DATE_TIME_MESSAGE = 'not a valid date-time';
const isDateTime = (v: string): boolean => RFC3339.test(v) && !Number.isNaN(Date.parse(v));

const dateTime = z.string().max(INGEST_LIMITS.dateTimeMax).refine(isDateTime, DATE_TIME_MESSAGE);

const line = (max?: number) => {
  const base = max === undefined ? z.string() : z.string().max(max);
  return base.regex(RE.line);
};

export const ingestSourceSchema = z
  .object({
    kind: z.enum(VM_SOURCE_KINDS),
    label: z.string().min(1).max(INGEST_LIMITS.labelMax).regex(RE.line),
  })
  .strict();

export const ingestExporterSchema = z
  .object({
    name: z.string().regex(RE.exporterName),
    version: z.string().regex(RE.exporterVersion),
  })
  .strict();

export const ingestOsSchema = z
  .object({
    name: line(INGEST_LIMITS.osNameMax).optional(),
    version: line(INGEST_LIMITS.osVersionMax).optional(),
  })
  .strict();

export const ingestPackageSchema = z
  .object({
    name: z.string().min(1).max(INGEST_LIMITS.packageNameMax).regex(RE.line),
    version: line(INGEST_LIMITS.packageVersionMax).optional(),
    fixed_version: z.string().max(INGEST_LIMITS.fixedVersionMax).nullable().optional(),
  })
  .strict();

export const ingestFindingSchema = z
  .object({
    vuln_id: z.string().regex(RE.vulnId),
    title: line(INGEST_LIMITS.titleMax).optional(),
    severity: z.enum(VM_SEVERITIES),
    cvss_v3: z.number().min(0).max(10).nullable().optional(),
    package: ingestPackageSchema.optional(),
    detected_at: dateTime.optional(),
    published_at: dateTime.nullable().optional(),
    refs: z.array(z.string().max(INGEST_LIMITS.refMax).regex(RE.ref)).max(INGEST_LIMITS.maxRefs).optional(),
  })
  .strict();

export const ingestHostSchema = z
  .object({
    agent_id: z.string().min(1).max(INGEST_LIMITS.agentIdMax).regex(RE.line),
    hostname: line(INGEST_LIMITS.hostnameMax).optional(),
    ip: z.string().regex(RE.ip).optional(),
    mac: z.string().regex(RE.mac).optional(),
    os: ingestOsSchema.optional(),
    findings: z.array(ingestFindingSchema).max(INGEST_LIMITS.maxFindingsPerHost),
  })
  .strict();

export const ingestPayloadSchema = z
  .object({
    schema_version: z.literal(1).optional(),
    source: ingestSourceSchema,
    exporter: ingestExporterSchema,
    collected_at: dateTime,
    hosts: z.array(ingestHostSchema).max(INGEST_LIMITS.maxHosts),
  })
  .strict();

export type IngestPayload = z.infer<typeof ingestPayloadSchema>;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** `$` for the root, `[n]` for indexes, `.key` for identifier keys and `["key"]` for any other key. */
export function formatJsonPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '$';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else {
      const key = String(seg);
      out += IDENTIFIER.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
    }
  }
  return out;
}

/** Validates a parsed JSON body. Reports the first failure only, as server/assets.ts does. */
export function validateIngestPayload(raw: unknown): Validation<IngestPayload> {
  const parsed = ingestPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue.code === 'unrecognized_keys') {
      return { ok: false, error: `${formatJsonPath([...issue.path, issue.keys[0]])}: unknown field` };
    }
    return { ok: false, error: `${formatJsonPath(issue.path)}: ${issue.message}` };
  }
  const payload = parsed.data;

  let total = 0;
  for (const host of payload.hosts) total += host.findings.length;
  if (total > INGEST_LIMITS.maxTotalFindings) {
    return { ok: false, error: `$.hosts: at most ${INGEST_LIMITS.maxTotalFindings} findings in total` };
  }

  const seen = new Map<string, number>();
  for (let j = 0; j < payload.hosts.length; j++) {
    const id = payload.hosts[j].agent_id;
    const first = seen.get(id);
    if (first !== undefined) {
      return { ok: false, error: `$.hosts[${j}].agent_id: duplicate agent_id (also at $.hosts[${first}])` };
    }
    seen.set(id, j);
  }
  return { ok: true, value: payload };
}

export const VM_INGEST_DEFAULT_BYTES = 67108864;
export const VM_INGEST_CAP_BYTES = 104857600;

/** Raw body limit of the ingest route: VM_INGEST_MAX_BYTES (digits, > 0), default 64 MB, never above 100 MB. */
export function vmIngestMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.VM_INGEST_MAX_BYTES;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return VM_INGEST_DEFAULT_BYTES;
  const n = Number(raw);
  if (!(n > 0)) return VM_INGEST_DEFAULT_BYTES;
  return Math.min(n, VM_INGEST_CAP_BYTES);
}
