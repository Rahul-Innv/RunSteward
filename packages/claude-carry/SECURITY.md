# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately by opening a **confidential issue**: New issue → tick **"This issue is
confidential"** so it's visible only to project members. (GitLab's private security advisories are
an Ultimate-tier feature and aren't available on this project, so a confidential issue is the
private channel here.) If you'd rather not file anything public-adjacent at all, contact the
maintainer directly and they'll set up a channel.

Include: what the issue is and where, how to reproduce it, and the potential impact.

This is a small, single-maintainer project, so responses are best-effort — but security reports are
taken seriously and prioritized over features.

## Supported versions
Only the current `main` branch is supported.

## Secrets & security posture
- Secrets live only in environment variables / CI secrets — **never committed**. `.env` and key files
  (`*.pem`, `*.key`, `.env.local`, `.env.backup`) are gitignored.
- If a key is ever exposed, **rotate it immediately** — treat anything that touched a commit, log, or
  transcript as compromised.
- Claude Carry runs locally and spawns the Claude CLI under your own login — it stores **no API keys**
  (authentication is delegated entirely to the Claude CLI). Its guardrails deny reading `.env`,
  `~/.ssh`, and cloud-credential files, and deny `git push` / `npm publish` during unattended runs.
- Output from third-party/untrusted sources is escaped/sanitized before rendering.
