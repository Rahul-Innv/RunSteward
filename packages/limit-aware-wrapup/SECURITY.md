# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately with a **confidential issue**: open a new issue, pick the **Security** description
template, and tick **"This issue is confidential"** before submitting so only maintainers can see it.
If in doubt, open a minimal confidential issue saying *only* that you'd like a private security
contact (no details), and the maintainer will follow up.

Include: what the issue is and where, how to reproduce it, and the potential impact.

This is a small, single-maintainer project, so responses are best-effort — but security reports are
taken seriously and prioritized over features.

## Supported versions
Only the current `main` branch is supported.

## Security posture (verified 2026-07-07)

This tool reads your Anthropic usage data on your own machine. Its threat model is deliberately small:

- **The OAuth token** is read from *your own* `~/.claude/.credentials.json`, expiry-checked, and sent
  **only** to `api.anthropic.com` (the hostname is hardcoded — [`sensor/refresh-oauth.js`](sensor/refresh-oauth.js)).
  It is never logged, and never sent to any third party.
- **Zero runtime dependencies** — no supply-chain surface. The only external call is the single
  usage-poll to Anthropic's own endpoint.
- **No untrusted input, no third-party exfiltration** — the "lethal trifecta" is broken by design.
- **Logs carry no secrets** — [`decisions.log`](trigger/check.js) records a truncated session id, the
  decision, and usage percentages only.
- **Wrap-up commits are local-only** (never pushed) and respect `.gitignore`.
- **Fail-open everywhere** — missing, renamed, or stale data makes the tool do nothing. A tool that can
  block or degrade a Claude Code session is worse than no tool, so it never throws out of a hook.

If a credential is ever exposed, **rotate it immediately** — treat anything that touched a commit, log,
or transcript as compromised. This project never writes credentials to disk itself; it only reads the
existing Claude Code credential file.
