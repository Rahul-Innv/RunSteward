# Contributing

Codex Nightwatch is currently an MVP. Contributions should keep the project conservative, local-first, and easy to verify.

## Development

Run the test suite:

```bash
python -m unittest discover -s tests
python -m py_compile scripts/nightwatch.py tests/test_nightwatch.py
```

Run the sample proof flow:

```bash
python scripts/nightwatch.py analyze --jsonl tests/sample_codex_events.jsonl --token-budget 5000 --reserve-tokens 1000
```

## Design Principles

- Keep the core CLI stdlib-only unless a dependency removes substantial complexity.
- Prefer dry-run behavior before unattended execution.
- Do not add auth handling, token storage, or external publishing in core MVP paths.
- Keep machine-readable JSONL separate from human transcript logs.
- Treat usage totals as advisory local policy inputs, not billing truth.

## Pull Request Checklist

- Tests pass locally.
- New behavior has a fixture or unit test.
- Docs explain any user-visible CLI change.
- Reports and fixtures do not contain secrets, private paths, or real account identifiers.
- Safety defaults remain conservative.
