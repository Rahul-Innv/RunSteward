# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
Preparing the first public release.

### Added
- **Wrap notification** (`trigger/notify.js`, `notify` config, default on): a native desktop
  notification when an unattended WRAPUP fires — so the auto-wrap is *seen*, not discovered later as a
  `wip/` branch. Cross-platform (Windows toast / macOS / Linux) and fail-open. Only on WRAPUP, never a
  heads-up.
- Open-source governance: `LICENSE` (MIT), `SECURITY.md` (documented security posture), `CONTRIBUTING.md`
  (the fail-open / account-% / zero-dep invariants), `CODE_OF_CONDUCT.md`, GitLab issue/MR templates, `.gitignore`.
- Config contract made self-documenting: `config.schema.json` (editor autocomplete + hover docs),
  `config.example.json`, a dependency-free CLI validator (`bin/validate-config.js`), and a
  "Make it yours" README section.
- `bin/status.js` — a one-screen human-facing status view that reuses the live decision logic.
- `bin/demo.js` — an honest, self-contained demo that replays the decision ladder (silent → heads-up →
  WRAPUP + notification) through the real engine on synthetic usage, for a screen recording.
- README rewritten to portfolio grade: problem framing, the design insights, and the live-soak
  bug-hunt narrative (idle-cache → weekly-blindness → OAuth-authoritative).

## [0.1.0] — 2026-07-07
First working end-to-end cut (used daily by the author before public prep).

### Added
- **Sensor** (`sensor/statusline.js`): appends usage samples + burn rate to `state.json` from the
  statusline stdin `rate_limits` payload, and renders a compact `5h % | wk %` readout.
- **Fallback sensor** (`sensor/refresh-oauth.js`): an authoritative, throttled OAuth usage poll to
  `api.anthropic.com`, covering VS Code / headless sessions the statusline never reaches.
- **Trigger** (`trigger/check.js` + pure `trigger/decide.js`): reads state, decides
  NONE / WARN / WRAPUP, latches once per session+window+reset, injects `additionalContext`.
- **Wrap-up ritual** (`skills/wrapping-up/`): finish the atomic step → HANDOFF.md → WIP commit on a
  `wip/<date>` branch → optional auto-resume → stop clean.
- Reserve knob (`reserve_pct`): auto-wrap fires at `(100 − reserve_pct)%`; calibrated to 98.5%.

### Fixed
- **Idle-cache pollution across resets**: idle TUI statuslines re-emit cached percentages under fresh
  timestamps; regressing readings are now dropped on append.
- **Weekly-window blindness**: `resets_at` can jitter *earlier* between polls, which mis-classified
  live weekly readings as stale. Fixed by treating the OAuth source as authoritative and never
  regression-dropping it.

[Unreleased]: ./CHANGELOG.md
[0.1.0]: ./CHANGELOG.md
