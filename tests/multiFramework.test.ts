/**
 * Multi-Framework Control Schema & Cross-Framework Evidence Inheritance Test Suite
 * Validates Ticket 1.1 functionality for Event Horizon GRC
 */

import './testEnv';
import app, { server } from '../server/index';
import http from 'http';

const TEST_PORT = 8080;

function generateMockJwt(tenantId: string, email: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64');
  const payload = Buffer.from(
    JSON.stringify({
      sub: `user_${tenantId}`,
      email,
      tenantId,
      name: `Assessor for ${tenantId}`,
      iss: 'https://securetoken.google.com/grc-tool-507203',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
  ).toString('base64');
  return `${header}.${payload}.mock_pbc_signature`;
}

const TENANT_A_TOKEN = generateMockJwt('tenant-alpha', 'compliance@alphadefense.com');
const TENANT_B_TOKEN = generateMockJwt('tenant-beta', 'audit@betasystems.com');

let totalTests = 0;
let passedTests = 0;

function makeRequest(
  path: string,
  method: string = 'GET',
  token?: string,
  tenantId?: string,
  body?: any
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(payload ? { 'Content-Length': Buffer.byteLength(payload).toString() } : {}),
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (tenantId) {
      headers['x-tenant-id'] = tenantId;
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path,
        method,
        headers,
      },
      (res) => {
        let rawData = '';
        res.on('data', (chunk) => {
          rawData += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = rawData ? JSON.parse(rawData) : null;
            resolve({ status: res.statusCode || 500, body: parsed });
          } catch {
            resolve({ status: res.statusCode || 500, body: rawData });
          }
        });
      }
    );

    req.on('error', (err) => reject(err));
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function assert(condition: boolean, message: string) {
  totalTests++;
  if (!condition) {
    console.error(`  ❌ FAIL: ${message}`);
    process.exit(1);
  }
  passedTests++;
  console.log(`  ✅ PASS: ${message}`);
}

async function runMultiFrameworkTests() {
  console.log('================================================================');
  console.log('🧪 RUNNING MULTI-FRAMEWORK & EVIDENCE INHERITANCE TEST SUITE');
  console.log('================================================================\n');

  try {
    // -------------------------------------------------------------
    // 1. Framework Catalog & Registry Endpoint
    // -------------------------------------------------------------
    console.log('--- Test 1: Framework Registry Metadata ---');
    const fwRes = await makeRequest('/api/v1/controls/frameworks', 'GET', TENANT_A_TOKEN, 'tenant-alpha');
    assert(fwRes.status === 200, 'Frameworks endpoint returns HTTP 200');
    assert(Array.isArray(fwRes.body?.frameworks), 'Returns frameworks array');
    assert(fwRes.body?.frameworks?.length === 5, 'Supports all 5 frameworks (CMMC L1, L2, NIST 800-53, SOC 2, HIPAA)');

    const cmmcL2Fw = fwRes.body?.frameworks?.find((f: any) => f.id === 'CMMC_L2');
    assert(cmmcL2Fw?.totalControls === 110, 'CMMC Level 2 specifies 110 controls');

    const nistFw = fwRes.body?.frameworks?.find((f: any) => f.id === 'NIST_800_53_REV5');
    assert(nistFw?.supportsNonNetworkedOverlay === true, 'NIST SP 800-53 Rev 5 supports tactical non-networked overlay');

    // -------------------------------------------------------------
    // 2. Default Query: Backwards-Compatible CMMC Level 1
    // -------------------------------------------------------------
    console.log('\n--- Test 2: Default Query Compatibility (CMMC Level 1) ---');
    const defaultRes = await makeRequest('/api/v1/controls', 'GET', TENANT_A_TOKEN, 'tenant-alpha');
    assert(defaultRes.status === 200, 'GET /api/v1/controls returns HTTP 200');
    assert(defaultRes.body?.framework === 'CMMC_L1', 'Default framework is CMMC_L1');
    assert(defaultRes.body?.controls?.length === 17, 'Default returns exactly 17 CMMC L1 controls');

    // -------------------------------------------------------------
    // 3. CMMC Level 2 (110 Controls)
    // -------------------------------------------------------------
    console.log('\n--- Test 3: CMMC Level 2 Catalog Query ---');
    const l2Res = await makeRequest('/api/v1/controls?framework=CMMC_L2', 'GET', TENANT_A_TOKEN, 'tenant-alpha');
    assert(l2Res.status === 200, 'GET /api/v1/controls?framework=CMMC_L2 returns HTTP 200');
    assert(l2Res.body?.framework === 'CMMC_L2', 'Framework ID matches CMMC_L2');
    assert(l2Res.body?.controls?.length === 110, 'Returns all 110 CMMC Level 2 (NIST 800-171) controls');
    assert(l2Res.body?.controls?.some((c: any) => c.id === 'AC.L2-3.1.3'), 'Contains L2 control AC.L2-3.1.3');

    // -------------------------------------------------------------
    // 4. NIST SP 800-53 Rev 5 with Baseline & Tactical Overlay
    // -------------------------------------------------------------
    console.log('\n--- Test 4: NIST SP 800-53 Rev 5 Baseline & Overlay Filtering ---');
    const nistModRes = await makeRequest(
      '/api/v1/controls?framework=NIST_800_53_REV5&baseline=MOD_MOD_MOD',
      'GET',
      TENANT_A_TOKEN,
      'tenant-alpha'
    );
    assert(nistModRes.status === 200, 'GET NIST 800-53 Moderate Baseline returns HTTP 200');
    const totalModControls = nistModRes.body?.controls?.length || 0;
    assert(totalModControls > 0, `NIST 800-53 Moderate returns catalog controls (${totalModControls})`);

    // Verify alias NIST_800_53_MOD works identically
    const nistAliasRes = await makeRequest('/api/v1/controls?framework=NIST_800_53_MOD', 'GET', TENANT_A_TOKEN, 'tenant-alpha');
    assert(nistAliasRes.status === 200, 'GET NIST_800_53_MOD alias returns HTTP 200');
    assert(nistAliasRes.body?.framework === 'NIST_800_53_REV5', 'Alias resolves to NIST_800_53_REV5');
    assert(nistAliasRes.body?.baseline === 'MOD_MOD_MOD', 'Alias sets baseline to MOD_MOD_MOD');

    // Filter with NON_NETWORKED overlay
    const nistOverlayRes = await makeRequest(
      '/api/v1/controls?framework=NIST_800_53_MOD&overlay=NON_NETWORKED',
      'GET',
      TENANT_A_TOKEN,
      'tenant-alpha'
    );
    assert(nistOverlayRes.status === 200, 'Overlay query returns HTTP 200');
    const overlayControls = nistOverlayRes.body?.controls || [];
    assert(
      overlayControls.length < totalModControls,
      `Non-networked overlay filters out controls (${overlayControls.length} < ${totalModControls})`
    );
    // Boundary-specific controls (e.g. SC-7, AC-17) must be filtered out
    const hasSC7 = overlayControls.some((c: any) => c.id === 'SC-7');
    const hasAC17 = overlayControls.some((c: any) => c.id === 'AC-17');
    assert(!hasSC7 && !hasAC17, 'Network boundary controls (SC-7, AC-17) are successfully filtered out for tactical non-networked systems');

    // -------------------------------------------------------------
    // 5. SOC 2 Type II and HIPAA Security Rule Catalogs
    // -------------------------------------------------------------
    console.log('\n--- Test 5: SOC 2 Type II & HIPAA Security Rule Catalogs ---');
    const soc2Res = await makeRequest('/api/v1/controls?framework=SOC_2_TYPE_II', 'GET', TENANT_A_TOKEN, 'tenant-alpha');
    assert(soc2Res.status === 200, 'GET SOC_2_TYPE_II returns HTTP 200');
    assert(soc2Res.body?.controls?.some((c: any) => c.id === 'CC6.1'), 'Contains SOC 2 CC6.1 Logical Access');

    const hipaaRes = await makeRequest('/api/v1/controls?framework=HIPAA_SECURITY', 'GET', TENANT_A_TOKEN, 'tenant-alpha');
    assert(hipaaRes.status === 200, 'GET HIPAA_SECURITY returns HTTP 200');
    assert(hipaaRes.body?.controls?.some((c: any) => c.id === '164.312(a)(1)'), 'Contains HIPAA §164.312(a)(1) Access Control');

    // -------------------------------------------------------------
    // 6. Cross-Framework Mapping Table Endpoint
    // -------------------------------------------------------------
    console.log('\n--- Test 6: Cross-Framework Canonical Mappings ---');
    const mapRes = await makeRequest('/api/v1/controls/mappings', 'GET', TENANT_A_TOKEN, 'tenant-alpha');
    assert(mapRes.status === 200, 'GET /api/v1/controls/mappings returns HTTP 200');
    assert(Array.isArray(mapRes.body?.mappings), 'Returns mappings array');
    assert(mapRes.body?.mappings?.length >= 25, `Contains at least 25 canonical mapping rules (actual: ${mapRes.body?.mappings?.length})`);

    // -------------------------------------------------------------
    // 7. Cross-Framework Evidence Inheritance Verification
    // -------------------------------------------------------------
    console.log('\n--- Test 7: Cross-Framework Evidence Inheritance ---');
    const testHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    
    // Upload evidence linked to CMMC L1 control AC.L1-3.1.1
    const uploadRes = await makeRequest('/api/v1/evidence/upload-url', 'POST', TENANT_A_TOKEN, 'tenant-alpha', {
      controlId: 'AC.L1-3.1.1',
      fileName: 'multi_framework_iam_policy.pdf',
      mimeType: 'application/pdf',
      fileSize: 24576,
      fileHash: testHash,
      description: 'Master Identity & Access Management Policy across all frameworks',
    });
    assert(uploadRes.status === 201, 'Upload evidence for AC.L1-3.1.1 succeeds (HTTP 201)');

    // Query evidence specifically for mapped NIST 800-53 control AC-2
    const nistEvidenceRes = await makeRequest('/api/v1/evidence?control_id=AC-2', 'GET', TENANT_A_TOKEN, 'tenant-alpha');
    assert(nistEvidenceRes.status === 200, 'Query evidence for AC-2 returns HTTP 200');
    const inheritedAc2 = nistEvidenceRes.body?.evidence?.find((e: any) => e.controlId === 'AC-2' && e.fileHash === testHash);
    assert(Boolean(inheritedAc2), 'AC-2 inherited evidence with matching SHA-256 hash from AC.L1-3.1.1');
    assert(inheritedAc2?.syncStatus === 'inherited', 'Inherited evidence has syncStatus = "inherited"');

    // Query evidence specifically for mapped SOC 2 control CC6.1
    const soc2EvidenceRes = await makeRequest('/api/v1/evidence?control_id=CC6.1', 'GET', TENANT_A_TOKEN, 'tenant-alpha');
    const inheritedSoc2 = soc2EvidenceRes.body?.evidence?.find((e: any) => e.controlId === 'CC6.1' && e.fileHash === testHash);
    assert(Boolean(inheritedSoc2), 'SOC 2 CC6.1 inherited evidence from AC.L1-3.1.1');

    // -------------------------------------------------------------
    // 8. Tenant Isolation on Inherited Evidence
    // -------------------------------------------------------------
    console.log('\n--- Test 8: Tenant Isolation on Inherited Evidence ---');
    // Tenant B queries AC-2
    const tenantBEvidenceRes = await makeRequest('/api/v1/evidence?control_id=AC-2', 'GET', TENANT_B_TOKEN, 'tenant-beta');
    assert(tenantBEvidenceRes.status === 200, 'Tenant B queries AC-2 evidence returns HTTP 200');
    const tenantBAc2Items = tenantBEvidenceRes.body?.evidence || [];
    assert(
      !tenantBAc2Items.some((e: any) => e.fileHash === testHash),
      'Tenant B cannot view Tenant A inherited evidence on AC-2 (RLS Tenant Isolation enforced)'
    );

  } catch (err: any) {
    console.error('Test run failed with error:', err);
  } finally {
    server.close(() => {
      console.log('\n================================================================');
      console.log(`📊 TEST RESULTS: ${passedTests} / ${totalTests} TESTS PASSED (${Math.round((passedTests / totalTests) * 100)}%)`);
      console.log('================================================================\n');
      process.exit(passedTests === totalTests ? 0 : 1);
    });
  }
}

runMultiFrameworkTests();
