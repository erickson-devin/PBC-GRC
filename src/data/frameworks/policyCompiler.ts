import { EnclaveStackProfile } from '../../types/tenant';
import { FipsModuleRef, applyFipsModules, isCryptographicProtectionControl } from '../telemetry/fipsValidation';
import {
  NIST_800_171A_REGISTRY,
  normalizeControlNumber,
  getObjectivesForControl,
} from './assessmentObjectives';

export function getCascadedObjectiveNarrative(
  controlId: string,
  objectiveLetter: string,
  stack: EnclaveStackProfile,
  /**
   * The validated cryptographic modules recorded in the tenant's asset inventory (collectFipsModules). For 3.13.11 they
   * replace the generic "FIPS 140-3" wording with the CMVP certificate numbers; an empty list adds a visible gap note.
   * Omit it (undefined) to keep the generic text.
   */
  cryptoModules?: ReadonlyArray<FipsModuleRef>
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
    narrative = narrative.replace(/directory services|identity provider|\*\*Microsoft Entra ID\*\*|\*\*Entra ID\*\*/gi, '**Microsoft Entra ID (GovCloud)**');
  } else if (stack.identityProvider === 'ENTRA_ID_COMMERCIAL') {
    narrative = narrative.replace(/directory services|identity provider|\*\*Microsoft Entra ID\*\*|\*\*Entra ID\*\*/gi, '**Microsoft Entra ID (Commercial)**');
  } else if (stack.identityProvider === 'OKTA') {
    narrative = narrative.replace(/directory services|identity provider|\*\*Microsoft Entra ID\*\*|\*\*Entra ID\*\*/gi, '**Okta Identity Cloud**');
  } else if (stack.identityProvider === 'ACTIVE_DIRECTORY') {
    narrative = narrative.replace(/directory services|identity provider|\*\*Microsoft Entra ID\*\*|\*\*Entra ID\*\*/gi, '**On-Premises Active Directory**');
  }

  // Tailor based on EDR
  if (stack.edrSolution === 'CROWDSTRIKE_FALCON') {
    narrative = narrative.replace(/antivirus|endpoint detection|EDR|\*\*Microsoft Defender for Endpoint\*\*|\*\*CrowdStrike Falcon\*\*/gi, '**CrowdStrike Falcon**');
  } else if (stack.edrSolution === 'DEFENDER_FOR_ENDPOINT') {
    narrative = narrative.replace(/antivirus|endpoint detection|EDR|\*\*Microsoft Defender for Endpoint\*\*|\*\*CrowdStrike Falcon\*\*/gi, '**Microsoft Defender for Endpoint**');
  } else if (stack.edrSolution === 'SENTINELONE') {
    narrative = narrative.replace(/antivirus|endpoint detection|EDR|\*\*Microsoft Defender for Endpoint\*\*|\*\*CrowdStrike Falcon\*\*/gi, '**SentinelOne Singularity**');
  }

  // Tailor based on MDM
  if (stack.mdmSolution === 'INTUNE') {
    narrative = narrative.replace(/MDM|mobile device management|group policy/gi, 'Microsoft Intune');
  } else if (stack.mdmSolution === 'JAMF') {
    narrative = narrative.replace(/MDM|mobile device management|group policy/gi, 'Jamf Pro');
  }

  // Tailor based on SIEM
  if (stack.siemSolution === 'SENTINEL') {
    narrative = narrative.replace(/SIEM|audit log server|central log server|\*\*Microsoft Sentinel\*\*|\*\*Splunk Cloud Gov\*\*/gi, '**Microsoft Sentinel**');
  } else if (stack.siemSolution === 'SPLUNK_GOV') {
    narrative = narrative.replace(/SIEM|audit log server|central log server|\*\*Microsoft Sentinel\*\*|\*\*Splunk Cloud Gov\*\*/gi, '**Splunk Cloud Gov**');
  } else if (stack.siemSolution === 'ELASTIC') {
    narrative = narrative.replace(/SIEM|audit log server|central log server|\*\*Microsoft Sentinel\*\*|\*\*Splunk Cloud Gov\*\*/gi, '**Elastic Security**');
  }

  // Tailor based on Infrastructure
  if (stack.infrastructure === 'AZURE_GOV') {
    narrative = narrative.replace(/\*\*Azure Gov\*\* and \*\*AWS GovCloud\*\* enclaves/gi, '**Azure Gov** enclaves');
    narrative = narrative.replace(/\*\*Azure Gov\*\*|\*\*AWS GovCloud\*\*/gi, '**Azure Gov**');
  } else if (stack.infrastructure === 'AWS_GOVCLOUD') {
    narrative = narrative.replace(/\*\*Azure Gov\*\* and \*\*AWS GovCloud\*\* enclaves/gi, '**AWS GovCloud** enclaves');
    narrative = narrative.replace(/\*\*Azure Gov\*\*|\*\*AWS GovCloud\*\*/gi, '**AWS GovCloud**');
  } else if (stack.infrastructure === 'ON_PREM_RHEL') {
    narrative = narrative.replace(/\*\*Azure Gov\*\* and \*\*AWS GovCloud\*\* enclaves/gi, 'On-Premises RHEL enclaves');
    narrative = narrative.replace(/\*\*Azure Gov\*\*|\*\*AWS GovCloud\*\*/gi, 'On-Premises RHEL infrastructure');
  } else if (stack.infrastructure === 'HYBRID_CLOUD') {
    narrative = narrative.replace(/\*\*Azure Gov\*\* and \*\*AWS GovCloud\*\* enclaves/gi, 'Hybrid Cloud enclaves');
    narrative = narrative.replace(/\*\*Azure Gov\*\*|\*\*AWS GovCloud\*\*/gi, 'Hybrid Cloud infrastructure');
  }


  // Resolve ODP placeholders
  if (stack.odpParams) {
    Object.keys(stack.odpParams).forEach((key) => {
      // Find the objective's defined parameter to know its default value text
      const paramDef = objective?.odpParameters?.find(p => p.id === key) ||
        getObjectivesForControl(controlId).find(o => o.letter.toLowerCase() === objectiveLetter.toLowerCase())?.odpParameters?.find(p => p.id === key);
      
      if (paramDef) {
        // Replace exact [ODP: defaultValue] block with the tenant's new value
        const targetText = `[ODP: ${paramDef.defaultValue}]`;
        narrative = narrative.split(targetText).join(stack.odpParams![key]);
      }
    });
  }

  // Cryptographic Protection (3.13.11): cite the certificates of the modules in the asset inventory
  if (cryptoModules && isCryptographicProtectionControl(controlId)) {
    narrative = applyFipsModules(narrative, cryptoModules);
  }

  // Fallback for unresolved ODP placeholders: remove the [ODP: ] wrapping to just display the default, or leave it.
  // We'll leave it as [ODP: default] because it's naturally readable.


  return narrative;
}
