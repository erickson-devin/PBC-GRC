/**
 * Import AFTER './testEnv' and BEFORE '../server/index' in tests of the vulnerability-management ingest:
 *  - received payloads are written to the evidence vault, so point it at a throw-away directory;
 *  - TRUST_PROXY=loopback makes the server honour X-Forwarded-Proto from the test client (127.0.0.1) only;
 *  - VM_INGEST_MAX_BYTES is small so the 413 case needs a 300 000 byte body, not 64 MB;
 *  - VM_ALLOW_INSECURE_TOKENS is cleared so token creation over plain HTTP is refused unless a test opts in.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export const VM_TEST_VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'pbc-vm-vault-'));
process.env.LOCAL_STORAGE_PATH = VM_TEST_VAULT;
process.env.STORAGE_PROVIDER = 'local';
process.env.TRUST_PROXY = 'loopback';
process.env.VM_INGEST_MAX_BYTES = '262144';
delete process.env.VM_ALLOW_INSECURE_TOKENS;
