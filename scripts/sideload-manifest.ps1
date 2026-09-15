<#
.SYNOPSIS
  Sideloads the Outlook AI Orchestrator dev add-in manifest into classic
  (Win32) Outlook via the WEF Developer registry key, and prints instructions
  for New Outlook / Outlook on the web (OWA), which don't use the registry.

.DESCRIPTION
  Classic Outlook on Windows reads shared-folder / registry-registered
  manifests from HKCU:\Software\Microsoft\Office\16.0\WEF\Developer. This
  script registers the local path to apps/addin/manifest/manifest.dev.xml
  there so Outlook offers it under "My Add-ins" without needing an
  organization catalog. It does NOT work for New Outlook or OWA — see the
  printed instructions below for those.

.PARAMETER ManifestPath
  Path to the manifest.dev.xml to register. Defaults to
  apps/addin/manifest/manifest.dev.xml relative to the repo root (this
  script's ../.. ).

.EXAMPLE
  .\scripts\sideload-manifest.ps1
#>

[CmdletBinding()]
param(
  [string]$ManifestPath
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $ManifestPath) {
  $ManifestPath = Join-Path $RepoRoot "apps\addin\manifest\manifest.dev.xml"
}

if (-not (Test-Path $ManifestPath)) {
  Write-Error "Manifest not found at '$ManifestPath'. Build the add-in first (pnpm --filter @oao/addin build) or pass -ManifestPath explicitly."
  exit 1
}

$ManifestDir = Split-Path -Parent (Resolve-Path $ManifestPath)
$RegKeyPath = "HKCU:\Software\Microsoft\Office\16.0\WEF\Developer"

Write-Host "==> Outlook AI Orchestrator — sideload dev manifest (classic Outlook)" -ForegroundColor Cyan
Write-Host "    Manifest folder: $ManifestDir"

if (-not (Test-Path $RegKeyPath)) {
  New-Item -Path $RegKeyPath -Force | Out-Null
}

# The WEF\Developer key holds one value per registered manifest folder: the
# value NAME is the folder path itself, and its DATA is an arbitrary label.
New-ItemProperty -Path $RegKeyPath -Name $ManifestDir -Value "OAO dev add-in" -PropertyType String -Force | Out-Null

Write-Host "==> Registered '$ManifestDir' under $RegKeyPath" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps (classic Outlook, Win32):" -ForegroundColor Yellow
Write-Host "  1. Restart Outlook."
Write-Host "  2. Home ribbon -> Get Add-ins -> My Add-ins -> 'Custom Addins' section"
Write-Host "     -> your dev add-in should already be listed (registry-registered manifests"
Write-Host "        show up automatically, no need to click 'Add from File')."
Write-Host "     If it doesn't appear, use 'Add a custom add-in' -> 'Add from File...' and"
Write-Host "     select: $ManifestPath"
Write-Host "  3. Make sure the dev server is running and trusted: pnpm --filter @oao/addin dev"
Write-Host "     (https://localhost:3000 must be reachable without a certificate warning —"
Write-Host "     run pnpm --filter @oao/addin certs once, or scripts/gen-dev-cert.sh)."
Write-Host ""
Write-Host "New Outlook (Windows) and Outlook on the web (OWA):" -ForegroundColor Yellow
Write-Host "  The WEF\Developer registry key is NOT read by New Outlook / OWA. Instead:"
Write-Host "  1. Open Outlook on the web (or New Outlook) -> Settings (gear) -> "
Write-Host "     'Manage add-ins' -> 'My add-ins' -> 'Custom add-ins' -> 'Add a custom add-in'"
Write-Host "     -> 'Add from file' and select manifest.dev.xml, OR 'Add from URL' and point it"
Write-Host "     at https://localhost:3000/manifest.dev.xml if the dev server serves it."
Write-Host "  2. Because the manifest points at https://localhost:3000, this only works when"
Write-Host "     testing from the same machine (or reachable host) as the dev server, and the"
Write-Host "     TLS certificate must be trusted by the browser (see scripts/gen-dev-cert.sh"
Write-Host "     or 'pnpm --filter @oao/addin certs')."
Write-Host "  3. For centralized / team testing without per-user sideloading, see the"
Write-Host "     'Déploiement centralisé M365 (Integrated Apps)' section of docs/SETUP.md."
Write-Host ""
Write-Host "To remove: Remove-ItemProperty -Path '$RegKeyPath' -Name '$ManifestDir'" -ForegroundColor DarkGray
