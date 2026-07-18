# Learnings

This document captures product, implementation, and workflow lessons from building the Codex Nightwatch MVP.

## Product Learnings

- The opportunity is not generic token visibility. `ccusage` already has strong traction and supports Codex local usage reports.
- The differentiated wedge is usage-aware orchestration: checkpoint, stop, resume, and report for unattended Codex runs.
- `codex-nightwatch` is a better fit than `codex-orchestrator` because it is narrower, clearer, and available on npm/PyPI as of the July 6, 2026 check.
- `codex-orchestrator` is already taken on npm and PyPI.
- Public proof matters. A credible public repo needs reproducible artifacts, not just claims about an overnight run.

## Technical Learnings

- `codex exec --json` is the right MVP event source because it exposes machine-readable turn events and usage summaries.
- JSONL events must stay separate from stderr/transcript output. Mixing them makes parsers brittle.
- On Windows, `codex` may resolve to a WindowsApps shim that subprocesses cannot execute. The runner should prefer a working user-local Codex binary or accept an explicit `--codex-bin`.
- `codex exec resume` has a different option surface than initial `codex exec`: `--sandbox` is accepted for initial runs but rejected by resume. Resume-specific args need their own validation and/or config translation instead of blindly mirroring initial-run flags.
- Empty JSONL resume logs are not always "no work"; if stderr contains a CLI usage error, the report should classify it as an infrastructure failure and preserve the actionable error.
- Resume must fail closed when no thread/session id is known. Falling back to `--last` can resume the wrong session.
- Overnight runs need a persisted pre-run contract, not only a prompt convention. Autonomy, approval, commit, push, scheduler, and resume-after-stop choices should be stored in state and repeated in the morning report.
- Live monitoring is necessary for the product promise. Post-run analysis alone does not satisfy "pause near limits."
- Token totals should be described as advisory. They do not exactly represent ChatGPT subscription limits, cached-token economics, or API billing.
- Cached input can dominate Codex usage summaries on large repos. Reports should separate raw context size from likely fresh budget pressure so owners do not overread cached tokens as equivalent spend or immediate limit risk.
- The core CLI can stay stdlib-only for now, which keeps installation and CI simple.
- Real Codex CLI startup can emit local plugin and cache paths to stderr. Raw transcript logs should stay ignored unless explicitly reviewed and redacted.
- Runtime path checks should warn without failing closed. Operators may intentionally place Nightwatch state outside the target workspace, but the report path needs to be explicit before an unattended run starts.

## Safety Learnings

- Default behavior should print commands rather than execute unattended work.
- `--execute` should be explicit.
- `--dry-run` should also be explicit for operator clarity, and it should override `--execute` when both are provided so previews fail closed.
- Obvious bypass/full-access flags should be blocked in unattended MVP paths.
- Nightwatch runtime directories inside target repos, such as `.codex/nightwatch`, are local state and should remain uncommitted unless a user explicitly asks to preserve an artifact.
- A hygiene check should call out untracked `.codex/nightwatch` or `.nightwatch` artifacts in target repos and remind the agent not to commit them by accident.
- Reports and state files may contain prompts, local paths, thread ids, and resume commands. They are not automatically share-safe.
- Real Codex fixtures must be redacted before becoming public test data.
- Redaction should cover thread ids, local paths, prompts, and resume commands. JSONL fixtures can be safer than transcript logs because they contain fewer local environment details.

## Workflow Learnings

- The scheduled heartbeat automation did not fire or did not execute work in the original overnight attempt. Do not depend on automation until the run can prove its wake-up path.
- Folder rename failed while the Codex workspace was open because Windows locked the directory.
- GitLab upload needs either an existing remote repo or a visible GitLab CLI/token. Plain Git can push once the private GitLab project exists.
- GitLab project access tokens may return `404 Not Found` for path-based private project API lookups; searching membership or using the numeric project id can still work. For `codex-nightwatch`, the verified project id is `84157552`.
- This Codex shell sees Git and Git Credential Manager, but not `glab`.
- Git may require a one-command `safe.directory` override because the repo was created by the Codex sandbox user.
- A stale Git Credential Manager entry can block GitLab pushes even when the browser is authenticated. Clearing the GitLab credential lets Git prompt for or reuse the correct account.
- The July 8 Lentova trial proved Nightwatch can preserve target-repo safety under messy conditions: it left product code uncommitted when git metadata writes failed, did not add `.codex/nightwatch`, and stopped before unrelated S7/B16 work.
- The same trial showed the morning report is too sparse for non-expert recovery when redacted: it needs product outcome, environment blockers, failed commands, and a practical safe next step, not only token totals and checkpoint timestamps.
- A good morning report should start with a wrap-up: outcome, blocker type, safe next action, changed files observed, and failed commands observed.
- Windows Task Scheduler launches should use explicit Python and Codex binary paths, a correct **Start in** workspace, bounded timeouts, and a post-run report check instead of assuming an interactive Codex window can be monitored.
- Build failures caused by sandboxed network access, such as `next/font` fetching Google Fonts, should be classified as environment blockers rather than product-code failures.
- Git metadata permission failures in worktrees, such as inability to create `.git/worktrees/.../index.lock`, should be reported as commit/staging blockers and kept separate from implementation correctness.

## Public Release Learnings

- Public positioning should avoid implying official OpenAI ownership.
- The safe claim is that Nightwatch observes local Codex JSONL events and applies local user-defined thresholds.
- A public proof should include tests, CI artifacts, diagrams, and a redacted real Codex JSONL fixture.
- Private GitLab CI passed for `e36be16` in pipeline `2662514605`; `test` and `proof_demo` succeeded, and the proof artifact contained `.nightwatch/proof-report.md` plus `.nightwatch/proof-state.json`.
- The first public tag should wait until distribution path and public proof excerpt decisions are complete.
