# Limit-Aware Wrap-Up — Build Plan (2026-07-05)

Companion to `Limit-Aware-Wrapup-Research-2026-07-04.md` (gap analysis, citations). This is the
how-we-build-it overview, optimized for shortest path to a working thing.

## Goal (one sentence)
When a Claude Code session's remaining usage budget (5-hour / weekly) won't fit the remaining task,
trigger a graceful wrap-up (commit WIP, write handoff, stop clean, optionally queue auto-resume) —
and otherwise stay silent and let small tasks run to ~98%.

## Non-goals (v1)
- No ML / trained estimator. No dashboard UI (monitors already exist). No API-key/token-cost
  accounting (subscription quota only). No public packaging until it works for Rahul daily.

## Design principles
1. **Fail-open, always.** If the usage data is missing/renamed/stale → do nothing. This tool must
   never block or degrade a session. (Same guard-polarity lesson as DL-006: absent data = safe state,
   and here the safe state is "stay silent", not "escalate".)
2. **Warn, don't seize.** Default mode injects a directive Claude follows; it never kills the process.
   Auto-wrap is a config opt-in for unattended runs.
3. **Reserve budget for the wrap-up itself — MEASURED, not guessed.** Committing + writing a handoff
   costs turns. The reserve is calibrated empirically (Phase 3): run the ritual 2–3 times, read the
   before/after delta straight from the sensor's `rate_limits` samples, set
   `reserve = ~2–3× measured cost` as margin. Rahul's prior: one wrap-up ≤ ~0.5%, so the reserve
   likely lands ~1–1.5%, not the 4% first guessed. Note wrap-up cost is not constant — it scales with
   context size and diff size — so calibrate on realistic sessions and keep the margin.
4. **Latch, don't nag.** Fire the wrap-up directive once per session per window; hysteresis so a %
   flicker doesn't re-trigger. Warnings capped (e.g. at 70% and 85% only).
5. **Zero dependencies, cross-platform.** Node single-file scripts (Windows-first — this machine).

## Architecture (3 small parts + 1 skill)

```
statusline stdin JSON (native rate_limits: five_hour/seven_day % + reset)
        │
   [1] SENSOR  — statusline script: extract rate_limits → append sample to
        │        ~/.claude/limit-wrapup/state.json  (also renders % in statusline as a bonus)
        ▼
   [2] TRIGGER — Stop / UserPromptSubmit + THROTTLED PreToolUse hook (unattended turns can run
        │        30+ min with no turn boundary — PreToolUse is the only mid-turn seam; full check
        │        at most every ~60s / N tool calls, otherwise instant no-op on state-file mtime)
        │        → account-level burn rate (deltas; discard pairs spanning a reset)
        │        → decision: NONE | WARN | WRAPUP, weighing remaining %, fit, AND time-to-reset
        │        (85% with reset in 10 min = cheap cliff → don't wrap)
        │        → emit additionalContext with the budget math + directive
        ▼
   [3] WRAP-UP SKILL — defines the ritual Claude executes on WRAPUP:
        │        finish current atomic step → commit WIP to wip/<date> branch →
        │        write HANDOFF.md (state, next steps, exact resume command) → stop clean
        ▼
   [4] RESUME LEG — existing carry adopt / continue-after-reset (already built) —
                 wrap-up optionally queues it → closed loop: predict → wrap → auto-resume
```

Key plumbing fact from research: `rate_limits` arrives via **statusline stdin**, not hook stdin — so
the statusline script is the sensor that persists state; hooks only read the state file. Two scripts,
one state file.

### The fit estimator — v1 is a delegation trick, not a model
Deterministic task-size estimation (parse todos/plans) is brittle (transcript format explicitly
unstable). v1 instead **delegates the task-size half to Claude itself**:

> Hook computes the hard numbers: "Budget: 78% of 5h window used, resets 14:32. Burn rate ≈2.1%/turn
> across all sessions → ~10 turns left. Weekly: 61%." and injects: *"If the remaining work on the
> current task likely exceeds this, begin the wrap-up ritual NOW; if it comfortably fits, continue
> and ignore this."*

The hook owns the budget math (deterministic); the model owns the task estimate (it's the only thing
that actually knows the task). This IS the task-aware behavior — small task runs to 98%, big task
wraps early — with zero estimator code. A deterministic estimator is a v2 refinement, only if v1's
judgment proves unreliable in practice.

