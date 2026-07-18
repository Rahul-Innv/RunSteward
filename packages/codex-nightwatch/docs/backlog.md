# Backlog

This backlog is ordered for practical MVP hardening before public release.

## Done

- [x] Create the private GitLab repository and push `main`.
- [x] Capture one tiny real `codex exec --json` fixture.
- [x] Redact the real fixture and add it to tests.
- [x] Confirm parser behavior against normal completion, rate-limit text, and missing usage payloads.
- [x] Add an inactivity timeout in addition to max runtime.
- [x] Add a `fixtures/` directory with multiple Codex JSONL streams.
- [x] Add `doctor` checks for writable state/report directories.
- [x] Add report redaction options for prompts, cwd, and thread ids.
- [x] Add CI badge after GitLab project exists.
- [x] Add a redacted real-run diagram or timeline.
- [x] Add a local supervised run/resume loop that does not depend on heartbeat persistence.
- [x] Rename the outer workspace folder to `Codex Nightwatch` after closing the active Codex workspace.
- [x] Add warnings for state paths outside the project workspace.
- [x] Add integration-style tests for `init -> run dry-run -> record -> report -> resume-command`.
- [x] Add a runtime-artifact hygiene check that warns when `.codex/nightwatch` or other Nightwatch state is untracked in the target product repo and reminds the agent not to commit it.
- [x] Add optional Windows Task Scheduler guidance for launching `supervise`.
- [x] Add a Windows launcher checklist for robust unattended runs: explicit Codex binary resolution, lock ownership, stale-lock/process checks, stderr warning tolerance, UTF-8 log writing, worktree path clarity, and post-run report generation.
- [x] Confirm GitLab CI passes in the private repo for `e36be16`.
- [x] Confirm proof artifact job produces `.nightwatch/proof-report.md`.
- [x] Set GitLab description and topics from `docs/repository-metadata.md`.

## Now

- [ ] Confirm parser behavior against resume output.
- [x] Fix monitored resume argument handling for current Codex CLI: `codex exec resume` accepts `--json`, `-c/--config`, `--model`, etc., but not initial-run-only flags such as `--sandbox`; reject or translate unsupported resume args before launching.
- [x] Treat empty resume JSONL plus non-empty transcript error text as an infrastructure failure with a clear report reason instead of creating ambiguous zero-event resume cycles.
- [ ] Run the Startup Momentum overnight trial from `docs/startup-momentum-overnight-trial.md`.
- [ ] Review the Startup Momentum morning report and confirm whether monitored resume worked.

## MVP Hardening

- [x] Add a `--dry-run` alias or clearer output label for the default `run` mode.
- [x] Split token reporting into raw context size, cached input, uncached input pressure, output, and reasoning so reports do not imply cached input is the same as fresh usage pressure.
- [x] Persist the owner-approved pre-run contract in state and reports: autonomy mode, approval mode, commit policy, push policy, scheduler mode, and explicit resume-after-stop allowance.
- [ ] Add an explicit configurable policy basis for budget decisions: raw advisory tokens versus fresh-pressure tokens.
- [x] Add environment-vs-product blocker classification to reports, including examples such as git metadata permission errors, restricted-network build failures, shell quoting mistakes, and Codex CLI argument errors.
- [ ] Include the latest agent checkpoint in redacted reports without exposing prompts, paths, or thread ids.
- [x] Add a clear wrap-up section with blocker type, changed-file summary, failed command summary, and exact owner-safe next action.

## Plugin Experience

- [ ] Decide whether the first release is CLI-first, plugin-first, or both.
- [ ] Make the skill instructions robust to installed plugin paths instead of assuming the current working directory.
- [ ] Add plugin marketplace metadata only after the private repo path is stable.
- [ ] Validate plugin and skill metadata in an environment with PyYAML available.

## Automation

- [x] Decide the first production path: local `supervise` loop first, Codex/OS schedulers only as launch mechanisms.
- [x] Add a safe scheduler design that never runs broad unattended commands by default.
- [ ] Add a proof that scheduled resume does not resume the wrong session.
- [ ] Add optional Codex app cron guidance once persistence can be verified.
- [ ] Add scheduler audit fixtures covering false-positive process detection, WindowsApps `codex.exe` access denial, git stderr warnings with successful exit, and path quoting failures with parentheses.

## Public Proof

- [ ] Add a generated proof report excerpt to the README.
- [ ] Add a terminal recording or GIF showing the proof flow.
- [ ] Add public issue templates if the GitHub mirror becomes primary.

## Distribution

- [ ] Recheck `codex-nightwatch` availability on npm and PyPI before public release.
- [ ] Choose package distribution: Python package, npm wrapper, Codex plugin, or combined.
- [ ] Add packaging tests.
- [ ] Tag `v0.1.0` only after real fixture validation.

## Later

- [ ] Optional `ccusage` integration for historical baseline estimates.
- [ ] Multi-run queue management.
- [ ] Multi-project overnight run planning.
- [ ] Richer policy language for cost, time, and file-change constraints.
- [ ] Machine-readable report output for dashboards.
