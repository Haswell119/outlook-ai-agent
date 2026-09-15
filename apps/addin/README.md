# @oao/addin — Outlook AI Orchestrator add-in

React 18 + TypeScript + Vite 5 + Office.js + Fluent UI v9 task pane for Outlook (desktop, new Outlook, web).

| Surface | Entry | What it shows |
|---|---|---|
| Message **read** ribbon → "Open AI panel" / "Ask about this email" | `taskpane.html` (`?tab=chat`) | Summary · Chat · Insights tabs, "Whole conversation" thread synthesis, Action Approval dialog, Automation Coach |
| Message **compose** ribbon → "Compliance Guardian" | `taskpane.html?mode=compose` | Compliance Guardian (issues, recommended actions, escalation) |
| **OnMessageSend** launch event (Smart Alerts, `SendMode=PromptUser`) | `commands.html` / `commands.js` → `onMessageSendHandler` | Runs the compliance check on Send; soft-blocks on `warn`/`block`, always allows on any error |

## Scripts

```bash
pnpm --filter @oao/addin dev          # https://localhost:3000 (builds commands.js first)
pnpm --filter @oao/addin build        # dist/ (taskpane.html, commands.html, commands.js, assets/)
pnpm --filter @oao/addin preview      # serves dist/ on http://localhost:4173
pnpm --filter @oao/addin typecheck    # tsc --noEmit (also used by `lint`)
pnpm --filter @oao/addin test         # vitest (jsdom + Testing Library)
pnpm --filter @oao/addin validate-manifest      # office-addin-manifest validate (fails on the {{AAD_CLIENT_ID}} placeholder until replaced)
pnpm --filter @oao/addin certs        # office-addin-dev-certs install (trusted localhost cert)
pnpm --filter @oao/addin icons        # regenerate public/assets/icon-*.png (pure Node)
pnpm --filter @oao/addin screenshots  # Playwright screenshots of the preview build → docs/screenshots/
node scripts/manifest-template.mjs    # regenerate manifest/manifest.xml + manifest.dev.xml from one template
```

## Environment variables (`.env` / `.env.local`, see `.env.example`)

| Variable | Default | Meaning |
|---|---|---|
| `VITE_API_BASE_URL` | `http://localhost:8080` in dev, `https://localhost:8443` in prod builds | Orchestrator base URL (`/api/v1/*` routes come from `@oao/shared`) |
| `VITE_API_MOCK` | `false` | `true` → always use the in-browser mock API (`src/api/mock.ts`). Also `?mock=1` in the URL |
| `VITE_AUTH_MODE` | `dev` | `dev` → `x-user-email` / `x-user-name` headers from `Office.context.mailbox.userProfile`; `aad` → `OfficeRuntime.auth.getAccessToken({allowSignInPrompt:true})` bearer token, falling back to dev headers when SSO fails **in dev builds only** |
| `VITE_ADMIN_URL` | `http://localhost:3001` | Admin dashboard (used by "View audit log" / "View activity history" links) |
| `VITE_COMPLIANCE_EMAIL` | `compliance@northbridge.example` | "Contact Compliance Team" mailto |

## Mock API and browser preview mode

* **Mock API** — `VITE_API_MOCK=true`, `?mock=1`, or automatically when the backend health check
  (`GET /api/v1/health`, 4 s) fails in a dev build or in preview mode. Every mock response is validated
  against the shared zod schemas; the fixtures reproduce `docs/mockups.md` (summary 92 %, chat
  "Client approval detected" 95/78/62 %, thread synthesis with the missing Signed Account Mandate,
  5 proposed actions, 4 compliance issues, "Client A Reporting" automation, 18 min/week).
* **Preview mode** — open `taskpane.html` directly in a browser (no Outlook host): the Office adapters
  return the ABC Capital / Project Horizon sample email, thread and draft, client actions become toasts,
  and a "Preview mode" pill is shown in the header. Useful URLs on the preview server:
  `taskpane.html?mock=1`, `?tab=chat`, `?tab=insights`, `?view=thread`, `?mode=compose`.

## Sideloading

