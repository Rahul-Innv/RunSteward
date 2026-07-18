// wake — Windows sleep/wake glue. Two jobs:
//   1. schedule a Scheduled Task that WAKES the PC at a task's resume_at, so a
//      reset fires even if the machine slept while waiting (Node timers can't
//      wake a sleeping PC).
//   2. keep the PC awake while a task is actively running, releasing when idle.
//
// Pure wrappers around the PowerShell helpers in scripts/. All best-effort:
// a wake-scheduling failure must never crash the runner (the wall-clock loop
// still resumes once the PC is awake) — it logs and continues.

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const WAKE_PS1 = join(SCRIPTS, 'wake-task.ps1');
const KEEP_AWAKE_PS1 = join(SCRIPTS, 'keep-awake.ps1');

const isWindows = process.platform === 'win32';

function pwsh(args, opts = {}) {
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    ...opts,
  });
}

// Register/replace the one-shot wake task for the next resume time.
export function scheduleWake(atIso, runnerCmd) {
  if (!isWindows) return { ok: false, reason: 'not Windows' };
  const r = pwsh(['-File', WAKE_PS1, '-At', atIso, '-RunnerCmd', runnerCmd]);
  return { ok: r.status === 0, output: (r.stdout || r.stderr || '').trim() };
}

export function removeWake() {
  if (!isWindows) return { ok: false };
  const r = pwsh(['-File', WAKE_PS1, '-Remove']);
  return { ok: r.status === 0, output: (r.stdout || '').trim() };
}

// Register the at-logon recovery task so the runner restarts after a reboot
// (background sessions and the runner die on shutdown, but the queue file
// survives, so resuming on next logon picks every task back up).
export function scheduleLogonRecovery(runnerCmd) {
  if (!isWindows) return { ok: false };
  const r = pwsh(['-File', WAKE_PS1, '-AtLogon', '-RunnerCmd', runnerCmd]);
  return { ok: r.status === 0, output: (r.stdout || r.stderr || '').trim() };
}

// Hold the PC awake until `pid` exits. Returns the helper child so the caller
// can let it die naturally (it releases the wake-lock on exit).
export function keepAwakeFor(pid) {
  if (!isWindows) return null;
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', KEEP_AWAKE_PS1, '-WatchPid', String(pid)],
    { stdio: 'ignore', detached: false }
  );
  child.on('error', () => {}); // best-effort; never crash the run
  return child;
}

// doctor check: are wake timers enabled in the active power plan? If the user
// has "Allow wake timers" disabled, our WakeToRun task silently never fires —
// so we surface it loudly. Returns { enabled, detail }.
export function wakeTimersEnabled() {
  if (!isWindows) return { enabled: false, detail: 'not Windows' };
  // SUB_SLEEP / RTCWAKE (Allow wake timers) — query the active scheme
  const r = pwsh([
    '-Command',
    'powercfg /query SCHEME_CURRENT SUB_SLEEP RTCWAKE 2>$null | Select-String "Current AC Power Setting Index"',
  ]);
  const out = (r.stdout || '').trim();
  // value 0x0 = Disabled, 0x1 = Enabled, 0x2 = Important Wake Timers Only
  const m = out.match(/0x0000000([0-9a-f])/i);
  if (!m) return { enabled: null, detail: 'could not read wake-timer setting' };
  const val = parseInt(m[1], 16);
  return {
    enabled: val !== 0,
    detail: val === 0 ? 'DISABLED — scheduled wakes will NOT fire (powercfg: enable Allow wake timers)' : val === 2 ? 'Important only (our task qualifies)' : 'Enabled',
  };
}

// overnight-readiness — the lesson from run 1, codified: a laptop whose only
// sleep state is modern standby (S0 Low Power Idle) will SUSPEND an unattended
// run when it idles or the lid closes, and keep-awake (SetThreadExecutionState)
// CANNOT stop S0ix. So we detect that machine and check the two settings that
// actually keep it awake while plugged in: lid-close = Do Nothing (AC) and the
// AC sleep timeout = Never. Returns { modernStandby, warnings[], oks[] }.
const LIDACTION_GUID = '5ca83367-6e45-459f-a27b-476b1d01c936';
const SUB_BUTTONS = '4f971e89-eebd-4455-a8de-9e59040e7347';

function acIndex(out) {
  // read the "Current AC Power Setting Index: 0x0000000N" hex value
  const m = (out || '').match(/Current AC Power Setting Index:\s*0x0000000([0-9a-f])/i);
  return m ? parseInt(m[1], 16) : null;
}

export function overnightReadiness() {
  if (!isWindows) return { modernStandby: false, warnings: [], oks: ['not Windows — sleep model N/A'] };
  const avail = pwsh(['-Command', 'powercfg /a']);
  const availOut = avail.stdout || '';
  const hasS0 = /S0 Low Power Idle/i.test(availOut);
  // "real" S3 available = listed under available states and NOT in the disabled block
  const s3Disabled = /Standby \(S3\)[\s\S]*?disabled when S0/i.test(availOut);
  const modernStandby = hasS0 && s3Disabled;
  if (!modernStandby) {
    return { modernStandby: false, warnings: [], oks: ['traditional sleep (S3) available — keep-awake can hold it'] };
  }

  const warnings = [];
  const oks = [];
  // lid-close action on AC (unhide first; it's often hidden)
  pwsh(['-Command', `powercfg /attributes ${SUB_BUTTONS} ${LIDACTION_GUID} -ATTRIB_HIDE`]);
  const lid = pwsh(['-Command', `powercfg /query SCHEME_CURRENT ${SUB_BUTTONS} ${LIDACTION_GUID}`]);
  const lidAc = acIndex(lid.stdout);
  if (lidAc === 0) oks.push('lid-close on AC = Do nothing');
  else if (lidAc == null) warnings.push('could not read lid-close action — set "When I close the lid (plugged in)" to "Do nothing"');
  else warnings.push(`lid-close on AC = ${['Do nothing', 'Sleep', 'Hibernate', 'Shut down'][lidAc] || lidAc} — closing the lid will SUSPEND overnight runs; set it to "Do nothing"`);

  // AC sleep (standby) idle timeout — must be Never (0)
  const slp = pwsh(['-Command', 'powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE']);
  const slpAc = acIndex(slp.stdout);
  if (slpAc === 0) oks.push('AC sleep timeout = Never');
  else if (slpAc == null) warnings.push('could not read AC sleep timeout — set "Put the computer to sleep (plugged in)" to Never');
  else warnings.push(`AC sleep timeout = ${slpAc}s — the machine will idle into modern standby; set it to Never`);

  return { modernStandby, warnings, oks };
}
