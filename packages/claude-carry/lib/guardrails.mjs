// guardrails — the safety floor for unattended runs, enforced entirely through
// native CLI permission flags (no hooks, so nothing to drift): every task runs
// with `--permission-mode dontAsk` plus an allowlist and a denylist.
//
// How the three layers combine (verified against code.claude.com/docs AND a
// live run on this Windows machine, 2026-06-13):
//   - dontAsk           : anything NOT explicitly allowed is auto-DENIED (no
//                         prompt to answer overnight) — fail-safe by default.
//   - --allowedTools    : the curated safe set runs without prompting.
//   - --disallowedTools : hard denials that WIN over everything (deny-first
//                         precedence), even if something were also allowed.
//
// WINDOWS NOTE (caught live): Claude Code drives the shell through the
// `PowerShell` tool here, not `Bash`. So every shell rule is emitted for BOTH
// Bash(...) and PowerShell(...) — otherwise an allowlist of only Bash(...) would
// silently deny legitimate npm/git commands, and a Bash-only denylist would miss
// the dangerous ones. PowerShell aliases canonicalize (rm->Remove-Item,
// curl->Invoke-WebRequest), so a few cmdlet denies cover the common aliases.

const bash = (r) => `Bash(${r})`;
const pwsh = (r) => `PowerShell(${r})`;
const bothShells = (r) => [bash(r), pwsh(r)];

// Tool rules are shell-agnostic (built-in Read/Edit/Write tools).
const TOOL_ALLOW = ['Read', 'Edit', 'Write'];

// Safe to run unattended: tests/builds, node, dir creation, non-destructive git.
// Read-only shell commands (ls, cat, grep, ...) already run without prompt.
const CMD_ALLOW = [
  'npm run *',
  'npm test *',
  'npm test',
  'npm ci',
  'node *',
  'mkdir *',
  'git add *',
  'git commit *',
  'git status *',
  'git diff *',
  'git log *',
  'git stash *',
  'git checkout *',
  'git restore *',
  'git branch *',
  'git check-ignore *', // read-only: verify what .gitignore would skip
];

// PowerShell-only read-only verification cmdlets. Bash equivalents (grep, wc,
// test, ls) are already auto-allowed by Claude's read-only detection, but these
// PowerShell cmdlets are NOT, so benign verification pipes were false-parking
// (8 of them on the first real run). Every cmdlet here operates on PIPELINE
// objects or path existence — none reads file CONTENTS, so none is a secret-read
// vector. (Get-Content / Select-String are deliberately omitted: allowlisting a
// file-content reader under dontAsk would bypass the .env/secret Read denials —
// those pipes still park for one-tap approval instead.)
const PWSH_READONLY_ALLOW = [
  'Get-ChildItem *', // list (names/metadata, not contents)
  'Select-Object *',
  'Where-Object *',
  'Measure-Object *',
  'Sort-Object *',
  'Test-Path *',
  'Format-Table *',
  'Format-List *',
  'Out-String *',
];

export const DEFAULT_ALLOW = [
  ...TOOL_ALLOW,
  ...CMD_ALLOW.flatMap(bothShells),
  ...PWSH_READONLY_ALLOW.map(pwsh),
];

// Never, regardless of anything else. Outbound/irreversible actions + secret
// exfiltration. Denying curl/wget/Invoke-WebRequest closes the easiest
// exfiltration path; WebFetch isn't allowlisted so dontAsk already blocks it.
const CMD_DENY = [
  'git push *',
  'git push',
  'git remote *',
  'npm publish *',
  'npm install -g *',
  'npm install --global *',
  'sudo *',
];
const BASH_ONLY_DENY = ['rm *', 'rmdir *', 'curl *', 'wget *'];
// cmdlet denies (PowerShell canonicalizes aliases: rm/del/ri -> Remove-Item,
// curl/wget/iwr -> Invoke-WebRequest)
const PWSH_ONLY_DENY = ['Remove-Item *', 'Invoke-WebRequest *', 'Invoke-RestMethod *'];
// secret reads (Read tool). A bare PowerShell Get-Content .env is already
// blocked because PowerShell is not broadly allowlisted (dontAsk denies it).
const READ_DENY = [
  'Read(.env)',
  'Read(.env.*)',
  'Read(**/.env)',
  'Read(**/.env.*)',
  'Read(**/secrets/**)',
  'Read(~/.ssh/**)',
  'Read(~/.aws/**)',
  'Read(~/.config/gcloud/**)',
  'Read(~/.config/gh/**)',
];

export const DEFAULT_DENY = [
  ...CMD_DENY.flatMap(bothShells),
  ...BASH_ONLY_DENY.map(bash),
  ...PWSH_ONLY_DENY.map(pwsh),
  ...READ_DENY,
];

// Resolve the effective lists: a config may REPLACE a list (guardrails.allow /
// guardrails.deny) and/or EXTEND it (allowExtra / denyExtra). Deny always wins,
// so extending deny is the safe way to tighten.
export function effectiveRules(cfg = {}) {
  const g = cfg.guardrails || {};
  const allow = [...(g.allow ?? DEFAULT_ALLOW), ...(g.allowExtra ?? [])];
  const deny = [...(g.deny ?? DEFAULT_DENY), ...(g.denyExtra ?? [])];
  return { allow, deny };
}

// The CLI args that impose the policy. `taskAllowExtra` are per-task grants from
// `carry approve` (deny still wins over them — a never-allow can't be approved).
// MUST be appended LAST in the argv because --allowedTools/--disallowedTools are
// variadic (they swallow following values until the next flag) — anything after
// them would be eaten as a rule.
export function guardrailArgs(cfg = {}, taskAllowExtra = []) {
  const { allow, deny } = effectiveRules(cfg);
  const fullAllow = [...allow, ...taskAllowExtra];
  const args = [];
  if (fullAllow.length) args.push('--allowedTools', ...fullAllow);
  if (deny.length) args.push('--disallowedTools', ...deny);
  return args;
}

// Detect permission denials in a task's event stream so the runner can PARK the
// task for morning approval. Returns the attempted calls that were blocked,
// classified: 'dontask' (gray-zone — you could approve it) vs 'rule' (hard deny
// — a never-allow). Signal shapes captured from a real run on this machine.
export function detectDenials(events) {
  const denials = [];
  // map tool_use_id -> {tool, input} so a denial result can name what was tried
  const attempts = new Map();
  for (const e of events) {
    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c.type === 'tool_use') attempts.set(c.id, { tool: c.name, input: c.input });
      if (c.type === 'tool_result' && c.is_error) {
        const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
        const isDontAsk = /don't ask mode|do not ask mode/i.test(text);
        const isRuleDeny = /denied by your permission settings/i.test(text);
        if (isDontAsk || isRuleDeny) {
          const a = attempts.get(c.tool_use_id) || {};
          denials.push({
            kind: isDontAsk ? 'dontask' : 'rule',
            tool: a.tool || 'unknown',
            input: a.input || null,
            message: text.slice(0, 200),
          });
        }
      }
    }
  }
  return denials;
}
