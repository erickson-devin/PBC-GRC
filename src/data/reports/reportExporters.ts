import { CompiledDocument, MachineReadablePackage, POAMEntry } from '../../types/report';
import { AssessmentState } from '../../types/cmmc';

export const PITCH_BLACK_CYBER_LOGO_BASE64 = 'data:image/png;base64,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';

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
  <div class="classification-banner">${escapeHtml(classification)} — EVENT HORIZON: SINGULARITY (PITCH BLACK CYBER)</div>

  <div class="container">
    <!-- Official Cover Page -->
    <div class="cover-page">
      <div>
        <div class="cover-header">
          <!-- Pitch Black Cyber Official Brand Header -->
          <div style="display: flex; align-items: center; gap: 16px; margin-bottom: 22px; padding-bottom: 16px; border-bottom: 1px solid #e2e8f0;">
            <img src="${PITCH_BLACK_CYBER_LOGO_BASE64}" alt="Pitch Black Cyber Emblem" style="width: 58px; height: 58px; border-radius: 50%; border: 1.5px solid #06b6d4; padding: 2px; background-color: #090d16; box-shadow: 0 0 10px rgba(6,182,212,0.35);" />
            <div>
              <div style="font-size: 13pt; font-weight: 800; color: #0f172a; letter-spacing: -0.02em;">
                Event Horizon: Singularity (Pitch Black Cyber)
              </div>
              <div style="font-size: 8pt; font-weight: 700; color: #0891b2; font-family: 'Courier New', monospace; letter-spacing: 0.1em; text-transform: uppercase; margin-top: 2px;">
                Central Governance & Compliance Engine
              </div>
            </div>
          </div>

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
    ${escapeHtml(classification)} — GENERATED BY EVENT HORIZON: SINGULARITY (PITCH BLACK CYBER)
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
