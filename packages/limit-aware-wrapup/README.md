# Limit-Aware Wrapup

![tests](https://img.shields.io/badge/tests-70%20passing-brightgreen)
![dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen)
![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

**A usage-budget sensor for Claude Code that ends a session *gracefully* instead of mid-sentence.**

When a subscription session runs out of budget, Claude Code doesn't wrap up — it stops, wherever it
happens to be: a half-applied edit, an uncommitted diff, no note about what came next. Limit-Aware
Wrapup watches the account's 5-hour and weekly usage windows and, when the remaining budget is about
to run out, has the session **commit its WIP, write a HANDOFF, and stop clean** — then (unattended)
queue its own resume for after the reset. The rest of the time it stays completely silent, so small
tasks run all the way to the cliff.

Zero runtime dependencies. Three small Node scripts + one skill. Fail-open everywhere: if the usage
data is missing, renamed, or stale, the tool does *nothing* — a tool that can block a coding session
is worse than no tool.

```
Limit-Aware Wrapup — status @ 7/7/2026, 4:29 PM

Usage (account-wide):
  5-hour  7%     resets 18:00 (~90m)
  weekly  93%    resets 17:00 (4d)   ⚠ past heads-up (85%)

Sensor:  fresh (oauth, 2m ago)
Mode:    warn (heads-ups only; no auto-wrap — attended)
         heads-up at 70/85% · auto-wrap at 98.5% (reserve 1.5%)
         dry_run: off (live)

Today:   175 checks · 5 heads-ups · 0 wraps · 48 stale-silent
```
<sub>`node bin/status.js` — the human-facing readout, reusing the exact live decision logic.</sub>

**See the decision flow** — `node bin/demo.js` runs synthetic rising usage through the *real* engine
and prints each step (silence → heads-up → the WRAPUP directive + notification), so you can watch the
whole ladder without waiting to hit a real cliff:

```
weekly 88%  →  WARN     [limit-wrapup] Usage heads-up … 88% of budget consumed … ~6.7h of headroom
weekly 96%  →  NONE     (silent — why: 85% warn already latched this session+window)   ← the nag-cap
weekly 99%  →  WRAPUP   Invoke the wrapping-up skill NOW: finish the atomic step, commit WIP …
                        🔔 desktop notification → Claude Code — wrapping up (usage limit)
```
<sub>Record it as a GIF with `asciinema rec` + `agg`, or any terminal recorder: `node bin/demo.js --slow`.</sub>

---

## The problem

Claude Code subscriptions meter usage in rolling windows (a 5-hour window and a 7-day window). Hit the
limit and the current turn is simply cut off. In an *attended* session that's a mild annoyance. In an
**unattended** one — an overnight run, a long agentic task — it's the difference between coming back to
a clean handoff you can resume in one command, and coming back to a session frozen halfway through an
edit with no record of intent.

The naive fix — "stop early when the budget looks low" — is worse than the problem: it wastes paid
budget and interrupts work that would have finished fine. The hard part isn't stopping. It's stopping
**at the right moment, for the right reason, and only then.**

## What it does — two signals, deliberately separated

The tool draws a hard line between *notifying* and *stopping*:

- **Heads-up (WARN)** — fires at your `warn_at` thresholds (e.g. 70% / 85%). Purely **informational**:
  "you're getting close." It *never* tells the session to wrap. An attended owner just keeps working.
- **Wrap (WRAPUP)** — the actual stop, and only in `mode: "auto"` (unattended). Fires only near the
  cliff, once a window passes `100 − reserve` (e.g. reserve 1.5% → **98.5%**). This is the hard
  directive that runs the [`wrapping-up`](skills/wrapping-up/) ritual, and it raises a **native
  desktop notification** so an away-from-keyboard wrap is *seen*, not discovered later as a stray
  `wip/` branch.

The policy in one line: **use the budget, warn early, and only auto-wrap near the cliff when nobody's
watching.** Wrapping early because a task "might not fit" throws away budget you paid for.

## The ideas that make it small

Most of the cleverness here is in what *didn't* get built:

- **Fit is delegated to the model, not estimated in code.** The hook computes the deterministic budget
  math (how much % is left, at what burn rate) and injects it; the *session* — the only thing that
  actually knows the remaining task — decides whether it fits. Task-aware behavior with **zero
  estimator code** and no brittle task-size heuristics.
- **Everything is denominated in account-% of a window, never tokens.** Measuring against the user's
  own account means the tool **self-adapts across every plan tier** (Pro / Max 5×/10×/20×) with no
  tier table and no token accounting — a percentage is a percentage.
- **The signal is account-wide, so one sensor covers the whole machine.** Because the usage % reflects
  *all* concurrent sessions, burn rate computed from sample deltas already captures every session at
  once. No per-session coordination.
- **Fail-open is the top invariant.** Every error path degrades to silence. The hook never throws,
  never exits non-zero, never writes to stderr. Missing/renamed/stale data → do nothing.

## The engineering: a live-soak bug hunt

The design above is the easy half. The half that makes this a real tool — and the part worth reading —
is what a multi-day live soak surfaced once it was running against a real account. Two bugs, both in
sensor fusion, both invisible to unit tests because they only appear when a *live* API misbehaves:

1. **A fresh timestamp does not mean a fresh value.** Idle Claude Code statuslines re-emit a whole
   **cached** payload — stale % *and* stale reset time — under a brand-new timestamp. Observed live: an
   idle feeder reported 31% while the account was actually at 67%. A "the newest sample wins" fuser
   trusts the stale cache and goes blind. *Fix:* within one reset window utilization can only rise, so
   drop any reading that regresses on append (`burnrate.dropRegressions`).

2. **The reset instant isn't monotonic — and assuming it is blinds you exactly when it matters.** The
   weekly window's `resets_at` can jitter *earlier* between polls (observed 21:00 → 17:00). A natural
   "resets only move forward" rule then classifies every *current* weekly reading as a stale
   pre-reset cache and drops it — so the tool sees nothing at 90%, precisely when a wrap matters most.
   *Fix, and the general lesson:* when fusing a fast-but-cachey source (the statusline) with a
   slow-but-authoritative one (the OAuth usage poll), **trust the authoritative source
   unconditionally** and only sanity-check the cachey one. The OAuth source is never regression-dropped;
   the monotonic/reset checks defend *only* the statusline.

That second bug is the whole reason the fallback OAuth poller exists as the *authoritative* source
rather than a mere backup — and why the [architecture](#how-it-works) treats the two sensors
asymmetrically on purpose. The full write-up, plus the reserve-calibration finding (five wrap-up
rituals back-to-back didn't move the weekly % by a single point), is in [`LESSONS.md`](LESSONS.md).

## How it works

```
statusline stdin JSON (rate_limits: five_hour/seven_day used_percentage + resets_at)
        │
   [1] sensor/statusline.js   appends samples + burn rate to ~/.claude/limit-wrapup/state.json
        │                     (and renders "5h 21% | wk 47%" in the statusline as a bonus)
        ▼
   [2] trigger/check.js       UserPromptSubmit + throttled PreToolUse hook: reads state,
        │                     decides NONE | WARN | WRAPUP (trigger/decide.js, pure),
        │                     latches once per session+window+reset, injects additionalContext.
        │                     Every full check also fire-and-forgets sensor/refresh-oauth.js
        │                     (detached, ≤1 per 180s machine-wide): the AUTHORITATIVE OAuth
        │                     usage poll — covers VS Code / headless sessions the statusline
        │                     never reaches and corrects idle-TUI cached values
        ▼
   [3] skills/wrapping-up     the ritual Claude executes: finish atomic step -> HANDOFF.md ->
        │                     WIP commit on a wip/<date> branch -> (unattended: carry adopt) -> stop
        │                     A WRAPUP also fires a native desktop notification (trigger/notify.js)
        ▼
   [4] resume                 claude -c / carry adopt (continue-after-reset) closes the loop
```

Key facts the design rests on:
- `rate_limits` arrives via **statusline stdin** (interactive TUI only), not hook stdin — so the
  statusline script is the sensor and hooks only read the state file. The **OAuth poll** is what
  reaches the surfaces the statusline can't (VS Code panel, headless `claude -p`).
- The % is **account-wide**, so burn rate from sample deltas captures ALL concurrent sessions, and
  one sensing session covers the whole machine.
- `used_percentage` arrives server-rounded to **integers**; `resets_at` is **epoch seconds** on
  exact hour boundaries. Sub-1% quantities are only measurable cumulatively.
- The fit estimate is **delegated to the model**: the hook injects the budget math; the session
  decides whether the remaining task fits (it's the only thing that knows the task).

## Make it yours

Fork, then change the few fields that make it yours — everything else has a safe default. The config
lives at `~/.claude/limit-wrapup/config.json`; copy [`config.example.json`](config.example.json) there
to start. Editors autocomplete and document every field from [`config.schema.json`](config.schema.json)
(via the `$schema` key). Units are **account-%** of a usage window, never tokens.

| field | default | change it to… |
|---|---|---|
| `mode` | `"warn"` | `"auto"` when running **unattended** — lets the tool actually wrap near the cliff (attended, leave `"warn"`: heads-ups only, you decide) |
| `reserve_pct` | `1.5` (example) | the % you want held back for the wrap-up itself; auto-wrap fires at `(100 − reserve_pct)%` |
| `warn_at` | `[70, 85]` | your heads-up thresholds, or `{ "five_hour": […], "seven_day": […] }` per window |
| `dry_run` | `true` | `false` once the `decisions.log` looks sane — until then it logs decisions but injects nothing |
| `plan` | `"pro"` | your tier (`max_5x` / `max_10x` / `max_20x`) — only affects the reserve fallback until you set `reserve_pct` |

**Safe quickstart (nothing reaches a live session until you opt in):**
1. `node --test test/*.test.js` — confirm the suite is green on your machine.
2. Copy `config.example.json` → `~/.claude/limit-wrapup/config.json` and edit the fields above (keep `dry_run: true`).
3. `node bin/validate-config.js` — checks your config and prints, in plain language, anything the tool would ignore or clamp. (A convenience check only; the runtime itself is fail-open and never blocks on a bad config.)
4. Wire the statusline + hooks (below), use Claude normally, then read `node bin/status.js` and `decisions.log` to see what it *would* have done.
5. Flip `dry_run: false` when you trust it; set `mode: "auto"` only for unattended runs.

The config is the single source of truth — see the full field table under [Config](#config-claudelimit-wrapupconfigjson) below.

## Install (what this machine's `~/.claude/settings.json` wires)

```jsonc
"statusLine": {
  "type": "command",
  "command": "node \"<repo>\\sensor\\statusline.js\"",
  "refreshInterval": 30
},
"hooks": {
  "UserPromptSubmit": [{ "hooks": [
    { "type": "command", "command": "node", "args": ["<repo>\\trigger\\check.js"], "timeout": 10 } ] }],
  "PreToolUse": [{ "matcher": "*", "hooks": [
    { "type": "command", "command": "node", "args": ["<repo>\\trigger\\check.js"], "timeout": 10 } ] }]
}
```

Copy `skills/wrapping-up/` to `~/.claude/skills/wrapping-up/`. The PreToolUse hook is the mid-turn
seam for long agentic turns; internally it full-checks at most once per 60s per session (otherwise
one small file read and exit). Kill-switch: `"enabled": false` in the config below silences the
logic; removing the hooks entries removes the node spawn entirely. Paths are Windows-first in the
examples; the JS itself is portable (uses `os.homedir()`), so a POSIX install swaps the slashes.

## Config (`~/.claude/limit-wrapup/config.json`)

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | master kill-switch |
| `mode` | `"warn"` | `warn` = informational heads-ups only, never forces a wrap (attended); `auto` = also emits a hard WRAPUP directive once a window passes `100 − reserve` (unattended) |
| `warn_at` | `[70, 85]` | heads-up thresholds; flat array applies to both windows, or `{ "five_hour": [...], "seven_day": [...] }` per window |
| `reserve_pct` | `null` | **the wrap-point knob**: auto-wrap fires at `100 − reserve_pct`. Set directly (e.g. `1.5` → wrap at 98.5%). Overrides the measured value below; `null` = use measured × margin. Clamped 0.5–10% |
| `wrapup_cost_measured` | `null` | account-% one ritual costs, from calibration runs; reserve = this × margin (used only when `reserve_pct` is null) |
| `wrapup_reserve_margin` | `2.5` | safety factor over the measured cost (ritual cost scales with context/diff size) |
| `plan` | `"pro"` | picks the reserve fallback until measured: pro 3% / max_5x 2% / max_10x 1.5% / max_20x 1% |
| `dry_run` | `true` | log decisions to `decisions.log`, inject nothing (flip off after the log looks sane) |
| `notify` | `true` | show a native desktop notification when an (unattended) WRAPUP fires, so it's seen — not discovered later as a `wip/` branch. Only on WRAPUP, never on a heads-up; fail-open if there's no toast subsystem |
| `stale_after_min` | `10` | older sensor state = unknown = silent |
| `suppress_warn_if_reset_within_min` | `15` | cheap cliff: reset imminent -> being cut off costs minutes, don't warn/wrap |

Reserve precedence: `reserve_pct` (direct) → `wrapup_cost_measured × wrapup_reserve_margin` → plan
fallback. All quantities are **account-% units**, never tokens.

## Files at runtime (`~/.claude/limit-wrapup/`)

`state.json` (rolling samples + burn), `config.json`, `latches.json` (per-session warn/wrapup
latches + PreToolUse throttle), `decisions.log` (JSONL, 1MB rotation), `raw-sample.json`
(latest raw statusline payload, schema drift canary), `last-invoked.txt` (sensor liveness marker),
`oauth-refresh.txt` (fallback-poll throttle marker).

## Security posture

Small by design: the tool reads *your own* usage data on *your own* machine. The OAuth token is read
from your existing `~/.claude/.credentials.json`, expiry-checked, and sent **only** to
`api.anthropic.com` (hostname hardcoded) — never logged, never to third parties. Zero runtime
dependencies means no supply-chain surface; the "lethal trifecta" (untrusted input + private data +
exfiltration) is broken because there's no untrusted input and no third-party sink. Wrap-up commits
are local-only (never pushed) and respect `.gitignore`. Full details: [SECURITY.md](SECURITY.md).

## Known limitations

- **The statusline is interactive-terminal-TUI-only** (verified 2026-07-05): the VS Code extension
  panel and headless `claude -p` never run it, so they never feed the sensor. Covered by the
  **OAuth usage poll** — every full check spawns `sensor/refresh-oauth.js` (detached, throttled to
  the endpoint's documented-safe 180s; requires the `claude-code/<version>` User-Agent or it 429s;
  token read from `~/.claude/.credentials.json`, expiry-checked, refresh flow out of scope), which
  stores the endpoint's windows verbatim — burnrate's fallback keys extract its `utilization`/ISO
  `resets_at` shape, and reset identity is minute-rounded so mixed statusline+oauth samples pair
  correctly.
- **Idle TUI statuslines re-emit CACHED percentages under fresh timestamps** (verified live
  2026-07-05: idle feeder said 31% while the account was at 67%). Within one reset window
  utilization never decreases, so both sensors drop regressing readings on append
  (`burnrate.dropRegressions`) and the authoritative OAuth poll runs continuously, not only when
  timestamps look stale. An artificial sensing session
  (`Start-Process cmd /c 'claude "..." --model haiku' -WindowStyle Minimized` — `Hidden` suppresses
  the statusline) is therefore only a bonus, not load-bearing.
- Stale/absent data still fails open to silence for THAT check (the fallback poll lands for the
  next one) — wrong warnings would be worse than none.
- `rate_limits` is per-invocation optional and its schema is pinned to CC 2.1.x docs + a real
  capture in `test/samples/`; a rename in a future release degrades to silence, not breakage.

## Test

```
node --test test/*.test.js
```

70 tests, zero dependencies (Node's built-in runner): burn-rate math (reset/gap discarding,
cross-source reset identity), decision engine (thresholds, latching, reserve, auto mode, cheap cliff),
end-to-end hook runs in an isolated `LIMIT_WRAPUP_DIR` (fail-open on garbage, live emit shapes,
throttle, concurrent-process contention, fallback-poll dispatch — network-guarded via
`LIMIT_WRAPUP_NO_NET`), the OAuth sample mapping, the desktop-notification dispatch (WRAPUP notifies,
a heads-up does not), and the config validator.

## Contributing & license

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the non-negotiable invariants
(fail-open, account-% units, zero runtime dependencies, the asymmetric sensor-fusion rule).
Security reports: [SECURITY.md](SECURITY.md). Licensed [MIT](LICENSE).
