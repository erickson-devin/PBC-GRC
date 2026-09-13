import { StigProfile, StigRule, StigProfileId } from '../../types/stig';

// ============================================================================
// 1. Windows Server 2022 & Windows 11 Enterprise DISA STIG (Release V1R2)
// ============================================================================
export const WINDOWS_STIG_RULES: StigRule[] = [
  {
    id: 'SV-254256r917887_rule',
    vulnId: 'V-254256',
    ruleVersion: 'WN11-00-000010',
    title: 'Windows 11 must enforce password length of at least 15 characters.',
    severity: 'CAT_II',
    benchmarkId: 'WIN11_SERVER2022_STIG',
    benchmarkTitle: 'Microsoft Windows 11 / Server 2022 DISA STIG',
    discussion: 'Information systems not protected with strong authenticators are susceptible to dictionary attacks. A minimum length of 15 characters significantly increases brute-force entropy beyond common rainbow tables.',
    checkText: 'Verify the effective setting in Local Computer Policy: Computer Configuration >> Windows Settings >> Security Settings >> Account Policies >> Password Policy >> "Minimum password length" is set to "15" or more characters.',
    fixText: 'Configure the policy value for Computer Configuration >> Windows Settings >> Security Settings >> Account Policies >> Password Policy >> "Minimum password length" to "15" or more characters.',
    powershellSnippet: `net accounts /minpwlen:15
Set-ItemProperty -Path "HKLM:\\SAM\\SAM\\Domains\\Account" -Name "MinPasswordLength" -Value 15 -Type DWord`,
    ansibleTaskSnippet: `- name: Enforce Minimum Password Length to 15 Characters
  ansible.windows.win_security_policy:
    section: System Access
    key: MinimumPasswordLength
    value: 15`,
    mappedControlIds: ['IA.L1-3.5.1', 'IA.L1-3.5.2', 'IA.L2-3.5.7', 'IA-5', 'CC6.1', '164.312(d)'],
    policyNarrative: 'The enclave enforces a minimum password length of 15 characters with complexity requirements for all local and domain accounts via Group Policy Object (GPO) and Intune endpoint configuration profiles, meeting DISA STIG V-254256.',
    verificationSteps: [
      'Run `net accounts` in elevated PowerShell and inspect "Minimum password length".',
      'Verify Local Group Policy object "Minimum password length" is set to >= 15.',
    ],
  },
  {
    id: 'SV-254260r917889_rule',
    vulnId: 'V-254260',
    ruleVersion: 'WN11-AC-000020',
    title: 'Windows 11 must automatically lock workstation after 15 minutes of user inactivity.',
    severity: 'CAT_II',
    benchmarkId: 'WIN11_SERVER2022_STIG',
    benchmarkTitle: 'Microsoft Windows 11 / Server 2022 DISA STIG',
    discussion: 'Unattended workstations are vulnerable to unauthorized physical tampering and session hijacking. Automated inactivity lockouts enforce physical session boundaries.',
    checkText: 'Verify Computer Configuration >> Windows Settings >> Security Settings >> Local Policies >> Security Options >> "Interactive logon: Machine inactivity limit" is set to "900" seconds or fewer.',
    fixText: 'Configure "Interactive logon: Machine inactivity limit" to "900" seconds (15 minutes).',
    powershellSnippet: `Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" -Name "InactivityTimeoutSecs" -Value 900 -Type DWord`,
    ansibleTaskSnippet: `- name: Configure Interactive Logon Machine Inactivity Timeout
  ansible.windows.win_regedit:
    path: HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System
    name: InactivityTimeoutSecs
    data: 900
    type: dword`,
    mappedControlIds: ['AC.L1-3.1.1', 'AC.L2-3.1.10', 'AC-11', 'CC6.1', '164.312(a)(2)'],
    policyNarrative: 'Interactive sessions automatically lock after 15 minutes (900 seconds) of inactivity via GPO setting InactivityTimeoutSecs=900, requiring MFA credential re-authentication to resume sessions, satisfying DISA STIG V-254260.',
    verificationSteps: [
      'Query `Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" -Name InactivityTimeoutSecs`.',
      'Confirm workstation locks after 15 minutes of idle time.',
    ],
  },
  {
    id: 'SV-254270r917891_rule',
    vulnId: 'V-254270',
    ruleVersion: 'WN11-CC-000030',
    title: 'Remote Desktop must require Network Level Authentication (NLA).',
    severity: 'CAT_I',
    benchmarkId: 'WIN11_SERVER2022_STIG',
    benchmarkTitle: 'Microsoft Windows 11 / Server 2022 DISA STIG',
    discussion: 'NLA requires client authentication before establishing a full RDP session and UI rendering, mitigating credential relay and pre-authentication vulnerabilities such as BlueKeep.',
    checkText: 'Verify Computer Configuration >> Administrative Templates >> Windows Components >> Remote Desktop Services >> Remote Desktop Session Host >> Security >> "Require user authentication for remote connections by using Network Level Authentication" is Enabled.',
    fixText: 'Enable "Require user authentication for remote connections by using Network Level Authentication".',
    powershellSnippet: `Set-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp" -Name "UserAuthentication" -Value 1 -Type DWord`,
    ansibleTaskSnippet: `- name: Enforce NLA on Remote Desktop Sessions
  ansible.windows.win_regedit:
    path: HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp
    name: UserAuthentication
    data: 1
    type: dword`,
    mappedControlIds: ['AC.L1-3.1.1', 'AC.L2-3.1.12', 'AC-17', 'IA-2', 'CC6.6', '164.312(a)(1)'],
    policyNarrative: 'Remote access connections enforce Network Level Authentication (NLA) with TLS 1.3 encryption prior to session initialization, eliminating unauthenticated RDP surface in accordance with DISA STIG V-254270.',
    verificationSteps: [
      'Verify registry UserAuthentication is set to 1 under HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp.',
      'Test RDP connection without NLA and confirm rejection.',
    ],
  },
  {
    id: 'SV-254300r917895_rule',
    vulnId: 'V-254300',
    ruleVersion: 'WN11-AC-000040',
    title: 'Account lockout threshold must be set to 3 or fewer invalid logon attempts.',
    severity: 'CAT_II',
    benchmarkId: 'WIN11_SERVER2022_STIG',
    benchmarkTitle: 'Microsoft Windows 11 / Server 2022 DISA STIG',
    discussion: 'Account lockout thresholds protect systems from repeated automated password guessing and credential stuffing attacks.',
    checkText: 'Verify Computer Configuration >> Windows Settings >> Security Settings >> Account Policies >> Account Lockout Policy >> "Account lockout threshold" is set to "3" or fewer attempts.',
    fixText: 'Configure "Account lockout threshold" to 3 invalid logon attempts and lockout duration to 30 minutes.',
    powershellSnippet: `net accounts /lockoutthreshold:3 /lockoutduration:30 /lockoutwindow:30`,
    ansibleTaskSnippet: `- name: Enforce Account Lockout Threshold to 3 Attempts
  ansible.windows.win_security_policy:
    section: System Access
    key: LockoutBadCount
    value: 3`,
    mappedControlIds: ['AC.L1-3.1.1', 'AC.L2-3.1.8', 'AC-7', 'CC6.1', '164.312(a)(1)'],
    policyNarrative: 'Local and domain accounts lock out after 3 consecutive invalid authentication attempts for 30 minutes, preventing brute-force password guessing in compliance with DISA STIG V-254300.',
    verificationSteps: [
      'Execute `net accounts` and confirm "Lockout threshold" equals 3.',
    ],
  },
  {
    id: 'SV-254310r917897_rule',
    vulnId: 'V-254310',
    ruleVersion: 'WN11-EP-000050',
    title: 'BitLocker Drive Encryption must be enabled with XTS-AES-256 for all operating system and fixed drives.',
    severity: 'CAT_I',
    benchmarkId: 'WIN11_SERVER2022_STIG',
    benchmarkTitle: 'Microsoft Windows 11 / Server 2022 DISA STIG',
    discussion: 'Data at rest on lost, stolen, or decommissioned storage media is vulnerable to offline extraction without FIPS 140-validated full volume encryption.',
    checkText: 'Run `manage-bde -status`. Verify all volumes have Protection Status "Protection On" and Encryption Method "XTS-AES 256".',
    fixText: 'Enable BitLocker on OS and fixed data drives using TPM + PIN with XTS-AES 256 encryption.',
    powershellSnippet: `Enable-BitLocker -MountPoint "C:" -EncryptionMethod XtsAes256 -UsedSpaceOnly -TpmProtector`,
    ansibleTaskSnippet: `- name: Enable BitLocker on System Drive
  ansible.windows.win_command: manage-bde -on C: -em xts_aes256 -used`,
    mappedControlIds: ['MP.L1-3.8.3', 'SC.L2-3.13.16', 'SC-28', 'MP-6', 'CC6.1', '164.312(a)(2)'],
    policyNarrative: 'All laptops and fixed storage drives enforce BitLocker full-disk encryption with XTS-AES-256 and hardware TPM 2.0 key attestation in compliance with DISA STIG V-254310.',
    verificationSteps: [
      'Run `manage-bde -status C:` in PowerShell and confirm "Protection Status: Protection On" and "Encryption Method: XTS-AES 256".',
    ],
  },
  {
    id: 'SV-254320r917899_rule',
    vulnId: 'V-254320',
    ruleVersion: 'WN11-SI-000060',
    title: 'Windows Defender Antivirus real-time protection and daily definition updates must be active.',
    severity: 'CAT_I',
    benchmarkId: 'WIN11_SERVER2022_STIG',
    benchmarkTitle: 'Microsoft Windows 11 / Server 2022 DISA STIG',
    discussion: 'Endpoints lacking real-time behavioral malware detection and up-to-date signature definitions risk compromise from malicious payloads.',
    checkText: 'Run `Get-MpComputerStatus`. Verify RealTimeProtectionEnabled is True and AntivirusSignatureAge is <= 1 day.',
    fixText: 'Enable Real-time Protection and configure automatic daily signature definitions.',
    powershellSnippet: `Set-MpPreference -DisableRealtimeMonitoring $false -CheckForSignaturesBeforeRunningScan $true
Update-MpSignature`,
    ansibleTaskSnippet: `- name: Enforce Defender Real-Time Protection
  ansible.windows.win_command: powershell.exe -Command "Set-MpPreference -DisableRealtimeMonitoring 0"`,
    mappedControlIds: ['SI.L1-3.14.1', 'SI.L1-3.14.2', 'SI.L1-3.14.3', 'SI-2', 'SI-3', 'CC6.8', '164.308(a)(1)'],
    policyNarrative: 'Windows Defender Antivirus real-time monitoring and behavioral heuristics are continuously enforced with automated daily signature updates via Microsoft Endpoint Manager, satisfying DISA STIG V-254320.',
    verificationSteps: [
      'Run `Get-MpComputerStatus | Select RealTimeProtectionEnabled, AntivirusSignatureAge`.',
      'Confirm RealTimeProtectionEnabled is True.',
    ],
  },
  {
    id: 'SV-254360r917905_rule',
    vulnId: 'V-254360',
    ruleVersion: 'WN11-SC-000060',
    title: 'BitLocker Drive Encryption must enforce XTS-AES 256-bit encryption on operating system and data drives.',
    severity: 'CAT_I',
    benchmarkId: 'WIN11_SERVER2022_STIG',
    benchmarkTitle: 'Microsoft Windows 11 / Server 2022 DISA STIG',
    discussion: 'Unencrypted endpoints and servers are susceptible to offline physical data theft if the device is lost, stolen, or improperly decommissioned.',
    checkText: 'Verify Computer Configuration >> Administrative Templates >> Windows Components >> BitLocker Drive Encryption >> "Choose drive encryption method and cipher strength (Windows 10 [Version 1511] and later)" is Enabled with "XTS-AES 256-bit".',
    fixText: 'Configure BitLocker encryption method to XTS-AES 256-bit for operating system drives and fixed data drives.',
    powershellSnippet: `Enable-BitLocker -MountPoint "C:" -EncryptionMethod XtsAes256 -UsedSpaceOnly -TpmProtector`,
    ansibleTaskSnippet: `- name: Enforce BitLocker XTS-AES 256 Drive Encryption
  ansible.windows.win_powershell:
    script: |
      Enable-BitLocker -MountPoint "C:" -EncryptionMethod XtsAes256 -TpmProtector`,
    mappedControlIds: ['SC.L1-3.13.1', 'SC.L2-3.13.16', 'SC-28', 'MP.L1-3.8.3', 'CC6.1', '164.312(a)(2)'],
    policyNarrative: 'BitLocker Drive Encryption with military-grade XTS-AES 256-bit cipher strength is enforced across all internal and removable drives, protecting CUI at rest per DISA STIG V-254360.',
    verificationSteps: [
      'Run `manage-bde -status C:` in elevated PowerShell and inspect Encryption Method is XTS-AES 256.',
    ],
  },
  {
    id: 'SV-254370r917907_rule',
    vulnId: 'V-254370',
    ruleVersion: 'WN11-NA-000070',
    title: 'Link-Local Multicast Name Resolution (LLMNR) must be disabled.',
    severity: 'CAT_II',
    benchmarkId: 'WIN11_SERVER2022_STIG',
    benchmarkTitle: 'Microsoft Windows 11 / Server 2022 DISA STIG',
    discussion: 'LLMNR enables unauthenticated broadcast name resolution, making hosts vulnerable to local network spoofing, NetNTLM hash poisoning, and Responder attacks.',
    checkText: 'Verify Computer Configuration >> Administrative Templates >> Network >> DNS Client >> "Turn off multicast name resolution" is set to "Enabled".',
    fixText: 'Set registry HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\DNSClient EnableMulticast to 0.',
    powershellSnippet: `Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\DNSClient" -Name "EnableMulticast" -Value 0 -Type DWord`,
    ansibleTaskSnippet: `- name: Disable Link-Local Multicast Name Resolution (LLMNR)
  ansible.windows.win_regedit:
    path: HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\DNSClient
    name: EnableMulticast
    data: 0
    type: dword`,
    mappedControlIds: ['SC.L1-3.13.1', 'SC.L2-3.13.8', 'SC-8', 'CC6.6'],
    policyNarrative: 'Legacy broadcast protocols including LLMNR and NetBIOS are disabled via Group Policy, mitigating internal multicast credential harvesting and relay attacks per DISA STIG V-254370.',
    verificationSteps: [
      'Verify `(Get-ItemProperty "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\DNSClient").EnableMulticast` is 0.',
    ],
  },
];