## Pinned `rate_limits` schema (2026-07-05, from official docs)
Source: https://code.claude.com/docs/en/statusline (Full JSON schema section), confirmed on CC 2.1.201 docs.
```json
"rate_limits": {
  "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
  "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
}
```
- `used_percentage`: **0–100 decimal** (23.5 = 23.5%). NOT a 0–1 fraction — the sensor's original
  fraction heuristic (`v <= 1 → ×100`) would have misread a real 0.5% as 50% and is now removed.
- `resets_at`: **unix epoch SECONDS** (not ms, not ISO).
- Presence: only for Pro/Max subscribers, only after the first API response in a session; each
  window can be independently absent → extraction stays per-field fail-open.
- Sensor v0's render guess was WRONG (`utilization`/`used_pct`/`percent` — real key is
  `used_percentage`); fixed in sensor + burnrate module. `used_percentage` is primary; old
  candidates kept as low-priority drift fallbacks until a real capture double-confirms.
- **CONFIRMED by real capture 2026-07-05 17:05Z** (CC 2.1.201, live TUI session): field names,
  0–100 scale, epoch-seconds resets all match. Evidence in `test/samples/real-*.json`. Three
  additional facts the docs did NOT say:
  1. `used_percentage` arrived as **integers** (1, 43) in every sample — likely server-rounded.
     Burn-rate deltas therefore move in ≥1% quantization steps: short-span rates are coarse, and
     Phase 2 thresholds must not assume sub-1% precision.
  2. **`rate_limits` is per-invocation optional**, not just per-session: an invocation ~58s into
     the session arrived WITHOUT it (and with zeroed `cost` / null `context_window` fields),
     seconds apart from invocations that had it. Per-field fail-open is mandatory, and validated.
  3. `resets_at` lands on exact hour boundaries.
  Also note: `context_window.used_percentage` (context fill) shares a field NAME with
  `rate_limits.*.used_percentage` (quota) — never grep-match the bare key; always path-qualify.

### Sensor coverage gap (found 2026-07-05, important)
The statusline is **interactive-terminal-TUI-only**. Verified empirically 2026-07-05:
- VS Code extension panel: does NOT execute `statusLine` (anthropics/claude-code#55643, closed
  not-planned).
