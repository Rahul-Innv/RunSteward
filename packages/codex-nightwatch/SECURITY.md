# Security

Codex Nightwatch is designed for local, user-controlled Codex runs.

## Sensitive Data

State files and reports may contain:

- prompts and resume prompts
- local filesystem paths
- thread or session identifiers
- token usage summaries
- generated resume commands

Do not put secrets in prompts. Review reports before sharing them publicly.

## Unattended Execution

The MVP is conservative:

- `run` prints the Codex command by default.
- `--execute` is required to start Codex.
- `resume-command` fails when no thread id is known unless `--allow-last` is passed.
- obvious bypass/full-access flags are refused for unattended runs.

## Reporting Issues

Before public release, report issues privately in the GitLab repository. Once public, add the preferred public/private disclosure channel here.
