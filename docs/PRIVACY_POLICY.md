# PITCH BLACK CYBER — PRIVACY POLICY

**Effective Date:** September 1, 2026  
**Last Updated:** September 1, 2026  
**Entity:** Pitch Black Cyber, LLC ("Pitch Black Cyber", "we", "us", or "our")  
**Product:** PBC-GRC Compliance Platform & SSP Generation Engine (`grc.pitchblackcyber.com`)

---

## 1. Overview & Commitment to Defense Data Protection

Pitch Black Cyber provides cybersecurity compliance software, automated System Security Plan (SSP) authoring tools, and cryptographic evidence vault management to Defense Industrial Base (DIB) contractors, aerospace organizations, and Managed Service Providers (MSPs). 

Because our customers operate under strict Department of Defense (DoD) regulatory standards—including **FAR 52.204-21**, **DFARS 252.204-7012**, **NIST SP 800-171**, and the **Cybersecurity Maturity Model Certification (CMMC 2.0)**—we have designed our data practices around strict tenant isolation, cryptographic verification, and minimal data collection.

This Privacy Policy explains how we collect, handle, protect, and process information when you visit `grc.pitchblackcyber.com` or subscribe to our compliance enclave software.

---

## 2. Information We Collect

### A. Customer Account & Identity Information
When you request an enclave license, schedule a sales onboarding call, or log into the platform via Single Sign-On (SSO):
- **Contact Information:** Name, corporate work email address, telephone number, and job title.
- **Organization Metadata:** Company name, Commercial and Government Entity (CAGE) Code, System for Award Management (SAM.gov) registration status, and estimated in-scope user count.
- **Federated Authentication Tokens:** Identity provider claims transmitted during OAuth SSO authentication (such as Microsoft 365 / Entra ID or Google Workspace), including your user principal name, unique subject identifier, and cryptographic ID token. We do not receive or store your plaintext passwords.

### B. Compliance Assessment & Evidence Data (Customer Tenant Data)
When using the PBC-GRC platform to document compliance:
- **System Security Plan (SSP) Details:** System descriptions, network architecture narratives, designated system owners, boundary statements, and operational environment descriptions.
- **Control Implementation Statements:** Custom narratives detailing your organization's technical implementation of the 17 CMMC Level 1 / FAR 52.204-21 controls.
- **Audit Evidence Files:** Artifacts, policies, configuration screenshots, and audit logs uploaded to support assessment claims. These files are stored in customer-isolated Google Cloud Storage (GCS) buckets and indexed using cryptographic SHA-256 hashes.

### C. Technical & Usage Information
When interacting with our web application:
- **Session & Audit Logs:** Timestamps of control modifications, evidence uploads, export operations, IP addresses, browser user agent, and diagnostic telemetry necessary for security audit trails required by CMMC Level 1 (e.g., FAR 52.204-21(b)(1)(vi)).

---

## 3. How We Use Your Information

We process customer data exclusively to deliver and secure our compliance enclave services:
1. **Provisioning Isolated Enclaves:** To configure logical tenant boundaries in Google Cloud SQL and Google Cloud Storage.
2. **Generating Compliance Deliverables:** To automate the compilation of auditor-ready System Security Plans (SSPs), SPRS score calculation matrices, and evidence packages.
3. **Identity Verification & Access Control:** To authenticate defense assessors, system owners, and compliance personnel using multi-factor federated SSO.
4. **Customer Support & Solution Architecture:** To assist your team with CMMC boundary scoping, platform configuration, and license management.
5. **Security & Regulatory Compliance:** To maintain immutable audit logs, prevent unauthorized access, and detect system anomalies.

**We do NOT sell, monetize, rent, or trade your personal or organizational data. We do NOT use your compliance narratives or evidence files to train public artificial intelligence models.**

---

## 4. Multi-Tenant Data Isolation & Security Architecture

PBC-GRC employs defense-in-depth architectural safeguards to maintain rigorous tenant boundaries:
- **Cryptographic Evidence Integrity:** Every evidence file uploaded to our Google Cloud Storage enclave is hashed client-side with SHA-256 before transit. Integrity hashes are verified upon retrieval to prevent tampering.
- **Tenant Partitioning:** Database records are partitioned using PostgreSQL Row-Level Security (RLS) ensuring strict logical segregation between contractor enclaves.
- **Encryption in Transit & at Rest:** All data in transit is encrypted using TLS 1.3. All persistent data in Google Cloud Storage and Google Cloud SQL is encrypted at rest using AES-256 with customer-managed or Google-managed encryption keys.
- **Sub-processor Compliance:** All cloud infrastructure hosting PBC-GRC services (Google Cloud Platform) maintains FedRAMP certifications, ISO 27001, and SOC 2 Type II compliance.

---

## 5. Third-Party Sub-processors & Service Providers

To operate our cloud-native compliance architecture, we engage vetted sub-processors that meet strict security criteria:
- **Google Cloud Platform (GCP):** Cloud Run (compute), Cloud SQL (relational database), Cloud Storage (evidence enclaves), and Cloud Identity Platform (authentication).
- **Microsoft Entra ID:** Federated enterprise authentication for defense contractors utilizing Microsoft 365 GCC or Commercial.
- **Cloudflare:** DNS routing, DDoS mitigation, and edge TLS termination.

---

## 6. Data Retention & Deletion

- **Active Subscriptions:** We retain your tenant configuration, compliance narratives, and evidence files for the duration of your active license agreement to support ongoing assessment baselines and C3PAO audits.
- **Upon Contract Termination:** Within thirty (30) days of subscription termination or upon explicit written request, customer tenant databases and Google Cloud Storage evidence objects will be permanently purged in accordance with DoD 5220.22-M / NIST SP 800-88 sanitization guidelines.
- **Customer Backups:** Administrators may export a complete JSON or Markdown archive of their entire assessment state and evidence manifest at any time via the top navigation bar.

---

## 7. Your Rights & Choices

Depending on your jurisdiction and role within your organization:
- **Access & Correction:** You may inspect and modify your contact information, system owner metadata, and control statements directly within the PBC-GRC interface.
- **Enclave Data Export:** You retain 100% ownership of your compliance documentation and may export your System Security Plan at any time.
- **Marketing Preferences:** You may opt out of non-essential communications by contacting us at the email below.

---

## 8. Contact Information

If you have questions regarding this Privacy Policy or our security practices, please contact our compliance and security office:

**Pitch Black Cyber, LLC**  
Attention: Privacy & Information Security Officer  
Email: `privacy@pitchblackcyber.com`  
Support: `support@pitchblackcyber.com`  
Website: `https://pitchblackcyber.com`
