/** What a compiled document states when the SSP records no cloud service provider (#122). */
export const NO_CSP_RECORDED = 'No cloud service provider is recorded for this system boundary.';
/** #151: what a document states for a value the customer has not recorded. A document never invents one. */
export const NOT_RECORDED = 'Not recorded'; // short cells: cover page, certificate, copied text, crypto module name
export const NO_ORGANIZATION_RECORDED = 'No organization name is recorded.';
export const NO_SYSTEM_NAME_RECORDED = 'No system name is recorded.';
export const NO_SYSTEM_OWNER_RECORDED = 'No system owner is recorded.';
export const NO_SECURITY_OFFICIAL_RECORDED = 'No HIPAA security official is recorded.';
export const NO_ASSESSOR_RECORDED = 'No assessor or author is recorded.';
export const NO_CAGE_CODE_RECORDED = 'No CAGE code is recorded.';
export const NO_SAM_STATUS_RECORDED = 'No SAM.gov registration status is recorded.';
export const NO_BOUNDARY_RECORDED = 'No system boundary description is recorded.';
export const NO_SERVICE_COMMITMENTS_RECORDED = 'No principal service commitments or system requirements are recorded for this system.';
/** How a subtitle or running sentence names a system whose name is not recorded. */
export const UNNAMED_SYSTEM = 'the system';
/** #198: what a POA&M weakness states when no milestone is recorded for it. */
export const NO_MILESTONES_RECORDED = 'No milestones are recorded for this weakness.';
/** #196: what a SOC 2 system description states when no complementary user entity controls are recorded. */
export const NO_CUECS_RECORDED = 'No complementary user entity controls are recorded. The service organization completes this section.';
export const SOC2_TESTS_BY_SERVICE_AUDITOR = 'Statuses are self-assessed. Tests of operating effectiveness and their results are completed by the service auditor.';
export const NO_SUBSERVICE_RELIANCE_RECORDED = 'No reliance on subservice organizations is recorded. The service organization completes this section.';
/** #200: what a policy document states when the enclave stack survey has not been completed. */
export const NO_STACK_PROFILE_RECORDED = 'Not recorded: complete the enclave stack survey to generate an implementation statement.';
export const NO_FAMILY_IMPLEMENTATION_RECORDED = 'Not recorded: no implementation statement is recorded for this control family.';
/** #197: an attestation is an unsigned template until the named person signs and dates it. */
export const UNSIGNED_ATTESTATION_NOTE = 'Unsigned. This statement takes effect only when the named person signs and dates it.';
export const SIGNATURE_BLANK = '______________________';
/** #198: the role every control was created with before roles could be recorded; it is not a recorded role. */
export const LEGACY_DEFAULT_ROLE = 'IT / Security Lead';
/** A role as a document states it: empty or the legacy default prints as not recorded. */
export const recordedRole = (role?: string | null): string => {
  const r = (role ?? '').trim();
  return !r || r === LEGACY_DEFAULT_ROLE ? NOT_RECORDED : r;
};
