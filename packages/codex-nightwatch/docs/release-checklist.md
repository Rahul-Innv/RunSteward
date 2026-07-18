# Release Checklist

## Private MVP

- [x] Push private GitLab repository.
- [x] Confirm GitLab CI test job passes.
- [x] Confirm proof artifact job produces `proof-report.md`.
- [x] Set GitLab description and topics from `docs/repository-metadata.md`.
- [x] Run one tiny real `codex exec --json` fixture capture.
- [x] Add redacted real fixture to tests.
- [x] Update README with real fixture result.

## Public Preview

- [x] Confirm license, security policy, contribution guide, and code of conduct.
- [ ] Confirm package name availability again on npm and PyPI.
- [ ] Decide whether to publish as plugin, Python package, npm wrapper, or all three.
- [x] Add project badges.
- [ ] Add public demo media or terminal recording.
- [ ] Tag `v0.1.0`.

## Do Not Release If

- Real Codex JSONL parsing is untested.
- Reports contain private paths, prompts, or account/session identifiers.
- The README implies official OpenAI ownership.
- The runner defaults to executing unattended work instead of dry-run.
