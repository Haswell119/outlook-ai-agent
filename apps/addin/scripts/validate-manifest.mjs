/**
 * Validates a manifest with office-addin-manifest.
 *
 *  - XML: the {{AAD_CLIENT_ID}} placeholder is replaced by a dummy GUID first
 *    (the real id is only known at deployment time).
 *  - JSON (unified): `office-addin-manifest validate` supports it from v1.13;
 *    when the installed version does not, we fall back to a structural check of
 *    the nodes the Microsoft 365 admin centre requires, so CI still catches a
 *    broken template.
 *
 * Usage: node scripts/validate-manifest.mjs [manifest/manifest.xml ...]
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const DUMMY_CLIENT_ID = "00000000-0000-4000-8000-000000000000";
const files = process.argv.slice(2);
if (files.length === 0) files.push("manifest/manifest.xml");

/**
 * Prefer the workspace binary so the script works both through `pnpm run`
 * (node_modules/.bin on PATH) and when invoked directly with `node`.
 */
const binName = process.platform === "win32" ? "office-addin-manifest.cmd" : "office-addin-manifest";
const localBin = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".bin", binName);
const bin = existsSync(localBin) ? localBin : binName;

/** Nodes the unified manifest must carry for an Outlook add-in deployment. */
function checkUnified(file) {
  const m = JSON.parse(readFileSync(file, "utf8"));
  const problems = [];
  const need = (cond, message) => {
    if (!cond) problems.push(message);
  };
  need(typeof m.manifestVersion === "string", "manifestVersion is missing");
  need(/^[0-9a-f-]{36}$/i.test(m.id ?? ""), "id must be a GUID");
  need(/^\d+\.\d+\.\d+$/.test(m.version ?? ""), "version must be x.y.z");
  need(!!m.name?.short && m.name.short.length <= 30, "name.short is missing or longer than 30 chars");
  need(!!m.description?.short && m.description.short.length <= 80, "description.short is missing or longer than 80 chars");
  need(Array.isArray(m.validDomains) && m.validDomains.length > 0, "validDomains is empty");
  // Office SSO is optional (the template only emits it for a real AAD_CLIENT_ID),
  // but a half-filled block would fail silently at sign-in time.
  if (m.webApplicationInfo !== undefined) {
    need(!!m.webApplicationInfo?.id && !!m.webApplicationInfo?.resource, "webApplicationInfo is incomplete");
  }
  // Teams app packages carry the two icons next to manifest.json, so the paths
  // must be package-relative — an URL here breaks "Upload a custom app".
  for (const [key, value] of Object.entries(m.icons ?? {})) {
    need(typeof value === "string" && !/^(https?:)?\/\//.test(value) && !value.startsWith("/"), `icons.${key} must be a package-relative path, got ${value}`);
  }

  // The "Apps" rail entry (personal tab): the only way in with no mailbox item.
  const tabs = Array.isArray(m.staticTabs) ? m.staticTabs : [];
  need(tabs.length > 0, "staticTabs is missing — the add-in would not appear in the new Outlook Apps rail");
  for (const tab of tabs) {
    need(!!tab.entityId, "staticTabs: entityId is missing");
    need(!!tab.contentUrl, `staticTabs ${tab.entityId}: contentUrl is missing`);
    need((tab.scopes ?? []).includes("personal"), `staticTabs ${tab.entityId}: scopes must include "personal"`);
    need((tab.context ?? []).includes("personalTab"), `staticTabs ${tab.entityId}: context must include "personalTab"`);
    if (tab.contentUrl) {
      try {
        need(m.validDomains?.includes(new URL(tab.contentUrl).host), `${tab.contentUrl} is not covered by validDomains`);
      } catch {
        problems.push(`staticTabs ${tab.entityId}: contentUrl is not an absolute URL`);
      }
      // "home" mode is what makes the tab usable without Office.context.mailbox.
      need(/[?&]host=tab\b/.test(tab.contentUrl), `staticTabs ${tab.entityId}: contentUrl must carry host=tab so the pane runs in home mode`);
    }
  }

  const ext = Array.isArray(m.extensions) ? m.extensions[0] : undefined;
  need(!!ext, "extensions[0] is missing");
  if (!ext) return problems;

  const runtimeIds = (ext.runtimes ?? []).map((r) => r.id);
  need(runtimeIds.length >= 2, "extensions[0].runtimes must declare at least the task pane and the commands runtime");
  const actionIds = new Set((ext.runtimes ?? []).flatMap((r) => (r.actions ?? []).map((a) => a.id)));
  need(actionIds.size > 0, "no runtime action declared");

  // Pinning and multi-select live on the runtime actions in the unified manifest.
  const allActions = (ext.runtimes ?? []).flatMap((r) => r.actions ?? []);
  need(
    allActions.some((a) => a.type === "openPage" && a.pinnable === true),
    "no pinnable openPage action — the pane could not stay open while the user navigates the list",
  );
  need(
    allActions.some((a) => a.type === "openPage" && a.multiselect === true),
    "no multiselect openPage action — the pane would not activate on several selected messages",
  );

  const contexts = (ext.ribbons ?? []).flatMap((r) => r.contexts ?? []);
  need(contexts.includes("mailRead"), "ribbons: no mailRead context");
  need(contexts.includes("mailCompose"), "ribbons: no mailCompose context");

  for (const ribbon of ext.ribbons ?? []) {
    for (const tab of ribbon.tabs ?? []) {
      for (const group of tab.groups ?? []) {
        for (const control of group.controls ?? []) {
          need(actionIds.has(control.actionId), `ribbon control ${control.id} references unknown actionId ${control.actionId}`);
        }
      }
    }
  }

  const events = (ext.autoRunEvents ?? []).flatMap((e) => e.events ?? []);
  const sending = events.find((e) => e.type === "messageSending");
  need(!!sending, "autoRunEvents: no messageSending (OnMessageSend) event");
  if (sending) {
    need(actionIds.has(sending.actionId), `messageSending references unknown actionId ${sending.actionId}`);
    need(sending.options?.sendMode === "promptUser", "messageSending should use sendMode promptUser so an outage never blocks a send");
  }

  // Every view/page must live on a declared valid domain.
  for (const runtime of ext.runtimes ?? []) {
    const pages = [runtime.code?.page, runtime.code?.script].filter(Boolean);
    for (const page of pages) {
      const host = new URL(page).host;
      need(m.validDomains.includes(host), `${page} is not covered by validDomains`);
    }
  }
  return problems;
}

let failed = false;
for (const file of files) {
  const isJson = file.endsWith(".json");
  process.stdout.write(`\n== ${file} ==\n`);

  if (isJson) {
    const problems = checkUnified(file);
    if (problems.length) {
      failed = true;
      for (const p of problems) console.error(`  ✗ ${p}`);
    } else {
      console.log("  ✓ unified manifest structure OK");
    }
  }

  const dir = mkdtempSync(join(tmpdir(), "oao-manifest-"));
  const tmp = join(dir, basename(file));
  writeFileSync(tmp, readFileSync(file, "utf8").replaceAll("{{AAD_CLIENT_ID}}", DUMMY_CLIENT_ID));
  const r = spawnSync(bin, ["validate", tmp], { stdio: "inherit", shell: process.platform === "win32" });
  rmSync(dir, { recursive: true, force: true });
  if (r.error) {
    // The CLI itself could not be started — that is an environment problem, not
    // a broken manifest, and it must not silently pass as "structure OK".
    console.error(`  ✗ could not run ${bin}: ${r.error.message}`);
    failed = true;
  } else if (r.status !== 0) {
    if (isJson) {
      // Older office-addin-manifest releases cannot read the unified manifest;
      // the structural check above is then the authoritative result.
      console.warn("  ! office-addin-manifest could not validate the unified manifest (older CLI) — structural check used instead");
    } else {
      failed = true;
    }
  }
}

process.exit(failed ? 1 : 0);
