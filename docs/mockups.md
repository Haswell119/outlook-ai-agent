# UI mock-ups (reference for the add-in and the admin dashboard)

These describe the promised screens (the original mock-ups are Outlook screenshots).
The visual language is Microsoft Fluent: white cards with 1px `#E1DFDD` borders and 8px
radius on a `#F5F5F5`/white background, Segoe UI, primary blue `#0F6CBD`, text
`#242424`, secondary text `#616161`. Risk/severity badges: Low = green
(`#DFF6DD` bg / `#107C10` text), Medium = orange (`#FFF4CE` / `#C19C00`→`#8A6D00`),
High = red (`#FDE7E9` / `#C4314B`). Each AI panel ends with an **"AI confidence"** progress
bar with the % (e.g. 92%) and the footer **"AI-generated content may be incorrect"** with
thumbs up / thumbs down icons.

Panel header everywhere: title **"Outlook AI Orchestrator"** (blue) + close ✕ on the right.

---

## A. Reading pane — Summary tab (email opened)

Tabs: **Summary** | **Insights**. Then four stacked cards, each with a small coloured icon:

1. **Summary** — 2–3 sentences: "Sarah Johnson is sharing the Q2 vendor risk assessment
   report for review. There are high-risk findings that require your input and approval."
2. **Decisions** — bullet list ("Review and approve high-risk findings in the Q2 vendor risk assessment.")
3. **Pending Tasks** — bullet list ("Review attached Q2 vendor risk assessment.", "Provide input or approval on high-risk findings.")
4. **Detected Risks** — bullet list ("High-risk vendor findings identified.", "Potential compliance and operational exposure.", "Approval pending from recipient.")

Then **Suggested Actions** — a list of rows, each: icon + bold title + grey subtitle + a `+` button on the right:
- Create reminder — "Set a follow-up to review this email"
- Draft reply — "Generate a reply draft using AI"
- Classify email — "Categorize this email"
- Escalate compliance review — "Route to compliance for further review"

Footer: `AI confidence ━━━━━━━━━ 92%` and "AI-generated content may be incorrect 👍 👎".

Above the reply box in the reading pane the mock-up also shows **3 quick-reply chips**
("Looks good, I will review.", "Please highlight the high-risk items.", "Can we discuss this later today?").
In the add-in these chips live at the bottom of the Summary tab; clicking one opens a reply draft.

## B. Chat tab

Tabs: **Chat** | **Insights**. A chat transcript:
- User bubble (light blue, right-aligned name "You 10:32 AM"): "Find the email where the client approved the mandate."
- Assistant card:
  - Green check headline **"Client approval detected"** + text "I found 3 emails that may contain the client's approval of the mandate. The most relevant result is highlighted."
  - **Sources used** — numbered list: `1. Re: Mandate Approval – ABC Capital` (blue link) / "James Carter" / "24 May 2025 9:47 AM" / relevance **95%** in green on the right; `2. FW: Mandate Documents – ABC Capital` 78%; `3. Mandate Approval Confirmation` 62%.
  - **Evidence from top result** — "Email: Re: Mandate Approval – ABC Capital" then a green-tinted quote box: "… We confirm our approval of the mandate as outlined in the Investment Management Agreement dated 20 May 2025." — James Carter, 24 May 2025 9:47 AM
  - Button **"Open original email ↗"**.
- Footer "AI-generated content may be incorrect 👍 👎".
- Composer at the bottom: text input "Ask a question…" with attach 📎, mic 🎤 and send ➤ icons.

## C. Thread synthesis (conversation view) — Summary tab

Two-column layout inside the pane (stacked on narrow width):

Left column:
- **Executive summary** (icon shield): "This conversation covers the onboarding of ABC Capital for the Project Horizon mandate. ABC has provided most required information, but one critical document is still outstanding. The target onboarding date is approaching."
- **Amber warning box**: ⚠ **Missing document: Signed Account Mandate** — "Requested on 14 May 2025" — button `Request document`.
- **Decisions** — bullets.
- **Open tasks** — checkbox list, first one highlighted orange/bold: "Obtain signed Account Mandate from ABC Capital — Owner: Jane Smith · Priority: High"; "Complete KYC validation — Owner: Compliance Team · Priority: Medium"; "Legal final sign-off — Owner: Legal Team · Priority: Medium".
- **Deadlines** — red text "Target onboarding date: 30 May 2025 (in 5 days)" + "Risk of delay if missing document not received."
- **Potential risks** — bullets.

Right column:
- **Recommended actions** — 4 clickable cards with chevron: Draft follow-up (Email ABC Capital), Create task (Add to your task list), Set reminder (For document follow-up), Share summary (Copy summary or send).
- **AI confidence** bar 92%.
- **Sources used** — "10 emails in this conversation ›".
- Blue-tinted **Recommended next step** card: "Draft a follow-up email to request the signed Account Mandate." + button `Draft follow-up email`.
- Footer "AI-generated content may be incorrect 👍 👎".

## D. Automation Coach (subtitle under header: "Automation Coach")

