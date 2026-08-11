# ego lite for Windows - personal uninstaller.
#
#   powershell -ExecutionPolicy Bypass -File windows-local\uninstall.ps1
#
# Closes the hosted browser, removes the `ego-browser` command and the installed
# agent skill, and deletes host state (task spaces and the hosted browser
# profile, including any imported logins). This checkout is left untouched.

[CmdletBinding()]
param(
    # Remove a project-scoped install (its .ego directory and skill) instead of
    # the user-wide one.
    [string]$Project,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cli = Join-Path $here 'src\ego-lite.mjs'

if (-not $Force) {
    Write-Host 'This removes the ego-browser command, the installed agent skill,'
    Write-Host 'and all host state including imported logins.'
    $answer = Read-Host 'Continue? (y/N)'
    if ($answer -notmatch '^[Yy]') {
        Write-Host 'Cancelled.'
        return
    }
}

$scopeArgs = @()
if ($Project) {
    $scopeArgs = @('--project', (Resolve-Path $Project).Path)
}

node $cli uninstall @scopeArgs
Write-Host ''
if ($Project) {
    Write-Host 'Project install removed.' -ForegroundColor Green
}
else {
    Write-Host 'Uninstalled. Delete the windows-local directory to remove the rest.' -ForegroundColor Green
}