// ============================================================================
// 2. Red Hat Enterprise Linux 9 DISA STIG (Release V1R1)
// ============================================================================
export const RHEL9_STIG_RULES: StigRule[] = [
  {
    id: 'SV-257812r928731_rule',
    vulnId: 'V-257812',
    ruleVersion: 'RHEL-09-211010',
    title: 'RHEL 9 must disable SSH root logins.',
    severity: 'CAT_I',
    benchmarkId: 'RHEL9_STIG',
    benchmarkTitle: 'Red Hat Enterprise Linux 9 DISA STIG',
    discussion: 'Direct root access over remote channels undermines non-repudiation and accountability by obscuring which administrator initiated actions.',
    checkText: 'Verify /etc/ssh/sshd_config contains "PermitRootLogin no".',
    fixText: 'Configure /etc/ssh/sshd_config with "PermitRootLogin no" and restart sshd.',
    bashSnippet: `sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart sshd`,
    ansibleTaskSnippet: `- name: Disable SSH Root Login
  ansible.builtin.lineinfile:
    path: /etc/ssh/sshd_config
    regexp: '^#?PermitRootLogin'
    line: 'PermitRootLogin no'
    state: present
  notify: Restart sshd`,
    mappedControlIds: ['AC.L1-3.1.1', 'AC.L2-3.1.5', 'AC-2', 'AC-6', 'CC6.1', '164.312(a)(1)'],
    policyNarrative: 'Remote administrative logins via SSH root accounts are strictly prohibited. Administrators authenticate using individual named credentials with hardware MFA and elevate privileges using sudo, meeting DISA STIG V-257812.',
    verificationSteps: [
      'Execute `grep "^PermitRootLogin" /etc/ssh/sshd_config` and verify output is "PermitRootLogin no".',
    ],
  },
  {
    id: 'SV-257830r928735_rule',
    vulnId: 'V-257830',
    ruleVersion: 'RHEL-09-215020',
    title: 'RHEL 9 must lock user accounts after 3 consecutive failed logon attempts using pam_faillock.',
    severity: 'CAT_II',
    benchmarkId: 'RHEL9_STIG',
    benchmarkTitle: 'Red Hat Enterprise Linux 9 DISA STIG',
    discussion: 'Without account lockout limits, systems are susceptible to online brute-force authentication attacks.',
    checkText: 'Check /etc/security/faillock.conf for "deny = 3" and "unlock_time = 1800".',
    fixText: 'Configure /etc/security/faillock.conf with "deny = 3" and "unlock_time = 1800".',
    bashSnippet: `authselect enable-feature with-faillock
sed -i 's/^#\\?deny =.*/deny = 3/' /etc/security/faillock.conf
sed -i 's/^#\\?unlock_time =.*/unlock_time = 1800/' /etc/security/faillock.conf`,
    ansibleTaskSnippet: `- name: Configure pam_faillock 3-attempt lockout
  ansible.builtin.lineinfile:
    path: /etc/security/faillock.conf
    regexp: '^#?\\s*deny\\s*='
    line: 'deny = 3'`,
    mappedControlIds: ['AC.L1-3.1.1', 'AC.L2-3.1.8', 'AC-7', 'CC6.1', '164.312(a)(1)'],
    policyNarrative: 'Account lockouts are configured via pam_faillock to lock accounts after 3 consecutive invalid authentication attempts for a minimum of 30 minutes (1800 seconds), satisfying DISA STIG V-257830.',
    verificationSteps: [
      'Inspect `/etc/security/faillock.conf` and confirm `deny = 3`.',
      'Test `faillock --user <user>` following 3 bad attempts.',
    ],
  },
  {
    id: 'SV-257840r928737_rule',
    vulnId: 'V-257840',
    ruleVersion: 'RHEL-09-231010',
    title: 'RHEL 9 must run the auditd service to capture security event records.',
    severity: 'CAT_II',
    benchmarkId: 'RHEL9_STIG',
    benchmarkTitle: 'Red Hat Enterprise Linux 9 DISA STIG',
    discussion: 'System auditing records events to track unauthorized configuration modifications, privilege escalation, and access attempts.',
    checkText: 'Run `systemctl is-active auditd`. Output must be "active".',
    fixText: 'Enable and start auditd with DoD DISA baseline ruleset.',
    bashSnippet: `systemctl enable auditd
systemctl start auditd
auditctl -e 1`,
    ansibleTaskSnippet: `- name: Ensure auditd is enabled and running
  ansible.builtin.systemd:
    name: auditd
    enabled: yes
    state: started`,
    mappedControlIds: ['AU.L2-3.3.1', 'AU.L2-3.3.2', 'AU-2', 'AU-12', 'CC7.2', '164.312(b)'],
    policyNarrative: 'The Linux audit daemon (auditd) is active and configured with DoD STIG immutable audit rules capturing user logons, privilege escalation, and critical file modifications, fulfilling DISA STIG V-257840.',
    verificationSteps: [
      'Execute `systemctl status auditd` and verify service is running.',
      'Check `auditctl -s` to verify audit enabled state is 1 or 2.',
    ],
  },
  {
    id: 'SV-257850r928739_rule',
    vulnId: 'V-257850',
    ruleVersion: 'RHEL-09-251010',
    title: 'RHEL 9 must operate SELinux in Enforcing mode.',
    severity: 'CAT_I',
    benchmarkId: 'RHEL9_STIG',
    benchmarkTitle: 'Red Hat Enterprise Linux 9 DISA STIG',
    discussion: 'Security-Enhanced Linux provides Mandatory Access Control (MAC) mechanisms to enforce least privilege and contain zero-day process compromises.',
    checkText: 'Run `getenforce`. Output must be "Enforcing".',
    fixText: 'Set SELINUX=enforcing in /etc/selinux/config and reboot.',
    bashSnippet: `sed -i 's/^SELINUX=.*/SELINUX=enforcing/' /etc/selinux/config
setenforce 1`,
    ansibleTaskSnippet: `- name: Enforce SELinux Mandatory Access Controls
  ansible.posix.selinux:
    policy: targeted
    state: enforcing`,
    mappedControlIds: ['AC.L1-3.1.2', 'AC.L2-3.1.5', 'AC-3', 'CM-6', 'CC6.1', '164.312(a)(1)'],
    policyNarrative: 'Mandatory Access Control is enforced via SELinux in targeted Enforcing mode across all production Linux instances, preventing unauthorized lateral movement as mandated by DISA STIG V-257850.',
    verificationSteps: [
      'Run `getenforce` and confirm output is "Enforcing".',
      'Inspect `/etc/selinux/config` for `SELINUX=enforcing`.',
    ],
  },
  {
    id: 'SV-257870r928743_rule',
    vulnId: 'V-257870',
    ruleVersion: 'RHEL-09-291010',
    title: 'RHEL 9 must maintain an active host-based firewall with drop default policy.',
    severity: 'CAT_I',
    benchmarkId: 'RHEL9_STIG',
    benchmarkTitle: 'Red Hat Enterprise Linux 9 DISA STIG',
    discussion: 'Unrestricted inbound networking exposes hosts to network enumeration and service vulnerability exploitation.',
    checkText: 'Run `systemctl is-active firewalld`. Output must be "active".',
    fixText: 'Enable firewalld, set default zone to drop, and permit only authorized ports.',
    bashSnippet: `systemctl enable --now firewalld
firewall-cmd --set-default-zone=drop
firewall-cmd --permanent --zone=drop --add-service=ssh
firewall-cmd --reload`,
    ansibleTaskSnippet: `- name: Configure firewalld with drop default zone
  ansible.posix.firewalld:
    zone: drop
    service: ssh
    permanent: yes
    state: enabled`,
    mappedControlIds: ['SC.L1-3.13.1', 'SC.L2-3.13.1', 'SC-7', 'CC6.6', '164.312(e)(1)'],
    policyNarrative: 'Host-based firewalling is actively enforced with firewalld configured to drop all unsolicited inbound network traffic by default, whitelisting only authorized SSH management channels, satisfying DISA STIG V-257870.',
    verificationSteps: [
      'Verify `systemctl is-active firewalld` returns active.',
      'Check `firewall-cmd --get-default-zone` returns drop.',
    ],
  },
  {
    id: 'SV-257880r928745_rule',
    vulnId: 'V-257880',
    ruleVersion: 'RHEL-09-411010',
    title: 'RHEL 9 must implement FIPS-validated cryptographic modules.',
    severity: 'CAT_I',
    benchmarkId: 'RHEL9_STIG',
    benchmarkTitle: 'Red Hat Enterprise Linux 9 DISA STIG',
    discussion: 'Use of weak or unvalidated ciphers leaves government communications and encrypted data subject to unauthorized decryption.',
    checkText: 'Run `fips-mode-setup --check`. Output must indicate FIPS mode is enabled.',
    fixText: 'Execute `fips-mode-setup --enable` and reboot system.',
    bashSnippet: `fips-mode-setup --enable`,
    ansibleTaskSnippet: `- name: Enable FIPS Cryptographic Mode
  ansible.builtin.command: fips-mode-setup --enable`,
    mappedControlIds: ['SC.L1-3.13.1', 'SC.L2-3.13.11', 'SC-13', 'CC6.1', '164.312(e)(1)'],
    policyNarrative: 'Operating system cryptographic operations are restricted to FIPS 140-3 validated algorithmic modules in compliance with DISA STIG V-257880.',
    verificationSteps: [
      'Verify `fips-mode-setup --check` outputs "FIPS mode is enabled".',
    ],
  },
];

