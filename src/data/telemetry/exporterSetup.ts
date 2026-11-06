/**
 * Exporter setup (field test 0.3.1): the env file and the commands for pbc-vm-exporter, and the error-to-fix table, as pure text.
 * No react, no storage, no logging, no network. The service token is NEVER part of this text: PBC_SERVICE_TOKEN is left empty
 * and the person pastes the token they copied (it is shown once). Every key emitted here is one config.py of the exporter reads
 * (pinned by tests/exporterSetup.test.ts). Comments sit on their own lines: the exporter's env parser has no inline comments.
 * The troubleshooting wording is the same as exporters/pbc-vm-exporter/pbc_vm_exporter/diagnose.py and the docs.
 */

export type ExporterSource = 'wazuh' | 'xccdf' | 'action1' | 'sentinelone';
export type WazuhMode = 'indexer' | 'api';

export const EXPORTER_SOURCES: ReadonlyArray<{ id: ExporterSource; label: string }> = [
  { id: 'wazuh', label: 'Wazuh' },
  { id: 'xccdf', label: 'XCCDF / ARF files (SCAP)' },
  { id: 'action1', label: 'Action1' },
  { id: 'sentinelone', label: 'SentinelOne' },
];

export const DEFAULT_LABELS: Record<ExporterSource, string> = {
  wazuh: 'wazuh-prod',
  xccdf: 'scap-scans',
  action1: 'action1-prod',
  sentinelone: 'sentinelone-prod',
};

export const EXPORTER_ENV_FILENAME = 'pbc-vm-exporter.env';
export const DEFAULT_ENV_PATH = './pbc-vm-exporter.env';

export interface ExporterEnvInput {
  source: ExporterSource;
  pbcUrl: string;
  label: string;
  wazuhMode?: WazuhMode;
}

/** One line of text: control characters (a line break would start a new KEY) become spaces, then trimmed. */
const oneLine = (raw: string): string => raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();

/** The URL as written to the file: one line, no trailing slashes. */
export const cleanPbcUrl = (raw: string): string => oneLine(raw).replace(/\/+$/, '');

export const cleanLabel = (raw: string, source: ExporterSource): string => oneLine(raw) || DEFAULT_LABELS[source];

const COMMON_NOTES = [
  '# pbc-vm-exporter settings. Keep this file readable only by the exporter account (chmod 600).',
  '# Quotes around a value are optional and are stripped. Comments go on their own line, never after a value.',
];

function wazuhLines(mode: WazuhMode): string[] {
  const common = [
    '# Wazuh certificates: point this at the CA that signed them (the Wazuh root CA is /etc/wazuh-indexer/certs/root-ca.pem on the Wazuh host).',
    '# WAZUH_CA_BUNDLE=/path/to/root-ca.pem',
  ];
  if (mode === 'api') {
    return [
      '# api mode reads the Wazuh manager API (port 55000, Wazuh 4.7 and earlier). The indexer is port 9200.',
      'WAZUH_MODE=api',
      'WAZUH_API_URL=https://wazuh.example.local:55000',
      '# A Wazuh manager API (RBAC) user.',
      'WAZUH_API_USER=',
      'WAZUH_API_PASSWORD=',
      ...common,
    ];
  }
  return [
    '# 9200 is the Wazuh indexer, which the exporter reads. 55000 is the Wazuh manager API.',
    '# WAZUH_MODE=auto would also need WAZUH_API_URL, WAZUH_API_USER and WAZUH_API_PASSWORD.',
    'WAZUH_MODE=indexer',
    'WAZUH_INDEXER_URL=https://wazuh.example.local:9200',
    '# An indexer user from the OpenSearch security plugin (not a Wazuh manager API user) with read on the vulnerability index.',
    'WAZUH_INDEXER_USER=',
    'WAZUH_INDEXER_PASSWORD=',
    ...common,
    '# WAZUH_INDEXER_INDEX=wazuh-states-vulnerabilities-*',
  ];
}

