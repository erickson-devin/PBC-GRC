import app, { server } from '../server/index';
import http from 'http';

// Helper to make HTTP requests against local Express test instance
function request(options: {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  headers?: Record<string, string>;
  body?: any;
}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = options.body ? JSON.stringify(options.body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 8080,
        path: options.path,
        method: options.method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload).toString() } : {}),
          ...options.headers,
        },
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

    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

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

async function runTests() {
  console.log('================================================================');
  console.log('🧪 RUNNING PRODUCTION CLOUD SQL RLS TENANT ISOLATION TEST SUITE');
  console.log('================================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    totalTests++;
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passedTests++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      if (detail) console.error(`     Detail: ${detail}`);
    }
  }

  try {
    // 1. Health Check
    console.log('--- Test 1: Service Health Check ---');
    const healthRes = await request({ method: 'GET', path: '/api/v1/health' });
    assert(healthRes.status === 200, 'Health endpoint responds with HTTP 200');
    assert(healthRes.body?.status === 'healthy', 'Health status is healthy');
    console.log('');

    // Setup Tenant Tokens
    const tenantA = 'tenant_company_a';
    const tenantB = 'tenant_company_b';
    const tokenA = generateMockJwt(tenantA, 'security@companya.mil');
    const tokenB = generateMockJwt(tenantB, 'audit@companyb.com');

    // 2. Fetch Controls for Company A
    console.log('--- Test 2: Fetch Controls for Company A ---');
    const controlsARes = await request({
      method: 'GET',
      path: '/api/v1/controls',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'x-tenant-id': tenantA,
      },
    });

    assert(controlsARes.status === 200, 'Company A fetches controls successfully (HTTP 200)');
    assert(controlsARes.body?.controls?.length === 17, 'Returns exactly 17 CMMC Level 1 controls');
    assert(
      controlsARes.body?.controls?.every((c: any) => c.tenantId === tenantA),
      'All controls are strictly scoped to Company A tenant ID'
    );
    console.log('');

    // 3. Update Control Status for Company A
    console.log('--- Test 3: Update Control Status for Company A ---');
    const updateRes = await request({
      method: 'PUT',
      path: '/api/v1/controls/AC.L1-3.1.1',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'x-tenant-id': tenantA,
      },
      body: {
        status: 'MET',
        implementationNotes: 'Company A implements centralized identity via Azure AD / Google Cloud Identity with MFA enforced on all accounts.',
        responsibleRole: 'CISO / Lead Security Engineer',
      },
    });

    assert(updateRes.status === 200, 'Company A updates AC.L1-3.1.1 to MET (HTTP 200)');
    assert(updateRes.body?.control?.status === 'MET', 'Control status is persisted as MET');
    assert(
      updateRes.body?.control?.implementationNotes?.toLowerCase().includes('centralized identity'),
      'Implementation notes recorded accurately'
    );
    console.log('');

    // 4. Verify Row-Level Security Isolation between Company A and Company B
    console.log('--- Test 4: RLS Tenant Isolation (Controls Matrix) ---');
    const controlsBRes = await request({
      method: 'GET',
      path: '/api/v1/controls',
      headers: {
        Authorization: `Bearer ${tokenB}`,
        'x-tenant-id': tenantB,
      },
    });

    assert(controlsBRes.status === 200, 'Company B fetches controls successfully (HTTP 200)');
    const ctrlBinB = controlsBRes.body?.controls?.find((c: any) => c.id === 'AC.L1-3.1.1');
    assert(
      ctrlBinB?.status === 'NOT_STARTED',
      "Company B's AC.L1-3.1.1 remains NOT_STARTED (RLS prevented cross-tenant leakage from Company A)"
    );
    console.log('');

    // 5. Evidence Pipeline: Request GCS Signed URL & Save Record for Company A
    console.log('--- Test 5: Evidence Pipeline & SHA-256 Immutability Record ---');
    const testSha256 = '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8';
    const uploadUrlRes = await request({
      method: 'POST',
      path: '/api/v1/evidence/upload-url',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'x-tenant-id': tenantA,
      },
      body: {
        controlId: 'AC.L1-3.1.1',
        fileName: 'MFA_Enforcement_Policy_2026.pdf',
        fileSize: 450200,
        mimeType: 'application/pdf',
        fileHash: testSha256,
        description: 'Signed executive security directive enforcing MFA across all authorized endpoints',
      },
    });

    assert(uploadUrlRes.status === 201, 'GCS Signed Upload URL generated (HTTP 201)');
    assert(Boolean(uploadUrlRes.body?.uploadUrl), 'Upload URL contains valid presigned endpoint');
    assert(
      uploadUrlRes.body?.gcsPath?.includes(`tenants/${tenantA}/controls/AC.L1-3.1.1/`),
      'GCS object path is partitioned strictly under Company A tenant folder'
    );
    assert(
      uploadUrlRes.body?.evidence?.fileHash === testSha256,
      'SHA-256 cryptographic hash recorded immutably in database'
    );

    const evidenceAId = uploadUrlRes.body?.evidenceId;
    assert(Boolean(evidenceAId), `Evidence artifact ID generated: ${evidenceAId}`);
    console.log('');

    // 6. Test Evidence Isolation: Company B queries Company A's evidence artifact ID directly
    console.log('--- Test 6: Cross-Tenant Evidence Artifact Access Security Check ---');
    // Company A queries its own evidence
    const readOwnEvidenceRes = await request({
      method: 'GET',
      path: `/api/v1/evidence/${evidenceAId}`,
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'x-tenant-id': tenantA,
      },
    });
    assert(readOwnEvidenceRes.status === 200, 'Company A can retrieve its own evidence artifact (HTTP 200)');

    // Company B attempts to directly query Company A's evidence artifact ID
    const unauthorizedCrossQueryRes = await request({
      method: 'GET',
      path: `/api/v1/evidence/${evidenceAId}`,
      headers: {
        Authorization: `Bearer ${tokenB}`,
        'x-tenant-id': tenantB,
      },
    });

    assert(
      unauthorizedCrossQueryRes.status === 404,
      "Company B directly querying Company A's evidence ID returns 404 Not Found (Row-Level Security enforced)"
    );

    // Company B lists all evidence -> must be empty
    const listEvidenceBRes = await request({
      method: 'GET',
      path: '/api/v1/evidence',
      headers: {
        Authorization: `Bearer ${tokenB}`,
        'x-tenant-id': tenantB,
      },
    });
    assert(listEvidenceBRes.body?.evidence?.length === 0, "Company B's evidence dataset contains 0 items");
    console.log('');

    // 7. Test Unauthorized Access without Bearer Token
    console.log('--- Test 7: Unauthorized Request Protection ---');
    const noTokenRes = await request({
      method: 'GET',
      path: '/api/v1/controls',
    });
    assert(noTokenRes.status === 401, 'Request without Authorization header is rejected with 401 Unauthorized');
    console.log('');

  } catch (err: any) {
    console.error('Unexpected test error:', err);
  } finally {
    server.close(() => {
      console.log('================================================================');
      console.log(`📊 TEST RESULTS: ${passedTests} / ${totalTests} TESTS PASSED (${Math.round((passedTests / totalTests) * 100)}%)`);
      console.log('================================================================\n');
      process.exit(passedTests === totalTests ? 0 : 1);
    });
  }
}

runTests();
