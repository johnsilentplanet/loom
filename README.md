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

Everything lives behind one shared core library (`src/core`). The CLI
(`src/cli`) and the MCP server (`src/mcp`) are both thin wrappers over it —
neither has orchestration logic of its own.

## Auth model

Loom runs entirely on Claude Code **subscription auth** (`~/.claude/`), the
same session a normal `claude login` creates — never an `ANTHROPIC_API_KEY`.
Loom actively strips `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from the
environment it hands to the Agent SDK (`src/core/auth.ts`) so it can never
silently fall back to key-based billing.

## Install

```sh
bun install
```

Persistence is a local SQLite file at `./data/loom.db` (override with
`LOOM_DB_PATH`). Worktrees and DAG scratch dirs live under
`~/.loom/worktrees` (override with `LOOM_WORKTREE_ROOT`). No network calls
other than the Agent SDK's own calls to Anthropic over your subscription
session.

## CLI

```sh
# Register a project. verify_cmd runs inside the worktree before any merge.
bun run src/cli/main.ts project add myapp /path/to/myapp --base main --verify "bun test"
bun run src/cli/main.ts project list

# Spawn one coding job: worktree -> agent -> verify -> merge. Blocks until done.
bun run src/cli/main.ts spawn myapp "Add a /healthz endpoint that returns 200 OK" --model sonnet

# Spawn a DAG of coding tasks sharing one scratch workspace (see below for the
# graph.json shape). Blocks until every task reaches a terminal state.
bun run src/cli/main.ts dag myapp graph.json

# Status / listing / cancel.
bun run src/cli/main.ts status <jobId>
bun run src/cli/main.ts jobs [--project myapp]
bun run src/cli/main.ts cancel <jobId>
```

`bun install` also wires up a `loom` bin (via `package.json#bin`), so once
linked (`bun link`, or installed globally) the same commands work as:

```sh
loom project add myapp /path/to/myapp --base main --verify "bun test"
loom spawn myapp "<instructions>" --model opus
loom dag myapp graph.json
loom status <jobId>
loom cancel <jobId>
```

### DAG graph file

A DAG job's `graph.json` is a flat list of named tasks with optional
dependencies; independent tasks run in parallel, dependents wait, and
everything shares one scratch workspace (no git, no merge — hand off through
files):

```json
{
  "tasks": [
    { "name": "investigate", "instructions": "Read src/ and write a FINDINGS.md summary" },
    { "name": "draft", "instructions": "Using FINDINGS.md, draft a migration plan into PLAN.md", "depends_on": ["investigate"] },
    { "name": "lint-plan", "instructions": "Check PLAN.md for obvious gaps and append notes", "depends_on": ["draft"] }
  ]
}
```

Each task may also set `"model": "sonnet" | "opus" | "haiku"`.

## MCP server

Loom also exposes the same operations as MCP tools over stdio:
`create_project`, `list_projects`, `spawn_code_job`, `spawn_dag_job`,
`get_run_status`, `cancel_job_tree` (plus `list_run_jobs`).

Run it directly:

```sh
bun run src/mcp/server.ts
```

Wire it into Claude Code / Claude Desktop's MCP config, e.g.
`~/.claude.json` (Claude Code) or the Claude Desktop config file:

```json
{
  "mcpServers": {
    "loom": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/loom/src/mcp/server.ts"]
    }
  }
}
```

## Web UI

Loom ships a minimal, read-only local dashboard over the same SQLite store
the CLI/MCP use (no separate state, no build step, no framework — plain
HTML/CSS/vanilla JS served by Bun's built-in HTTP server):

```sh
loom serve
# or
bun run serve
```

It binds to `127.0.0.1:4177` by default (override with `LOOM_HOST` /
`LOOM_PORT`) — deliberately not exposed publicly unless you choose a
different host yourself, and on a port that won't collide with other local
dev servers. Open it at <http://127.0.0.1:4177>.

The page lists projects, lists jobs per project with live status
(pending/running/verifying/merging/done/failed/cancelled), and shows the
selected job's task tree (name, model, status, error) for DAG jobs — the
same shape `get_run_status` / `src/core/status.ts` already return. It polls
every few seconds; no websockets.

## Scope

What loom does:

1. **Project registry** — name, absolute repo path, default base branch,
   optional verify command.
2. **Single coding job** — isolated git worktree off the base branch, one
   Claude Agent SDK `query()` with coding tools (Read/Write/Edit/Bash/Grep/Glob),
   then the project's verify command in the worktree, then a serialized
   merge into the base branch (the "merge train" — one merge at a time per
   project, so concurrent jobs never race on the base branch). On verify
   failure or a merge conflict, the branch is left unmerged for inspection
   and the job is reported as failed. No deploy step, no smoke test, no
   auto-rollback — coding + merge only.
3. **DAG variant** — a small task graph (name, instructions, `depends_on`)
   sharing one scratch workspace. Independent tasks run in parallel,
   dependents wait, and they hand off through files in that shared
   workspace rather than separate git worktrees.
4. **Status + cancel** — fetch a job's status (and task tree, for DAG jobs),
   or cancel a running job tree (abort in-flight tasks, leave completed ones
   alone).

What it deliberately does not do: task management, scheduling, notifications,
a memory store, deploy/smoke-test/rollback, or any integration with
personal-data systems.

## Status

Early extraction in progress. Not yet published anywhere.

## License

MIT — see LICENSE.
