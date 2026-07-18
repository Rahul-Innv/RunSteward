#!/usr/bin/env node
'use strict';
// Native desktop notification for a WRAPUP — so an UNATTENDED auto-wrap is SEEN when it happens,
// not discovered later as a stray wip/ branch. Cross-platform, and FAIL-OPEN like everything else:
// any error (no toast subsystem, no PowerShell, headless box) degrades to silence, never a throw.
//
// Two ways in:
//   - as a module: require('./notify').dispatch(title, message)  (used by check.js)
//   - as a CLI:     node trigger/notify.js "<title>" "<message>"  (manual test)
//
// Escape hatches / test seams (checked in this order):
//   - LIMIT_WRAPUP_NO_NOTIFY   -> do nothing at all.
//   - LIMIT_WRAPUP_NOTIFY_FILE -> append the notification as a JSON line to that file instead of
//                                 showing a toast. Deterministic; lets tests assert dispatch without
//                                 a display, and doubles as a "log, don't pop" mode on a server.

const fs = require('fs');

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Build the toast text from a decide() result. Kept here so the wording lives with the notifier.
function buildNotifyText(result) {
  const wins = (result && Array.isArray(result.windows) ? result.windows : []).filter((w) => w && w.level === 'wrapup');
  const parts = wins.map((w) => {
    const label = w.window === 'seven_day' ? 'weekly' : w.window === 'five_hour' ? '5h' : w.window;
    return `${label} ${Math.round(w.util)}%`;
  });
  const detail = parts.length ? parts.join(', ') : 'near the usage cliff';
  return {
    title: 'Claude Code — wrapping up (usage limit)',
    message: `Auto-wrap triggered (${detail}). Committing WIP to a wip/ branch and writing HANDOFF.md.`,
  };
}

// PowerShell balloon/toast via NotifyIcon — the most reliable no-dependency path on Win10/11.
// The whole script is passed as -EncodedCommand (base64 UTF-16LE) so no shell quoting can break it;
// title/message are still escaped for the single-quoted PS string literals inside.
function windowsCommand(title, message) {
  const psq = (s) => String(s).replace(/'/g, "''");
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$n = New-Object System.Windows.Forms.NotifyIcon',
    '$n.Icon = [System.Drawing.SystemIcons]::Warning',
    '$n.Visible = $true',
    `$n.ShowBalloonTip(10000, '${psq(title)}', '${psq(message)}', [System.Windows.Forms.ToolTipIcon]::Warning)`,
    'Start-Sleep -Seconds 6',
    '$n.Dispose()',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded] };
}

function platformCommand(title, message) {
  if (process.platform === 'win32') return windowsCommand(title, message);
  if (process.platform === 'darwin') {
    const esc = (s) => String(s).replace(/["\\]/g, '\\$&');
    return { cmd: 'osascript', args: ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`] };
  }
  // linux / other: notify-send if present (spawn just fails silently if it isn't).
  return { cmd: 'notify-send', args: ['-u', 'critical', String(title), String(message)] };
}

// Fire a native notification. Never throws; returns true if a dispatch was attempted.
function dispatch(title, message) {
  try {
    title = truncate(title, 120);
    message = truncate(message, 400);
    if (process.env.LIMIT_WRAPUP_NO_NOTIFY) return false;

    const file = process.env.LIMIT_WRAPUP_NOTIFY_FILE;
    if (file) {
      try { fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), title, message }) + '\n'); } catch {}
      return true;
    }

    const { cmd, args } = platformCommand(title, message);
    const child = require('child_process').spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); // no toast subsystem -> silent
    child.unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = { dispatch, buildNotifyText };

if (require.main === module) {
  const title = process.argv[2] || 'Claude Code — wrapping up (usage limit)';
  const message = process.argv[3] || 'Auto-wrap triggered.';
  dispatch(title, message);
}