1. Start the dev server: `pnpm --filter @oao/addin dev` (https://localhost:3000). Trust the certificate:
   run `pnpm --filter @oao/addin certs` (installs the *office-addin-dev-certs* CA in your OS store — Vite
   picks `~/.office-addin-dev-certs/localhost.{crt,key}` up automatically). Without it Vite falls back to
   `@vitejs/plugin-basic-ssl`; open https://localhost:3000/taskpane.html once in the browser and accept
   the self-signed certificate, otherwise Outlook shows an empty pane.
2. Sideload `manifest/manifest.dev.xml`:
   * **Outlook desktop (classic, Windows)** — Home → *Get Add-ins* → *My add-ins* → *Add a custom add-in* →
     *Add from file…* → pick `manifest.dev.xml`. (Alternatively `npx office-addin-debugging start manifest/manifest.dev.xml`.)
   * **New Outlook (Windows/Mac)** and **Outlook on the web** — open <https://aka.ms/olksideload>
     (or *Apps* → *Add apps* → *My add-ins* → *Add a custom add-in* → *Add from file…*) and upload the manifest.
     Sideloaded add-ins appear in the *Apps* menu of the message read/compose surfaces.
   * **Outlook for Mac (classic)** — *Get Add-ins* → *My add-ins* → *Add from file…*.
3. Open a message → ribbon group **AI Orchestrator** → *Open AI panel*. Compose a message → *Compliance Guardian*.
   The **OnMessageSend** handler requires Mailbox 1.10+ (Smart Alerts) and, on classic Windows Outlook,
   the JavaScript-only runtime file `commands.js` (built by `pnpm build:commands`, served from `public/`).
4. Production: replace `https://addin.northbridge.local` in `manifest/manifest.xml` (or edit
   `scripts/manifest-template.mjs`), replace `{{AAD_CLIENT_ID}}` with the Azure AD app registration id
   (the `Resource` must match the app's *Application ID URI* `api://<host>/<client-id>` with the
   `access_as_user` scope), then deploy through *Integrated Apps* (Microsoft 365 admin center).

## Office.js APIs / requirement sets used

Mailbox **1.10** is the manifest minimum (Smart Alerts `OnMessageSend`). Every optional API is guarded with
`Office.context.requirements.isSetSupported`:

* 1.1 — `item.body.getAsync("text")`, `item.attachments`, `displayReplyForm` / `displayReplyAllForm`,
  `displayNewAppointmentForm`, `displayMessageForm`, `userProfile`, `displayLanguage`
* 1.3 — `convertToRestId` · 1.5 — `ewsUrl`, `Office.context.ui.closeContainer`
* 1.7 — `from.getAsync` (compose), `RecipientsChanged` event
* 1.8 — `categories.getAsync/addAsync`, `masterCategories`, `getAttachmentsAsync`, `removeAttachmentAsync`, `AttachmentsChanged` event
* 1.10 — `LaunchEvent` / `OnMessageSend`, `Office.actions.associate`
* 1.13 — `item.sensitivityLabel.setAsync` (only when a `labelId` is supplied; otherwise the user is asked to apply the label)
* Identity API 1.3 — `OfficeRuntime.auth.getAccessToken` (`VITE_AUTH_MODE=aad`)

## Client instructions the backend can return (`ActionResult.clientInstruction.operation`)

`displayReplyForm` `{htmlBody|body}` · `displayReplyAllForm` · `addCategory` `{category}` · `flag` (toast: no Office.js API) ·
`displayNewAppointmentForm` `{subject, body, start, end}` · `openMoveDialog` `{folder}` (toast) · `applyLabel` `{label, labelId?}` ·
`removeAttachment` `{attachmentId|name}` (compose only) · `none`.
After executing one the add-in POSTs `Routes.reportActionResult(id)` with `{actionId, status, message}`.

## Project layout

```
manifest/            manifest.xml (prod placeholders) · manifest.dev.xml (localhost:3000)
public/assets/       icon-16/32/64/80/128.png + icon.svg (generated)
src/taskpane/        main.tsx (Office.onReady → React)
src/commands/        commands.ts (onMessageSendHandler)
src/office/          env · sample · cache · readItem · readCompose · thread · actions · observe · sso
src/api/             client (fetch + zod) · mock · errors · types
src/features/        summary · thread · chat · insights · automation · compliance · actions (approval dialog)
src/ui/              ConfidenceBar · RiskBadge · SectionCard · AiFooter · States (Empty/Error/Skeleton) · toast
src/i18n/            en.json · fr.json · hook (auto-detect from Office.context.displayLanguage + FR/EN toggle)
docs/screenshots/    generated by scripts/screenshots.mjs
```
