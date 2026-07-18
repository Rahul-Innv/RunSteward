# Changelog

All notable changes to Codex Nightwatch will be documented here.

This project follows a lightweight changelog format until the public release process stabilizes.

## Unreleased

### Added

- MVP CLI for analyzing Codex JSONL events, creating run state, recording events, rendering reports, and generating resume commands.
- Live monitored execution path for `codex exec --json` with explicit `--execute`.
- Safety defaults: dry-run command generation, fail-closed resume, transcript/event log separation, timeout support, and blocked unsafe unattended flags.
- Codex plugin manifest and skill instructions.
- GitLab CI proof pipeline.
- Public proof, architecture, open-source readiness, release checklist, learnings, and backlog docs.

### Known Gaps

- No redacted real Codex JSONL fixture yet.
- No published Python/npm package yet.
- GitLab project topics/description must be set in GitLab project settings or via API.
