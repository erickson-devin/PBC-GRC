// CSV of the Tools and Services register (#239, #249) and of the vendor register (#248). Pure: every cell goes through csvCell, so text a spreadsheet
// could read as a formula is neutralised. Enum values are written as their stored codes (stable, importable), dates as stored, cost as US dollars.
// The cost column is written only when the caller says the role may see it (includeCost); it is always the last column.

import type { InventoryTool, InventoryVendor } from '../../types/inventory';
import { csvCell } from './csv';

const CRLF = '\r\n';

const triState = (b: boolean | null): string => (b === true ? 'Yes' : b === false ? 'No' : '');

/** 1250000 -> '12500.00'. Whole cents in, so no floating point. */
export function centsToDollars(cents: number): string {
  const whole = Math.floor(cents / 100);
  return `${whole}.${String(cents - whole * 100).padStart(2, '0')}`;
}

const line = (cells: (string | number | null | undefined)[]): string => cells.map(csvCell).join(',');

export const TOOL_CSV_HEADERS = [
  'Name',
  'Vendor',
  'Mission',
  'Type',
  'Deployment',
  'CMMC asset category',
  'FedRAMP status',
  'FedRAMP checked on',
  'CRM on file',
  'End users',
  'Privileged users',
  'Recovery order',
  'Renewal date',
];

export function toolRegisterCsv(
  tools: InventoryTool[],
  opts: { includeCost: boolean; controlCounts?: Record<string, number>; vendorsById?: Record<string, string> }
): string {
  const headers = [...TOOL_CSV_HEADERS, ...(opts.controlCounts ? ['Controls linked'] : []), ...(opts.includeCost ? ['Annual cost (USD)'] : [])];
  const rows = tools.map((t) => {
    const vendor = (t.vendorId && opts.vendorsById?.[t.vendorId]) || t.vendorName;
    const cost = typeof t.annualCostCents === 'number' ? centsToDollars(t.annualCostCents) : '';
    return line([
      t.name,
      vendor,
      t.mission,
      t.toolType ?? '',
      t.deployment ?? '',
      t.assetCategory ?? '',
      t.fedrampStatus,
      t.fedrampVerifiedOn ?? '',
      triState(t.crmOnFile),
      t.endUsers ?? '',
      t.privilegedUsers ?? '',
      t.recoveryRank ?? '',
      t.renewalDate ?? '',
      ...(opts.controlCounts ? [opts.controlCounts[t.id] ?? 0] : []),
      ...(opts.includeCost ? [cost] : []),
    ]);
  });
  return [line(headers), ...rows].join(CRLF) + CRLF;
}

export const VENDOR_CSV_HEADERS = [
  'Name',
  'Kind',
  'Services',
  'Contract start',
  'Contract end',
  'Renewal date',
  'FedRAMP status',
  'FedRAMP reference',
  'FedRAMP checked on',
  'CRM on file',
  'Last review',
  'Tools',
];

/** `toolsByVendor`: the tool names of each vendor id (the register's tools grouped by `vendorId`). */
export function vendorRegisterCsv(vendors: InventoryVendor[], toolsByVendor: Record<string, string[]>): string {
  const rows = vendors.map((v) =>
    line([
      v.name,
      v.kind,
      v.services,
      v.contractStart ?? '',
      v.contractEnd ?? '',
      v.renewalDate ?? '',
      v.fedrampStatus,
      v.fedrampReference,
      v.fedrampVerifiedOn ?? '',
      triState(v.crmOnFile),
      v.lastReviewDate ?? '',
      (toolsByVendor[v.id] ?? []).join('; '),
    ])
  );
  return [line(VENDOR_CSV_HEADERS), ...rows].join(CRLF) + CRLF;
}
