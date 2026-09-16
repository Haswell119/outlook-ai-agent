# @oao/addin — Outlook AI Orchestrator add-in

React 18 + TypeScript + Vite 5 + Office.js + Fluent UI v9 task pane for Outlook (classic desktop, new Outlook, Outlook on the web).

The design goal is not "an AI panel". It is **an assistant that is already finished thinking when you open the email**: the pane
renders precomputed work first, shows you where the answer came from, and never spends a model call you did not ask for.

| Surface | Entry | What it shows |
|---|---|---|
| Message **read** ribbon → "Open AI panel" / "Ask about this email" | `taskpane.html` (`?tab=chat`) | Summary · Chat · Insights · Brief tabs, "Whole conversation" thread synthesis, Action Approval dialog, Automation Coach |
| The same pane **pinned**, while you keep clicking through the message list | `taskpane.html` + `ItemChanged` | Re-runs the (cached / precomputed) analysis for each newly selected message; switches to the **home** surface (brief + chat) when nothing is selected |
| **Several messages selected** in the list (`SupportsMultiSelect`) | `taskpane.html` + `getSelectedItemsAsync` | **Selection** view: the N selected emails, "Synthesise these N emails", "Ask about the selection", "Review proposed actions" |
| Ribbon → **"Daily brief"** | `taskpane.html?view=brief` | Headline, highlights, priority emails, open tasks, deadlines, alerts, stats |
| The **"Apps" rail** of the new Outlook / Outlook on the web (unified manifest `staticTabs`), and the pane opened with **no message selected** | `taskpane.html?view=home&host=tab` | **Home** mode: daily brief, chat over the indexed mailbox, sync status, settings — everything that does not need an item |
| Message **compose** ribbon → "Compliance Guardian" | `taskpane.html?mode=compose` | Compliance Guardian (issues, recommended actions, escalation) + the in-window compliance banner |
| **OnMessageSend** launch event (Smart Alerts, `SendMode=PromptUser`) | `commands.html` / `commands.js` → `onMessageSendHandler` | Runs the compliance check on Send; prompts on `warn`/`block`, always allows on any error |

> **You do not have to open an email.** Pin the pane and it follows the list; select several messages and it synthesises them; open the
> app from the Apps rail and it answers about the whole mailbox. See §6 for the three sideload paths and §7 for the requirement sets.

---

## 1. Speed, and not wasting the model

### Three tiers, cheapest first

Opening an email resolves its analysis through `src/features/summary/useAnalysis.ts`:

| Tier | Source | Cost | Badge |
|---|---|---|---|
| 1 | **Local cache** — IndexedDB, key `analysis:<hash(itemId)>:<contentHash+lang>`, TTL 24 h | none at all | "From cache" |
| 2 | **`GET /api/v1/analyze/email/:id`** with the *stable REST id* | one cheap GET | "Precomputed" / "From cache" / "Rules only" |
| 3 | **`POST /api/v1/analyze/email`** | **one model call** | "AI-generated" |

A 404 on tier 2 means "the sync worker has not seen this message" and falls through to tier 3. A precomputed analysis written in a
*different language* than the pane is **not** shown (an English summary in a French pane is worse than a slow one); the pane falls
through and emits an `analysis.languageMismatch` telemetry event so operations can see the worker is precomputing in the wrong
language.

### Id format for `analysisByEmail` — what the backend must match

The add-in calls `Office.context.mailbox.convertToRestId(itemId, Office.MailboxEnums.RestVersion.v2_0)` when Mailbox **1.3** is
available, so the id it sends is the **Outlook REST v2.0 / Microsoft Graph message id** — the same id the precompute worker gets
from Graph. Fallbacks, in order: the conversion result → the raw `itemId` (classic Outlook without 1.3, or a draft with no id yet).
The id is `encodeURIComponent`-ed into the path by `Routes.analysisByEmail`. See `toStableEmailId()` in `src/office/env.ts`.

> **Backend note:** `GET /analyze/email/:id` should therefore accept *both* a Graph/REST id and an EWS `itemId`, and must answer a
> clean **404** (not 500, not an empty 200) when nothing is precomputed. A 404 is the normal, expected case.

### Cache behaviour (Cache-Control-like semantics)

* **Key** — item id + content hash (subject, from, to/cc, attachment names+sizes, categories, importance, body) + language.
  Editing a draft, adding a recipient or switching language all miss; re-opening the same untouched email hits.
* **TTL** — 24 h. Entries are pruned lazily on read, on write and once at startup; the store is capped at 300 entries (oldest first).
* **Refresh** (the ⟳ button) sets `bypass`, which **deletes** the entry and goes straight to tier 3. Its tooltip says so: *"uses one AI call"*.
* **Storage** — IndexedDB (`oao-addin` / `analyses`), transparently degrading to an in-memory map in private windows, with site
  data blocked, or when `open()` takes longer than 2 s. Nothing ever throws out of the cache layer.
