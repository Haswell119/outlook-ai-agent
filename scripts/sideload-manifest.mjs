#!/usr/bin/env node
/**
 * `npm run manifest:sideload` — load the add-in manifest into Outlook, on any OS.
 *
 *   Windows  : registers the manifest folder under
 *              HKCU\\Software\\Microsoft\\Office\\16.0\\WEF\\Developer
 *              (classic Win32 Outlook) by driving PowerShell.
 *   macOS    : copies the manifest into
 *              ~/Library/Containers/com.microsoft.Outlook/Data/Documents/wef
 *   otherwise: prints the Outlook on the web / New Outlook procedure.
 *
 * Replaces the former PowerShell-only sideload script.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  capture,
  die,
  helpIfRequested,
  info,
  isMac,
  isWindows,
  ok,
  openPath,
  parseArgs,
  repoRoot,
  run,
  step,
  style,
  warn,
} from "./lib/common.mjs";

const { flags } = parseArgs(process.argv.slice(2), {
  booleans: ["prod", "remove", "print", "open", "help", "h"],
});

helpIfRequested(
  flags,
  `
Usage: npm run manifest:sideload -- [options]

Options:
  --manifest <path>  manifest to sideload (default
                     apps/addin/manifest/manifest.dev.xml)
  --prod             use apps/addin/manifest/manifest.xml instead
  --remove           undo the registration (Windows registry / macOS copy)
  --print            only print the instructions, change nothing
  --open             open the manifest folder in the file manager
  -h, --help         show this help

Centralised deployment for the whole company (no per-user sideloading) is
described in docs/SETUP.md (Microsoft 365 admin center > Integrated apps).
`,
);

const manifestPath = flags.manifest
  ? isAbsolute(String(flags.manifest))
    ? String(flags.manifest)
    : resolve(process.cwd(), String(flags.manifest))
  : join(repoRoot, "apps", "addin", "manifest", flags.prod ? "manifest.xml" : "manifest.dev.xml");

if (!existsSync(manifestPath)) {
  die(
    `manifest not found: ${manifestPath}\n` +
      "     Render it first: npm run manifest:render -w @oao/addin\n" +
      "     (or pass --manifest <path>)",
  );
}

const manifestDir = dirname(manifestPath);
step(`Manifest: ${manifestPath}`);

const owaInstructions = `
${style.bold("Outlook on the web / New Outlook (any OS)")}
  1. Settings (gear) > Mail > "Manage add-ins" (or Get Add-ins)
  2. My add-ins > Custom add-ins > "Add a custom add-in" > "Add from file"
  3. Select: ${manifestPath}
     — or "Add from URL" with https://<ADDIN_HOST>/manifest/manifest.xml
       when the add-in is already deployed (Helm chart serves it there).
  4. The add-in host must be reachable and its TLS certificate trusted by the
     browser: run "npm run certs" once for https://localhost:3000.
`;

if (flags.print) {
  console.log(owaInstructions);
  process.exit(0);
}

if (flags.open) {
  openPath(manifestDir);
}

/* -------------------------------------------------------------------------- */
/*  Windows: WEF\\Developer registry key (classic Outlook)                    */
/* -------------------------------------------------------------------------- */
if (isWindows) {
  const regKey = "HKCU:\\Software\\Microsoft\\Office\\16.0\\WEF\\Developer";
  const powershell = capture("where", ["pwsh"]) ? "pwsh" : "powershell";

  if (flags.remove) {
    step(`Removing "${manifestDir}" from ${regKey}`);
    run(
      powershell,
      [
        "-NoProfile", "-NonInteractive", "-Command",
        `Remove-ItemProperty -Path '${regKey}' -Name '${manifestDir}' -ErrorAction SilentlyContinue; ` +
          "Write-Host 'done'",
      ],
      { check: false },
    );
    ok("registry entry removed (restart Outlook)");
    process.exit(0);
  }

  step(`Registering "${manifestDir}" under ${regKey}`);
  // The WEF\Developer key holds one value per registered manifest FOLDER:
  // the value NAME is the folder path, its DATA is an arbitrary label.
  const psCommand =
    `if (-not (Test-Path '${regKey}')) { New-Item -Path '${regKey}' -Force | Out-Null }; ` +
    `New-ItemProperty -Path '${regKey}' -Name '${manifestDir}' -Value 'OAO dev add-in' ` +
    "-PropertyType String -Force | Out-Null; Write-Host 'registered'";
  const result = run(
    powershell,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psCommand],
    { check: false },
  );
  if (result.status !== 0) {
    warn("PowerShell registration failed — use the manual procedure below");
  } else {
    ok(`registered — restart Outlook, then Home > Get Add-ins > My Add-ins`);
    info("Registry-registered manifests appear automatically under 'Custom Addins'.");
  }
  console.log(owaInstructions);
  console.log(
    `${style.dim("Undo:")} npm run manifest:sideload -- --remove\n` +
      `${style.dim("Note:")} New Outlook for Windows does NOT read this registry key — use the web procedure above.`,
  );
  process.exit(0);
}

/* -------------------------------------------------------------------------- */
/*  macOS: the wef folder inside the Outlook container                        */
/* -------------------------------------------------------------------------- */
if (isMac) {
  const wefDir = join(
    homedir(),
    "Library", "Containers", "com.microsoft.Outlook", "Data", "Documents", "wef",
  );
  const target = join(wefDir, basename(manifestPath));

  if (flags.remove) {
    step(`Removing ${target}`);
    run("rm", ["-f", target], { check: false });
    ok("manifest removed (restart Outlook)");
    process.exit(0);
  }

  try {
    mkdirSync(wefDir, { recursive: true });
    copyFileSync(manifestPath, target);
    ok(`copied to ${target}`);
    info("Restart Outlook for Mac — the add-in appears in the ribbon.");
  } catch (error) {
    warn(`could not write to ${wefDir}: ${/** @type {Error} */ (error).message}`);
    info("Grant Terminal full-disk access, or use the web procedure below.");
  }
  console.log(owaInstructions);
  console.log(`${style.dim("Undo:")} npm run manifest:sideload -- --remove`);
  process.exit(0);
}

/* -------------------------------------------------------------------------- */
/*  Linux and everything else: OWA only                                       */
/* -------------------------------------------------------------------------- */
info(`${process.platform}: no Outlook desktop client — use Outlook on the web.`);
console.log(owaInstructions);
