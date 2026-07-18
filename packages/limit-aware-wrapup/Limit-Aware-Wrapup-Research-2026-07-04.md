# Limit-Aware Wrap-Up Skill — Research Brief (2026-07-04)

Idea: automatically detect remaining Claude Code usage budget (5-hour / weekly), estimate whether the
CURRENT task fits the remaining budget, and if not, trigger a graceful wrap-up (commit WIP, write
handoff, stop cleanly) instead of being cut off mid-task. Target: "use it and leave it" users.

## Verdict
Real gap. Everything in the ecosystem WATCHES; nothing ACTS before the cliff. The exact feature was
requested of Anthropic and closed "not planned" (anthropics/claude-code#47157), and the enabling data
now exists natively — a build-now seam.

## Landscape (who does what)
- Display/prediction only (no action): ccusage (blocks --live burn-rate projection), Claude Code Usage
  Monitor (~8.3k★, P90 burn-rate extrapolation branded as "ML"), claude-powerline, ccstatusline,
  CCometixLine, ohugonnot/kcchien statuslines, SessionWatcher (macOS menu bar, lockout-risk score).
- Reactive-only action (after the crash): claude-auto-resume (~787★, waits out countdown then resumes,
  uses --dangerously-skip-permissions), claude-autocontinue. No pre-limit wrap-up, can't fix
  inconsistent WIP.
- Handoff tools (thepushkarp/handoff, session-handoff skill): keyed to CONTEXT-WINDOW pressure
  (PreCompact) or manual invocation — not usage-budget depletion.
- Anthropic Task Budgets beta (task-budgets-2026-03-13): the graceful-finish primitive exists at the
  API layer (server-injected token countdown; model prioritizes and finishes gracefully) but docs say
  explicitly "not supported on Claude Code or Cowork surfaces", and it budgets a per-loop developer
  allowance, not subscription quota.

## Prediction gap
Every tool extrapolates consumption velocity (tokens/min, sometimes P90). NONE answers "will THIS task
fit?" — no tool estimates remaining task need from plan/todos/diff scope vs remaining budget. That
task-aware fit estimate is the novel piece (Rahul's core insight: small task → run to 98%; big task →
wrap at lower %; it's a fit calculation, not a fixed threshold).

## Sensing & actuation (feasibility)
- SOLVED sensing: since Claude Code v2.1.x the statusline stdin JSON includes a native `rate_limits`
  object with `five_hour` and `seven_day` utilization % + reset timestamps (see ohugonnot statusline).
  Older fallback: undocumented OAuth endpoint /api/oauth/usage (jtbr gist).
- Actuation via hooks: UserPromptSubmit / Stop / SessionStart hooks can inject `additionalContext`
  ("at 95%, wrap up now"); Stop hook can also block/stop cleanly. No native timer hook — piggyback on
  per-turn events. No native threshold config exists (no `usageWarnAt` in settings.json).
- No OTel per-session token export; transcript JSONL format is explicitly unstable (don't parse).
- Resume side: `claude --resume <id>` after reset; Rahul's carry adopt / continue-after-reset skill
  already covers the after-reset leg → closed loop: predict → wrap up → auto-resume.

## Demand evidence
- #47157 "Auto-pause when approaching usage limit to prevent work loss" — the idea verbatim
  (autoPauseThreshold: 90), closed not-planned/stale. Pain: parallel agents fail mid-write,
  inconsistent state.
- #43149 "Expose API usage limits + reset timer" — "power users running autonomous overnight jobs are
  blindsided... no warning, no graceful shutdown"; closed duplicate.
- #61906 (Max plan interrupts mid-task, unfinished state), #26775 (auto-resume for overnight tasks),
  #5977 ("it has lost context of what it was doing"), #36320, #30341/#30965/#20636 (surface limit %).
- HN 44713757 + follow-ups: weekly-cap anger ("that's it for the entire week").

## Risks
1. HIGHEST: Anthropic graduates Task Budgets to Claude Code and wires it to subscription quota — the
   "not supported" line could flip in one release. Mitigant: they closed #47157/#43149 not-planned;
   nothing announced as of 2026-07.
2. Limits keep loosening (2026-05-06 doubled 5h caps; 2026-05-13 weekly +50% through Jul 13) →
   market narrows to heavy unattended users — but that IS the target segment.
3. Extra Usage pay-as-you-go softens the cliff for those willing to pay.

## What needs building (3 components)
1. SENSOR — statusline script (or hook helper) reading native `rate_limits` from stdin JSON; persist
   samples → burn rate per session.
2. FIT ESTIMATOR (the novel bit) — per-turn hook (UserPromptSubmit/Stop) that asks: remaining budget
   vs estimated remaining task cost (from todo list / plan size / recent per-turn burn × remaining
   steps). Dynamic threshold: small task → allow to ~98%; large task → wrap early.
3. WRAP-UP SKILL + actuator — hook injects additionalContext directive at trigger; skill defines the
   wrap-up ritual: commit WIP to branch, write HANDOFF.md, optionally queue carry adopt for
   auto-resume after reset.

Full agent briefs with all citations were produced 2026-07-04 in-session (claude-code-guide mechanics
brief + web landscape brief); key sources: code.claude.com/docs hooks + statusline + sessions + costs;
github.com/anthropics/claude-code issues above; ccusage.com; Task Budgets doc on platform.claude.com.
