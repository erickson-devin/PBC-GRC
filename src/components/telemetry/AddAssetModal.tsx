import React, { useState, useEffect, useId, useRef } from 'react';
import {
  X,
  Server,
  Monitor,
  AlertTriangle,
  Wifi,
} from 'lucide-react';
import {
  EnclaveAsset,
  EnclaveAssetOsProfile,
  CmmcAssetCategory,
  EnclaveAssetStatus,
} from '../../types/telemetry';
import { CATEGORY_INFO, CMMC_ASSET_CATEGORIES } from '../../data/telemetry/assetScope';
import {
  FIPS_STANDARDS,
  FIPS_STATUSES,
  FIPS_STATUS_LABELS,
  FipsStandard,
  FipsValidationStatus,
  isFipsEligibleCategory,
  normalizeFips,
} from '../../data/telemetry/fipsValidation';
import { errorMessage } from '../../utils/errors';

import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { radioGroupKeyDown } from '../../utils/a11y';
import { HARDWARE_LIMITS } from '../../data/telemetry/hardwareDetails';
import { osProfileFor, osProfileSelectValue } from '../../data/telemetry/osProfile';
import type { ObservedComparisonRow, ObservedField } from '../../data/telemetry/observedInventory';
import { OBSERVED_COPY, OBSERVED_FIELD_LABEL, reportedOsText } from '../../data/telemetry/observedInventoryView';
import { useObservedInventory } from '../../hooks/useObservedInventory';
import { ObservedInventoryPanel } from './ObservedInventoryPanel';
interface AddAssetModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Resolves when the asset is saved. A rejection is shown in the form, which stays open so nothing typed is lost. */
  onSave: (asset: Omit<EnclaveAsset, 'id'>) => Promise<void> | void;
  initialAsset?: EnclaveAsset | null;
  tenantId: string;
  /** True for a tenant on the server: only then is there scanner data to show beside an asset being edited. */
  serverBacked?: boolean;
}