function sourceLines(input: ExporterEnvInput): string[] {
  switch (input.source) {
    case 'wazuh':
      return wazuhLines(input.wazuhMode === 'api' ? 'api' : 'indexer');
    case 'xccdf':
      return ['# XCCDF / ARF result files are named on the command line (--input), not here.'];
    case 'action1':
      return [
        '# The full Action1 API root (North America shown; Europe is https://app.eu.action1.com/api/3.0).',
        'ACTION1_BASE_URL=https://app.action1.com/api/3.0',
        'ACTION1_ORG_ID=',
        'ACTION1_CLIENT_ID=',
        'ACTION1_CLIENT_SECRET=',
        '# ACTION1_INCLUDE_PATCH_FINDINGS=true',
        '# ACTION1_CA_BUNDLE=/path/to/ca.pem',
        '# ACTION1_PROXY_URL=http://proxy.example.local:3128',
      ];
    case 'sentinelone':
      return [
        '# The console host only, without a path.',
        'S1_CONSOLE_URL=https://example.sentinelone.net',
        'S1_API_TOKEN=',
        '# Comma-separated numeric site ids.',
        'S1_SITE_IDS=',
        '# S1_CA_BUNDLE=/path/to/ca.pem',
        '# S1_PROXY_URL=http://proxy.example.local:3128',
      ];
  }
}

/** The env file text. The token line is empty on purpose. */
export function buildExporterEnv(input: ExporterEnvInput): string {
  const lines = [
    ...COMMON_NOTES,
    '',
    '# The address this exporter host uses to reach PBC-GRC (https).',
    `PBC_URL=${cleanPbcUrl(input.pbcUrl)}`,
    '# Paste the token you copied; it is shown once.',
    'PBC_SERVICE_TOKEN=',
    '# A stable name for this source: a new label is a new source.',
    `PBC_SOURCE_LABEL=${cleanLabel(input.label, input.source)}`,
    '# PBC-GRC certificate from a private CA: point this at the CA file.',
    '# PBC_CA_BUNDLE=/path/to/pbc-root-ca.pem',
    '',
    ...sourceLines(input),
  ];
  return lines.join('\n') + '\n';
}

/** Run inside the exporters/pbc-vm-exporter folder. */
export const installCommand = (): string => 'python3 -m venv .venv && .venv/bin/python -m pip install .';

const sourceArgs = (source: ExporterSource): string => (source === 'wazuh' ? '' : ` --source ${source}`);
const xccdfInput = (source: ExporterSource): string => (source === 'xccdf' ? ' --input /path/to/results' : '');

/** The env path is shown as typed; a space or quote in it is quoted for a POSIX shell. */
const shellPath = (envPath: string): string => {
  const p = oneLine(envPath) || DEFAULT_ENV_PATH;
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
};

export const checkCommand = (envPath: string, source: ExporterSource = 'wazuh'): string =>
  `.venv/bin/pbc-vm-exporter check --env-file ${shellPath(envPath)}${sourceArgs(source)}`;

export const dryRunCommand = (envPath: string, source: ExporterSource = 'wazuh'): string =>
  `.venv/bin/pbc-vm-exporter --dry-run --env-file ${shellPath(envPath)}${sourceArgs(source)}${xccdfInput(source)}`;

export const runCommand = (envPath: string, source: ExporterSource = 'wazuh'): string =>
  `.venv/bin/pbc-vm-exporter --env-file ${shellPath(envPath)}${sourceArgs(source)}${xccdfInput(source)}`;

export const EXPORTER_SETUP_COPY = {
  heading: 'Set up the exporter',
  intro: 'The exporter reads your scanner and pushes the results here with a service token. Fill in the three fields, copy the settings into an env file on the exporter host, paste the token you copied, then run the commands in order.',
  sourceLabel: 'Scanner',
  urlLabel: 'PBC-GRC URL',
  urlHelp: 'The address the exporter host uses to reach this app.',
  labelLabel: 'Source label',
  labelHelp: 'A stable name for this scanner. A new label is a new source.',
  modeLabel: 'Wazuh reader',
  modeIndexer: 'Indexer (port 9200, Wazuh 4.8 and later)',
  modeApi: 'Manager API (port 55000, Wazuh 4.7 and earlier)',
  envHeading: 'Settings file',
  envNote: 'The token is not included: paste the token you copied after PBC_SERVICE_TOKEN=. Keep the file readable only by the exporter account.',
  copyEnv: 'Copy settings',
  download: `Download ${EXPORTER_ENV_FILENAME}`,
  copied: 'Copied',
  copyFailed: 'The browser blocked copying. Select the text and copy it with Ctrl+C (Cmd+C on a Mac).',
  commandsHeading: 'Commands',
  commandsNote: 'Run these on the exporter host, inside the exporters/pbc-vm-exporter folder.',
  stepInstall: '1. Install',
  stepCheck: '2. Check the connections',
  stepDryRun: '3. Dry run (sends nothing)',
  stepRun: '4. Run',
  troubleshooting: 'Troubleshooting',
} as const;

