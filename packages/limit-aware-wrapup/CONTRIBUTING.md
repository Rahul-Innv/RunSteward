# Contributing to Limit-Aware Wrapup

Thanks for your interest! This is a small, focused tool with a few **non-negotiable invariants** that
keep it safe to run inside a live Claude Code session. Please read them before opening a PR.

## Ground rules (the invariants)
- **Fail-open, always.** Any error path must degrade to silence / a no-op — never a throw out of a
  hook, never a non-zero exit, never a write to `stderr`. A tool that can block or degrade a Claude
  Code session is worse than no tool. (See the contract at the top of [`trigger/check.js`](trigger/check.js).)
- **Account-% units, never tokens.** Every budget/threshold/reserve quantity is a percentage of a
  usage window. This is what lets the tool self-adapt across plan tiers with no tier table.
- **Zero runtime dependencies.** No new runtime deps — the supply-chain surface is a feature. Tests use
  only Node's built-in `node --test` runner.
- **Sensor-fusion invariant.** The OAuth usage poll is the **authoritative** source and is *never*
  regression-dropped; the reset/monotonic sanity checks defend **only** the possibly-cached statusline
  source. Don't "simplify" this into treating the two sources symmetrically — it re-introduces the
  weekly-window-blindness bug (see [`LESSONS.md`](LESSONS.md)).
- **Heads-up ≠ wrap.** A WARN is informational and must never push a wrap; only the WRAPUP directive
  (auto mode, near the cliff) stops a session.

## Dev setup
- **Install:** none — zero dependencies. Requires **Node.js 18+** (uses the built-in test runner and
  `node:test`).
- **Run the tests:** `node --test test/*.test.js`
- **Run offline / safely:** the runtime is dry-run by default (`dry_run: true` logs decisions but
  injects nothing) and network calls are guarded by `LIMIT_WRAPUP_NO_NET` in tests. You never need a
  live account to develop — the suite drives the hook end-to-end in an isolated `LIMIT_WRAPUP_DIR`.

## Making a change
1. Fork and create a branch (`git checkout -b my-change`).
2. Make a focused change that matches the surrounding style.
3. **Add or update tests** and make sure `node --test test/*.test.js` passes.
4. Open a **merge request** describing **what** changed and **why**, and note any invariant it touches.

### Commit checklist
- [ ] Tests pass (`node --test test/*.test.js`).
- [ ] The fail-open contract holds — no new path can throw out of a hook.
- [ ] All new budget quantities are in account-% (not tokens).
- [ ] No new runtime dependencies (or an issue agreed one).
- [ ] No secrets staged — `git status` shows no `.env` / keys / `*.pem` / `*.key`.

## Reporting bugs & security issues
Open an [issue](../../issues) for bugs and ideas. For anything security-sensitive, follow
[SECURITY.md](SECURITY.md) instead of a public issue.
