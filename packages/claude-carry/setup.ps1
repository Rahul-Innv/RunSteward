# Claude Carry one-time setup for Windows 11.
# Installs the standalone Claude Code CLI if missing (the VS Code extension's
# bundled binary is NOT on PATH and moves on every extension update — we never
# depend on it). Idempotent: safe to re-run.

$ErrorActionPreference = 'Stop'

# git + node live outside the default PATH on this machine
$env:Path = "C:\Program Files\Git\cmd;C:\Program Files\nodejs;" + $env:Path
# standalone CLI install target
$localBin = Join-Path $env:USERPROFILE ".local\bin"
$env:Path = "$localBin;" + $env:Path

Write-Host "== Claude Carry setup ==" -ForegroundColor Cyan

$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
    Write-Host "Standalone Claude CLI not found - installing via official installer..." -ForegroundColor Yellow
    irm https://claude.ai/install.ps1 | iex
    $claude = Get-Command claude -ErrorAction SilentlyContinue
    if (-not $claude) {
        Write-Error "Install finished but 'claude' still not found. Open a new terminal and re-run, or check $localBin"
    }
}

$version = (& claude --version) 2>&1 | Out-String
Write-Host "claude: $($version.Trim()) at $($claude.Source)"

# minimum version: 2.1.139 (agent view / --bg era)
if ($version -match '(\d+)\.(\d+)\.(\d+)') {
    $v = @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
    $min = @(2, 1, 139)
    $ok = $false
    for ($i = 0; $i -lt 3; $i++) {
        if ($v[$i] -gt $min[$i]) { $ok = $true; break }
        if ($v[$i] -lt $min[$i]) { $ok = $false; break }
        if ($i -eq 2) { $ok = $true }
    }
    if (-not $ok) { Write-Error "claude $($v -join '.') is older than required $($min -join '.') - run 'claude update'" }
}

Write-Host "`nNOTE: overnight runs should set DISABLE_AUTOUPDATER=1 for the duration" -ForegroundColor Yellow
Write-Host "(a mid-run CLI auto-update can orphan in-flight work; the runner does this itself)."

Write-Host "`nSetup OK. Next: node bin/carry.mjs doctor" -ForegroundColor Green