/** The error-to-fix table. Same wording as diagnose.py in the exporter and the Troubleshooting section of the docs. */
export const TROUBLESHOOTING: Array<{ symptom: string; fix: string }> = [
  {
    symptom: 'Connection refused (WinError 10061) to the Wazuh indexer',
    fix: 'nothing is listening at that address: on the Wazuh host the indexer may be bound to 127.0.0.1 only; set network.host in /etc/wazuh-indexer/opensearch.yml (a list such as [127.0.0.1, <LAN IP>]) and restart wazuh-indexer, or check the firewall for port 9200',
  },
  {
    symptom: 'Connection timed out',
    fix: 'the connection timed out: a firewall is probably dropping traffic from this host to that address and port (indexer 9200, manager API 55000, PBC-GRC 443); open the port from this host',
  },
  {
    symptom: 'getaddrinfo failed, Name or service not known',
    fix: 'the host name does not resolve from this machine: check the spelling, DNS, or use the IP address',
  },
  {
    symptom: 'unable to get local issuer certificate, self-signed certificate',
    fix: 'set WAZUH_CA_BUNDLE to the indexer root CA (/etc/wazuh-indexer/certs/root-ca.pem on the Wazuh host); for the PBC-GRC certificate set PBC_CA_BUNDLE to its CA',
  },
  {
    symptom: "IP address mismatch, Hostname mismatch, doesn't match",
    fix: 'the certificate does not cover the host name or IP in the URL: use a name the certificate lists (check with openssl s_client ... | openssl x509 -noout -text, Subject Alternative Name), or reissue it with that IP',
  },
  {
    symptom: 'Indexer returned HTTP 401',
    fix: 'the indexer (port 9200) uses its own internal users from the OpenSearch security plugin, not Wazuh manager API users; create the user with the security plugin (see docs/SCANNER_INTEGRATIONS.md)',
  },
  {
    symptom: 'Indexer returned HTTP 403',
    fix: 'the user is known but its role lacks read access on the vulnerability index: map a role with read on wazuh-states-vulnerabilities-* to this user in the indexer security plugin',
  },
  {
    symptom: 'Indexer returned HTTP 404 (index_not_found)',
    fix: 'index_not_found: vulnerability detection is probably off in Wazuh, or WAZUH_INDEXER_INDEX is the wrong index name',
  },
  {
    symptom: 'WAZUH_INDEXER_URL ends in :55000, or WAZUH_API_URL ends in :9200',
    fix: 'port 9200 is the Wazuh indexer, which the exporter reads; port 55000 is the Wazuh manager API: point WAZUH_INDEXER_URL at 9200 and set WAZUH_MODE=indexer',
  },
  {
    symptom: 'PBC-GRC answers HTTP 403 vm_insecure_transport',
    fix: 'PBC-GRC saw plain http: serve the app over HTTPS, and set TRUST_PROXY on the server when a reverse proxy terminates TLS (vm_insecure_transport)',
  },
  {
    symptom: 'PBC-GRC answers HTTP 401',
    fix: 'the service token is wrong, expired or revoked: create a new one in PBC-GRC (API tokens) and paste it',
  },
  {
    symptom: 'Warning: PBC_ALLOW_INSECURE_TRANSPORT is set',
    fix: 'PBC_ALLOW_INSECURE_TRANSPORT is set but every URL is https: remove it, it only silences a safety check',
  },
];