// ============================================================================
// 3. Cisco IOS/NX-OS Switch DISA STIG (Release V2R3)
// ============================================================================
export const CISCO_STIG_RULES: StigRule[] = [
  {
    id: 'SV-216500r853401_rule',
    vulnId: 'V-216500',
    ruleVersion: 'NET-AUT-001',
    title: 'Cisco IOS must enforce centralized AAA authentication via TACACS+ / RADIUS.',
    severity: 'CAT_I',
    benchmarkId: 'CISCO_IOS_STIG',
    benchmarkTitle: 'Cisco IOS/NX-OS Network Infrastructure DISA STIG',
    discussion: 'Shared local switch accounts prevent individual user auditing and credential rotation upon personnel departures.',
    checkText: 'Verify configuration contains "aaa new-model" and "aaa authentication login default group tacacs+".',
    fixText: 'Configure centralized AAA authentication with failover to local emergency credentials.',
    powershellSnippet: `# Cisco IOS CLI Configuration
aaa new-model
aaa group server tacacs+ TACACS_SERVERS
 server name ISE_PRIMARY
 server name ISE_SECONDARY
aaa authentication login default group TACACS_SERVERS local
aaa authorization exec default group TACACS_SERVERS local`,
    ansibleTaskSnippet: `- name: Configure Centralized AAA TACACS+ Authentication
  cisco.ios.ios_config:
    lines:
      - aaa new-model
      - aaa authentication login default group TACACS_SERVERS local`,
    mappedControlIds: ['IA.L1-3.5.1', 'IA.L2-3.5.3', 'IA-2', 'AC-2', 'CC6.1', '164.312(d)'],
    policyNarrative: 'All network switches and boundary routers enforce centralized AAA authentication using TACACS+ with dedicated multi-factor credentials and session accounting, complying with DISA STIG V-216500.',
    verificationSteps: [
      'Run `show running-config | include aaa authentication` on device CLI.',
      'Verify TACACS+ server group is configured and active.',
    ],
  },
  {
    id: 'SV-216510r853403_rule',
    vulnId: 'V-216510',
    ruleVersion: 'NET-BAN-002',
    title: 'Cisco IOS must display the official DoD warning banner prior to logon.',
    severity: 'CAT_II',
    benchmarkId: 'CISCO_IOS_STIG',
    benchmarkTitle: 'Cisco IOS/NX-OS Network Infrastructure DISA STIG',
    discussion: 'Displaying a legal warning banner establishes authorized use, lack of privacy expectations, and consent to monitoring.',
    checkText: 'Verify banner motd or banner login contains official DoD notice.',
    fixText: 'Configure banner motd with standard DoD warning language.',
    powershellSnippet: `banner motd ^C
*** YOU ARE ACCESSING A U.S. GOVERNMENT (USG) INFORMATION SYSTEM (IS) ***
*** ACCESS IS RESTRICTED TO AUTHORIZED PERSONNEL FOR OFFICIAL USE ONLY. ***
*** SYSTEM USAGE IS MONITORED, RECORDED, AND AUDITED. ***
^C`,
    ansibleTaskSnippet: `- name: Configure DoD Login Banner
  cisco.ios.ios_banner:
    banner: motd
    text: "YOU ARE ACCESSING A USG RESTRICTED DEFENSE ENCLAVE. USAGE IS MONITORED."
    state: present`,
    mappedControlIds: ['AC.L2-3.1.9', 'AC-8', 'CC6.1', '164.312(a)(1)'],
    policyNarrative: 'The required DoD Notice and Consent banner is displayed on all network infrastructure consoles and SSH terminal sessions prior to credential entry, fulfilling DISA STIG V-216510.',
    verificationSteps: [
      'Open SSH session to switch and confirm DoD warning banner displays before username prompt.',
    ],
  },
  {
    id: 'SV-216530r853407_rule',
    vulnId: 'V-216530',
    ruleVersion: 'NET-SSH-003',
    title: 'Cisco IOS must disable Telnet and permit management only via SSHv2.',
    severity: 'CAT_I',
    benchmarkId: 'CISCO_IOS_STIG',
    benchmarkTitle: 'Cisco IOS/NX-OS Network Infrastructure DISA STIG',
    discussion: 'Telnet transmits passwords and session data in clear text, exposing network infrastructure credentials to sniffing.',
    checkText: 'Inspect line vty 0 15 configuration for "transport input ssh".',
    fixText: 'Configure line vty 0 15 with "transport input ssh" and generate RSA 2048+ key.',
    powershellSnippet: `ip ssh version 2
crypto key generate rsa modulus 2048
line vty 0 15
 transport input ssh`,
    ansibleTaskSnippet: `- name: Enforce SSHv2 Only on Line VTY
  cisco.ios.ios_config:
    parents: line vty 0 15
    lines:
      - transport input ssh`,
    mappedControlIds: ['AC.L1-3.1.1', 'SC.L2-3.13.8', 'SC-8', 'AC-17', 'CC6.6', '164.312(e)(1)'],
    policyNarrative: 'Cleartext management protocols (Telnet, HTTP) are disabled across all network devices. Administrative access is restricted exclusively to SSHv2 with FIPS-validated cryptography, meeting DISA STIG V-216530.',
    verificationSteps: [
      'Confirm `show line vty 0 15` reflects `transport input ssh`.',
      'Attempt connection via port 23 (Telnet) and verify connection refused.',
    ],
  },
  {
    id: 'SV-216540r539630_rule',
    vulnId: 'V-216540',
    ruleVersion: 'CISC-RT-000040',
    title: 'Cisco IOS must encrypt privileged enable passwords using type 8 or type 9 algorithms.',
    severity: 'CAT_I',
    benchmarkId: 'CISCO_IOS_STIG',
    benchmarkTitle: 'Cisco IOS/NX-OS Network Infrastructure DISA STIG',
    discussion: 'Legacy type 5 (MD5) enable secret hashes are susceptible to rapid GPU-based dictionary and rainbow table cracking.',
    checkText: 'Inspect running configuration for "enable algorithm-type sha256" or "enable algorithm-type scrypt".',
    fixText: 'Configure enable algorithm-type scrypt secret <password>.',
    powershellSnippet: `enable algorithm-type scrypt secret cisco_secure_pass`,
    ansibleTaskSnippet: `- name: Enforce scrypt type 9 password encryption
  cisco.ios.ios_config:
    lines:
      - enable algorithm-type scrypt`,
    mappedControlIds: ['IA.L1-3.5.1', 'IA.L2-3.5.7', 'IA-5', 'CC6.1'],
    policyNarrative: 'Network infrastructure devices protect privileged EXEC passwords using modern scrypt (type 9) cryptographic hashing, meeting DISA STIG V-216540.',
    verificationSteps: [
      'Confirm `show running-config | include enable secret` reflects type 8 or type 9 hash.',
    ],
  },
];