- Headless `claude -p`: does NOT execute it either — tested live with an unconditional
  invocation marker in the sensor (`last-invoked.txt`, written before any parsing); two `-p`
  runs completed without a single invocation. (A docs-derived claim that headless runs it was
  wrong — original assumption #12 was right after all.)
- Interactive `claude` in ANY terminal — including VS Code's integrated terminal panel — DOES
  run it.
- **Self-capture works**: spawning a console window running `claude "<prompt>" --model haiku`
  (auto-submitted first message) gives the TUI a real ConPTY and the statusline fires — this is
  how the 2026-07-05 capture was made, no human at the keyboard. Candidate mechanism for Phase 3
  reserve calibration and the Phase 5 staleness fallback (test `-WindowStyle Hidden` to make it
  non-intrusive before relying on it).
Consequence: sessions run inside VS Code — Rahul's primary surface — never feed the sensor.
Mitigations, in order: (a) any concurrent/occasional terminal `claude` session keeps account-level
state fresh (quota is account-wide, so ONE sensing session covers all); (b) Phase 5 fallback poll
of the OAuth usage endpoint when state is stale; (c) trigger treats stale state as unknown →
fail-open silence.

## Status (2026-07-05 afternoon, second pass)
- Phase 2 **COMPLETE — live**. Dry-run log reviewed sane: stale path (33/33 decisions correctly
  stale->silent while no TUI session fed the sensor, ages counted right, PreToolUse throttle held
  ~1/min/session), fresh path (the moment a self-capture session freshened state, five concurrent
  sessions flipped to correct below-threshold NONE at 21%/47%). `dry_run: false` flipped 13:37.
- **First live in-conversation warning verified end-to-end** (synthetic 5h=72% state, real burn):
  PreToolUse -> additionalContext rendered in-conversation with %, reset countdown, burn, headroom,
  fit wording. Live latch suppression ALSO verified in production: a second session hit the same
  synthetic state 3s earlier in the staging window and was correctly silenced by its pre-latch.
  Test design kept other sessions safe: synthetic sample used a fake resetId (real+1s) and every
  other known session was pre-latched against that fake id only — genuine warns unaffected.
- **Self-capture spawn recipe pinned**: `Start-Process cmd /c claude "<prompt>" --model haiku`
  `-WindowStyle Hidden` does NOT fire the statusline (claude.exe runs, no invocations — ConPTY
  hidden appears to suppress the TUI loop); **`-WindowStyle Minimized` works**, statusline fires
  within ~30s and an IDLE minimized session keeps delivering fresh account-wide % samples
  (18 samples over ~8 min while doing nothing) — a cheap persistent "sensing session" that covers
  the VS Code gap while it's open.
- **Phase 3 in progress**: `skills/wrapping-up/` authored via authoring-skills (evals-first, 6
  cases incl. 3 near-misses; validate-skill machine checks pass), installed user-level at
  `~/.claude/skills/wrapping-up`. WRAPUP directive wired: `buildWarning` now names the skill.
  34 tests green. **Dogfood run: full pass** — a fresh headless sonnet agent given only the
  synthetic warning invoked the skill and executed the ritual exactly (correct
  `wip/2026-07-05-tokenizer-refactor` off main, template-conform HANDOFF.md with cold-startable
  first step + "untested" flags, HANDOFF in the WIP commit, clean stop, main untouched; details it
  followed exist only in SKILL.md, proving the skill loaded). **First measurement: the whole
  ritual cost <1 integer tick of 5h %** (31% before and after) — consistent with the ≤0.5% prior.
  Precise value needs cumulative runs on a quiet machine (integer quantization + concurrent burn)
  — **queued as carry t6** (5 ritual runs overnight, writes `wrapup_cost_measured` into config).
  Eval status: lightweight tier — set gated well-formed (6 cases); trigger-positive verified live
  by the dogfood run; near-misses argued from the description's explicit exclusions, full
  trigger-rate tier deferred until the skill misfires in practice.
- Headless `-p` note for calibration runs: no statusline (already known), so a concurrent minimized
  feeder session does the sensing; `-p` avoids the new-folder trust dialog that would block a
  spawned TUI in a scratch dir.

## Status (2026-07-05 afternoon, third pass — Phase 5 largely pulled forward)
- **Reserve + auto mode wired into the engine**: `effectiveReserve` (measured × margin, tier
  fallback until calibrated, clamped 0.5–10%), per-window `warn_at`, `mode: auto` -> WRAPUP
  decision once utilization is inside the reserve (latched, cheap-cliff-suppressed), `buildWrapup`
  directive names the skill + auto-resume. Skill gained the unattended auto-resume step
  (`carry adopt`, fail-open). Contention e2e added (concurrent checks; atomic last-writer-wins).
- **OAuth usage poller built and live-verified** (`sensor/refresh-oauth.js`): endpoint
  `GET api.anthropic.com/api/oauth/usage` (Bearer token from `~/.claude/.credentials.json`,
  `anthropic-beta: oauth-2025-04-20`, `User-Agent: claude-code/<version>` REQUIRED or 429; safe at
  180s). Live call returned real data. Response shape: `{five_hour|seven_day: {utilization,
  resets_at: ISO-with-microseconds, *_dollars}, seven_day_opus/sonnet, extra_usage}` — stored
  verbatim; burnrate fallback keys already extract it.
- **Sensor correctness finding (live cross-validation): idle TUI statuslines re-emit CACHED
  percentages under fresh timestamps** — idle feeder reported 5h=31% while the endpoint (and a
  freshly spawned TUI) said 65–67%. Fresh `ts` ≠ fresh VALUE: this masked staleness detection and
  would flatten/spike burn rates. Fixes: (1) reset identity minute-rounded (epoch-seconds vs
  ISO-with-jitter forms of the same reset now compare equal — also required for latch suppression
  across sources); (2) `dropRegressions` in both sensors — within a reset window utilization never
  decreases, lower readings are stale cache and are dropped; (3) the OAuth poll runs on EVERY full
  check (180s marker throttle), making it the authoritative source and demoting the statusline to
  an opportunistic fast path. 51 tests green. README written.
- Remaining now: t6 overnight calibration lands `wrapup_cost_measured`; Phase 4 wording soak on
  real sessions (account was at 5h=67% during this session — a genuine 70% warning is imminent);
  future: statusline `warning` render at high %, packaging/publish decision.

## Status (2026-07-06 morning — first full day of live soak: milestone + 2 bugs)
- **Phase 4 milestone hit ON REAL DATA, unprompted.** Over ~24h of 5+ concurrent sessions, weekly
  usage climbed 47% -> 79%. When weekly crossed 70% (~21:39 on 07-05) the tool fired genuine
  warnings into multiple real sessions (Startup Momentum, Laptop tracker, +2), each latched once;
  5h crossed 70% again late evening; weekly at 78% fired into this session this morning. 24 live
  WARN firings, all correctly one-per-threshold-per-session. The predict-and-warn loop works.
- **Bug A (sensor, FIXED): idle statuslines poison state ACROSS a reset.** An idle TUI re-emits its
  whole cached payload — stale util AND stale `resets_at` — so after a 5h reset (67%->3%) the
  cached 67% cites the OLD reset instant and slipped past the same-id `dropRegressions` check;
  state.json read 5h=67% when truth was 3% (cross-checked against the oauth endpoint). Fix:
  `dropRegressions` now anchors on reset-instant monotonicity (a reading citing an older reset than
  one already seen is stale) via a maxima-based `windowBaseline` (robust to an already-polluted
  history). Polluted 300-sample state reset to a single authoritative oauth seed; verified live that
  idle stale-67 writes are now dropped, state holds at truth (5h=7%/wk=79%). 52 tests green.
  Also surfaced: the "~1h headroom / 22%/h weekly burn" in a warning was an artifact of the polluted
  samples; true weekly burn averaged ~1.6%/h — burn figures are trustworthy again post-fix.
- **Bug B (tooling, FIXED): calibration never ran.** Claude Carry's project folder was renamed
  Autopilot -> "Claude Carry"; the npm global symlink still pointed at the vanished old path, so
  `carry` crashed (MODULE_NOT_FOUND) and — separately — Carry isn't a daemon, so nothing invoked
  `carry run` overnight. t6 sat `pending`. Re-linked (`npm link` from the renamed folder); `carry
  status` works, t6 intact. `wrapup_cost_measured` still null -> reserve still on the 3% Pro-tier
  fallback (as the warnings' "3% earmarked" shows).
- Remaining to "done": run t6 on an IDLE machine (concurrent burn invalidates a ~0.5% measurement),
  then one `mode:auto` overnight for the auto-wrap -> auto-resume end-to-end.

## Status (2026-07-06 evening — reserve CALIBRATED; ritual validated 5/5 headless)
- **Calibration done (Phase 3 reserve).** Ran the wrap-up ritual 5x back-to-back on fresh dirty
  scratch repos on a verified-idle machine (all Claude sessions quiet; Codex ignored — different
  quota meter), reading 5h% straight from the OAuth endpoint (no feeder needed). Result: **5h flat
  at 6% across all 5 runs — delta 0, i.e. 5 full rituals did not move the 5h window a single integer
  point.** Per-ritual cost is below the 1% quantization floor (<0.2% on small repos). Set
  `wrapup_cost_measured: 0.5` (Rahul's prior, deliberately anchored ABOVE the toy-repo floor because
  real wraps scale with context+diff size, per principle 3) x `margin 2.5` -> **effective reserve
  1.25%** (was the 3% Pro fallback). Auto-mode WRAPUP now fires at 98.75% of a window. Matches the
  plan's predicted 1-1.5% landing.
- **Ritual validated 5/5 in headless/unattended mode** — every run produced a real
  `wip/2026-07-06-tokenizer-refactor` branch + HANDOFF.md + WIP commit off a base commit, entirely
  via `claude -p` with the injected warning (the wrapping-up skill self-invoked and executed
  correctly each time). This is the strongest ritual-correctness evidence yet: it's the Phase 3
  "clean commit + handoff + stop" acceptance, proven 5x unattended.
- **Operational finding: the calibration meta-task can't run under Claude Carry's unattended
  guardrails.** Queued as t6, Carry parked it (needs-approval) after ~8 min ($1.13) because
  don't-ask mode blocks process-spawning (the feeder) and git/file ops OUTSIDE the project dir
  (scratch repos in %TEMP%, reading ~/.claude/limit-wrapup). Correct behaviour by Carry; wrong
  vehicle for this task. Ran it directly instead (full tool access, OAuth for sensing). t6 removed
  from the queue.
- **Reserve-currency insight (measured):** the ritual burns the 5h window, and the same absolute
  tokens are a far smaller % of the 7-day window — so wrap-ups are cheap in weekly terms. Confirmed
  live: t6's partial run moved 5h ~1% but weekly 0%.
- Remaining to "done": ONE `mode:auto` (or low-threshold warn) overnight that actually wraps a real
  in-progress session and auto-resumes — staged as carry **t7** (Verando landing). NB weekly hit 85%
  today (resets 07-11) so t7 as-queued would warn+wrap almost immediately; raise the weekly threshold
  or defer t7 to post-reset if real landing progress (not just loop-validation) is wanted.

## Status (2026-07-05 evening — superseded by second pass above)
- Phase 0 ✅ (schema pinned + real capture), Phase 1 ✅ (burn rate, 13 tests) — committed 6e63a90.
- Phase 2 built and live-verified: `trigger/decide.js` (pure engine) + `trigger/check.js` (hook,
  latching, 60s PreToolUse throttle, dry-run JSONL log w/ 1MB rotation), 20 more tests (33 total).
  Hooks wired in global settings (UserPromptSubmit + PreToolUse, exec form, 10s timeout);
  `config.json` created with `dry_run: true`. First live firing observed same-session: correctly
  judged stale state -> NONE -> silent.
- Phase 2 remaining: soak the dry-run log over a real day of work, sanity-check decisions, then
  flip `dry_run: false` to see the first in-conversation warning.
- Note: PreToolUse hook spawns node on every tool call machine-wide (~50-150ms, throttled to a
  single small file read internally). If ever unwanted: `enabled: false` in config.json silences
  the logic; removing the hooks entry in settings.json removes the spawn entirely.

## Phases (effort in working sessions; MVP lands after Phase 2)

| # | Phase | What | Done when | Effort |
|---|-------|------|-----------|--------|
| 0 | Spike | On THIS machine, capture a real statusline stdin payload; confirm `rate_limits` fields + shape on current CC version; freeze state-file schema | Real JSON sample saved in repo | 0.5 |
| 1 | Sensor | Statusline script → state.json (rolling samples, atomic writes); burn-rate calc; synthetic-sample unit tests | Burn rate correct on synthetic + live data | 0.5–1 |
| 2 | Trigger (MVP) | Hook script: thresholds config, WARN injections (70/85%), latching, dry-run mode that only logs decisions | Live session shows warning in-conversation; dry-run log sane over a real day | 1 |
| 3 | Wrap-up skill | Author via authoring-skills; the ritual (WIP branch, HANDOFF.md format, resume command); WRAPUP directive wired; **reserve calibration**: force the ritual 2–3× on realistic sessions, measure %-delta from sensor samples, write `wrapup_cost_measured` into config | Clean commit + handoff + stop; reserve set from ≥2 measured runs | 1 |
| 4 | Fit v1 | The delegation injection (budget math + fit question); tune wording so small tasks aren't spooked into wrapping early | 2 real big-task + 2 small-task sessions behave correctly | 0.5 |
| 5 | Harden + close loop | Queue carry adopt on wrap-up; multi-session contention test (two terminals); fail-open audit (kill state file mid-run → silence); README | Overnight unattended run wraps + auto-resumes end-to-end | 1 |

**Total: ~4.5–5 sessions. Usable MVP (in-conversation budget awareness) after ~2.**
Later/optional: deterministic estimator, plugin packaging, publish (real gap → shareable).

## Things we had NOT yet considered (now folded into the design)
1. **Multi-session drain.** Other terminals / background agents / cloud agents burn the SAME quota.
   A session-local burn estimate lies. Fix: burn rate from account-level `rate_limits` deltas (the %
   itself is account-wide) — that's why the sensor tracks deltas, not per-session tokens.
2. **Two cliffs, different stakes.** 5-hour limit = hours of pain; weekly limit = days. Thresholds
   must differ (be far more conservative near the weekly cliff); decision takes min-safety over both.
3. **The wrap-up costs budget.** Without a reserve, a 98% trigger can't finish its own ritual →
   measured `wrapup_reserve` (principle 3).
3b. **Plan tiers differ (Pro / Max 5x / Max 10x / Max 20x).** The same wrap-up token count is a
   different % of quota on each plan — hardcoded token thresholds would be wrong on 3 of 4 tiers.
   Resolution: denominate EVERYTHING in the account's own `rate_limits` % (burn rate, reserve,
   thresholds) — measurement on the user's account self-adapts to their tier, no tier table needed.
   Tier only matters for pre-calibration DEFAULTS: until the reserve is measured, use a conservative
   fallback sized for Pro (smallest quota → largest % per wrap-up); optional `plan` config key just
   picks the fallback, calibration overrides it.
4. **Nagging is a real failure mode.** Injecting every turn wastes tokens and degrades the model's
   focus → latch + capped warnings (principle 4).
5. **False-positive cost is asymmetric.** Wrapping 30 min early wastes a little budget; NOT wrapping
   loses hours of unattended progress. Bias the fit question toward wrapping when genuinely unsure —
   but only past the warn thresholds.
6. **Version fragility.** `rate_limits` is v2.1.x+ and undocumented-ish; could rename any release →
   fail-open (principle 1) + Phase-0 spike pins the current shape.
7. **Testing without burning limits.** Synthetic state-file injection + dry-run mode (Phase 2) — never
   test by actually draining the week.
8. **Attended vs unattended modes.** Attended users may want warn-only (they decide); unattended runs
   want auto-wrap. Config `mode: warn | auto`, default warn.
9. **Kill-switch.** `enabled: false` per project or globally — one config key, checked first.
10. **If Anthropic ships Task Budgets on Claude Code** → sensor/trigger become redundant; wrap-up
    ritual + carry loop remain valuable. Thin layers = graceful obsolescence.
11. **Long agentic turns starve turn-boundary hooks.** The target user's sessions have FEW turn
    boundaries — one autonomous turn can burn budget for 30+ min before Stop ever fires → throttled
    PreToolUse check (see architecture). Throttle keeps per-tool-call overhead ~zero.
12. **Statusline is interactive-TUI-only** (verified empirically 2026-07-05): neither headless
    `claude -p` NOR the VS Code extension panel executes it (#55643 closed not-planned) — and
    VS Code is the primary surface here. v1: stale state = unknown = fail-open silence. Phase 5:
    fallback poll of the OAuth usage endpoint (jtbr gist) only when state is stale. See "Sensor
    coverage gap" above.
13. **Reset proximity changes the stakes.** Cliff cost = time until reset, not a constant. At 85%
    with the 5h reset 10 min away, being cut off costs 10 min — don't wrap. Decision weighs
    time-to-reset; burn-rate calc discards sample pairs spanning a reset (negative deltas).
14. **Extra Usage (pay-as-you-go) softens the cliff** into spend instead of a stop → optional
    "warn on projected spend" mode; default assumes hard cliff.

## Config sketch (`~/.claude/limit-wrapup/config.json`)
```json
{
  "enabled": true,
  "mode": "warn",
  "plan": "max_20x",
  "warn_at": [70, 85],
  "wrapup_cost_measured": null,
  "wrapup_reserve_margin": 2.5,
  "fallback_reserve_pct": { "pro": 3, "max_5x": 2, "max_10x": 1.5, "max_20x": 1 },
  "weekly_conservatism": 2.0,
  "dry_run": false
}
```
Effective reserve = `wrapup_cost_measured × wrapup_reserve_margin` once calibrated (Phase 3);
until then the tier fallback applies. All quantities are account-% units, never raw tokens.

## Repo layout (this folder becomes the repo)
```
limit-aware-wrapup/
  sensor/statusline.js      # [1] reads stdin, writes state.json, renders %
  trigger/check.js          # [2] hook: decision + additionalContext
  skills/wrapping-up/SKILL.md  # [3] the ritual
  test/samples/*.json       # synthetic payloads
  README.md
```

## Immediate next step
Phase 0 spike (~30 min): wire a passthrough statusline script, capture one real payload, pin the
`rate_limits` schema. Everything else keys off that sample.
