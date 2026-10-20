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
When you request an enclave license, schedule a sales onboarding call, or sign in to the platform with your local account:
- **Contact Information:** Name, corporate work email address, telephone number, and job title.
- **Organization Metadata:** Company name, Commercial and Government Entity (CAGE) Code, System for Award Management (SAM.gov) registration status, and estimated in-scope user count.
- **Local Account Credentials:** Your name, work email address and a password you choose. Passwords are stored only as salted bcrypt hashes on the customer's own infrastructure; plaintext passwords are never stored or transmitted to Pitch Black Cyber. Sessions use locally signed tokens that expire after 8 hours.

### B. Compliance Assessment & Evidence Data (Customer Tenant Data)
When using the PBC-GRC platform to document compliance:
- **System Security Plan (SSP) Details:** System descriptions, network architecture narratives, designated system owners, boundary statements, and operational environment descriptions.
- **Control Implementation Statements:** Custom narratives detailing your organization's technical implementation of the 17 CMMC Level 1 / FAR 52.204-21 controls.
- **Audit Evidence Files:** Artifacts, policies, configuration screenshots, and audit logs uploaded to support assessment claims. These files are stored on the customer's own infrastructure, in customer-isolated storage that never leaves the customer's enclave, and indexed using cryptographic SHA-256 hashes.

### C. Technical & Usage Information
When interacting with our web application:
- **Session & Audit Logs:** Timestamps of control modifications, evidence uploads, export operations, IP addresses, browser user agent, and diagnostic telemetry necessary for security audit trails required by CMMC Level 1 (e.g., FAR 52.204-21(b)(1)(vi)).

---

## 3. How We Use Your Information

We process customer data exclusively to deliver and secure our compliance enclave services:
1. **Provisioning Isolated Enclaves:** To configure logical tenant boundaries in the PostgreSQL database and evidence storage hosted on the customer's own infrastructure.
2. **Generating Compliance Deliverables:** To automate the compilation of auditor-ready System Security Plans (SSPs), SPRS score calculation matrices, and evidence packages.
3. **Identity Verification & Access Control:** To authenticate defense assessors, system owners, and compliance personnel with local password accounts (accounts lock after repeated failed attempts). Multi-factor authentication within the platform is planned.
4. **Customer Support & Solution Architecture:** To assist your team with CMMC boundary scoping, platform configuration, and license management.
5. **Security & Regulatory Compliance:** To maintain immutable audit logs, prevent unauthorized access, and detect system anomalies.

**We do NOT sell, monetize, rent, or trade your personal or organizational data. We do NOT use your compliance narratives or evidence files to train public artificial intelligence models.**

---

## 4. Multi-Tenant Data Isolation & Security Architecture

PBC-GRC employs defense-in-depth architectural safeguards to maintain rigorous tenant boundaries:
- **Cryptographic Evidence Integrity:** Every evidence file uploaded to the customer's on-premises evidence storage is hashed client-side with SHA-256 before transit. Integrity hashes are verified upon retrieval to prevent tampering.
- **Tenant Partitioning:** Database records are partitioned using PostgreSQL Row-Level Security (RLS) ensuring strict logical segregation between contractor enclaves.
- **Encryption in Transit & at Rest:** All data in transit is encrypted using TLS 1.3. Persistent data is stored on the customer's own infrastructure, where encryption at rest is provided by the customer's disk or volume encryption and managed with customer-controlled keys.
- **On-Premises Hosting:** PBC-GRC is hosted on the customer's own infrastructure. Documents and CUI never leave the customer's enclave, and no cloud provider processes customer data.

---

## 5. Third-Party Sub-processors & Service Providers

The platform runs entirely on the customer's own infrastructure and engages no third-party sub-processors for customer data:
- **Customer-Hosted Infrastructure:** Compute, the relational database, evidence storage, and authentication run on the customer's own infrastructure; no cloud provider or identity provider processes customer data.

---

## 6. Data Retention & Deletion

- **Active Subscriptions:** We retain your tenant configuration, compliance narratives, and evidence files for the duration of your active license agreement to support ongoing assessment baselines and C3PAO audits.
- **Upon Contract Termination:** Within thirty (30) days of subscription termination or upon explicit written request, customer tenant databases and evidence files will be permanently purged in accordance with DoD 5220.22-M / NIST SP 800-88 sanitization guidelines.
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
