## What & why
<!-- What does this change, and why? Link any issue (e.g. Closes #12). -->

## How I tested
- [ ] `node --test test/*.test.js` passes

## Checklist
- [ ] Fail-open contract holds — no new path can throw out of a hook / exit non-zero
- [ ] New budget quantities are in account-% (not tokens)
- [ ] No new runtime dependencies (or an issue agreed one)
- [ ] No secrets staged (`git status` shows no `.env` / keys)
- [ ] Tests added/updated for new behavior
