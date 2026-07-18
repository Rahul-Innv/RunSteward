---
name: wrapping-up
description: >-
  Executes the graceful limit-aware wrap-up ritual: finish the current atomic step, commit WIP to a
  dated wip/ branch, write HANDOFF.md (state, next steps, exact resume command), then stop clean.
  Use whenever a [limit-wrapup] WRAPUP directive appears in context (the hard stop near the usage
  cliff), or when the user says to wrap up the session, they're about to hit their usage/rate limit,
  they're running out of budget/quota, or asks to leave a handoff and stop. A bare [limit-wrapup]
  usage heads-up is INFORMATIONAL and does NOT trigger this — keep working unless it's a WRAPUP
  directive or the user asks. NOT for wrapping code in try/catch or other code "wrapping", and NOT
  for a normal commit/push request without a limit or stop-work motive.
shell: bash
# Model-invocable BY DESIGN despite being side-effecting (it commits): the limit-wrapup hook's
# injected directive must be able to auto-fire this ritual mid-session. The side effect is gated
# in-body (Step 0) instead of via disable-model-invocation, which would strip it from context.
---

!`node "${CLAUDE_SKILL_DIR}/scripts/read-lessons.mjs" 2>/dev/null || cat "${CLAUDE_SKILL_DIR}/LESSONS.md" 2>/dev/null`

# Wrapping up (limit-aware)

Land the session cleanly before the usage budget runs out: consistent code state, WIP committed on a
safe branch, a handoff the next session can resume from in one command. The whole ritual must stay
CHEAP — target well under 0.5% of account budget: no extra file reads beyond this body, no polish
passes, few turns.

## Step 0 — Gate (MUST pass before any side effect)
Proceed only when at least one holds:
- a `[limit-wrapup]` **WRAPUP directive** is present (the hard stop fired near the usage cliff), or
- the user explicitly asked to wrap up / stop and hand off.

A bare `[limit-wrapup]` **usage heads-up** is INFORMATIONAL — it is NOT a trigger. Keep working; do
NOT wrap on a heads-up alone (the owner's policy is to use the budget and let the near-cliff WRAPUP
directive stop the session, not to wrap early on a poor task-fit). Otherwise stop here and handle the
request normally (it is probably a normal commit or code task).

## Step 1 — Finish the current atomic step only
Complete the smallest unit that leaves the code consistent (finish the in-flight edit, make the
half-changed file compile). Start NOTHING new. Skip test runs unless one command is enough to know
the state is green — record "untested" in the handoff instead of spending budget verifying.

## Step 2 — Write HANDOFF.md (repo root, overwrite)
Terse bullets, facts only — this is the file the next session reads first. Fill this template:

```markdown
# HANDOFF — <yyyy-mm-dd hh:mm> (limit-aware wrap-up)

**Task:** <what this session was doing, one line>
**Branch:** <branch the WIP commit lands on>
**Usage at wrap-up:** 5h <n>% / wk <n>%  <!-- from the [limit-wrapup] warning if present -->

## Done this session
- <completed item>

## In flight (state of partial work)
- <file/area>: <exact state, incl. "untested" flags>

## Next steps (ordered — first one precise enough to start cold)
1. <next concrete action>
2. <then>

## Resume
`cd <absolute project dir>` then `claude -c` (or `claude --resume` and pick this session).
<If an unattended run: note the continue-after-reset / carry adopt command instead.>
```

## Step 3 — Commit WIP (fail-open: any git failure -> skip to Step 4, never block)
- Not a git repo -> skip to Step 4 (HANDOFF.md still gets written).
- On `main`/`master`: `git checkout -b wip/<yyyy-mm-dd>-<short-slug>` first. Already on a work
  branch: commit in place. NEVER commit the WIP to main/master, never amend, never push unasked.
- `git add -A` (HANDOFF.md travels in the same commit), then commit:
  `WIP wrap-up: <one-line state> — see HANDOFF.md`

## Step 4 — Queue auto-resume (unattended sessions only; fail-open)
Only when this session is unattended — a WRAPUP directive said "auto mode", the session is a
carry/queued run, or the user said they'll be away. Try, in order, and skip silently on any failure
(the HANDOFF resume command is the fallback):
1. `carry adopt` (adopts THIS session for auto-continue after the limit resets — the
   continue-after-reset flow). If `carry` is not on PATH, skip.
2. Note in HANDOFF.md's Resume section which auto-resume was queued (or that none was).
Attended sessions: skip this step — the user decides when to resume.

## Step 5 — Stop clean
Final message: one short paragraph — what landed, the branch name, "resume with `claude -c`" — then
end the turn. No new work, no "one more quick thing", no offers to continue.

## Anti-patterns
- Wrapping on a bare heads-up — a `[limit-wrapup]` heads-up is INFORMATIONAL, not a stop signal;
  only a WRAPUP directive (or an explicit owner ask) triggers the ritual (see Step 0).
- Starting anything new once the ritual has begun — the WRAPUP directive IS the stop signal for new work.
- Polishing the handoff or running full test suites — the ritual burning the budget it exists to
  protect is the primary failure mode.
- Aborting the ritual because git failed — the handoff is the non-negotiable part; commit is
  best-effort.
- Touching history: amend, rebase, force-push have no place in a wrap-up.

## Improve this skill (feedback loop)
When the user corrects the ritual or states a reusable preference, propose a reviewable diff
appending one entry to `LESSONS.md` (schema inside) — never edit silently. Promote a verified,
high-confidence "rule was ignored" lesson into this body with MUST language. Cross-project
preferences go to Claude Code memory instead.

## Bundled files
- `scripts/read-lessons.mjs` — executable; injects LESSONS.md at invocation (line above the title).
- `evals/evals.json` — the eval set (trigger cases + near-misses). Required.
