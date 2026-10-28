/**
 * Import AFTER './testEnv' and BEFORE '../server/index' in tests of the evidence download: files are kept in the evidence
 * vault, so point it at a throw-away directory instead of ./data/evidence.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export const EVIDENCE_TEST_VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'pbc-evidence-vault-'));
process.env.LOCAL_STORAGE_PATH = EVIDENCE_TEST_VAULT;
process.env.STORAGE_PROVIDER = 'local';