* **Clear** — Settings → *Clear local cache*.
* Thread synthesis and the daily brief use the same cache (`thread:`, `brief:` kinds).

### What never runs on its own

* Thread synthesis — only when the user turns on "Whole conversation".
* Chat retrieval — only on send.
* Compose compliance — debounced 1.5 s on recipient/attachment changes **and** skipped entirely when the draft's content hash is
  unchanged (`composeContentHash` over recipients + subject + body + attachments + label).
* The daily brief is **never** generated by the pane; "Regenerate" asks for confirmation first and says it costs a model call.
* Triaged mail (newsletter, notification, out-of-office…) renders a one-line card with an explicit **"Analyse anyway"** button.

### Bundle budget

`vite build` prints every chunk's gzipped size and **fails** when the main entry exceeds 250 kB gzip (`budgetPlugin` in `vite.config.ts`).

```
  123.9 kB  assets/fluent-*.js          Fluent UI v9 + icons
   46.1 kB  assets/react-*.js           react + react-dom + scheduler
   26.5 kB  assets/taskpane-*.js        app shell, summary, theme, cache, api
   19.2 kB  assets/index-*.js           shared module graph
   12.0 kB  assets/zod-*.js             shared contract validation
    4.9 kB  assets/InsightsTab-*.js     lazy
    3.1 kB  assets/DailyBriefView-*.js  lazy
    3.0 kB  assets/ComplianceGuardian-*.js  lazy
    2.9 kB  assets/ActionApprovalDialog-*.js lazy
    2.5 kB  assets/ThreadView-*.js      lazy
    2.7 kB  assets/ChatTab-*.js         lazy
    2.3 kB  assets/SettingsSheet-*.js   lazy
    2.2 kB  assets/SelectionView-*.js   lazy (multi-select)
    1.4 kB  assets/SyncStatusPill-*.js  lazy (also used by the home surface)
   44.2 kB  commands.js                 JS-only runtime for Smart Alerts (loaded by Outlook, not by the pane)
  ─────────
  218 kB    main entry (taskpane + react + fluent), budget 250 kB
  301 kB    total js+css, gzip
```

Chat, Insights, Automation, Compliance, the Daily brief, the Settings sheet, the Approval dialog, the Thread view and the Selection view are
`React.lazy` chunks, **prefetched on tab hover/focus** and on idle after the first analysis renders (skipped on `saveData` / 2G).
`ANALYZE=1 pnpm build` additionally writes a `dist/stats.html` treemap.

---

## 2. Scripts

```bash
pnpm --filter @oao/addin dev              # https://localhost:3000 (builds commands.js first)
pnpm --filter @oao/addin build            # typecheck + dist/ (taskpane.html, commands.html, commands.js, assets/)
pnpm --filter @oao/addin preview          # serves dist/ on http://localhost:4173
pnpm --filter @oao/addin typecheck        # tsc --noEmit (also used by `lint`)
pnpm --filter @oao/addin test             # vitest (jsdom + Testing Library) — 134 tests
pnpm --filter @oao/addin e2e              # Playwright against `vite preview` — 16 specs
pnpm --filter @oao/addin analyze          # build + dist/stats.html bundle treemap
pnpm --filter @oao/addin manifest:render  # regenerate every manifest from the one template
pnpm --filter @oao/addin manifest:package # zip manifest.json + color.png/outline.png → Teams app package
pnpm --filter @oao/addin manifest:package:dev
pnpm --filter @oao/addin validate-manifest         # office-addin-manifest validate (XML + unified JSON)
pnpm --filter @oao/addin validate-manifest:dev
pnpm --filter @oao/addin certs            # office-addin-dev-certs install (trusted localhost cert)
pnpm --filter @oao/addin icons            # regenerate public/assets/icon-*.png (pure Node)
pnpm --filter @oao/addin screenshots      # Playwright screenshots of the preview build → docs/screenshots/
```

`pnpm --filter @oao/addin typecheck && pnpm --filter @oao/addin test && pnpm --filter @oao/addin build && pnpm --filter @oao/addin e2e`
is the full gate and is what CI runs.

---

## 3. Environment variables (`.env` / `.env.local`, see `.env.example`)

