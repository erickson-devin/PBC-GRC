import { CompiledDocument, MachineReadablePackage, POAMEntry } from '../../types/report';
import { AssessmentState } from '../../types/cmmc';

/**
 * Computes a SHA-256 cryptographic digest for integrity verification.
 * Works seamlessly in both browser (Web Crypto API) and Node.js environments.
 */
export async function computeSha256(text: string): Promise<string> {
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
      const data = new TextEncoder().encode(text);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch {}

  try {
    const nodeCrypto = await import(/* @vite-ignore */ 'crypto');
    return nodeCrypto.createHash('sha256').update(text).digest('hex');
  } catch {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash |= 0;
    }
    return `sha256_sim_${Math.abs(hash).toString(16).padStart(32, '0')}`;
  }
}

/**
 * Helper to escape HTML special characters.
 */
function escapeHtml(str: string | number | undefined | null): string {
  if (str === undefined || str === null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Generates defense-grade printable HTML with official cover pages, headers,
 * footers, and @media print page break rules conforming to NIST/DoD/AICPA standards.
 */
export function generatePrintableHtml(
  doc: CompiledDocument,
  options: { theme?: 'light' | 'dark' } = {}
): string {
  const theme = options.theme || 'light';
  const meta = doc.metadata;
  const metrics = doc.summaryMetrics;
  const isDark = theme === 'dark';

  const classification = meta.classificationLevel || 'UNCLASSIFIED // CUI';

  // CSS Stylesheet with Defense-Grade Typography and Print CSS Rules
  const styles = `
    @charset "UTF-8";
    @page {
      size: letter portrait;
      margin: 15mm 15mm 20mm 15mm;
      @bottom-right {
        content: counter(page);
        font-family: 'Inter', sans-serif;
        font-size: 8pt;
        color: #64748b;
      }
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      font-size: 9.5pt;
      line-height: 1.5;
      color: ${isDark ? '#e2e8f0' : '#1e293b'};
      background-color: ${isDark ? '#0f172a' : '#ffffff'};
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    .classification-banner {
      width: 100%;
      background-color: #0284c7;
      color: #ffffff;
      text-align: center;
      font-size: 8pt;
      font-weight: 800;
      letter-spacing: 0.12em;
      padding: 5px 0;
      text-transform: uppercase;
    }

    .container {
      max-width: 900px;
      margin: 0 auto;
      padding: 30px 40px;
    }

    /* Cover Page */
    .cover-page {
      min-height: 90vh;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 40px 0;
      page-break-after: always;
    }

    .cover-header {
      border-bottom: 3px solid #0284c7;
      padding-bottom: 20px;
      margin-bottom: 30px;
    }

    .cover-badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 8pt;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      background: #e0f2fe;
      color: #0369a1;
      border: 1px solid #bae6fd;
      margin-bottom: 12px;
    }

    .cover-title {
      font-size: 24pt;
      font-weight: 800;
      letter-spacing: -0.02em;
      color: ${isDark ? '#ffffff' : '#0f172a'};
      line-height: 1.2;
      margin-bottom: 8px;
    }

    .cover-subtitle {
      font-size: 13pt;
      font-weight: 500;
      color: #64748b;
      margin-bottom: 20px;
    }

    .meta-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
      background: ${isDark ? '#1e293b' : '#f8fafc'};
      border: 1px solid ${isDark ? '#334155' : '#e2e8f0'};
      border-radius: 8px;
      padding: 20px;
      margin: 25px 0;
    }

    .meta-item {
      display: flex;
      flex-direction: column;
    }

    .meta-label {
      font-size: 7.5pt;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #64748b;
      margin-bottom: 2px;
    }

    .meta-val {
      font-size: 9.5pt;
      font-weight: 600;
      color: ${isDark ? '#f1f5f9' : '#0f172a'};
    }

    .executive-score-box {
      background: ${isDark ? '#1e293b' : '#f0fdf4'};
      border: 1px solid ${isDark ? '#334155' : '#bbf7d0'};
      border-radius: 8px;
      padding: 16px 20px;
      margin: 20px 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .score-title {
      font-size: 10pt;
      font-weight: 700;
      color: #166534;
    }

    .score-metric {
      font-size: 16pt;
      font-weight: 800;
      color: #15803d;
      font-family: monospace;
    }

    /* Signature Block */
    .signature-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 40px;
      margin-top: 40px;
      padding-top: 25px;
      border-top: 1px dashed #cbd5e1;
    }

    .signature-box {
      display: flex;
      flex-direction: column;
    }

    .signature-line {
      height: 40px;
      border-bottom: 1.5px solid #0f172a;
      margin-bottom: 6px;
      display: flex;
      align-items: flex-end;
      font-family: 'Courier New', Courier, monospace;
      font-size: 9pt;
      color: #0284c7;
      font-style: italic;
    }

    .signature-role {
      font-size: 8pt;
      font-weight: 700;
      color: #475569;
      text-transform: uppercase;
    }

    .signature-name {
      font-size: 9pt;
      font-weight: 600;
      color: ${isDark ? '#f8fafc' : '#0f172a'};
    }

    /* Section Typography */
    .section-container {
      margin-bottom: 35px;
      page-break-inside: avoid;
    }

    .page-break-before {
      page-break-before: always;
    }

    .section-heading {
      font-size: 13pt;
      font-weight: 800;
      color: ${isDark ? '#ffffff' : '#0f172a'};
      border-bottom: 1.5px solid #0284c7;
      padding-bottom: 6px;
      margin-bottom: 12px;
    }

    .section-summary {
      font-size: 9pt;
      color: #64748b;
      margin-bottom: 15px;
      font-style: italic;
    }

    .subsection-container {
      margin-bottom: 20px;
      page-break-inside: avoid;
    }

    .subsection-heading {
      font-size: 10.5pt;
      font-weight: 700;
      color: ${isDark ? '#93c5fd' : '#0369a1'};
      margin-bottom: 8px;
    }

    .subsection-content {
      font-size: 9pt;
      margin-bottom: 12px;
      white-space: pre-wrap;
    }

    /* Data Tables */
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 12px 0 20px 0;
      font-size: 8pt;
      page-break-inside: auto;
    }

    tr {
      page-break-inside: avoid;
      page-break-after: auto;
    }

    th {
      background-color: ${isDark ? '#1e293b' : '#f1f5f9'};
      color: ${isDark ? '#f8fafc' : '#334155'};
      font-weight: 700;
      text-align: left;
      padding: 8px 10px;
      border: 1px solid ${isDark ? '#334155' : '#cbd5e1'};
      font-size: 7.5pt;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    td {
      padding: 7px 10px;
      border: 1px solid ${isDark ? '#334155' : '#e2e8f0'};
      vertical-align: top;
    }

    tr:nth-child(even) {
      background-color: ${isDark ? '#0f172a' : '#f8fafc'};
    }

    /* Status Pills */
    .status-badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 7pt;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      white-space: nowrap;
    }

    .status-met {
      background-color: #dcfce7;
      color: #15803d;
      border: 1px solid #86efac;
    }

    .status-in-progress {
      background-color: #fef3c7;
      color: #b45309;
      border: 1px solid #fde68a;
    }

    .status-not-met {
      background-color: #fee2e2;
      color: #b91c1c;
      border: 1px solid #fca5a5;
    }

    .status-not-started {
      background-color: #f1f5f9;
      color: #475569;
      border: 1px solid #cbd5e1;
    }

    .hash-badge {
      font-family: 'Courier New', Courier, monospace;
      font-size: 7.5pt;
      background: #f1f5f9;
      padding: 1px 4px;
      border-radius: 3px;
      color: #334155;
    }

    @media print {
      body {
        background-color: #ffffff !important;
        color: #0f172a !important;
      }
      .no-print {
        display: none !important;
      }
      .container {
        padding: 0 !important;
        max-width: 100% !important;
      }
      .classification-banner {
        background-color: #0f172a !important;
        color: #ffffff !important;
      }
      a {
        text-decoration: none;
        color: inherit;
      }
    }
  `;

  // Helper to format table cells with status badges
  const renderCell = (val: string | number, headerName: string): string => {
    const text = String(val ?? '');
    const headerLower = headerName.toLowerCase();

    if (headerLower.includes('status') || headerLower.includes('operating status') || headerLower.includes('compliance posture')) {
      const upper = text.toUpperCase();
      if (upper.includes('MET') || upper.includes('EFFECTIVELY') || upper.includes('COMPLIANT')) {
        return `<span class="status-badge status-met">${escapeHtml(text)}</span>`;
      }
      if (upper.includes('PROGRESS') || upper.includes('UNDERWAY') || upper.includes('TESTING')) {
        return `<span class="status-badge status-in-progress">${escapeHtml(text)}</span>`;
      }
      if (upper.includes('NOT_MET') || upper.includes('DEFICIENCY') || upper.includes('GAP') || upper.includes('EXCEPTION')) {
        return `<span class="status-badge status-not-met">${escapeHtml(text)}</span>`;
      }
      return `<span class="status-badge status-not-started">${escapeHtml(text)}</span>`;
    }

    if (text.startsWith('POAM-') || text.startsWith('AC.') || text.startsWith('CC') || text.startsWith('164.')) {
      return `<strong>${escapeHtml(text)}</strong>`;
    }

    return escapeHtml(text);
  };

  // Build HTML Content
  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(doc.title)}</title>
  <style>${styles}</style>
</head>
<body>
  <div class="classification-banner">${escapeHtml(classification)}</div>

  <div class="container">
    <!-- Official Cover Page -->
    <div class="cover-page">
      <div>
        <div class="cover-header">
          <span class="cover-badge">${escapeHtml(meta.framework)} • NIST / AICPA / HHS DEFENSE GRADE</span>
          <h1 class="cover-title">${escapeHtml(doc.title)}</h1>
          <p class="cover-subtitle">${escapeHtml(doc.subtitle)}</p>
        </div>

        <div class="meta-grid">
          <div class="meta-item">
            <span class="meta-label">Information System</span>
            <span class="meta-val">${escapeHtml(meta.systemName)}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">Governing Organization</span>
            <span class="meta-val">${escapeHtml(meta.organizationName)}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">CAGE Code / SAM Status</span>
            <span class="meta-val">${escapeHtml(meta.cageCode || 'N/A')} • ${escapeHtml(meta.samStatus || 'Active')}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">Operational Status</span>
            <span class="meta-val">${escapeHtml(meta.operationalStatus)}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">System Owner</span>
            <span class="meta-val">${escapeHtml(meta.systemOwner)}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">Primary Assessor / Author</span>
            <span class="meta-val">${escapeHtml(meta.primaryAssessor)}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">Assessment Date</span>
            <span class="meta-val">${escapeHtml(meta.assessmentDate)}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">Document Revision</span>
            <span class="meta-val">${escapeHtml(meta.version)}</span>
          </div>
        </div>

        <div class="executive-score-box">
          <div>
            <div class="score-title">Assessment Compliance Readiness Posture</div>
            <div style="font-size: 8.5pt; color: #475569; margin-top: 2px;">
              ${metrics.metCount} of ${metrics.totalControls} Controls Implemented (${metrics.inProgressCount} In-Progress, ${metrics.notMetCount} Unmet)
            </div>
          </div>
          <div class="score-metric">${metrics.completionPercentage}% MET</div>
        </div>
      </div>

      <!-- Formal Attestation Signature Block -->
      <div class="signature-grid">
        <div class="signature-box">
          <div class="signature-line">${escapeHtml(meta.systemOwner)}</div>
          <div class="signature-role">System Owner Attestation</div>
          <div class="signature-name">${escapeHtml(meta.systemOwner)} — Date: ${escapeHtml(meta.assessmentDate)}</div>
        </div>
        <div class="signature-box">
          <div class="signature-line">${escapeHtml(meta.primaryAssessor)}</div>
          <div class="signature-role">Certified Lead Assessor</div>
          <div class="signature-name">${escapeHtml(meta.primaryAssessor)} — Date: ${escapeHtml(meta.assessmentDate)}</div>
        </div>
      </div>
    </div>

    <!-- Body Sections -->
  `;

  for (let i = 0; i < doc.sections.length; i++) {
    const sec = doc.sections[i];
    const pageBreakClass = i > 0 && i % 2 === 0 ? 'page-break-before' : '';

    html += `
    <div class="section-container ${pageBreakClass}" id="${escapeHtml(sec.id)}">
      <h2 class="section-heading">${escapeHtml(sec.title)}</h2>
      ${sec.summary ? `<p class="section-summary">${escapeHtml(sec.summary)}</p>` : ''}
      ${sec.content ? `<div class="subsection-content">${escapeHtml(sec.content)}</div>` : ''}
    `;

    // Render section-level table
    if (sec.table && sec.table.headers.length > 0) {
      html += `<table><thead><tr>`;
      for (const h of sec.table.headers) {
        html += `<th>${escapeHtml(h)}</th>`;
      }
      html += `</tr></thead><tbody>`;
      for (const row of sec.table.rows) {
        const cells = Array.isArray(row) ? row : row.cells;
        html += `<tr>`;
        cells.forEach((c, idx) => {
          const headerName = sec.table?.headers[idx] || '';
          html += `<td>${renderCell(c, headerName)}</td>`;
        });
        html += `</tr>`;
      }
      html += `</tbody></table>`;
    }

    // Render subsections
    if (sec.subsections && sec.subsections.length > 0) {
      for (const sub of sec.subsections) {
        html += `
        <div class="subsection-container">
          <h3 class="subsection-heading">${escapeHtml(sub.title)}</h3>
          ${sub.content ? `<div class="subsection-content">${escapeHtml(sub.content)}</div>` : ''}
        `;

        if (sub.items && sub.items.length > 0) {
          html += `<div class="meta-grid" style="margin: 10px 0; padding: 12px 16px;">`;
          for (const item of sub.items) {
            html += `
            <div class="meta-item">
              <span class="meta-label">${escapeHtml(item.label)}</span>
              <span class="meta-val">${escapeHtml(item.value)}</span>
            </div>`;
          }
          html += `</div>`;
        }

        if (sub.table && sub.table.headers.length > 0) {
          html += `<table><thead><tr>`;
          for (const h of sub.table.headers) {
            html += `<th>${escapeHtml(h)}</th>`;
          }
          html += `</tr></thead><tbody>`;
          for (const row of sub.table.rows) {
            const cells = Array.isArray(row) ? row : row.cells;
            html += `<tr>`;
            cells.forEach((c, idx) => {
              const headerName = sub.table?.headers[idx] || '';
              html += `<td>${renderCell(c, headerName)}</td>`;
            });
            html += `</tr>`;
          }
          html += `</tbody></table>`;
        }

        html += `</div>`;
      }
    }

    html += `</div>`;
  }

  html += `
  </div>

  <div class="classification-banner" style="margin-top: 50px;">
    ${escapeHtml(classification)} — GENERATED BY PBC-GRC COMPLIANCE ENGINE
  </div>
</body>
</html>`;

  return html;
}

/**
 * Triggers native browser print dialog for the generated document.
 */
export function triggerBrowserPrint(doc: CompiledDocument): void {
  const html = generatePrintableHtml(doc, { theme: 'light' });
  const printWindow = window.open('', '_blank');
  if (printWindow) {
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
    }, 400);
  } else {
    // Fallback: create hidden iframe
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    document.body.appendChild(iframe);
    const docFrame = iframe.contentWindow?.document;
    if (docFrame) {
      docFrame.open();
      docFrame.write(html);
      docFrame.close();
      iframe.contentWindow?.focus();
      setTimeout(() => {
        iframe.contentWindow?.print();
        document.body.removeChild(iframe);
      }, 500);
    }
  }
}

/**
 * Downloads the official document as a standalone printable HTML file.
 */
export function downloadHtmlDocument(doc: CompiledDocument): void {
  const html = generatePrintableHtml(doc, { theme: 'light' });
  const blob = new Blob([html], { type: 'text/html;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = (doc.metadata.systemName || 'compliance_document')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_');
  a.href = url;
  a.download = `${safeName}_${doc.documentType.toLowerCase()}_${new Date().toISOString().split('T')[0]}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Builds a structured, machine-readable JSON compliance package for audit verification.
 */
export async function generateMachineReadablePackage(
  doc: CompiledDocument,
  state: AssessmentState
): Promise<MachineReadablePackage> {
  const controlMap: MachineReadablePackage['controls'] = {};

  for (const [cId, cState] of Object.entries(state.controls)) {
    const evCount = state.evidenceIndex.filter(e => e.controlId === cId).length;
    controlMap[cId] = {
      status: cState.status,
      implementationNotes: cState.implementationNotes,
      responsibleRole: cState.responsibleRole,
      lastUpdated: cState.lastUpdated,
      tags: cState.tags || [],
      evidenceCount: evCount,
    };
  }

  const evidenceList = state.evidenceIndex.map(e => ({
    id: e.id,
    controlId: e.controlId,
    name: e.name,
    fileSize: e.fileSize,
    mimeType: e.mimeType,
    uploadedAt: e.uploadedAt,
    fileHash: e.fileHash,
    gcsPath: e.gcsPath,
  }));

  const rawPayload = {
    schemaVersion: '2.0.0',
    packageId: `pkg_${state.tenantId}_${Date.now()}`,
    tenantId: state.tenantId,
    framework: doc.framework,
    exportTimestamp: new Date().toISOString(),
    metadata: doc.metadata,
    metrics: {
      totalControls: doc.summaryMetrics.totalControls,
      metCount: doc.summaryMetrics.metCount,
      inProgressCount: doc.summaryMetrics.inProgressCount,
      notMetCount: doc.summaryMetrics.notMetCount,
      notStartedCount: doc.summaryMetrics.notStartedCount,
      completionPercentage: doc.summaryMetrics.completionPercentage,
      isSprsReady: doc.summaryMetrics.metCount === doc.summaryMetrics.totalControls,
      domainStats: {} as any,
    },
    controls: controlMap,
    evidenceIndex: evidenceList,
    poamEntries: doc.poamEntries || [],
  };

  const canonicalString = JSON.stringify(rawPayload, Object.keys(rawPayload).sort());
  const integrityChecksum = await computeSha256(canonicalString);

  return {
    ...rawPayload,
    integrityChecksum,
  };
}

/**
 * Exports the structured compliance package as an immutable JSON file.
 */
export async function downloadJsonPackage(
  doc: CompiledDocument,
  state: AssessmentState
): Promise<void> {
  const pkg = await generateMachineReadablePackage(doc, state);
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = (doc.metadata.systemName || 'compliance_package')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_');
  a.href = url;
  a.download = `${safeName}_audit_package_${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Generates RFC 4180 compliant CSV text from structured POA&M entries.
 */
export function generatePoamCsv(poamEntries: POAMEntry[]): string {
  const headers = [
    'Weakness ID',
    'Control ID',
    'Control Title',
    'Deficiency Description',
    'Current Status',
    'Scheduled Completion Date',
    'Responsible Role',
    'Required Resources',
    'Remediation Action Plan',
  ];

  const escapeCsv = (val: string | number | undefined | null): string => {
    if (val === undefined || val === null) return '""';
    const text = String(val).replace(/"/g, '""');
    return `"${text}"`;
  };

  let csv = headers.map(h => `"${h}"`).join(',') + '\r\n';

  for (const entry of poamEntries) {
    const row = [
      escapeCsv(entry.weaknessId),
      escapeCsv(entry.controlId),
      escapeCsv(entry.controlTitle),
      escapeCsv(entry.weaknessDescription),
      escapeCsv(entry.status),
      escapeCsv(entry.scheduledCompletionDate),
      escapeCsv(entry.responsibleRole),
      escapeCsv(entry.requiredResources),
      escapeCsv(entry.remediationPlan),
    ];
    csv += row.join(',') + '\r\n';
  }

  return csv;
}

/**
 * Downloads structured POA&M entries as a standard CSV spreadsheet.
 */
export function downloadPoamCsv(poamEntries: POAMEntry[], systemName: string = 'system'): void {
  const csv = generatePoamCsv(poamEntries);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = systemName.toLowerCase().replace(/[^a-z0-9]/g, '_');
  a.href = url;
  a.download = `${safeName}_poam_matrix_${new Date().toISOString().split('T')[0]}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
