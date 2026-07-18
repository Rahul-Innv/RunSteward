// doctor — verifies every link in the Claude Carry chain and says exactly what's red.
// Run it after any Claude Code update; it is designed to fail loudly and specifically.

import { spawnSync, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';

// Claude Code version where agent view / --bg shipped; our minimum supported.
const MIN_CLAUDE_VERSION = [2, 1, 139];

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

// The standalone CLI installs to ~/.local/bin; the current shell may not have
// re-read PATH since install, so we make sure node's children can see it.
export function withClaudePath(env = process.env) {
  const localBin = join(homedir(), '.local', 'bin');
  if (!(env.PATH || '').includes(localBin)) {
    return { ...env, PATH: `${localBin}${delimiter}${env.PATH || ''}` };
  }
  return env;
}

// Resolve the claude binary to a full path so children can be spawned with
// shell:false — task prompts are arbitrary text and must never pass through a
// shell. Returns null if not installed.
export function findClaude() {
  const direct = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (existsSync(direct)) return direct;
  const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['claude'], {
    encoding: 'utf8',
    env: withClaudePath(),
  });
  const found = (probe.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return probe.status === 0 && found ? found : null;
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    env: withClaudePath(),
    timeout: opts.timeout ?? 15_000,
    ...opts,
  });
}

function parseVersion(text) {
  const m = (text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function versionAtLeast(v, min) {
  for (let i = 0; i < 3; i++) {
    if (v[i] > min[i]) return true;
    if (v[i] < min[i]) return false;
  }
  return true;
}

export async function doctor({ smoke = false } = {}) {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok });
    console.log(`${ok ? green('PASS') : red('FAIL')}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // 1. Node
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  check('node >= 18', nodeMajor >= 18, `v${process.versions.node}`);

  // 2. git
  const git = run('git', ['--version']);
  check('git available', git.status === 0, (git.stdout || '').trim() || 'not found — prepend C:\\Program Files\\Git\\cmd to PATH');

  // 3. standalone claude CLI (resolved to a full path — children spawn shell-free)
  const claudePath = findClaude();
  const claude = claudePath ? run(claudePath, ['--version']) : { status: 1, stdout: '' };
  const claudeOk = claude.status === 0;
  const version = claudeOk ? parseVersion(claude.stdout) : null;
  check(
    'claude CLI found',
    claudeOk,
    claudeOk ? `${(claude.stdout || '').trim()} at ${claudePath}` : 'not found — run ./setup.ps1 to install the standalone CLI'
  );
  if (claudeOk && version) {
    check(
      `claude >= ${MIN_CLAUDE_VERSION.join('.')}`,
      versionAtLeast(version, MIN_CLAUDE_VERSION),
      version.join('.')
    );
  }

  // 4. skills directory (depth check: queued runs should see these)
  const skillsDir = join(homedir(), '.claude', 'skills');
  const skillCount = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).length
    : 0;
  check('~/.claude/skills present', skillCount > 0, `${skillCount} skill folder(s)`);

  // 4b. Windows wake timers — without these, a scheduled wake silently never
  // fires and an asleep PC misses every resume until someone touches it.
  if (process.platform === 'win32') {
    const { wakeTimersEnabled, overnightReadiness } = await import('./wake.mjs');
    const w = wakeTimersEnabled();
    check('Windows wake timers enabled', w.enabled !== false, w.detail);

    // overnight-readiness (the lesson from the first real run): a modern-standby
    // laptop suspends unattended runs unless lid-close=Do Nothing + sleep=Never.
    const o = overnightReadiness();
    if (o.modernStandby) {
      const ready = o.warnings.length === 0;
      check(
        'overnight-readiness (this laptop uses modern standby)',
        ready,
        ready
          ? o.oks.join('; ') + ' — safe to run overnight while plugged in'
          : o.warnings.join(' | ') + ' [keep-awake CANNOT stop modern standby — these settings are the fix]'
      );
    }
  }

  // 5. optional live smoke test: one tiny haiku-class -p call, stream-json.
  //    Asserts the three load-bearing facts: a session_id is issued, the init
  //    event lists skills (full context loads — we never run --bare), and the
  //    run completes with a result event.
  if (smoke) {
    if (!claudeOk) {
      check('smoke: claude -p stream-json', false, 'skipped — no claude CLI');
    } else {
      console.log(yellow('....  smoke: running one tiny claude -p call (haiku, ~<$0.01)'));
      const smokeResult = await smokeTest(claudePath);
      check('smoke: session_id issued', !!smokeResult.sessionId, smokeResult.sessionId || smokeResult.error);
      check('smoke: init event lists skills (full context, not --bare)', smokeResult.skillCount > 0, `${smokeResult.skillCount} skills visible`);
      check('smoke: run completed', smokeResult.completed, smokeResult.resultSubtype || '');
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    failed.length === 0
      ? green(`\nAll ${results.length} checks passed.`)
      : red(`\n${failed.length}/${results.length} checks FAILED: ${failed.map((f) => f.name).join(', ')}`)
  );
  return failed.length === 0;
}

function smokeTest(claudePath) {
  return new Promise((resolve) => {
    const out = { sessionId: null, skillCount: 0, completed: false, resultSubtype: null, error: null };
    const child = spawn(
      claudePath,
      ['-p', 'Reply with exactly: OK', '--model', 'haiku', '--output-format', 'stream-json', '--verbose'],
      { env: withClaudePath() }
    );
    const timer = setTimeout(() => {
      out.error = 'timeout after 120s';
      child.kill();
    }, 120_000);

    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue; // defensive: never die on an unparseable line
        }
        if (evt.type === 'system' && evt.subtype === 'init') {
          out.sessionId = evt.session_id || null;
          out.skillCount = Array.isArray(evt.skills) ? evt.skills.length : 0;
        }
        if (evt.type === 'result') {
          out.completed = true;
          out.resultSubtype = evt.subtype || null;
        }
      }
    });
    let errBuf = '';
    child.stderr.on('data', (c) => (errBuf += c));
    child.on('close', () => {
      clearTimeout(timer);
      if (!out.completed && !out.error) out.error = errBuf.trim().slice(0, 200) || 'no result event';
      resolve(out);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      out.error = e.message;
      resolve(out);
    });
  });
}
