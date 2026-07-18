## Summary

What changed?

## Verification

- [ ] `python -m unittest discover -s tests`
- [ ] `python -m py_compile scripts/nightwatch.py tests/test_nightwatch.py`
- [ ] Sample proof command still works

## Safety Checklist

- [ ] Default behavior remains dry-run unless explicitly executing.
- [ ] No secrets, private prompts, or unredacted real logs were added.
- [ ] Resume behavior remains fail-closed unless explicitly overridden.
- [ ] Docs were updated for user-visible behavior.
