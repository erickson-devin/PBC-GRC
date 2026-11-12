import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_ENV_PATH, EXPORTER_SOURCES, INSECURE_HTTP_COMMENT, TROUBLESHOOTING, buildExporterEnv, checkCommand, cleanLabel, dryRunCommand, installCommand,
  isPlainHttp, runCommand, windowsAclCommand,
} from '../src/data/telemetry/exporterSetup';
import type { ExporterSource } from '../src/data/telemetry/exporterSetup';

/**
 * Exporter setup (field test 0.3.1): the generated env file and commands are pure text, never carry a token, only emit keys the exporter's
 * config.py reads, and the troubleshooting table matches the docs. Source checks on the two panels and the API Keys modal. No server.
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

const root = process.cwd();
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

function main() {
  const sources = EXPORTER_SOURCES.map((s) => s.id);
  const configSrc = read('exporters/pbc-vm-exporter/pbc_vm_exporter/config.py');
  const keyLine = /^[A-Z_][A-Z0-9_]*=/;
  // get("KEY") or an equivalent accessor such as _plain_value(get, "KEY", ...): the key is a quoted string in config.py.
  const readsKey = (k: string): boolean => configSrc.includes(`get("${k}")`) || configSrc.includes(`get, "${k}"`);

  console.log('--- the env text ---');
  for (const source of sources) {
    const text = buildExporterEnv({ source, pbcUrl: 'https://grc.example.mil/', label: 'my-label' });
    const lines = text.split('\n').filter((l) => l !== '');
    const keyLines = lines.filter((l) => !l.startsWith('#'));
    assert(keyLines.length >= 3 && keyLines.every((l) => keyLine.test(l)), `${source}: every non-comment line is KEY=value`, keyLines.filter((l) => !keyLine.test(l)));
    assert(keyLines.every((l) => !l.slice(l.indexOf('=') + 1).includes('#')), `${source}: no inline comment after a value`);
    assert(/^PBC_SERVICE_TOKEN=$/m.test(text), `${source}: PBC_SERVICE_TOKEN is left empty`);
    assert(text.includes('# Paste the token you copied; it is shown once.'), `${source}: a comment tells the person to paste the token`);
    assert(text.includes('PBC_URL=https://grc.example.mil\n') && !text.includes('mil/'), `${source}: the trailing slash is stripped from the URL`);
    assert(text.includes('PBC_SOURCE_LABEL=my-label\n'), `${source}: the label is written`);
    assert(!text.includes('pbcvm_') && !/Bearer/i.test(text), `${source}: no token text`);
    const missing = keyLines.map((l) => l.slice(0, l.indexOf('='))).filter((k) => !readsKey(k));
    assert(missing.length === 0, `${source}: every key is one config.py reads`, missing);
    const commentedKeys = lines.filter((l) => /^# [A-Z][A-Z0-9_]*=/.test(l)).map((l) => l.slice(2, l.indexOf('=')));
    assert(commentedKeys.every((k) => readsKey(k)), `${source}: every commented key is one config.py reads`, commentedKeys.filter((k) => !readsKey(k)));
    assert(text.endsWith('\n') && !text.includes('\r'), `${source}: LF only, one trailing newline`);
  }

  const wazuh = buildExporterEnv({ source: 'wazuh', pbcUrl: 'https://g', label: '' });
  assert(wazuh.includes('WAZUH_MODE=indexer\n') && wazuh.indexOf('WAZUH_MODE=indexer') < wazuh.indexOf('WAZUH_INDEXER_URL='), 'wazuh: WAZUH_MODE=indexer comes first by default');
  assert(wazuh.includes('# 9200 is the Wazuh indexer, which the exporter reads. 55000 is the Wazuh manager API.') && wazuh.includes('# WAZUH_CA_BUNDLE='), 'wazuh: the 9200 / 55000 comment and the commented CA bundle line');
  assert(wazuh.includes('PBC_SOURCE_LABEL=wazuh-prod\n'), 'an empty label falls back to the default for the source');
  const api = buildExporterEnv({ source: 'wazuh', pbcUrl: 'https://g', label: 'x', wazuhMode: 'api' });
  assert(api.includes('WAZUH_MODE=api\n') && api.includes('WAZUH_API_URL=') && !/^WAZUH_INDEXER_URL=/m.test(api), 'wazuh api mode writes the manager API keys');
  const injected = buildExporterEnv({ source: 'wazuh', pbcUrl: 'https://g\nPBC_CA_BUNDLE=/x', label: 'a\r\nWAZUH_MODE=api' });
  assert(injected.split('\n').filter((l) => /^PBC_CA_BUNDLE=/.test(l)).length === 0 && injected.split('\n').filter((l) => /^WAZUH_MODE=/.test(l)).length === 1, 'a line break in the URL or label cannot add a key');
  assert(cleanLabel('  \n ', 'action1') === 'action1-prod', 'a blank label is the default');

  console.log('\n--- plain http ---');
  const httpEnv = buildExporterEnv({ source: 'wazuh', pbcUrl: 'http://10.35.1.60:3000/', label: '' });
  assert(httpEnv.includes(`PBC_URL=http://10.35.1.60:3000\n${INSECURE_HTTP_COMMENT}\nPBC_ALLOW_INSECURE_TRANSPORT=true\n`), 'an http URL adds the comment and PBC_ALLOW_INSECURE_TRANSPORT=true right after PBC_URL');
  assert(/^PBC_ALLOW_INSECURE_TRANSPORT=true$/m.test(buildExporterEnv({ source: 'wazuh', pbcUrl: 'HTTP://x', label: '' })), 'HTTP:// in capitals counts as plain http');
  assert(isPlainHttp(' http://x/ ') && !isPlainHttp('https://x') && !isPlainHttp(''), 'isPlainHttp');
  for (const source of sources) {
    assert(/^PBC_ALLOW_INSECURE_TRANSPORT=true$/m.test(buildExporterEnv({ source, pbcUrl: 'http://g', label: '' })), `${source}: an http URL writes the flag`);
    assert(!buildExporterEnv({ source, pbcUrl: 'https://g', label: '' }).includes('PBC_ALLOW_INSECURE_TRANSPORT'), `${source}: an https URL never mentions the flag`);
  }

  console.log('\n--- the commands ---');
  const env = DEFAULT_ENV_PATH;
  assert(installCommand() === 'python3 -m venv .venv && .venv/bin/python -m pip install .', 'install is the one documented command');
  for (const source of sources as ExporterSource[]) {
    const cmds = [checkCommand(env, source), dryRunCommand(env, source), runCommand(env, source)];
    assert(cmds.every((c) => c.includes('.venv/bin/pbc-vm-exporter') && c.includes('--env-file')) && installCommand().includes('.venv'), `${source}: the commands use the .venv`, cmds);
    assert(cmds.every((c) => (source === 'wazuh') === !c.includes('--source')), `${source}: --source only for a non-Wazuh source`, cmds);
  }
  assert(checkCommand(env).startsWith('.venv/bin/pbc-vm-exporter check '), 'check is the check subcommand');
  assert(dryRunCommand(env).includes('--dry-run') && !runCommand(env).includes('--dry-run'), 'only the dry run has --dry-run');
  assert(runCommand(env, 'xccdf').includes('--input') && dryRunCommand(env, 'xccdf').includes('--input'), 'xccdf runs name an input');
  assert(checkCommand("/tmp/a b'c.env").includes(`'/tmp/a b'\\''c.env'`), 'a path with a space or quote is shell-quoted');
  assert(!/pbcvm_|Bearer/.test([installCommand(), checkCommand(env), runCommand(env), dryRunCommand(env)].join('\n')), 'no command carries a token');
  const aclCommand = 'icacls "pbc-vm-exporter.env" /inheritance:r /grant:r "$($env:USERNAME):F"';
  assert(windowsAclCommand('pbc-vm-exporter.env') === aclCommand, 'the Windows ACL command is the PowerShell form');

  console.log('\n--- troubleshooting ---');
  assert(TROUBLESHOOTING.length >= 10 && TROUBLESHOOTING.every((r) => r.symptom.trim() !== '' && r.fix.trim() !== ''), 'the table has at least ten non-empty rows');
  const norm = (text: string) => text.replace(/\\\|/g, '|').replace(/`/g, '').replace(/\s+/g, ' ');
  for (const doc of ['docs/SCANNER_INTEGRATIONS.md', 'exporters/pbc-vm-exporter/README.md', 'docs/CONNECT_EXISTING_WAZUH.md']) {
    const text = norm(read(doc));
    const absent = TROUBLESHOOTING.filter((r) => !text.includes(norm(r.fix))).map((r) => r.symptom);
    assert(absent.length === 0, `${doc} carries every fix, word for word`, absent);
  }
  const pyHints = norm(read('exporters/pbc-vm-exporter/pbc_vm_exporter/diagnose.py'));
  assert(pyHints.includes('network.host in /etc/wazuh-indexer/opensearch.yml') && pyHints.includes('its own internal users from the OpenSearch security plugin'), 'diagnose.py has the key hints');

  assert(read('exporters/pbc-vm-exporter/README.md').includes(aclCommand), 'the README has the PowerShell icacls command');
  const runbook = read('docs/CONNECT_EXISTING_WAZUH.md');
  const needles = [
    'wazuh-states-vulnerabilities-*', 'wazuh-states-inventory-*', 'Mapped users', 'Backend roles', 'ssh -N -L 9200:127.0.0.1:9200',
    'tar -xOf wazuh-install-files.tar wazuh-install-files/root-ca.pem', 'curl.exe', '--ssl-no-revoke', 'VM_ALLOW_INSECURE_TOKENS',
  ];
  assert(needles.every((n) => runbook.includes(n)), 'the runbook has the key facts', needles.filter((n) => !runbook.includes(n)));
  assert(!/pbcvm_[A-Za-z0-9]{10}/.test(runbook), 'the runbook carries no token');
  assert(read('docs/SCANNER_INTEGRATIONS.md').includes('CONNECT_EXISTING_WAZUH.md') && read('exporters/pbc-vm-exporter/README.md').includes('CONNECT_EXISTING_WAZUH.md'), 'the scanner guide and the README link the runbook');

  console.log('\n--- source checks ---');
  const modal = read('src/components/auth/ApiTokensModal.tsx');
  assert(!modal.includes('curl -X POST') && !modal.includes('curlExample') && !modal.includes('Service token authorization header'), 'the old curl sample is gone from the API Keys modal');
  assert(modal.includes('<ExporterSetupPanel') && modal.includes('<ConnectedScannersPanel'), 'the modal mounts both panels');
  const section = read('src/components/auth/VmServiceTokensSection.tsx');
  assert(section.includes('<ExporterSetupPanel'), 'the one-time reveal shows the exporter setup');
  const panel = read('src/components/auth/ExporterSetupPanel.tsx');
  assert(!/console\.|localStorage|sessionStorage|dangerouslySetInnerHTML|recordAuditEvent/.test(panel) && !/\bPBC_SERVICE_TOKEN\b.*\$\{/.test(panel), 'the panel logs, stores and injects nothing');
  assert(!/newToken|serviceToken|tokenValue/.test(panel), 'the panel never receives the token');
  assert(panel.includes('isPlainHttp(') && panel.includes('windowsAclCommand('), 'the panel shows the http note and the Windows ACL command');
  assert(panel.includes('window.location.origin') && panel.includes('new Blob(') && panel.includes('EXPORTER_ENV_FILENAME'), 'the URL defaults to the origin and the file is a Blob download');
  const buttons = panel.match(/<button\b[^>]*>/g) ?? [];
  assert(buttons.length >= 2 && buttons.every((b) => b.includes('type="button"') && b.includes('aria-label=')), 'every button is type="button" with an aria-label', buttons);
  const scanners = read('src/components/auth/ConnectedScannersPanel.tsx');
  assert(scanners.includes('ApiClient.listVmSources(tenantId)') && scanners.includes('ApiClient.listVmRuns(tenantId,') && scanners.includes('ErrorNotice') && !/console\.|dangerouslySetInnerHTML/.test(scanners), 'the scanners panel loads through ApiClient and shows a fixed error');
  const helper = read('src/data/telemetry/exporterSetup.ts');
  const nonTypeImports = helper.split('\n').filter((l) => /^import /.test(l) && !/^import type /.test(l));
  assert(nonTypeImports.length === 0 && !/react|console\.|localStorage|sessionStorage|fetch\(/.test(helper.replace(/\/\*[\s\S]*?\*\//, '')), 'the helper module is pure');

  console.log('--- pbc-vm-exporter init emits the same keys ---');
  const initSrc = read('exporters/pbc-vm-exporter/pbc_vm_exporter/init.py');
  for (const wazuhMode of [undefined, 'api'] as const) {
    const text = buildExporterEnv({ source: 'wazuh', pbcUrl: 'https://g', label: 'x', wazuhMode });
    const keys = text.split('\n').filter((l) => l !== '' && !l.startsWith('#')).map((l) => l.slice(0, l.indexOf('=')));
    const missing = keys.filter((k) => !initSrc.includes(`${k}=`));
    assert(keys.length >= 6 && missing.length === 0, `init.py emits every key of the in-app wazuh ${wazuhMode ?? 'indexer'} env text`, missing);
  }
  assert(initSrc.includes('WAZUH_MODE=indexer') && initSrc.includes('O_EXCL') && initSrc.includes('0o600'), 'init.py writes WAZUH_MODE=indexer and creates the file exclusively at 0600');
  assert(!/\bprint\(/.test(initSrc), 'init.py never calls print(');
  assert(initSrc.includes(INSECURE_HTTP_COMMENT) && initSrc.includes('/inheritance:r /grant:r "$($env:USERNAME):F"'), 'init.py writes the same http comment and prints the same PowerShell icacls command');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  process.exit(passed === total ? 0 : 1);
}

main();
