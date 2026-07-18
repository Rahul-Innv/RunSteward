# Limit-Aware Wrapup — Lessons & gotchas

Hard-won, non-obvious things this project learned, and the design decisions behind them. (Forward
work: `BACKLOG.md`. Full history: `Limit-Wrapup-Build-Plan-2026-07-05.md`.)

## Platform / sensing
- **The Claude Code statusline is interactive-TUI-only.** It does NOT run in the VS Code extension
  panel (anthropics/claude-code#55643) or in headless `claude -p`. Hooks, however, DO fire in all of
  those. So the statusline can't be the only sensor — the OAuth usage poll, spawned from the hook, is
  the real surface-independent source.
- **The OAuth usage endpoint** (`GET api.anthropic.com/api/oauth/usage`) needs a
  `User-Agent: claude-code/<version>` header or it 429s hard; safe at ~180s. It returns `utilization`
  + ISO-8601 `resets_at`; the statusline returns `used_percentage` + epoch seconds — normalize both.
- `rate_limits.used_percentage` arrives as **integers** (docs imply decimals) and is per-invocation
  optional — each window can be independently absent.

## Sensor fusion — two real bugs the live soak surfaced
- **A fresh timestamp does not mean a fresh value.** Idle TUI statuslines re-emit a whole CACHED
  payload (stale % *and* stale `resets_at`) under a new timestamp. Drop readings that regress within a
  reset window.
- **`resets_at` is not reliably monotonic.** The weekly reset instant can jitter *earlier* between
  polls (observed 21:00 → 17:00). A "resets only move forward" assumption then classifies every
  current weekly reading as a stale pre-reset cache and drops it — blinding the window at 90%, exactly
  when it matters. Fix: **the OAuth source is authoritative and is never regression-dropped**; the
  reset/monotonic checks defend *only* the possibly-cached statusline source.
- **General lesson:** when fusing a fast-but-cachey source with a slow-but-authoritative one, trust
  the authoritative source unconditionally and only sanity-check the cachey one.

## Design decisions
- **Fit is delegated to the model, not estimated in code.** The hook computes the deterministic
  budget math; the model — the only thing that knows the task — judges whether it fits. Task-aware
  behavior with zero estimator code.
- **Everything is denominated in account-% (never tokens).** Measurement on the user's own account
  self-adapts across plan tiers (Pro / Max 5x/10x/20x) with no tier table.
- **Heads-up and wrap are decoupled** (owner policy). A warning is *informational* and never forces a
  wrap; the only hard stop is the WRAPUP directive near the cliff (`100 − reserve`), and only when
  unattended. Wrapping early because a task "won't fit" wastes budget — use the budget, stop at the
  cliff. Wrap point is adjustable via the `reserve_pct` config knob.
- **Fail-open everywhere.** Missing / renamed / stale data → do nothing. A tool that can block or
  degrade a session is worse than no tool.

## Tooling
- **Claude Carry's unattended guardrails (correctly) block a meta-task** that spawns processes or runs
  git outside its own project dir — so the reserve-calibration task couldn't run *through* Carry; it
  was run directly instead. Carry's sandbox is the wrong vehicle for tools that reach outside their repo.
- **Reserve calibration result:** 5 wrap-up rituals back-to-back didn't move the 5h % by a single
  integer point (< 0.2% each). The ritual is far cheaper in weekly terms than in 5h terms (same
  absolute tokens, larger denominator). Reserve set to 1.5% → wrap at 98.5%.

## Security posture (verified 2026-07-07)
- OAuth token read from the user's own `~/.claude/.credentials.json`, expiry-checked, sent ONLY to
  `api.anthropic.com` (hostname hardcoded) — never logged, never to third parties. Lethal trifecta
  broken (no untrusted input, no third-party exfiltration).
- Zero dependencies (no supply-chain surface). Logs carry no secrets (truncated session id + decision
  + usage %). Wrap-up commits are local-only (never pushed) and respect `.gitignore`.
