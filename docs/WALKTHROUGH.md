# Walkthrough script: control matrix to SSP and POA&M

A repeatable pass through the product as a customer would use it, to find where the flow hurts (#281). It changes no code.
Run it before a release and after any change to the control dialog, the SSP or the POA&M.

Run it twice: once on a local test server (anyone), and once on the live install by a person who is allowed to see its
data. Never paste live narratives, file names or screenshots that show CUI into a ticket: record what happened, not the
content.

## Before you start

- **Local run.** Start the API (`server/dev.ts`) and `vite` with `DB_MODE=memory` in the environment file: an empty store
  on every start. Use made-up names and a test password. Restarting the server wipes everything, so in step 8 Retry
  ends at the sign-in page.
- **Live run.** Use a spare program, not the real one. Skip step 8 (it stops the server) and do step 9 only at a time
  when nobody else is signing in.
- Have one small text file ready to upload as evidence.
- Write each finding as: step, what you did, what you expected, what happened.

## The pass

### 1. First-time setup

1. Open the app on a fresh install. Fill in the setup form with all three frameworks ticked and create the enclave.
2. Open the dashboard and read the header and the sidebar **before** creating a program.
3. Create the first program: CMMC Level 2, blank seed.

Check: does anything on screen describe a framework the organization has not chosen yet? Does the journey bar appear and
do its six figures make sense for an empty program?

### 2. A control that is Met (with parameters and evidence)

Use `AC.L2-3.1.8` (two objectives, three parameters).

1. Control Matrix → find the control → **Open**. Count the clicks from the sidebar.
2. On **Assessment Objectives**: type a narrative for [a], save it, mark [a] Met. Read the rollup line and the recorded
   status. Do the same for [b].
3. Open the **System Security Plan (SSP)** tab. Set one parameter by typing a value and one with **Use baseline**. Read
   "What the SSP prints for this control".
4. Open **Evidence Vault**, upload the text file, then go back to the objectives and pin it to [b].
5. Close the dialog and read the control's card in the matrix.

Check: is it clear what was saved and when? Does the recorded status follow the objectives at every step? Could you tell
from the objectives tab that this control has parameters?

### 3. A control that is Not met

Use `AC.L2-3.1.1` (six objectives, starter templates).

1. Open it. Press **Use template for [a]**, mark [a] Met.
2. Type your own narrative for [b] describing what is missing, save it, mark [b] Not met. Leave [c] to [f] alone.
3. Read the recorded status, the rollup and the whole dialog.

Check: does the dialog tell you what happens next for a Not met control (a POA&M entry)? Where did the template text go?

### 4. POA&M

1. Sidebar → Plan of Action & Milestones (POA&M). Find the entry for `AC.L2-3.1.1`.
2. Read its deficiency summary. Press **Edit**, fill in owner, date and remediation plan, save.
3. Open Programs & Boundaries and compare its "Open POA&M" figure with the POA&M screen.

Check: does the summary describe the weakness in the words you typed for the Not met objective?

### 5. SSP

1. Sidebar → System Security Plan (SSP). Read sections 1 to 3 as an assessor would.
2. Read the entries for `AC.L2-3.1.1` and `AC.L2-3.1.8`, then two controls you did not touch.
3. Read section 5, the attestation.

Check: does each control read as one statement or as pasted fragments? Is anything printed that nobody typed or signed?
Is the "Requirement:" line the text of the standard?

### 6. The same control in a CMMC Level 1 program

1. Programs & Boundaries → New Program → CMMC Level 1. Open the matrix and the first control (the Level 1 form of 3.1.1).
2. Press **Use starter templates (6 of 6)**. Mark [a] to [e] Met and [f] Not applicable.
3. Open the SSP tab of the dialog and read the preview.

Check: does the wording on screen suit a Level 1 self-assessment? What does Not applicable ask for, and what prints for it?

### 7. Read-only view

1. Profile menu → Simulate role → Viewer (or sign in as a real Viewer, and again as an Assessor).
2. Open a control.

Check: does the dialog say why nothing can be edited?

### 8. "Not saved" and Retry (local run only)

1. With a control open, stop the API server. Type in the control statement and leave the field; change one objective.
2. Read every message. Start the server again and press **Retry**.

Check: is the unsaved text still on screen, and does each message name the control the way the screen names it?

### 9. Sign-in notice

1. Account Settings → set up two-step verification.
2. Super Admin Console → System use notice → tick "Show the notice before sign-in" → enter a fresh code → Save.
3. Sign out. Read the sign-in page, acknowledge the notice, sign in.

Check: is the sign-in form unreachable until the notice is acknowledged? Does the page describe the right product level?

## Results: 2026-11-20, local in-memory server

Run on `main` at `18331e4` (after PR #321) by Claude in a browser, as a Tenant Owner with made-up data. Checked by
reading page text and markup; no screenshots were kept. Not run: the live install, a real Viewer or Assessor account
(the role was simulated), Retry succeeding (the in-memory store is wiped by the restart), and the printed or downloaded
SSP files.

### Answers to the questions in #281

- **Clicks from the matrix to a finished control.** One to open; per objective a narrative, a save and a status; the
  control turns Met by itself when the last objective is answered. Parameters and evidence are on two other tabs.
- **Does what was typed per objective appear in the SSP?** Yes, labelled with its letter, and a Not met objective prints
  as "(Not met)".
- **Does the control status agree with the rollup?** Yes at every step tried, including Not met and Not applicable.
- **Is it clear what is saved?** Yes: each objective shows "Saved at" with the time, and a failed save shows "Not saved"
  with Retry and keeps the text.
- **Does the SSP read as one document?** Not yet: see findings 1 to 5.

### What worked

- Status follows the objectives; "Met needs every objective Met or Not applicable: n of m are not" is accurate.
- Evidence upload, hash display, pinning to an objective, and the evidence line in the SSP.
- Parameters print in the SSP once set.
- The POA&M entry lists exactly which objectives are open and accepts owner, date and plan.
- "Not saved" and Retry (#78): the message appears, the text stays, and after the session ended the app kept the unsaved
  fields in memory and said so.
- Sign-in notice (#256): no sign-in form until it is acknowledged; turning it on needs two-step verification and a fresh
  code.

### Findings

Each one is a candidate ticket. None matches an issue that was open on 2026-11-20.

**SSP output**

1. **The "Requirement:" line is not the standard's text, and at least one is wrong.** `AC.L2-3.1.10` is titled "Session
   Lock" but prints "Limit the number of concurrent sessions for each user…", which is a different requirement. 3.1.3,
   3.1.7 and 3.1.9 are paraphrases that add or change meaning. Source: `plainEnglishSummary` in
   `src/data/frameworks/cmmcLevel2Controls.ts` (frozen data, so this needs a decision). The SSP labels a summary as the
   requirement.
2. **Starter templates print literal `**` marks** ("`**Microsoft Entra ID**`") in the SSP.
3. **Two label styles inside one control.** A template lands in the control statement as "[Objective A - authorized
   users are identified]:" while typed narratives print as "[b] …". Together they read as pasted fragments.
4. **The attestation prints a name and today's date that nobody signed**, while the journey bar says 0 of 4 signable
   sections are reviewed. The date is the UTC date (2026-11-21 on the evening of 11-20 local time), a day ahead of the
   dates elsewhere on the page.
5. **Starter template for a Level 2 control talks about FCI** and names products (Google Workspace, YubiKey, 802.1X) as
   if the organization had them. One click on "Use starter templates" writes all of them with no confirmation.

**Control dialog**

6. **Not applicable asks for no reason.** Marking [f] Not applicable made the control Met, and the template text for [f]
   still prints in the SSP as an implemented safeguard.
7. **"Use template" writes to two places.** The text appears in the objective's narrative box and in the control
   statement. The SSP tab then shows the six texts and, directly under them, "No objective narrative prints yet".
8. **Nothing on the objectives tab says a control has parameters.** They are on the SSP tab only. `AC.L2-3.1.8` turned
   Met with two of three parameters still open, with no warning.
9. **A Not met control gives no pointer to the POA&M.** The dialog never mentions that an entry now exists.
10. **Level 1 wording.** A Level 1 control shows "C3PAO Assessment Method" and "DoD CMMC Assessment Guide Level 2"; Level
    1 is a self-assessment.
11. **The evidence tab shows the server's storage path** (the full directory on the host) to the person uploading.
12. **Read-only view gives no reason.** Template buttons and text boxes are disabled for a Viewer with no sentence saying
    why.
13. **Previous, Next and Close buttons in the dialog header have a tooltip but no accessible name.**

**Matrix and POA&M**

14. **A baseline filter (Low / Moderate / High) and "LOW BASELINE" chips appear on CMMC matrices**, which have no
    baselines. Level 1 cards also list SOC 2 and HIPAA equivalents.
15. **The POA&M deficiency summary quotes the wrong narrative.** After the list of open objectives it prints "Recorded
    implementation notes:" followed by the text of the objective that is Met, not the words typed for the one that is
    Not met.
16. **"Open POA&M 0" on Programs & Boundaries** while the POA&M screen lists 109 control entries, one of them Not met
    with a plan. The two figures count different things and the card does not say which.
17. **The impact filter adds up to 109 of 110** controls with no note about the one that has no weight.

**Around the flow**

18. **Before the first program exists** the header and sidebar say "1014 Controls", "NIST SP 800-53 Rev 5 Readiness" and
    "FISMA Compliant" for an organization that has chosen nothing yet.
19. **The sign-in page always says "CMMC 2.0 LEVEL 1 ENCLAVE"**, including for an organization whose only program is
    Level 2 (`src/components/auth/LoginPage.tsx`).
20. **A failed save names the control by its stored id** ("AC.L1-3.1.1") on a screen that shows "AC.L1-b.1.i".
21. **The notice settings say "Set up two-step verification on your own account" with no link** to Account Settings,
    which is in a different part of the app.

Lower confidence, to recheck: the session-ended screen reported "7 unsaved fields" after two unsaved changes; and one
objective reference rule looks unrelated to its objective (`sshd_disable_root_login` on "devices authorized to connect
are identified").