// ============================================================================
// 4. Cloud Enclave CIS Benchmark (GCP / AWS Enclave)
// ============================================================================
export const CLOUD_CIS_RULES: StigRule[] = [
  {
    id: 'CIS-GCP-1.1_rule',
    vulnId: 'CIS-1.1',
    ruleVersion: 'CIS-GCP-V3.0-1.1',
    title: 'Enforce multi-factor authentication (MFA) for all console and cloud IAM accounts.',
    severity: 'CAT_I',
    benchmarkId: 'CLOUD_ENCLAVE_CIS',
    benchmarkTitle: 'CIS Google Cloud Platform Foundation Benchmark v3.0',
    discussion: 'Compromised cloud identity credentials provide administrative access to enclave storage, compute, and databases without perimeter interception.',
    checkText: 'Inspect Google Workspace / Cloud Identity Admin Console >> Security >> 2-Step Verification is set to "Enforced".',
    fixText: 'Enforce 2-Step Verification (Security Key / FIDO2 preferred) for all organizational unit users.',
    powershellSnippet: `# GCP Cloud Shell gcloud verification
gcloud organizations get-iam-policy 1024090841200`,
    ansibleTaskSnippet: `- name: Verify Cloud IAM 2-Step Verification Policy
  google.cloud.gcp_iam_policy:
    organization: "1024090841200"
    state: present`,
    mappedControlIds: ['IA.L1-3.5.1', 'IA.L2-3.5.3', 'IA-2', 'AC-2', 'CC6.1', '164.312(d)'],
    policyNarrative: 'Hardware-backed MFA (FIDO2 WebAuthn / Security Key) is mandatory for all Cloud Identity accounts accessing GCP and AWS enclave infrastructure in accordance with CIS GCP Benchmark 1.1.',
    verificationSteps: [
      'Verify Cloud Identity 2-Step Verification status is "Enforced" across all organizational units.',
    ],
  },
  {
    id: 'CIS-GCP-2.1_rule',
    vulnId: 'CIS-2.1',
    ruleVersion: 'CIS-GCP-V3.0-2.1',
    title: 'Ensure Cloud Audit Logging is enabled across all services for Admin Read/Write and Data Access.',
    severity: 'CAT_I',
    benchmarkId: 'CLOUD_ENCLAVE_CIS',
    benchmarkTitle: 'CIS Google Cloud Platform Foundation Benchmark v3.0',
    discussion: 'Without comprehensive audit logs of administrative API calls and data bucket access, security incident forensics and non-repudiation are impossible.',
    checkText: 'Verify project IAM audit config contains entries for ADMIN_READ, DATA_READ, and DATA_WRITE on allServices.',
    fixText: 'Configure default audit log config on project/organization level enabling all audit categories.',
    bashSnippet: `gcloud projects get-iam-policy grc-tool-507203 --format=json > policy.json
# Ensure auditConfigs contains allServices with ADMIN_READ, DATA_READ, DATA_WRITE`,
    ansibleTaskSnippet: `- name: Enable Cloud Audit Logging on Enclave Project
  google.cloud.gcp_logging_project_sink:
    name: enclave-audit-sink
    project: grc-tool-507203
    state: present`,
    mappedControlIds: ['AU.L2-3.3.1', 'AU.L2-3.3.2', 'AU-2', 'AU-6', 'CC7.2', '164.312(b)'],
    policyNarrative: 'Cloud Audit Logs are enabled globally for all services covering Admin Activity, System Events, and Data Access, streaming immutably into dedicated Cloud Storage audit sinks, satisfying CIS GCP Benchmark 2.1.',
    verificationSteps: [
      'Run `gcloud logging sinks list` and verify export sink to cold-storage retention bucket.',
    ],
  },
  {
    id: 'CIS-GCP-5.1_rule',
    vulnId: 'CIS-5.1',
    ruleVersion: 'CIS-GCP-V3.0-5.1',
    title: 'Ensure Cloud Storage buckets enforce Uniform Bucket-Level Access and customer-managed KMS keys.',
    severity: 'CAT_I',
    benchmarkId: 'CLOUD_ENCLAVE_CIS',
    benchmarkTitle: 'CIS Google Cloud Platform Foundation Benchmark v3.0',
    discussion: 'Object-level ACLs introduce permission leakage. Uniform bucket-level access guarantees centralized IAM role evaluation.',
    checkText: 'Inspect bucket iamConfiguration.uniformBucketLevelAccess.enabled is True.',
    fixText: 'Enable uniform bucket-level access and enforce Cloud KMS default encryption.',
    bashSnippet: `gsutil uniformbucketlevelaccess set on gs://pbc-grc-evidence-prod
gsutil kms encryption set projects/grc-tool-507203/locations/us-central1/keyRings/enclave-ring/cryptoKeys/evidence-key gs://pbc-grc-evidence-prod`,
    ansibleTaskSnippet: `- name: Enforce Uniform Bucket-Level Access on Evidence Vault
  google.cloud.gcp_storage_bucket:
    name: pbc-grc-evidence-prod
    uniform_bucket_level_access: true
    project: grc-tool-507203`,
    mappedControlIds: ['SC.L1-3.13.1', 'SC.L2-3.13.16', 'SC-28', 'CC6.1', '164.312(a)(2)'],
    policyNarrative: 'Evidence storage vaults enforce Uniform Bucket-Level Access (UBLA) with Customer-Managed Encryption Keys (CMEK) via Google Cloud KMS, preventing unauthorized public exposure per CIS GCP Benchmark 5.1.',
    verificationSteps: [
      'Run `gsutil uniformbucketlevelaccess get gs://pbc-grc-evidence-prod` and verify Enabled: True.',
    ],
  },
  {
    id: 'CIS-GCP-1.4_rule',
    vulnId: 'CIS-1.4',
    ruleVersion: 'CIS-GCP-V3.0-1.4',
    title: 'Ensure Cloud KMS cryptographic keys are rotated at least once every 90 days.',
    severity: 'CAT_II',
    benchmarkId: 'CLOUD_ENCLAVE_CIS',
    benchmarkTitle: 'CIS Google Cloud Platform Foundation Benchmark v3.0',
    discussion: 'Periodic cryptographic key rotation limits the volume of ciphertext compromised should an individual key version leak.',
    checkText: 'Verify Cloud KMS CryptoKey rotationPeriod is set to 7776000s (90 days) or less.',
    fixText: 'Configure KMS key with rotation-period=90d and set next-rotation-time.',
    bashSnippet: `gcloud kms keys update evidence-key --keyring=enclave-ring --location=us-central1 --rotation-period=90d --next-rotation-time=$(date -d "+90 days" --iso-8601=seconds)`,
    ansibleTaskSnippet: `- name: Enforce 90-Day KMS Key Rotation
  google.cloud.gcp_kms_crypto_key:
    name: evidence-key
    rotation_period: 7776000s
    state: present`,
    mappedControlIds: ['SC.L2-3.13.10', 'SC-12', 'CC6.1', '164.312(a)(2)'],
    policyNarrative: 'Customer-Managed Encryption Keys in Google Cloud KMS automatically rotate every 90 days, restricting cryptanalytic exposure per CIS GCP Benchmark 1.4.',
    verificationSteps: [
      'Query `gcloud kms keys describe evidence-key --keyring=enclave-ring --location=us-central1` and verify rotationPeriod: 7776000s.',
    ],
  },
];

