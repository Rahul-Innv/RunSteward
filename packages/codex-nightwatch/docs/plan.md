# Codex Nightwatch Plan

## Product Thesis

Codex users who run long or parallel coding tasks need a local controller that can make unattended work less wasteful. The pain is strongest overnight: the user wants Codex to keep moving, but not burn through usage blindly, lose state, or wait forever after a rate/usage limit.

## Positioning

`ccusage` is the usage meter. Codex Nightwatch should be the usage-aware run controller.

Core promise:

> Tell Codex what to do overnight, and Nightwatch keeps it inside a budget, checkpoints progress, pauses when needed, resumes when sensible, and reports what happened.

## Architecture

Phase 1:

- Use `codex exec --json` as the event source.
- Parse `turn.completed` events and aggregate usage.
- Decide between `continue`, `checkpoint`, and `stop`.
- Persist state to a local JSON file.
- Generate markdown reports.
- Generate resume commands without executing them by default.
- Separate stdout JSONL events from stderr/transcript logs.
- Fail closed if no resume target is known.

Phase 2:

- Wrap `codex exec` in a runner command with dry-run default.
- Monitor JSONL events during execution and terminate Codex when stop policy triggers.
- Capture session/thread identifiers.
- Generate a resume command using `codex exec resume`.
- Add reset-window scheduling guidance.

Phase 3:

- Add Codex plugin hooks or automation prompts where useful.
- Consider integration with `ccusage` for richer historical usage estimates.
- Add a Codex app workflow for setting up overnight runs.

## Safety Rules

- Default to dry-run or command generation before command execution.
- Never change auth, publish packages, or create external repositories.
- Keep writes inside the selected workspace.
- Prefer explicit checkpoints before sleeping or stopping.
- Treat rate-limit text as a stop condition until a parser is proven reliable.
- Keep prompts out of shared reports unless the user accepts the disclosure.
- Block obvious unattended danger flags such as `danger-full-access`.

## Open Decisions

- Final package language: Python is simplest for local parsing; Node may fit npm distribution better.
- Whether to use `ccusage` as an optional dependency or a documented companion.
- Whether the first public release should be a plugin, CLI, or plugin plus CLI.
- Exact semantics for budget thresholds across ChatGPT subscription limits versus API-key billing.
- Whether to execute resume commands directly or hand them to Codex automations.

## MVP Command Surface

- `analyze` - parse a JSONL event stream and print usage plus budget decision.
- `init` - create a local state file for a planned run.
- `run` - print the `codex exec --json` command by default; execute only with `--execute`.
- `record` - update state from a completed run log.
- `resume-command` - print a safe `codex exec resume` command.
- `report` - render a markdown morning report.
- `doctor` - check local prerequisites.
