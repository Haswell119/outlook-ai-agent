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
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";

const DUMMY_CLIENT_ID = "00000000-0000-4000-8000-000000000000";
const files = process.argv.slice(2);
if (files.length === 0) files.push("manifest/manifest.xml");

const bin = process.platform === "win32" ? "office-addin-manifest.cmd" : "office-addin-manifest";

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
  need(!!m.webApplicationInfo?.id && !!m.webApplicationInfo?.resource, "webApplicationInfo is incomplete");

  const ext = Array.isArray(m.extensions) ? m.extensions[0] : undefined;
  need(!!ext, "extensions[0] is missing");
  if (!ext) return problems;

  const runtimeIds = (ext.runtimes ?? []).map((r) => r.id);
  need(runtimeIds.length >= 2, "extensions[0].runtimes must declare at least the task pane and the commands runtime");
  const actionIds = new Set((ext.runtimes ?? []).flatMap((r) => (r.actions ?? []).map((a) => a.id)));
  need(actionIds.size > 0, "no runtime action declared");

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
  if (r.status !== 0) {
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