export const AddAssetModal: React.FC<AddAssetModalProps> = ({
  isOpen,
  onClose,
  onSave,
  initialAsset,
  tenantId,
  serverBacked = false,
}) => {
  const [hostName, setHostName] = useState('');
  const [ipAddress, setIpAddress] = useState('');
  const [macAddress, setMacAddress] = useState('');
  const [osProfile, setOsProfile] = useState<EnclaveAssetOsProfile>('rhel9');
  const [cmmcAssetCategory, setCmmcAssetCategory] = useState<CmmcAssetCategory>('CUI_ASSET');
  const [status, setStatus] = useState<EnclaveAssetStatus>('NEVER_SCANNED');
  const [notes, setNotes] = useState('');
  const [owner, setOwner] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [model, setModel] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [location, setLocation] = useState('');
  const idBase = useId();
  const hwId = (f: string) => `${idBase}-hw-${f}`;
  const hwHelpId = `${idBase}-hw-help`;
  const fieldId = (f: string) => `${idBase}-f-${f}`;
  const osHelpId = `${idBase}-os-help`;
  const scannerHelpId = (f: ObservedField) => `${idBase}-scanner-${f}`;
  // Scanner values copied into the form and not edited since: each is flagged "not saved yet" under its field
  const [fromScanner, setFromScanner] = useState<ObservedField[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const ipRef = useRef<HTMLInputElement>(null);
  const macRef = useRef<HTMLInputElement>(null);
  const osRef = useRef<HTMLSelectElement>(null);
  const serialRef = useRef<HTMLInputElement>(null);
  const observed = useObservedInventory(tenantId, initialAsset?.id ?? null, isOpen && serverBacked && Boolean(initialAsset));
  const [fipsStatus, setFipsStatus] = useState<FipsValidationStatus | ''>('');
  const [fipsStandard, setFipsStandard] = useState<FipsStandard | ''>('');
  const [fipsCert, setFipsCert] = useState('');
  const [fipsModule, setFipsModule] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialAsset) {
      setHostName(initialAsset.hostName);
      setIpAddress(initialAsset.ipAddress);
      setMacAddress(initialAsset.macAddress || '');
      setOsProfile(osProfileSelectValue(initialAsset.osProfile) as EnclaveAssetOsProfile);
      setCmmcAssetCategory(initialAsset.cmmcAssetCategory);
      setStatus(initialAsset.status);
      setNotes(initialAsset.notes || '');
      setOwner(initialAsset.owner || '');
      setManufacturer(initialAsset.manufacturer || '');
      setModel(initialAsset.model || '');
      setSerialNumber(initialAsset.serialNumber || '');
      setLocation(initialAsset.location || '');
      setFipsStatus(initialAsset.fipsValidationStatus || '');
      setFipsStandard(initialAsset.fipsStandard || '');
      setFipsCert(initialAsset.fipsCertificateNumber || '');
      setFipsModule(initialAsset.fipsModuleName || '');
    } else {
      setHostName('');
      setIpAddress('');
      setMacAddress('');
      setOsProfile('rhel9');
      setCmmcAssetCategory('CUI_ASSET');
      setStatus('NEVER_SCANNED');
      setNotes('');
      setOwner('');
      setManufacturer('');
      setModel('');
      setSerialNumber('');
      setLocation('');
      setFipsStatus('');
      setFipsStandard('');
      setFipsCert('');
      setFipsModule('');
    }
    setError(null);
    setSaving(false);
    setFromScanner([]);
    setAnnouncement('');
  }, [initialAsset, isOpen]);

  if (!isOpen) return null;

  /** The person edited the field by hand: it is theirs again, no longer "a scanner value". */
  const edited = (f: ObservedField) => setFromScanner(cur => cur.filter(x => x !== f));

  /** Copies one scanner value into its form field (nothing is saved), flags it, announces it and moves focus to it. */
  const applyScannerValue = (row: ObservedComparisonRow) => {
    if (row.field === 'ipAddress') {
      setIpAddress(row.observed);
      ipRef.current?.focus();
    } else if (row.field === 'macAddress') {
      setMacAddress(row.observed);
      macRef.current?.focus();
    } else if (row.field === 'serialNumber') {
      setSerialNumber(row.observed);
      serialRef.current?.focus();
    } else {
      const host = observed.hosts.find(h => h.sourceId === row.sourceId);
      if (!host) return;
      setOsProfile(osProfileFor(host.os.name, host.os.version) as EnclaveAssetOsProfile);
      osRef.current?.focus();
    }
    setFromScanner(cur => (cur.includes(row.field) ? cur : [...cur, row.field]));
    setAnnouncement(`${OBSERVED_FIELD_LABEL[row.field]} set from the scanner. Not saved yet.`);
  };

  const scannerHelp = (f: ObservedField) =>
    fromScanner.includes(f) ? <p id={scannerHelpId(f)} className="mt-1 text-xs text-cyan-300">{OBSERVED_COPY.scannerValueHelp}</p> : null;
  const reportedOs = reportedOsText(initialAsset?.osProfile, observed.hosts);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hostName.trim()) {
      setError('Asset name is required.');
      return;
    }

    // The same rules the server applies, so a mistake is explained before anything is sent
    const fips = normalizeFips(cmmcAssetCategory, {
      fipsValidationStatus: fipsStatus || null,
      fipsStandard: fipsStandard || null,
      fipsCertificateNumber: fipsCert || null,
      fipsModuleName: fipsModule || null,
    });
    if (!fips.ok) {
      setError(fips.error);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave({
        tenantId,
        hostName: hostName.trim(),
        ipAddress: ipAddress.trim(),
        // Left blank when unknown: an invented address would be stored as if it were real
        macAddress: macAddress.trim(),
        osProfile,
        cmmcAssetCategory,
        status: initialAsset ? status : 'NEVER_SCANNED',
        sourceOrigin: initialAsset?.sourceOrigin || 'MANUAL_ENTRY',
        discoveryStatus: initialAsset?.discoveryStatus || 'ACTIVE',
        lastScannedAt: initialAsset?.lastScannedAt || null,
        complianceScore: initialAsset?.complianceScore !== undefined ? initialAsset.complianceScore : null,
        notes: notes.trim(),
        owner: owner.trim(),
        manufacturer: manufacturer.trim(),
        model: model.trim(),
        serialNumber: serialNumber.trim(),
        location: location.trim(),
        ...fips.fields,
        isManuallyAdded: true,
      });
      onClose();
    } catch (err: unknown) {
      setError(errorMessage(err) || 'The asset could not be saved.');
      setSaving(false);
    }
  };

  return (
    <DialogOverlay onClose={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
      {/* Click outside backdrop */}
      <div aria-hidden="true" className="absolute inset-0" onClick={onClose} />

      <div className="relative w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl p-6 text-slate-100 z-10 space-y-5 max-h-[90vh] overflow-y-auto">
        
        {/* Modal Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-400">
              <Server className="w-5 h-5" />
            </div>
            <div>
              <DialogTitle as="h2" className="text-base font-bold text-white">
                {initialAsset ? 'Edit Enclave Asset' : 'Register Enclave Asset'}
              </DialogTitle>
              <p className="text-xs text-slate-400">
                Describe the asset and assign its CMMC scoping category.
              </p>
            </div>
          </div>

          <button aria-label="Close"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div role="alert" className="p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          
          {/* Hostname & IP Address */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor={fieldId('hostName')} className="block font-semibold text-slate-300 mb-1.5">
                Asset name / hostname <span className="text-rose-400">*</span>
              </label>
              <div className="flex items-center gap-2">
                <Monitor className="w-4 h-4 text-slate-400 shrink-0" />
                <input
                  id={fieldId('hostName')}
                  type="text"
                  required
                  value={hostName}
                  onChange={e => setHostName(e.target.value)}
                  placeholder="e.g. WS-SEC-05"
                  className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 font-mono"
                />
              </div>
            </div>

            <div>
              <label htmlFor={fieldId('ipAddress')} className="block font-semibold text-slate-300 mb-1.5">
                IP Address <span className="text-slate-400 font-normal">(Optional)</span>
              </label>
              <div className="flex items-center gap-2">
                <Wifi className="w-4 h-4 text-slate-400 shrink-0" />
                <input
                  id={fieldId('ipAddress')}
                  ref={ipRef}
                  type="text"
                  value={ipAddress}
                  onChange={e => { setIpAddress(e.target.value); edited('ipAddress'); }}
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={fromScanner.includes('ipAddress') ? scannerHelpId('ipAddress') : undefined}
                  placeholder="e.g. 10.0.50.35"
                  className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 font-mono"
                />
              </div>
              {scannerHelp('ipAddress')}
            </div>
          </div>

          {/* MAC Address (Optional) & OS Profile */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor={fieldId('macAddress')} className="block font-semibold text-slate-300 mb-1.5">
                MAC Address <span className="text-slate-400 font-normal">(Optional)</span>
              </label>
              <input
                id={fieldId('macAddress')}
                ref={macRef}
                type="text"
                value={macAddress}
                onChange={e => { setMacAddress(e.target.value); edited('macAddress'); }}
                autoComplete="off"
                spellCheck={false}
                aria-describedby={fromScanner.includes('macAddress') ? scannerHelpId('macAddress') : undefined}
                placeholder="52:54:00:12:34:56"
                className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 font-mono"
              />
              {scannerHelp('macAddress')}
            </div>

            <div>
              <label htmlFor={fieldId('osProfile')} className="block font-semibold text-slate-300 mb-1.5">
                OS Platform Profile
              </label>
              <select
                id={fieldId('osProfile')}
                ref={osRef}
                value={osProfile}
                onChange={e => { setOsProfile(e.target.value as EnclaveAssetOsProfile); edited('os'); }}
                aria-describedby={[reportedOs ? osHelpId : '', fromScanner.includes('os') ? scannerHelpId('os') : ''].filter(Boolean).join(' ') || undefined}
                className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-1 focus:ring-cyan-500"
              >
                <option value="rhel9">Red Hat Enterprise Linux 9</option>
                <option value="rhel8">Red Hat Enterprise Linux 8</option>
                <option value="ubuntu2204">Ubuntu 22.04 LTS</option>
                <option value="win2022">Windows Server 2022</option>
                <option value="win11">Windows 11</option>
                <option value="cisco_ios">Cisco IOS / Network Device</option>
                <option value="custom">Custom / Appliance</option>
              </select>
              {reportedOs && <p id={osHelpId} className="mt-1 text-xs text-slate-400">Reported: <span className="font-mono">{reportedOs}</span></p>}
              {scannerHelp('os')}
            </div>
          </div>

          {/* What the scanners reported for this asset (#229): edit mode on a server-backed tenant only; nothing is saved until the person uses a value and saves */}
          {initialAsset && serverBacked && (
            <>
              <ObservedInventoryPanel
                status={observed.status}
                hosts={observed.hosts}
                recorded={initialAsset}
                note={OBSERVED_COPY.editNote}
                onRetry={observed.reload}
                onUseValue={applyScannerValue}
              />
              <p role="status" className="sr-only">{announcement}</p>
            </>
          )}

          {/* CMMC Scope Category */}
          <div>
            <label className="block font-semibold text-slate-300 mb-1.5">
              CMMC 2.0 asset category
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="radiogroup" aria-label="CMMC asset category" onKeyDown={radioGroupKeyDown}>
              {CMMC_ASSET_CATEGORIES.map(cat => (
                <button
                  type="button"
                  key={cat}
                  role="radio"
                  aria-checked={cmmcAssetCategory === cat}
                  tabIndex={cmmcAssetCategory === cat ? 0 : -1}
                  onClick={() => setCmmcAssetCategory(cat)}
                  className={`text-left p-2.5 rounded-xl border transition-all ${
                    cmmcAssetCategory === cat
                      ? 'bg-cyan-950/40 border-cyan-500/60 ring-1 ring-cyan-500/30'
                      : 'bg-slate-800/40 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <p className="font-bold text-white text-xs">{CATEGORY_INFO[cat].label}</p>
                  <p className="text-xs text-slate-400 mt-0.5">{CATEGORY_INFO[cat].description}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Cryptography & FIPS: only for assets that protect or process CUI */}
          {isFipsEligibleCategory(cmmcAssetCategory) && (
            <fieldset className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 space-y-3">
              <legend className="px-1.5 text-xs font-bold text-cyan-300">Cryptography & FIPS</legend>
              <p className="text-xs text-slate-400">
                NIST SP 800-171 3.13.11 requires FIPS-validated cryptography to protect CUI. Record the CMVP certificate of the
                cryptographic module this asset relies on; the policy and the SSP cite it.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="fips-status" className="block font-semibold text-slate-300 mb-1.5">Validation status</label>
                  <select
                    id="fips-status"
                    value={fipsStatus}
                    onChange={e => {
                      const next = e.target.value as FipsValidationStatus | '';
                      setFipsStatus(next);
                      if (next === '' || next === 'NOT_APPLICABLE') {
                        setFipsCert('');
                        setFipsModule('');
                        setFipsStandard('');
                      }
                      if (next === 'PENDING') setFipsCert('');
                    }}
                    className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  >
                    <option value="">Not recorded</option>
                    {FIPS_STATUSES.map(st => (
                      <option key={st} value={st}>{FIPS_STATUS_LABELS[st]}</option>
                    ))}
                  </select>
                </div>
                {(fipsStatus === 'VALIDATED' || fipsStatus === 'PENDING') && (
                  <div>
                    <label htmlFor="fips-standard" className="block font-semibold text-slate-300 mb-1.5">
                      FIPS 140 revision <span className="text-slate-400 font-normal">(Optional)</span>
                    </label>
                    <select
                      id="fips-standard"
                      value={fipsStandard}
                      onChange={e => setFipsStandard(e.target.value as FipsStandard | '')}
                      className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-1 focus:ring-cyan-500"
                    >
                      <option value="">Not specified</option>
                      {FIPS_STANDARDS.map(st => (
                        <option key={st} value={st}>FIPS {st}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              {(fipsStatus === 'VALIDATED' || fipsStatus === 'PENDING') && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {fipsStatus === 'VALIDATED' && (
                    <div>
                      <label htmlFor="fips-cert" className="block font-semibold text-slate-300 mb-1.5">
                        CMVP certificate number <span className="text-rose-400">*</span>
                      </label>
                      <input
                        id="fips-cert"
                        type="text"
                        inputMode="numeric"
                        value={fipsCert}
                        onChange={e => setFipsCert(e.target.value)}
                        placeholder="e.g. 4211"
                        className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 font-mono"
                      />
                    </div>
                  )}
                  <div className={fipsStatus === 'VALIDATED' ? '' : 'sm:col-span-2'}>
                    <label htmlFor="fips-module" className="block font-semibold text-slate-300 mb-1.5">
                      Cryptographic module name <span className="text-slate-400 font-normal">(Optional)</span>
                    </label>
                    <input
                      id="fips-module"
                      type="text"
                      value={fipsModule}
                      onChange={e => setFipsModule(e.target.value)}
                      placeholder="e.g. CrowdStrike Falcon Cryptographic Module"
                      className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                    />
                  </div>
                </div>
              )}
            </fieldset>
          )}

          {/* Owner */}
          <div>
            <label className="block font-semibold text-slate-300 mb-1.5">
              Owner <span className="text-slate-400 font-normal">(Optional)</span>
            </label>
            <input
              type="text"
              value={owner}
              onChange={e => setOwner(e.target.value)}
              placeholder="e.g. IT Operations, or Jordan Lee"
              className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500"
            />
          </div>

          {/* Hardware details (#229): optional, hand-recorded; exported in the Hardware Inventory */}
          <fieldset className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 space-y-3" aria-describedby={hwHelpId}>
            <legend className="px-1.5 text-xs font-bold text-cyan-300">Hardware details <span className="font-normal text-slate-400">(Optional)</span></legend>
            <p id={hwHelpId} className="text-xs text-slate-400">For the hardware inventory (NIST SP 800-171 3.4.1). The manufacturer, model, serial number and location appear in the exported Hardware Inventory.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor={hwId('manufacturer')} className="block font-semibold text-slate-300 mb-1.5">Manufacturer</label>
              <input
                id={hwId('manufacturer')}
                type="text"
                value={manufacturer}
                onChange={e => setManufacturer(e.target.value)}
                maxLength={HARDWARE_LIMITS.manufacturer}
                autoComplete="off"
                placeholder="e.g. Dell"
                className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              />
            </div>
            <div>
              <label htmlFor={hwId('model')} className="block font-semibold text-slate-300 mb-1.5">Model</label>
              <input
                id={hwId('model')}
                type="text"
                value={model}
                onChange={e => setModel(e.target.value)}
                maxLength={HARDWARE_LIMITS.model}
                autoComplete="off"
                placeholder="e.g. PowerEdge R650"
                className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              />
            </div>
            <div>
              <label htmlFor={hwId('serialNumber')} className="block font-semibold text-slate-300 mb-1.5">Serial number</label>
              <input
                id={hwId('serialNumber')}
                type="text"
                value={serialNumber}
                ref={serialRef}
                onChange={e => { setSerialNumber(e.target.value); edited('serialNumber'); }}
                aria-describedby={fromScanner.includes('serialNumber') ? scannerHelpId('serialNumber') : undefined}
                maxLength={HARDWARE_LIMITS.serialNumber}
                autoComplete="off"
                spellCheck={false}
                placeholder="e.g. 7XK2L93"
                className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 font-mono"
              />
              {scannerHelp('serialNumber')}
            </div>
            <div>
              <label htmlFor={hwId('location')} className="block font-semibold text-slate-300 mb-1.5">Location</label>
              <input
                id={hwId('location')}
                type="text"
                value={location}
                onChange={e => setLocation(e.target.value)}
                maxLength={HARDWARE_LIMITS.location}
                autoComplete="off"
                placeholder="e.g. HQ, server room 2, rack 4"
                className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              />
            </div>
            </div>
          </fieldset>

          {/* Administrative Notes */}
          <div>
            <label className="block font-semibold text-slate-300 mb-1.5">
              Description
            </label>
            <textarea
              rows={2}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="e.g. Dell PowerEdge R650, Rack 4 Enclave Node, designated for CUI enclave workloads."
              className="w-full bg-slate-800/80 border border-slate-700 rounded-lg p-2.5 text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500"
            />
          </div>

          {/* Actions */}
          <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="btn-primary px-4 py-2 rounded-xl"
            >
              {saving ? 'Saving…' : initialAsset ? 'Save Changes' : 'Register Asset'}
            </button>
          </div>

        </form>

      </div>
    </DialogOverlay>
  );
};