- Blue-tinted intro card with sparkle icon: **"I've detected a repeated workflow you do every morning for Client A reporting emails."** — "You do this 5 days a week, ~18 minutes total."
- **Detected workflow** ⓘ — "Triggered by: Emails from **Client A Reporting** with attachments".
- 4 step cards in a row with numbered badges and arrows → : ① Detect attachment ("Detect email with attachment from Client A Reporting"), ② Save to Client A folder ("Save attachment to \\Reports\Client A\Daily Reports"), ③ Apply category ("Categorize email as 'Client A – Reporting'"), ④ Create reminder ("Create follow-up task to review the report").
- **Simulation mode** ⓘ + green pill "Test before activation" on the right.
  - Card: left "We'll simulate this automation using your past 10 similar emails." + clock icon **Estimated time saved 18 minutes per week**; right "What we'll check" with green checks: Attachment detection accuracy, Correct folder mapping, Category assignment, Reminder creation.
- Buttons: `▶ Run simulation` (outline) · `✎ Edit rule` (outline) · `✓ Approve automation` (primary blue).
- Footer: AI confidence 94% · link "View activity history 🕓".

## E. Compliance Guardian (compose mode)

Banner at the top of the compose window (red icon): **Compliance risk detected** — "Review the issues in the Compliance Guardian panel before sending." + button `Show panel`.

Panel titled **"Compliance Guardian"** (shield icon):
- Red triangle + **"4 compliance issues detected"** — "Address the issues below to reduce risk before sending."
- **Risk summary** — rows with icon, bold title, grey description and a severity badge on the right:
  - External recipient detected — "michael.brown@clientco.com is outside your organization." — **High**
  - Confidential attachment — "Client A – Q2 Performance Report.pdf is classified as confidential." — **High**
  - Missing classification label — "This email is not labeled. Policy requires a classification." — **Medium**
  - Sensitive client information found — "Content may contain sensitive client or portfolio information." — **High**
- **Recommended actions** — rows with chevron: Apply confidential label; Remove attachment; Request approval ("Request approval from a manager or compliance officer."); Send for compliance review.
- "Need help? — Contact Compliance Team" link.
- Footer: AI confidence ⓘ 92% · "Learn more".

## F. Action approval dialog (human-in-the-loop) — modal "Outlook AI Orchestrator – Action Approval Required"

- Header with shield icon, title, "Provide feedback" link, ✕.
- Blue info box: ✦ "I've analyzed this email thread and prepared the following actions." / "Please review each action before I proceed."
- "**5 proposed actions**" + "Select all ☑" on the right.
- Table columns: **Action** (icon + bold name) · **Explanation** · **Source** (mail icon + "James Smith / Today at 9:24 AM", or attachment icon + "ABC Capital Mandate.pdf", or "Internal Rule / Client Mandate Workflow") · **Risk level** (badge) · **Select** (checkbox).
  Rows: Send draft reply (Low) · Archive email thread (Low) · Create calendar reminder (Medium) · Tag as client mandate (Low) · Notify relationship manager (Low).
- Grey box: 🛡 **Human validation required** — "These actions will only be executed after your approval. All actions are logged for audit and compliance." + button `View audit log ↗`.
- Footer: 🔒 "Secure. Compliant. Transparent." · primary `Approve selected actions (5)` · `Cancel`.

Note: "Send draft reply" in the mock-up means **open the draft** — the AI never sends.

## G. Admin dashboard — "Audit & Supervision"

Dark-navy left sidebar (`#0B2A4A`) with logo "Outlook AI Orchestrator", sections:
Overview · SUPERVISION: Audit & Actions, Approvals, Alerts & Compliance, Automations, Policy Center ·
ANALYTICS: Usage & Adoption, Performance, AI Impact · ADMINISTRATION: Users, Roles & Permissions, Integrations, Settings · Collapse.
Top bar: settings, help, notifications (badge), avatar, tenant name "ABC Capital ▾".

Page header: shield icon, **Audit & Supervision** — "Monitor AI activity, ensure compliance and review actions across your organization." Right: date range picker "May 12 – May 18, 2025 ▾", `Filters`, `Export`.

KPI tiles (6): Emails summarized 8,642 (↑12.4% vs previous week) · Drafts generated 2,341 (↑9.7%) · Automations proposed 186 (↑15.3%) · Automations approved 142 (↑13.8%) · Compliance alerts 37 (↑8.3%, red icon) · Errors avoided 1,216 (↑18.6%).

Charts row: **AI activity over time** (multi-line: Summaries, Drafts, Automations, Compliance alerts) · **Actions by type** (donut, "13,547 Total actions"; Summarization 63.8%, Draft generation 17.3%, Automation 9.6%, Classification 5.4%, Other 3.9%) · **Compliance alerts by category** (donut, 37 total; Missing label 35.1%, External recipient 27.0%, Confidential content 18.9%, Policy violation 10.8%, Other 8.2%) + Filters (Users, Action type, Risk level, Approval status).

**Audit log** table ("1,247 records"): Timestamp ↓ · User (name + email) · Action type (icon + label) · Source email / Item (subject + "From: x@y") · Risk level badge · Approval status (✓ Approved by Jane Smith / ⚠ Escalated to Compliance Team / Auto-approved Policy: Summarization) · Details (eye icon, ⋯).

Right **Insights** card: "Automations approval rate **76%** vs 68% last week", "Top users by actions" ranked list, "View full analytics →".
Footer: "© 2025 ABC Capital. All rights reserved." · "Data is processed in accordance with corporate policies and regulatory requirements." · "Last updated: …".