| Variable | Default | Meaning |
|---|---|---|
| `VITE_API_BASE_URL` | `http://localhost:8080` in dev, `https://localhost:8443` in prod builds | Orchestrator base URL (`/api/v1/*` routes come from `@oao/shared`). **Also narrows the CSP `connect-src` at build time.** |
| `VITE_API_MOCK` | `false` | `true` → always use the in-browser mock API (`src/api/mock.ts`). Also `?mock=1` in the URL |
| `VITE_AUTH_MODE` | `dev` | `dev` → `x-user-email` / `x-user-name` headers; `aad` → `OfficeRuntime.auth.getAccessToken` bearer token (falls back to dev headers when SSO fails **in dev builds only**) |
| `VITE_ADMIN_URL` | `http://localhost:3001` | Admin dashboard ("View audit log" links) |
| `VITE_COMPLIANCE_EMAIL` | `compliance@northbridge.example` | "Contact Compliance Team" mailto |
| `VITE_TELEMETRY_URL` | *(unset)* | Fetch-beacon telemetry endpoint. Unset → no-op sink in prod, console sink in dev |
| `VITE_APPINSIGHTS_CONNECTION_STRING` | *(unset)* | Application Insights connection string; the beacon posts to its `/v2/track` endpoint. No SDK is bundled (the web SDK alone is ~70 kB gz, over budget) |
| `VITE_APPINSIGHTS_INGESTION_ORIGIN` | *(unset)* | Build-time only: extra `connect-src` origin for the CSP when using App Insights |
| `ADDIN_VERSION` | `1.0.0` | Stamped into the build info shown in Settings → Diagnostics |
| `ADDIN_SOURCEMAP` | *(unset)* | `false` skips source-map emission (the Fluent icon maps are large) |
| `ANALYZE` | *(unset)* | `1` → write `dist/stats.html` |

Manifest rendering (`manifest:render`) reads `ADDIN_HOST`, `API_HOST`, `AAD_CLIENT_ID`, `ADDIN_ID`, `ADDIN_VERSION`, `ORGANIZATION_NAME`.

---

## 4. Production build & CD

```bash
# 1. render the manifests for the target environment
ADDIN_HOST=https://addin.example.com \
API_HOST=https://api.example.com \
AAD_CLIENT_ID=00000000-0000-0000-0000-000000000000 \
ADDIN_VERSION=1.4.0.0 \
ORGANIZATION_NAME="Example Capital" \
pnpm --filter @oao/addin manifest:render

# 2. build the static bundle (the CSP connect-src is baked in here)
VITE_API_BASE_URL=https://api.example.com \
VITE_AUTH_MODE=aad \
VITE_ADMIN_URL=https://admin.example.com \
ADDIN_VERSION=1.4.0 \
pnpm --filter @oao/addin build

# 3. validate before shipping
pnpm --filter @oao/addin validate-manifest

# 4. publish dist/ to the static host and upload the manifest
```

`dist/` layout and caching:

* `assets/*.js|css` — content-hashed, lower-case, correct extensions → serve with `Cache-Control: public, max-age=31536000, immutable`.
* `taskpane.html`, `commands.html`, `commands.js` — **never** long-cached: `Cache-Control: no-cache` (they reference the hashed assets).
* `assets/*.map` — hidden source maps (no `sourceMappingURL` comment, so no browser ever requests them). **Do not serve them
  publicly**: have the static host return 404 for `*.map` and ship them to your error tracker instead, or build with
  `ADDIN_SOURCEMAP=false`.
* Serve everything with `X-Content-Type-Options: nosniff` — the asset names carry real extensions so no MIME guessing is needed.
* The CSP `<meta>` is baked into both HTML entries. `frame-ancestors` **cannot** be set from a meta tag, so the static host must
  send it as a header; `frameAncestors()` in `src/security/csp.ts` returns exactly the value to use (nginx config lives in `infra/`).

---

## 5. Manifests — which one to use

`scripts/manifest-template.mjs` renders **all four** files from one template, so they can never drift:

| File | Format | Use it for |
|---|---|---|
| `manifest/manifest.xml` | classic XML (`MailApp`) | Classic Outlook on Windows/Mac, Outlook on the web, the new Outlook, sideloading, and the Office Store |
| `manifest/manifest.json` | unified (Teams-app style, `manifestVersion` 1.17) | Deployment through the **Microsoft 365 admin centre → Integrated apps** or as a **Teams app package**, the **"Apps" rail** entry (`staticTabs`), and the new Outlook / Microsoft 365 ecosystem (Teams, Copilot surfaces later) |
| `manifest/manifest.dev.xml` · `manifest.dev.json` | same two, pointed at `https://localhost:3000` | Local sideloading |

Both carry the same surfaces: `ribbons` for MessageRead (Open AI panel · Ask about this email · Daily brief) and MessageCompose
(Compliance Guardian), `runtimes` for the task pane and the commands file, `autoRunEvents` with `messageSending` →
`onMessageSendHandler` (`sendMode: promptUser`), and `webApplicationInfo` / `<WebApplicationInfo>` for Office SSO (only emitted
when `AAD_CLIENT_ID` is a real GUID — Outlook rejects a manifest whose SSO id is a placeholder).

