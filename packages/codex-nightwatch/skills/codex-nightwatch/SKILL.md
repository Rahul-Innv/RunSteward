---
name: codex-nightwatch
description: Use when planning or running unattended Codex work that should respect usage budgets, checkpoint progress, pause near limits, resume later, or produce overnight run reports. Use for Codex usage-aware orchestration, not for generic task planning or one-off token counting.
---

# Codex Nightwatch

Use this skill to make unattended Codex work explicit and recoverable.

## Workflow

1. Identify the task, workspace, safety constraints, and acceptable autonomy.
2. Ask or confirm the pre-run contract before scheduling unattended work:
   - autonomy mode: fully autonomous, conservative/checkpoint-only, or audit-only
   - whether Codex may ask for tool approvals while the owner is away
   - whether commits are allowed, and whether pushes are allowed
   - which checks are required before a commit or handoff
   - whether resume after a stop is allowed, or only after a checkpoint
   - whether OS scheduling, Codex app automation, or both should be used
   - what should count as an environment blocker versus a product-code failure
3. Define a budget policy:
   - total token budget
   - checkpoint threshold
   - stop threshold
   - reset or resume window
4. Prefer `codex exec --json` for machine-readable run events.
5. Parse `turn.completed.usage` events with `scripts/nightwatch.py`.
6. Before pausing or stopping, write a checkpoint summary with:
   - objective
   - current status
   - session or thread id when available
   - changed files
   - next resume prompt
7. Prefer `resume-command` to generate the next command. Execute it only when the user has allowed unattended continuation.
8. End every unattended run with a concise report and a clear wrap-up: outcome, blocker type, changed files observed, failed commands observed, owner-safe next action, budget used, and resume guidance.

## Pre-Run Questions

Use these when the user's intent is not already explicit:

1. Should this run be fully autonomous, or should it stop at the first commit, push, migration, network, credential, or owner-decision point?
2. May the agent request approvals while the owner is away, or should it stop and report instead?
3. Is `--resume-after-stop` allowed, or should stop decisions be terminal until the owner reviews the report?
4. Should runtime artifacts be placed inside the target repo under an ignored folder, or outside the repo?
5. What exact work is in scope, and what work must not start even if the first slice finishes?

## Wrap-Up Expectations

A Nightwatch report should make the next morning decision obvious before the owner reads raw logs. Include:

- outcome: stopped safely, checkpoint ready, or no stop needed
- blocker type: usage limit, budget policy, timeout, launcher, environment, project validation, or unknown
- safe next action: whether to resume, fix environment first, or review manually
- changed files observed and failed commands observed when available
- evidence paths for JSONL and transcript logs, redacted when requested

## Guardrails

- Do not publish packages, create external repositories, change authentication, or move the active workspace unless the user explicitly asks.
- Keep destructive actions and broad filesystem changes out of unattended runs.
- Treat uncertain usage or rate-limit parsing as a reason to checkpoint and stop.
- Prefer generating a resume command over executing it until the runner has been tested.
- Do not use `danger-full-access`, bypass flags, or `approval_policy=never` for unattended MVP runs.
- Do not blindly mirror initial `codex exec` flags into `codex exec resume`; resume supports a narrower option surface.
- If a resume command emits no JSONL events and only a CLI error transcript, treat that as an infrastructure failure and stop.
- Keep Nightwatch runtime files out of product commits unless explicitly requested.
- Remind users that state and reports can contain prompts, cwd paths, thread ids, and resume commands.

## Window And Scheduler Notes

Nightwatch launched from Windows Task Scheduler or a detached PowerShell process cannot safely keep using an already-open interactive Codex window. It starts a separate `codex exec --json` process so stdout JSONL can be monitored, logged, and stopped. If the user wants continuity with an existing interactive session, use an explicit session/thread id through `codex exec resume`; do not rely on the visible app window.

## Helper Script

Use the local helper for deterministic parsing and policy decisions:

```bash
python scripts/nightwatch.py analyze --jsonl codex-run.jsonl --token-budget 100000 --reserve-tokens 15000
```

Create state and generate a dry-run command:

```bash
python scripts/nightwatch.py init --state .nightwatch/run.json --objective "Overnight MVP" --prompt "Build the MVP safely" --token-budget 100000
python scripts/nightwatch.py run --state .nightwatch/run.json
```

Update state and report after a run:

```bash
python scripts/nightwatch.py record --state .nightwatch/run.json --jsonl .nightwatch/run.jsonl
python scripts/nightwatch.py report --state .nightwatch/run.json --output .nightwatch/report.md
```

Run local prerequisite checks:

```bash
python scripts/nightwatch.py doctor
```
