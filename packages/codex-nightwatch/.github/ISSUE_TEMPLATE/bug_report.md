---
name: Bug report
about: Report incorrect parsing, policy decisions, or run behavior
title: "[Bug]: "
labels: bug
assignees: ""
---

## Summary

What happened?

## Expected Behavior

What should have happened?

## Reproduction

```bash
python scripts/nightwatch.py doctor
python scripts/nightwatch.py analyze --jsonl tests/sample_codex_events.jsonl --token-budget 5000 --reserve-tokens 1000
```

## Environment

- OS:
- Python version:
- Codex CLI version:
- Nightwatch commit:

## Logs or Fixtures

Attach only redacted logs. Do not include prompts, credentials, private paths, or account identifiers.

## Safety Impact

- [ ] Incorrect continue/checkpoint/stop decision
- [ ] Resume command risk
- [ ] Report leaked sensitive data
- [ ] Other
