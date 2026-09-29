import { EnclaveStackProfile } from '../../types/tenant';
import {
  NIST_800_171A_REGISTRY,
  normalizeControlNumber,
  getObjectivesForControl,
} from './assessmentObjectives';

export function getCascadedObjectiveNarrative(
  controlId: string,
  objectiveLetter: string,
  stack: EnclaveStackProfile
): string {
  const normId = normalizeControlNumber(controlId);
  const controlReg =
    NIST_800_171A_REGISTRY[controlId] ||
    NIST_800_171A_REGISTRY[normId] ||
    Object.values(NIST_800_171A_REGISTRY).find(
      (c) => c.controlNumber === controlId || c.controlNumber === normId
    );
  const objective = controlReg?.objectives.find(
    (o) => o.letter.toLowerCase() === objectiveLetter.toLowerCase()
  );

  let narrative: string = objective?.prefilledTemplate || '';

  if (!narrative) {
    const fallbackObjs = getObjectivesForControl(controlId);
    const fallbackObj = fallbackObjs.find(
      (o) => o.letter.toLowerCase() === objectiveLetter.toLowerCase()
    );
    narrative =
      fallbackObj?.prefilledTemplate ||
      `The enclave enforces requirement ${controlId}[${objectiveLetter}] across technical architecture and operational procedures.`;
  }

  // Tailor based on stack identity provider
  if (stack.identityProvider === 'ENTRA_ID_GOV') {
    narrative = narrative.replace(/directory services|identity provider/gi, 'Microsoft Entra ID (GovCloud)');
  } else if (stack.identityProvider === 'ENTRA_ID_COMMERCIAL') {
    narrative = narrative.replace(/directory services|identity provider/gi, 'Microsoft Entra ID (Commercial)');
  } else if (stack.identityProvider === 'OKTA') {
    narrative = narrative.replace(/directory services|identity provider/gi, 'Okta Identity Cloud');
  } else if (stack.identityProvider === 'ACTIVE_DIRECTORY') {
    narrative = narrative.replace(/directory services|identity provider/gi, 'On-Premises Active Directory');
  }

  // Tailor based on EDR
  if (stack.edrSolution === 'CROWDSTRIKE_FALCON') {
    narrative = narrative.replace(/antivirus|endpoint detection|EDR/gi, 'CrowdStrike Falcon');
  } else if (stack.edrSolution === 'DEFENDER_FOR_ENDPOINT') {
    narrative = narrative.replace(/antivirus|endpoint detection|EDR/gi, 'Microsoft Defender for Endpoint');
  } else if (stack.edrSolution === 'SENTINELONE') {
    narrative = narrative.replace(/antivirus|endpoint detection|EDR/gi, 'SentinelOne Singularity');
  }

  // Tailor based on MDM
  if (stack.mdmSolution === 'INTUNE') {
    narrative = narrative.replace(/MDM|mobile device management|group policy/gi, 'Microsoft Intune');
  } else if (stack.mdmSolution === 'JAMF') {
    narrative = narrative.replace(/MDM|mobile device management|group policy/gi, 'Jamf Pro');
  }

  // Tailor based on SIEM
  if (stack.siemSolution === 'SENTINEL') {
    narrative = narrative.replace(/SIEM|audit log server|central log server/gi, 'Microsoft Sentinel');
  } else if (stack.siemSolution === 'SPLUNK_GOV') {
    narrative = narrative.replace(/SIEM|audit log server|central log server/gi, 'Splunk GovCloud');
  } else if (stack.siemSolution === 'ELASTIC') {
    narrative = narrative.replace(/SIEM|audit log server|central log server/gi, 'Elastic Security');
  }

  // Resolve ODP placeholders
  if (stack.odpParams) {
    Object.keys(stack.odpParams).forEach((key) => {
      const placeholder = new RegExp(`{{ODP_${key}}}`, 'g');
      narrative = narrative.replace(placeholder, stack.odpParams![key]);
    });
  }

  // Fallback for unresolved ODP placeholders
  narrative = narrative.replace(/{{ODP_[A-Z0-9_]+}}/g, '[Organization-Defined Parameter]');

  return narrative;
}
