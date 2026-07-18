# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- README badges (CI/license/node), an architecture diagram, a "Proven in the real world" section,
  a demo slot, real-name attribution, and `ROADMAP.md`.
- `repository`, `homepage`, and `bugs` metadata in `package.json`.
- A demo graphic (`demo.svg`), a logo (`logo.svg`), and npm-publish readiness (`files` whitelist, `keywords`, `private: false`).

## [0.2.0] — 2026-07-05
### Added
- `carry adopt` and the `continue-after-reset` skill — adopt a live session you started yourself so
  Claude Carry continues it in place after a usage-limit reset.
### Changed
- Renamed the project from **NightQueue** to **Claude Carry**; the command `nq` is now `carry` (with
  `nq` kept as a back-compat alias).
### Fixed
- `isolationMode()` now honors an explicit `isolation: 'none'`, so an adopted session runs on your own
  branch instead of creating a `carry/<id>` branch.
- **`carry adopt` now reliably resumes.** It spawns a detached `carry run --drain` whose wall-clock loop
  resumes the adopted session the moment the limit resets, then exits — instead of relying solely on a
  scheduled OS wake that could fail to launch the runner and leave the task stuck in `waiting`.
- Skills invoke the CLI as bare `carry` (on PATH) rather than the `…/bin/carry.cmd` path, which broke when
  the repo lives under a directory containing a space.
- New: `carry run --drain` (wait for due/scheduled tasks, run them, then exit), `carry run --no-wake`,
  and `carry ls` as an alias for `carry list`.

## [0.1.0] — 2026-06-18
- Initial public release: queued, unattended Claude Code runs with lossless resume at the usage-limit
  reset; in-folder branch mode (work + session visible in VS Code); per-task model/budget; parallel
  runs; incremental cost tracking; a morning handoff; and a Windows sleep→wake drill.

[Unreleased]: ./CHANGELOG.md
[0.2.0]: ./CHANGELOG.md
[0.1.0]: ./CHANGELOG.md