Both also declare the list-level activations:

| Capability | XML (`VersionOverridesV1_1` → `<Action xsi:type="ShowTaskpane">`) | Unified JSON (`runtimes[].actions[]`) | Requirement set |
|---|---|---|---|
| Pane stays open while you navigate the list | `<SupportsPinning>true</SupportsPinning>` | `"pinnable": true` | Mailbox 1.5 |
| Pane may open with **nothing** selected | `<SupportsNoItemContext>true</SupportsNoItemContext>` | *(no per-action equivalent; the hosts that read the unified manifest open the pane without an item anyway)* | Mailbox 1.8 |
| Pane activates on **several** selected messages | `<SupportsMultiSelect>true</SupportsMultiSelect>` | `"multiselect": true` | Mailbox 1.13 |
| Entry in the new Outlook / OWA **"Apps" rail** | **not possible** | root-level `staticTabs` (personal tab) | — (Teams app) |

"Open AI panel" and "Ask about this email" carry all three; "Daily brief" is pinnable and no-item but not multi-select (a brief is
about the day, not about the selection).

### The unified manifest must be uploaded as a Teams app package

`manifest.json` alone is not installable: Outlook and Teams want a **zip** with `manifest.json` at the root plus the two icons it
names (`icons.color` = `color.png` 192×192, `icons.outline` = `outline.png` 32×32 monochrome).

```bash
pnpm --filter @oao/addin manifest:package        # → manifest/oao-addin-teams-app.zip
pnpm --filter @oao/addin manifest:package:dev    # → manifest/oao-addin-teams-app.dev.zip (localhost:3000)
```

The script (`scripts/package-manifest.mjs`) generates both icons from the same vector definition as `public/assets/icon-*.png`
(`scripts/icon-png.mjs`) and writes the zip itself with `zlib` — no native dependency, fixed timestamps, so the same manifest always
produces the same bytes. Upload it with **"Upload a custom app"**: Outlook/Teams → *Apps* → *Manage your apps* → *Upload an app* for
yourself, or Teams admin centre → *Teams apps* → *Manage apps* → *Upload new app* for the tenant (see `docs/SETUP.md` §10).

Rule of thumb: **ship the XML manifest today** (it is the only one classic Outlook understands), and add the JSON manifest — as a
Teams app package — when you want the Apps-rail entry or when the tenant deploys centrally through the admin centre to the new
Outlook. Do not deploy both to the same tenant.

