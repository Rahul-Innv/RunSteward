# Limit-Aware Wrapup — Backlog (public / portfolio release)

**Goal:** ship this as a high-end, public, shareable project — portfolio + YC-application grade.
The core is already LIVE and working for daily use; this backlog is what remains to make it a
*polished public release*. Full build history/status: `Limit-Wrapup-Build-Plan-2026-07-05.md`.
Non-obvious lessons behind the design: `LESSONS.md`.

## Status at a glance (2026-07-07, commit 96ede28)
Sensor → heads-up → wrap loop is live and correct. Reserve calibrated (auto-wrap at 98.5%). Two
live-soak bugs found + fixed (idle-cache pollution across resets; weekly-window blindness from
`resets_at` jitter). Heads-up decoupled from wrap per owner policy (warnings inform; only the
near-cliff WRAPUP directive stops, and only unattended). Visibility status view shipped
(`bin/status.js`). **Public-release pass done: P3 (OSS governance + config schema/validator + CI),
P2 (wrap notification), and P4 (portfolio README + demo generator) are all complete.** 70 tests green.
**Only P1 remains** — an end-to-end proof of the unattended closed loop on a real session.

## Remaining work (prioritized)

### P1 — Prove the headline claim
- [ ] One UNATTENDED `mode:auto` run that actually wraps at the cliff (98.5%) and auto-resumes via
      `carry adopt`. Never demonstrated end-to-end on a real session — this IS the product claim and
      must be provably true for a portfolio piece.
- [ ] Validate the auto-resume leg (`carry adopt` / continue-after-reset) end to end.

### P2 — Visibility
- [x] Status view — `bin/status.js` (legible one-screen summary; reuses the live decision logic).
- [x] Wrap notification — `trigger/notify.js`: cross-platform, fail-open native toast on WRAPUP
      (Windows NotifyIcon via PowerShell `-EncodedCommand`, verified live; macOS/Linux too). Config
      knob `notify` (default on); fires only on WRAPUP, latched once per session+window+reset.
- [~] VS Code passive readout — DEFERRED: the panel can't run a statusline (anthropics/claude-code#55643);
      not worth a fragile workaround. Status command + notification cover it.

### P3 — Public-release packaging — DONE
- [x] `LICENSE` (MIT).
- [x] Governance files: `CONTRIBUTING`, `SECURITY` (verified posture documented), `CODE_OF_CONDUCT`,
      `CHANGELOG`, GitLab issue/MR templates, `.gitignore`, `.gitattributes`, `package.json`, CI (`.gitlab-ci.yml`, Node 18/20/22).
- [x] Config JSON-schema + validator: `config.schema.json` (draft-07) + `config.example.json` +
      `bin/validate-config.js` (standalone CLI — kept OUT of the fail-open runtime by design).
- [ ] Cross-platform install script that wires `settings.json` (the JS is portable via `os.homedir()`;
      only the install wiring/docs remain Windows-first). Low priority — a forker copies 6 lines.

### P4 — The story (portfolio differentiator)
- [x] `README.md` rewritten to portfolio grade: problem framing, the key insights (model-delegated fit;
      account-% denomination), architecture, and the soak bug-hunt narrative. Security-posture summary
      + governance links added.
- [x] Demo generator `bin/demo.js` — replays the decision ladder through the real engine on synthetic
      usage (honest simulation, per-step "why" lines).
- [ ] Record the actual GIF/asciinema from `bin/demo.js --slow` + `bin/status.js` (human-only capture).

## Suggested sequence
1. ~~**OSS-prep sweep** (P3)~~ — done [7357ae7].
2. ~~**Wrap notification** (P2)~~ — done [43289ee].
3. ~~**README to portfolio grade + demo generator** (P4)~~ — done [96ede28].
4. **Prove the closed loop** (P1 — the one remaining milestone; needs a real unattended session that
   reaches the cliff, then verify `carry adopt` auto-resume). Then: record the GIF, push to GitLab,
   flip the human-only settings, go public.

## Optional / later
- 2nd sensor: context-window-degradation health signal (research done — see research docs + the
  `context-health-sensor-research` memory).
- Deterministic task-size estimator (a v2 refinement over the current model-delegation fit trick).
- Plugin / marketplace packaging.