// ============================================================================
// 5. Tactical / Non-Networked Overlay: Standalone Workstation Profile
// ============================================================================
export const TACTICAL_STANDALONE_RULES: StigRule[] = [
  {
    id: 'TAC-STIG-01_rule',
    vulnId: 'TAC-001',
    ruleVersion: 'TAC-AIRGAP-01',
    title: 'Removable Mass Storage (USB) must be disabled or restricted to cryptographic hardware whitelist.',
    severity: 'CAT_I',
    benchmarkId: 'TACTICAL_STANDALONE_STIG',
    benchmarkTitle: 'Tactical Air-Gapped Standalone Workstation Hardening Profile',
    discussion: 'Air-gapped and tactical field stations are vulnerable to physical malware introduction (Stuxnet vector) and unauthorized data exfiltration via unauthorized USB drives.',
    checkText: 'Verify USBSTOR driver start mode is set to 4 (Disabled) or controlled via endpoint whitelist policy.',
    fixText: 'Set registry HKLM:\\SYSTEM\\CurrentControlSet\\Services\\USBSTOR Start value to 4.',
    powershellSnippet: `Set-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\USBSTOR" -Name "Start" -Value 4 -Type DWord`,
    bashSnippet: `echo "blacklist usb-storage" >> /etc/modprobe.d/blacklist.conf
rmmod usb_storage`,
    ansibleTaskSnippet: `- name: Disable USB Mass Storage Driver for Air-Gapped Station
  ansible.windows.win_regedit:
    path: HKLM:\\SYSTEM\\CurrentControlSet\\Services\\USBSTOR
    name: Start
    data: 4
    type: dword`,
    mappedControlIds: ['MP.L1-3.8.3', 'MP.L2-3.8.7', 'MP.L2-3.8.8', 'MP-6', 'AC-3', 'CC6.1'],
    policyNarrative: 'Physical USB mass storage drivers are disabled via registry policy (USBSTOR Start=4) and hardware kernel blacklisting on tactical standalone workstations, preventing unapproved media access per Tactical Profile TAC-001.',
    verificationSteps: [
      'Verify `(Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\USBSTOR").Start` equals 4.',
      'Insert test USB flash drive and confirm device fails to mount.',
    ],
  },
  {
    id: 'TAC-STIG-02_rule',
    vulnId: 'TAC-002',
    ruleVersion: 'TAC-AIRGAP-02',
    title: 'Wireless interfaces (Wi-Fi, Bluetooth, NFC, Cellular) must be physically or logically disabled.',
    severity: 'CAT_I',
    benchmarkId: 'TACTICAL_STANDALONE_STIG',
    benchmarkTitle: 'Tactical Air-Gapped Standalone Workstation Hardening Profile',
    discussion: 'Radio frequency interfaces on standalone air-gapped systems breach physical separation requirements and introduce covert data transmission channels.',
    checkText: 'Verify Wi-Fi and Bluetooth services are disabled and RF transmitters are off.',
    fixText: 'Disable WlanSvc and bthserv in Windows service manager; disable wireless radio in BIOS.',
    powershellSnippet: `Stop-Service -Name "WlanSvc", "bthserv" -Force -ErrorAction SilentlyContinue
Set-Service -Name "WlanSvc" -StartupType Disabled
Set-Service -Name "bthserv" -StartupType Disabled`,
    bashSnippet: `rfkill block all
systemctl disable --now bluetooth`,
    ansibleTaskSnippet: `- name: Disable Wireless and Bluetooth Radios
  ansible.windows.win_service:
    name: "{{ item }}"
    start_mode: disabled
    state: stopped
  loop:
    - WlanSvc
    - bthserv`,
    mappedControlIds: ['AC.L1-3.1.1', 'SC.L1-3.13.1', 'SC-7', 'AC-18', 'CC6.6'],
    policyNarrative: 'All wireless interfaces (Wi-Fi, Bluetooth, NFC) are disabled in BIOS/UEFI firmware and enforced via operating system service deactivation (WlanSvc, bthserv=Disabled), maintaining strict air-gap integrity.',
    verificationSteps: [
      'Execute `Get-Service WlanSvc, bthserv` and confirm Status=Stopped and StartType=Disabled.',
    ],
  },
  {
    id: 'TAC-STIG-04_rule',
    vulnId: 'TAC-004',
    ruleVersion: 'TAC-AIRGAP-04',
    title: 'Full volume encryption must operate in standalone mode without cloud key escrow.',
    severity: 'CAT_I',
    benchmarkId: 'TACTICAL_STANDALONE_STIG',
    benchmarkTitle: 'Tactical Air-Gapped Standalone Workstation Hardening Profile',
    discussion: 'Non-networked field devices cannot connect to cloud identity key vaults (Entra ID, GCP Cloud KMS). Encryption keys must be secured locally via TPM 2.0 with alphanumeric startup PINs.',
    checkText: 'Verify BitLocker or LUKS key protector is TPM + PIN or local passphrase without active network escrow requirement.',
    fixText: 'Configure BitLocker TPM + PIN protector and print physical offline recovery password into fire-rated safe.',
    powershellSnippet: `manage-bde -protectors -add C: -tpmandpin
manage-bde -protectors -get C:`,
    ansibleTaskSnippet: `- name: Configure Local TPM and PIN Key Protector
  ansible.windows.win_command: manage-bde -protectors -add C: -tp`,
    mappedControlIds: ['MP.L1-3.8.3', 'SC.L2-3.13.16', 'SC-28', 'MP-6', 'CC6.1', '164.312(a)(2)'],
    policyNarrative: 'Standalone field stations utilize hardware TPM 2.0 with enhanced startup PIN authentication for BitLocker full volume encryption. Recovery keys are archived physically in tamper-sealed envelopes, satisfying Tactical Profile TAC-004.',
    verificationSteps: [
      'Confirm TPM and PIN protector is listed in `manage-bde -protectors -get C:`.',
    ],
  },
  {
    id: 'TAC-STIG-05_rule',
    vulnId: 'TAC-005',
    ruleVersion: 'TAC-AIRGAP-05',
    title: 'UEFI / BIOS firmware administrator password and Secure Boot must be enabled to prevent physical boot tampering.',
    severity: 'CAT_I',
    benchmarkId: 'TACTICAL_STANDALONE_STIG',
    benchmarkTitle: 'Tactical Air-Gapped Standalone Workstation Hardening Profile',
    discussion: 'Unprotected firmware allows malicious physical actors to bypass operating system controls by booting alternative media (Live Linux, bootkit rootkits).',
    checkText: 'Verify BIOS Administrator Password is set and Secure Boot is enabled.',
    fixText: 'Enter UEFI firmware setup, enable Secure Boot, set 15+ character Supervisor Password, and disable non-internal boot options.',
    powershellSnippet: `Confirm-SecureBootUEFI`,
    bashSnippet: `mokutil --sb-state`,
    ansibleTaskSnippet: `- name: Verify UEFI Secure Boot State
  ansible.windows.win_powershell:
    script: |
      Confirm-SecureBootUEFI`,
    mappedControlIds: ['PE.L1-3.10.1', 'SI.L1-3.14.1', 'SI-7', 'PE-3', 'CC6.4'],
    policyNarrative: 'Hardware firmware is locked with complex administrator credentials and UEFI Secure Boot is enforced on all tactical field units, preventing unauthorized boot media execution per Tactical Profile TAC-005.',
    verificationSteps: [
      'Execute `Confirm-SecureBootUEFI` in PowerShell and confirm output is True.',
    ],
  },
];

