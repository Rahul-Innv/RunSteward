# Codex Nightwatch

[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Codex Nightwatch is a local, usage-aware controller for unattended Codex runs.

The differentiated wedge is not another token dashboard. `ccusage` already covers usage visibility well, including Codex local usage reports. Nightwatch is aimed at the next layer: deciding when an unattended run should checkpoint, stop, resume later, and leave a morning report.

Nightwatch observes local `codex exec --json` events and applies user-defined local thresholds. Token totals are advisory; they are not a billing statement and do not claim exact visibility into ChatGPT subscription limits.

## Public Proof

This repo includes reproducible proof artifacts:

- Unit tests for parsing, budget decisions, checkpoint idempotency, monitored subprocess behavior, fail-closed resume, and unsafe-flag blocking.
- A sample Codex JSONL fixture at `tests/sample_codex_events.jsonl`.
- A redacted real Codex JSONL fixture at `tests/fixtures/real_codex_minimal.redacted.jsonl`.
- Edge fixtures for rate-limit text and missing usage payloads under `tests/fixtures/`.
- A GitLab CI pipeline that runs tests and creates a proof report artifact.
- Architecture and proof diagrams in [docs/architecture.md](docs/architecture.md) and [docs/public-proof.md](docs/public-proof.md).
- Open-source readiness tracking in [docs/open-source-readiness.md](docs/open-source-readiness.md) and [docs/release-checklist.md](docs/release-checklist.md).
- Repository metadata recommendations in [docs/repository-metadata.md](docs/repository-metadata.md).
- Project memory in [docs/learnings.md](docs/learnings.md) and [docs/backlog.md](docs/backlog.md).

## Name Decision

Current name: `codex-nightwatch`.

Why:

- `codex-orchestrator` is already taken on npm and PyPI.
- `codex-nightwatch` was not found on npm or PyPI during the July 6, 2026 check.
- The name is narrower and more memorable for the overnight-run use case.
- It sounds like an independent utility, not an official OpenAI product.

The outer workspace folder can be renamed later, but the project folder and package metadata now use `codex-nightwatch`.

## MVP Scope

Implemented MVP:

- Parse `codex exec --json` event streams and extract `turn.completed.usage`.
- Apply local budget policy thresholds.
- Write a checkpoint state file with thread/session metadata.
- Generate a safe `codex exec resume` command after a configured reset window.
- Produce a concise markdown run report.
- Build a dry-run `codex exec --json` command before executing anything.
- When `--execute` is explicitly used, monitor JSON events while Codex runs and terminate when the stop policy triggers.
- Execute monitored resume cycles with `resume-run`.
- Run multiple supervised initial/resume cycles with `supervise`.
- Terminate quiet runs with an inactivity timeout when configured.
- Resolve the user-local Codex binary on Windows when the `codex` command points at a blocked WindowsApps shim.
- Keep machine JSONL events separate from stderr/transcript logs.
- Fail closed when no thread/session id is known, unless `--allow-last` is explicitly passed.
- Refuse obviously unsafe unattended Codex args such as `danger-full-access`.
- Render reports with optional redaction for paths, prompts, and thread ids.
- Run a `doctor` check for Codex availability and writable state directories.

Out of scope for the first pass:

- Publishing to npm, PyPI, or a plugin marketplace.
- Moving or renaming the active workspace folder.
- Changing Codex account/auth settings.
- Running unattended destructive commands.
- Automatically scheduling the next wake-up. For now, the MVP prints the resume command.

## Quick Start

Analyze an existing Codex JSONL event stream:

```bash
python scripts/nightwatch.py analyze \
  --jsonl tests/sample_codex_events.jsonl \
  --token-budget 5000 \
  --reserve-tokens 1000
```

Create a local state file for an unattended run:

```bash
python scripts/nightwatch.py init \
  --state .nightwatch/demo-state.json \
  --objective "Build the MVP overnight" \
  --prompt "Continue building the Codex Nightwatch MVP. Stop before risky changes." \
  --token-budget 100000 \
  --reserve-tokens 15000 \
  --reset-after-minutes 360
```

Print the Codex command without running it:

```bash
python scripts/nightwatch.py run --state .nightwatch/demo-state.json
```

Actually run Codex with live monitoring and a timeout:

```bash
python scripts/nightwatch.py run \
  --state .nightwatch/demo-state.json \
  --jsonl .nightwatch/demo-events.jsonl \
  --transcript .nightwatch/demo-transcript.log \
  --timeout-seconds 21600 \
  --inactivity-timeout-seconds 900 \
  --execute
```

If your shell resolves `codex` to a blocked WindowsApps shim, Nightwatch will try the user-local Codex binary under `AppData/Local/OpenAI/Codex/bin` on Windows. You can also pass an explicit binary:

```bash
python scripts/nightwatch.py run \
  --state .nightwatch/demo-state.json \
  --codex-bin "C:/Users/you/AppData/Local/OpenAI/Codex/bin/<version>/codex.exe"
```

After a run, record the JSONL output:

```bash
python scripts/nightwatch.py record \
  --state .nightwatch/demo-state.json \
  --jsonl .nightwatch/demo-state.jsonl
```

Generate the morning report:

```bash
python scripts/nightwatch.py report \
  --state .nightwatch/demo-state.json \
  --output .nightwatch/demo-report.md
```

Generate a share-safer report:

```bash
python scripts/nightwatch.py report \
  --state .nightwatch/demo-state.json \
  --redact-prompts \
  --redact-paths \
  --redact-thread-ids
```

Print the resume command:

```bash
python scripts/nightwatch.py resume-command --state .nightwatch/demo-state.json
```

Print the monitored resume command, keeping JSONL monitoring enabled:

```bash
python scripts/nightwatch.py resume-run --state .nightwatch/demo-state.json
```

Run a supervised overnight loop. By default, `supervise` resumes after checkpoint decisions but treats stop decisions as terminal. Use `--resume-after-stop` only when you explicitly want to resume after a stop threshold or stop signal.

```bash
python scripts/nightwatch.py supervise \
  --state .nightwatch/demo-state.json \
  --log-dir .nightwatch/demo-logs \
  --max-cycles 3 \
  --timeout-seconds 21600 \
  --inactivity-timeout-seconds 1800 \
  --codex-arg=--sandbox \
  --codex-arg=workspace-write \
  --execute
```

If no thread id was captured, `resume-command` fails closed. Use `--allow-last` only when you explicitly accept the risk of resuming the most recent Codex session:

```bash
python scripts/nightwatch.py resume-command --state .nightwatch/demo-state.json --allow-last
```

Check local prerequisites:

```bash
python scripts/nightwatch.py doctor
```

`doctor` also reports state-path placement and warns when Nightwatch runtime artifacts such as `.codex/nightwatch` are untracked in the target repo.

## Safety Notes

- Token totals are advisory. They are useful for local policy thresholds but do not perfectly model ChatGPT subscription limits, cached-token economics, or API billing.
- State and reports may contain prompts, cwd paths, thread ids, and resume commands. Do not include secrets in prompts, and do not share reports without reviewing them.
- `run --execute` is intentionally opt-in. The default `run` mode only prints the command.

## Current Layout

- `.codex-plugin/plugin.json` - Codex plugin manifest.
- `skills/codex-nightwatch/SKILL.md` - Agent workflow instructions.
- `scripts/nightwatch.py` - Deterministic local parsing, policy, state, report, and dry-run command helper.
- `tests/test_nightwatch.py` - Unit tests for parser, budget policy, monitoring, redaction, and fixtures.
- `tests/fixtures/` - redacted real Codex JSONL and edge-case streams.
- `.gitlab-ci.yml` - private/public GitLab CI proof pipeline.
- `docs/architecture.md` - architecture and state diagrams.
- `docs/public-proof.md` - public proof checklist and CI proof flow.
- `docs/windows-task-scheduler.md` - Windows Task Scheduler launch checklist.
- `docs/startup-momentum-overnight-trial.md` - first real supervised overnight trial plan.
- `docs/open-source-readiness.md` - checklist for public release.
- `docs/release-checklist.md` - private MVP and public release gates.
- `docs/repository-metadata.md` - GitLab description, topics, tagline, and badges.
- `docs/learnings.md` - durable decisions and lessons from the build.
- `docs/backlog.md` - prioritized remaining work.
- `CHANGELOG.md` - release notes and known gaps.
- `.gitlab/` - GitLab issue and merge request templates.
- `.github/` - GitHub issue/PR templates and CI for public mirrors.
- `CONTRIBUTING.md` - contribution guidelines.
- `CODE_OF_CONDUCT.md` - lightweight conduct expectations.
- `SECURITY.md` - local security and sharing guidance.

## Next Build Steps

1. Confirm the private GitLab CI pipeline passes and save a proof artifact excerpt.
2. Add automatic scheduler integration once the safe run loop is proven.
3. Add optional `ccusage` import for historical baseline estimates.
4. Add a packaging layer: Python package, npm wrapper, or both.
5. Add plugin marketplace metadata when the public distribution path is confirmed.
