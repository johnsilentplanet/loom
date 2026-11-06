# Loom

A standalone, Claude-powered coding-agent DAG runner.

Loom registers a git repo as a "project," then spawns one or more coding
agents into isolated git worktrees to make a change, verifies it, and merges
it back to the base branch through a serialized merge train. Multiple
agents/tasks can be wired into a dependency graph (a DAG) so independent work
runs in parallel and dependent work waits.

This is deliberately minimal: no task-management layer, no personal-data
integrations, no notifications, no memory store. Just: register a project,
spawn a coding job (single agent or a DAG of agents), watch its status,
cancel it if needed.

## Auth model

Loom runs entirely on Claude Code **subscription auth** (`~/.claude/`), the
same session a normal `claude login` creates — never an `ANTHROPIC_API_KEY`.
Loom actively strips `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from the
environment it hands to the Agent SDK so it can never silently fall back to
key-based billing.

## Status

Early extraction in progress. Not yet published anywhere.

## License

MIT — see LICENSE.