// ============================================================================
// Consolidated STIG Profiles Registry
// ============================================================================
export const STIG_PROFILES_REGISTRY: Record<StigProfileId, StigProfile> = {
  WIN11_SERVER2022_STIG: {
    id: 'WIN11_SERVER2022_STIG',
    title: 'Microsoft Windows 11 & Server 2022 DISA STIG',
    shortName: 'Windows 11 / 2022',
    version: 'V1R2',
    releaseDate: '2024-Q4',
    targetPlatform: 'Windows 11 Enterprise / Windows Server 2022',
    category: 'os',
    description: 'Official Department of Defense technical implementation guidance for hardening Microsoft Windows endpoints and servers in defense contractor enclaves.',
    authority: 'DISA / DoD Cyber Exchange',
    rules: WINDOWS_STIG_RULES,
    isTacticalOverlay: false,
  },
  RHEL9_STIG: {
    id: 'RHEL9_STIG',
    title: 'Red Hat Enterprise Linux 9 DISA STIG',
    shortName: 'RHEL 9',
    version: 'V1R1',
    releaseDate: '2024-Q3',
    targetPlatform: 'Red Hat Enterprise Linux 9 / Rocky Linux 9',
    category: 'os',
    description: 'Enterprise Linux baseline enforcing SELinux, pam_faillock, auditd, and SSH restrictions for secure server and container hosts.',
    authority: 'DISA / DoD Cyber Exchange',
    rules: RHEL9_STIG_RULES,
    isTacticalOverlay: false,
  },
  CISCO_IOS_STIG: {
    id: 'CISCO_IOS_STIG',
    title: 'Cisco IOS & NX-OS Network Infrastructure STIG',
    shortName: 'Cisco IOS / Switch',
    version: 'V2R3',
    releaseDate: '2024-Q2',
    targetPlatform: 'Cisco Catalyst, Nexus & ISR Routers',
    category: 'infrastructure',
    description: 'Boundary switch and router technical hardening standard covering AAA TACACS+, SSHv2 enforcement, and DoD MOTD banners.',
    authority: 'DISA / DoD Cyber Exchange',
    rules: CISCO_STIG_RULES,
    isTacticalOverlay: false,
  },
  CLOUD_ENCLAVE_CIS: {
    id: 'CLOUD_ENCLAVE_CIS',
    title: 'Cloud Enclave Foundation Benchmark (GCP / AWS)',
    shortName: 'Cloud CIS Enclave',
    version: 'v3.0.0',
    releaseDate: '2024-Q4',
    targetPlatform: 'Google Cloud Platform & AWS Defense Enclaves',
    category: 'cloud',
    description: 'Center for Internet Security (CIS) foundations benchmark for sovereign cloud enclaves covering IAM MFA, Cloud Audit Logs, and KMS encryption.',
    authority: 'Center for Internet Security (CIS)',
    rules: CLOUD_CIS_RULES,
    isTacticalOverlay: false,
  },
  TACTICAL_STANDALONE_STIG: {
    id: 'TACTICAL_STANDALONE_STIG',
    title: 'Tactical Air-Gapped Standalone Workstation Profile',
    shortName: 'Tactical Air-Gapped',
    version: 'V1.0',
    releaseDate: '2025-Q1',
    targetPlatform: 'Disconnected Field Workstations / Isolated CUI Nodes',
    category: 'tactical',
    description: 'Hardening profile for non-networked, air-gapped workstations enforcing physical USB blocking, radio deactivation, and offline TPM disk encryption.',
    authority: 'Event Horizon GRC Tactical Overlay',
    rules: TACTICAL_STANDALONE_RULES,
    isTacticalOverlay: true,
  },
};

/**
 * Returns all rules across all STIG profiles
 */
export function getAllStigRules(): StigRule[] {
  const rules: StigRule[] = [];
  for (const profile of Object.values(STIG_PROFILES_REGISTRY)) {
    rules.push(...profile.rules);
  }
  return rules;
}

/**
 * Returns all STIG profiles
 */
export function getAllStigProfiles(): StigProfile[] {
  return Object.values(STIG_PROFILES_REGISTRY);
}

/**
 * Retrieve a specific STIG profile by ID
 */
export function getStigProfile(profileId: StigProfileId): StigProfile | undefined {
  return STIG_PROFILES_REGISTRY[profileId];
}

/**
 * Returns all STIG rules that map to a specific control ID (or equivalent control IDs)
 */
export function getStigRulesForControl(controlId: string): StigRule[] {
  const cleanId = controlId.trim().toUpperCase();
  const allRules = getAllStigRules();
  return allRules.filter(rule =>
    rule.mappedControlIds.some(mId => mId.toUpperCase() === cleanId)
  );
}
