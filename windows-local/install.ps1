# ego lite for Windows - personal installer.
#
#   powershell -ExecutionPolicy Bypass -File windows-local\install.ps1
#
# Builds the runtime and host, installs the `ego-browser` command on your user
# PATH, copies the agent skill into every agent skills directory, and verifies
# the whole chain against your real browser. Re-runnable at any time.

[CmdletBinding()]
param(
    # Install into one folder only. Everything (browser profile, task spaces,
    # CDP port, agent skill) lives in <dir>\.ego; your PATH and other projects
    # are untouched. Pass the folder, or use -Project '.' for the current one.
    [string]$Project,
    # Skip the npm build steps (use when only re-installing the command/skill).
    [switch]$NoBuild,
    # Import this browser's profile right after setup: edge or chrome.
    [string]$ImportFrom,
    # Which source profile to import (default: the most recently used).
    [string]$ImportProfile
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cli = Join-Path $here 'src\ego-lite.mjs'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'Node.js 22 or newer is required and was not found on PATH.'
}

$scopeArgs = @()
if ($Project) {
    $scopeArgs = @('--project', (Resolve-Path $Project).Path)
}

$setupArgs = @('setup') + $scopeArgs
if ($NoBuild) { $setupArgs += '--no-build' }

node $cli @setupArgs
if ($LASTEXITCODE -ne 0) {
    Write-Error "setup failed with exit code $LASTEXITCODE"
}

if ($ImportFrom) {
    $importArgs = @('import-profile', '--from', $ImportFrom) + $scopeArgs
    if ($ImportProfile) { $importArgs += @('--profile', $ImportProfile) }
    node $cli @importArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "profile import failed with exit code $LASTEXITCODE"
    }
}

Write-Host ''
if ($Project) {
    Write-Host 'Done. From that folder, try:' -ForegroundColor Green
    Write-Host '  .ego\bin\ego-browser.cmd -e "console.log(await page.info())"'
    Write-Host "  node `"$cli`" status --project `"$((Resolve-Path $Project).Path)`""
}
else {
    Write-Host 'Done. Open a new terminal, then try:' -ForegroundColor Green
    Write-Host '  ego-browser -e "console.log(await page.info())"'
    Write-Host '  node windows-local\src\ego-lite.mjs status'
}
