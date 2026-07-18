# Open Source Readiness

This checklist tracks what should be true before making the repository public.

## Already In Place

- MIT license.
- Security notes for local state, prompts, reports, and unattended execution.
- Contribution guide.
- Code of conduct.
- GitLab CI for tests and proof artifacts.
- Public proof plan with Mermaid diagrams.
- Architecture diagram and state machine.
- Package metadata in `pyproject.toml`.
- `.gitignore` excludes local run artifacts.
- `.gitattributes` keeps text files stable across platforms.
- GitLab issue and merge request templates.
- GitHub issue and pull request templates for public mirrors or future migration.
- Repository metadata recommendations for GitLab description and topics.
- GitLab project description and topics applied from `docs/repository-metadata.md`.
- Changelog.
- Redacted real Codex JSONL fixture.
- Edge fixtures for rate-limit text and missing usage payloads.
- README badges for pipeline status and MIT license.

## Before Public Release

- Add a screenshot or copied CI artifact excerpt to the README.
- Confirm final package distribution path: plugin only, Python package, npm wrapper, or combined.
- Confirm repository owner/namespace and public issue policy.
- Add badges after the GitLab pipeline exists.
- Tag `v0.1.0` only after the real fixture parser has been checked.

## Public Positioning

Safe claim:

> Codex Nightwatch observes local Codex JSONL events and applies user-defined local thresholds so unattended runs can checkpoint, stop, and resume more predictably.

Avoid claiming:

- exact ChatGPT subscription usage visibility
- exact billing estimates
- official OpenAI affiliation
- fully autonomous recovery without user-defined policy