`validate-manifest` runs `office-addin-manifest validate` on each file (replacing the `{{AAD_CLIENT_ID}}` placeholder with a dummy
GUID; the XML goes through Microsoft's real XSD + acceptance service) and additionally structure-checks the unified manifest: ribbon
`actionId`s resolve to declared runtime actions, every page **and every `staticTabs.contentUrl`** is covered by `validDomains`, the
personal tab carries `scopes: ["personal"]`, `context: ["personalTab"]` and `host=tab`, at least one action is `pinnable` and one is
`multiselect`, the icons are package-relative, and `messageSending` uses `promptUser`.

### Mock API and browser preview mode

* **Mock API** — `VITE_API_MOCK=true`, `?mock=1`, or — **only in browser preview** — when the backend health check fails.
  `decideApi()` in `src/api/index.ts` is that decision, as a pure, unit-tested function:

  | requested? | preview (no Outlook host)? | health check | result |
  |---|---|---|---|
  | yes | — | not even run | mock |
  | no | — | OK | live |
  | no | yes | fails | mock (the UI stays reviewable in a browser) |
  | no | **no** | fails | **live + blocking error**, never sample data |

  The last row is the point: a dev build used to fall back to the mock inside a *real* Outlook host, so the pane summarised — and
  drafted replies from — the built-in **sample** email while the user was reading a real one, with nothing on screen saying so. Now
  the pane blocks with `BackendUnreachable`: what is broken, the base URL it tried, "check `pnpm dev` and `VITE_API_BASE_URL`", the
  health error and a **Retry**. Whenever the mock client *is* active the header shows a **"Mock data"** pill — in preview mode you
  therefore see both pills, "Preview mode" (no Outlook) and "Mock data" (no backend).

  Every mock response is validated against the shared zod schemas; the fixtures reproduce `docs/mockups.md`
  (summary 92 %, chat 95/78/62 %, 5 proposed actions, 4 compliance issues, "Client A Reporting" automation, 18 min/week) plus the
  new endpoints: a precomputed analysis for the sample email, a triaged newsletter, a daily brief, sync status and feature flags.
* **Preview mode** — open `taskpane.html` directly in a browser: the Office adapters return the sample email/thread/draft, client
  actions become toasts, and a "Preview mode" pill is shown. Useful URLs:
  `?mock=1`, `?tab=chat`, `?tab=insights`, `?view=thread`, `?view=brief`, `?mode=compose`, `?sample=newsletter` (triage layout),
  `?preview=1&selection=3` (fake a three-message multi-selection).

* **Preview mode is not "no mailbox"** — `?host=tab` and `?view=home` also have no `Office.context.mailbox`, but they are the real
  **home** surface: real backend, no sample email, no "Preview mode" pill (`?mock=1` still forces the mock API, which is how the e2e
  spec for `?view=home&host=tab` runs offline). `isPreviewMode()` in `src/office/env.ts` is the single decision:
  `?preview=1` → always preview · a mailbox → never preview · `host=tab` / `view=home` → never preview · otherwise a browser → preview.

---

## 6. Sideloading — the three ways to reach the pane

Common step for all three: start the dev server, `pnpm --filter @oao/addin dev` (https://localhost:3000). Trust the certificate with
`pnpm --filter @oao/addin certs`; without it Vite falls back to `@vitejs/plugin-basic-ssl` and you must accept the self-signed
certificate once at https://localhost:3000/taskpane.html, otherwise Outlook shows an empty pane.

### 6.1 From an opened email (XML manifest)

1. Sideload `manifest/manifest.dev.xml`:
   * **Outlook desktop (classic, Windows)** — Home → *Get Add-ins* → *My add-ins* → *Add a custom add-in* → *Add from file…*
   * **New Outlook / Outlook on the web** — <https://aka.ms/olksideload> → *Add a custom add-in* → *Add from file…*
   * **Outlook for Mac (classic)** — *Get Add-ins* → *My add-ins* → *Add from file…*
2. Open a message → ribbon group **AI Orchestrator** → *Open AI panel*. Compose a message → *Compliance Guardian*.
   The OnMessageSend handler requires Mailbox 1.10+ and, on classic Windows Outlook, the JavaScript-only runtime file `commands.js`.

### 6.2 From the message list: pin the pane, and select several messages (same XML manifest)

1. Sideload the same `manifest/manifest.dev.xml` (it already declares `SupportsPinning`, `SupportsNoItemContext` and
   `SupportsMultiSelect`).
2. **Pin it**: open *Open AI panel* once, then click the **pin** (📌) in the pane's top-right corner — that button is drawn by
   Outlook, not by us. The pane now stays open while you click through the list:
   * another message selected → the pane re-reads it and re-resolves the analysis (cache → precomputed → model), so switching back
     and forth is free;
   * **nothing** selected → it shows the **home** surface (daily brief + chat over the mailbox, the same one the Apps rail opens)
     instead of an empty "select an email" state.
3. **Multi-select**: hold <kbd>Ctrl</kbd>/<kbd>⌘</kbd> (or <kbd>Shift</kbd>) and select several messages, then click *Open AI panel*
   (or *Ask about this email*). The pane opens the **Selection** view: the N messages, then *Synthesise these N emails* (one model
   call, cached under `selection:<hash>`), *Ask about the selection* (the selected messages are indexed once, then the chat is scoped
   to them) and *Review proposed actions* (proposed from the synthesis). Changing the selection while the pane is open refreshes it
   (`SelectedItemsChanged`).
   * Needs **new Outlook for Windows / Outlook on the web** (Mailbox 1.13). On classic Outlook for Windows/Mac the button is simply
     not enabled for a multi-selection; if the view is reached anyway it says *"Multi-select needs the new Outlook or Outlook on the
     web"* rather than failing.

### 6.3 From the "Apps" rail, with no email at all (unified manifest, Teams app package)

The classic XML manifest **cannot** declare this entry; only the unified manifest can, and it has to be uploaded as a Teams app
package.

1. `pnpm --filter @oao/addin manifest:package:dev` → `manifest/oao-addin-teams-app.dev.zip`
   (`manifest.dev.json` + `color.png` + `outline.png`).
2. Upload it as a **custom app**:
   * just for you — in **Outlook** (new) or **Teams**: *Apps* → *Manage your apps* → *Upload an app* → *Upload a custom app* → pick
     the zip. (Requires the tenant policy "allow uploading custom apps"; ask your admin if the entry is greyed out.)
   * for the tenant — **Teams admin centre** → *Teams apps* → *Manage apps* → *Upload new app*, then publish/assign it.
3. In the new Outlook / Outlook on the web, the app appears in the **left "Apps" bar**. Click it with no email selected: the pane
   opens in **home** mode (`?view=home&host=tab`) with the daily brief, the chat over your indexed mailbox, the sync status and the
   settings. The item-dependent features are hidden behind one line: *"Open an email to analyse it."*
   * That host has **no `Office.context.mailbox`** (and TeamsJS is deliberately not loaded), so every Office.js call in the pane is
     guarded; nothing in home mode needs the Office host.
   * Outlook desktop (classic) has no Apps rail — use 6.1/6.2 there.

---

## 7. Office.js APIs / requirement sets used

Mailbox **1.10** is the manifest minimum (Smart Alerts `OnMessageSend`). Every optional API is guarded with
`Office.context.requirements.isSetSupported`, so nothing here hard-fails on an older host:

* **1.1** — `item.body.getAsync("text")`, `item.attachments`, `displayReplyForm` / `displayReplyAllForm`,
  `displayNewAppointmentForm`, `displayMessageForm`, `userProfile`, `displayLanguage`
* **1.3** — `convertToRestId` (→ the stable id for `analysisByEmail`)
* **1.5** — `ewsUrl`, `Office.context.ui.closeContainer`, **`SupportsPinning`** + the **`ItemChanged`** event (pinned pane follows the
  message list; `Office.context.mailbox.item` is `null` when nothing — or more than one message — is selected)
* **1.8** — also **`SupportsNoItemContext`**: the pane may be opened with no message selected (→ the daily brief)
* **1.7** — `from.getAsync` (compose), `RecipientsChanged` event
* **1.8** — `categories.getAsync/addAsync`, `masterCategories`, `getAttachmentsAsync`, `removeAttachmentAsync`, `AttachmentsChanged`
* **1.10** — `LaunchEvent` / `OnMessageSend`, `Office.actions.associate`, `notificationMessages` insight messages with a
  `showTaskPane` action ("Compliance risk detected — Show panel")
* **1.13** — `item.sensitivityLabel.setAsync` (only with a `labelId`; otherwise the user is asked to apply the label), plus the whole
  multi-select path: **`SupportsMultiSelect`**, `mailbox.getSelectedItemsAsync` and the **`SelectedItemsChanged`** event
* **1.15** — `mailbox.loadItemByIdAsync`, used to load the body/sender/attachments of each selected message. Without it the Selection
  view degrades to the subjects `getSelectedItemsAsync` returns (it does **not** return senders or bodies) and says so in the UI
* **1.14** — `event.completed({ sendModeOverride, commandId })` on the Smart Alerts dialog (feature-detected; older hosts get the
  same call without those options)
* **Identity API 1.3** — `OfficeRuntime.auth.getAccessToken` (`VITE_AUTH_MODE=aad`)
* `Office.context.officeTheme` + the `OfficeThemeChanged` event for light/dark/high-contrast

Every one of those is feature-detected, so the manifest minimum stays **1.10** and the add-in still installs on a host that has
nothing else: no pinning, no multi-select, no Apps rail — just the read and compose panes.

`OnAppointmentSend` is deliberately **not** registered: the Compliance Guardian policy is about mail recipients and attachments, so
a handler that always allows would only add latency to every meeting booked.

### Smart Alerts send semantics

Manifest `SendMode="PromptUser"` — an add-in outage, an expired token or a slow model must never stop someone sending an email.

| verdict | `event.completed(...)` | effect |
|---|---|---|
| `allow` | `{ allowEvent: true }` | sends, no dialog |
| `warn` | `{ allowEvent: false, errorMessage, sendModeOverride: PromptUser, commandId }` | dialog with the issues; "Send anyway" stays available even under a stricter manifest SendMode |
| `block` | `{ allowEvent: false, errorMessage, commandId }` | dialog; the manifest SendMode decides whether "Send anyway" is offered |
| *any error* | `{ allowEvent: true }` | **fail open, always** |

`commandId` points at the compose ribbon button, so the Outlook dialog offers a "Show panel" button. The same issues are also
pushed as a notification message on the item, so they survive the dialog being dismissed.

---

## 8. Robustness

* **Error boundaries per feature** (`src/app/ErrorBoundary.tsx`): a crash in Chat never takes down Summary. The recovery card is
  localised FR/EN, offers *Try again* (remounts just that subtree) and *Copy report*, which copies the correlation id, feature,
  version and message — and **nothing else**.
* **Every API call** has a timeout (8 s for the fast GETs, 4 s for health, 60 s for model calls), an `x-correlation-id`, and
  exponential backoff with jitter (250 ms → ~700 ms → …, capped at 4 s) for **idempotent GETs only** — a POST is never replayed,
  because replaying `analyze/email` would cost a second model call. Retries fire on network/timeout/429/5xx only.
* **No silent sample data** — the mock client is only used when it was asked for or in browser preview (see §5). Inside any Outlook
  host — read, compose, pinned, multi-select, Apps-rail home — a failed startup health check blocks the pane with the base URL, the
  error and a Retry button instead of answering with the sample email. Telemetry records the outcome as `api.mode {mode, reason}`.
* **Offline** — `navigator.onLine` plus two consecutive network failures against the backend raise a non-blocking banner
  (`role="status"`, `aria-live="polite"`). Cached analyses stay readable; `observe` events go to a bounded outbox
  (max 100, dropped after 24 h, persisted in localStorage) and are flushed when connectivity returns.
* **Auth** — see the SSO table below. The token is cached **in memory only** (never localStorage), its real expiry is parsed from
  the JWT `exp` claim and refreshed 5 minutes early, and concurrent callers share one in-flight `getAccessToken` so opening the
  pane can never trigger several sign-in prompts.
* **Security** — strict CSP `<meta>` on both HTML entries with `connect-src` narrowed to the configured backend origin,
  `object-src 'none'`, `form-action 'none'`, no `unsafe-eval`. There is **no `dangerouslySetInnerHTML`, no `innerHTML =` and no
  `document.write` anywhere in `src/`** (asserted by a unit test); model output is rendered as React text nodes after
  `toPlainText()`, and the single place that *produces* HTML (the reply body for `displayReplyForm`) escapes every character.
* **Telemetry** (`src/telemetry.ts`) — pluggable sink: console in dev, fetch-beacon to `VITE_TELEMETRY_URL` /
  Application Insights, no-op otherwise. An allow-list drops any property that is not a known counter/enum, plus any string longer
  than 64 chars or containing an `@`. **No email content, subject, recipient, attachment name, chat message or audit text is ever
  sent.** Users can opt out in Settings; the opt-out takes effect on the very next event.

### SSO troubleshooting

`OfficeRuntime.auth.getAccessToken({ allowSignInPrompt: true, allowConsentPrompt: true, forMSGraphAccess: false })`.
Each code maps to a localised message (`errors.sso.*`, FR + EN) and a retry decision in `src/office/sso.ts`.

| Code | Meaning | Pane behaviour | Fix |
|---|---|---|---|
| 13000 | SSO not supported by this Office version | message + runbook link | update Office / use the XML manifest path |
| 13001 | User not signed in to Office | message, retried once | sign in to Outlook, reopen the pane |
| 13002 | User dismissed the consent prompt | message, retried once | reopen and accept |
| 13003 | Unsupported account type (personal MSA, anonymous) | message | sign in with the work account |
| 13004 | Invalid `Resource` in the manifest | message + runbook | `Resource` must equal the app's *Application ID URI* `api://<host>/<client-id>` |
| 13005 | No consent / blocked for this add-in | message + runbook | admin consent in Entra ID |
| 13006 | Transient client error | retried once | retry |
| 13007 | Office could not get a token | message + runbook | retry, then check the app registration |
| 13008 | A token request is already in flight | retried once | wait |
| 13009 | Cannot complete without a prompt (`allowSignInPrompt: false`) | message | reopen the pane |
| 13010 | Blocked in this browser session (3rd-party cookies / Edge InPrivate) | message + runbook | allow site data, or use desktop Outlook |
| 13012 | SSO unavailable in this Outlook client | message + runbook | use a supported client |
| 13013 | Too many attempts | retried once | wait a minute |

The documented last-resort fallback for 13000/13003/13005/13009/13010/13012 is an MSAL dialog-API flow, which is **out of scope**
for this add-in: the pane shows a clear message and points at the runbook instead. In a **dev build only**, a failed SSO silently
falls back to the `x-user-email` dev headers so the UI stays reviewable; production builds surface the error.

---

## 9. Accessibility statement (WCAG 2.1 AA)

* **Landmarks & structure** — `<header>`, `<nav aria-label="Sections">`, `<main id="oao-main">`, a skip link to `#oao-main`, one
  `<h1>` per surface, and `lang` kept in sync with the FR/EN toggle.
* **Keyboard** — everything is reachable and operable by keyboard: the tab list is a real Fluent `TabList` (arrow keys), the
  quick-reply and scope chips are buttons in labelled groups, source rows and priority-email rows are buttons (not clickable divs),
  and a visible `:focus-visible` outline is forced on top of Fluent's own (`Highlight` colour under `forced-colors`).
* **Dialogs & sheets** — the approval dialog and the settings drawer trap focus, are labelled (`aria-label` / `aria-labelledby`),
  close on Escape, move focus to the heading on open and return it to the trigger on close.
* **Live regions** — a visually-hidden `aria-live="polite"` region announces "Analyzing this email…" and then how the result was
  obtained; the offline banner is `role="status"`; errors are `role="alert"`.
* **Contrast** — every body-text and badge foreground/background pair in both the light and the dark palette is verified at
  **≥ 4.5:1 by a unit test** (`infra.test.ts`). High-contrast mode delegates to the system colours (`Canvas`, `CanvasText`,
  `Highlight`) instead of fighting them.
* **Reduced motion** — `prefers-reduced-motion: reduce` and a `data-oao-motion` attribute collapse every animation and transition,
  including Fluent's.
* **Width** — usable from **320 px** with no horizontal scrolling (asserted in e2e), all layouts wrap or stack.
* **RTL** — logical CSS properties throughout (`paddingInline`, `paddingBlock`, `inset-inline-start`, `textAlign: start`), so the
  pane mirrors correctly if an RTL locale is added.
* **Icons** — decorative icons are `aria-hidden`; every icon-only button has an `aria-label`.

Known limitation: the add-in ships FR and EN only; there is no RTL locale to verify the mirrored layout against yet.

---

## 10. Client instructions the backend can return (`ActionResult.clientInstruction.operation`)

`displayReplyForm` `{htmlBody|body}` · `displayReplyAllForm` · `addCategory` `{category}` · `flag` (toast: no Office.js API) ·
`displayNewAppointmentForm` `{subject, body, start, end}` · `openMoveDialog` `{folder}` (toast) · `applyLabel` `{label, labelId?}` ·
`removeAttachment` `{attachmentId|name}` (compose only) · `none`.
After executing one the add-in POSTs `Routes.reportActionResult(id)` with `{actionId, status, message}`.

---

## 11. Project layout

```
manifest/            manifest.xml · manifest.json (unified, incl. staticTabs) · manifest.dev.xml · manifest.dev.json
                     + oao-addin-teams-app*.zip (generated by manifest:package, git-ignored)
public/assets/       icon-16/32/64/80/128.png + icon.svg (generated)
e2e/                 Playwright specs (run against `vite preview`)
src/taskpane/        main.tsx (Office.onReady → React)
src/commands/        commands.ts (onMessageSendHandler, send-mode semantics)
src/app/             App · AppContext · Header · ReadMode · BriefMode · HomeMode · BackendUnreachable · ErrorBoundary · settings ·
                     useAsync · useMediaQuery
src/office/          env (incl. toStableEmailId, isPreviewMode/isTabHost) · host (surface resolution) · events (one ItemChanged /
                     SelectedItemsChanged handler for the whole pane) · selection (getSelectedItemsAsync + loadItemByIdAsync,
                     selection:<hash>) · sample · cache · readItem · readCompose · thread · actions · observe · sso · notifications
src/api/             client (fetch + retry + zod) · index (decideApi: live vs mock) · mock · mockBrief · errors · types
src/cache/           idb (IndexedDB wrapper) · analysisCache (TTL, keys, pruning)
src/net/             connectivity (online/offline) · outbox (bounded observe queue)
src/security/        csp (policy builder) · sanitize (toPlainText / escapeHtml)
src/features/        summary (+ useAnalysis, TriageCard) · thread · chat · selection (multi-select view) · insights
                     (+ SyncStatusPill) · automation · compliance · actions · brief · settings · lazy (code-splitting + prefetch)
src/ui/              theme (tokens + palettes) · ThemeProvider · SourceBadge · OfflineBanner · ConfidenceBar · RiskBadge ·
                     SectionCard · AiFooter · States · toast
src/i18n/            en.json · fr.json · hook (auto-detect + FR/EN toggle)
src/telemetry.ts     pluggable sink, scrubbing allow-list
docs/screenshots/    generated by scripts/screenshots.mjs
```

---

## 12. Screenshots (`docs/screenshots/`, regenerate with `pnpm screenshots`)

| File | What |
|---|---|
| `summary.png` | Read pane, Summary tab, "Precomputed" badge |
| `summary-fr.png` | Same in French |
| `triage.png` | Compact layout for a newsletter + "Analyse anyway" |
| `daily-brief.png` | Daily brief: headline, highlights, priority emails, tasks, deadlines, alerts, stats |
| `home-tab.png` | Home mode from the Apps rail (`?view=home&host=tab`): brief + chat + sync status, no sample email |
| `selection.png` | Multi-select: the 3 selected emails and the three next steps |
| `thread.png` | Whole-conversation synthesis |
| `chat.png` | Chat with cited sources and evidence |
| `insights-automation.png` | Mailbox sync status + analysis details + Automation Coach simulation |
| `compliance.png` | Compliance Guardian (compose) with the 4 issues |
| `approval-dialog.png` · `approval-dialog-wide.png` | Action approval, narrow (cards) and wide (table) |
| `settings.png` | Settings sheet with diagnostics |
| `dark-mode.png` | The pane following Outlook's dark theme |
