# orc-mcp

[![npm version](https://img.shields.io/npm/v/orc-mcp.svg)](https://www.npmjs.com/package/orc-mcp)

A local-only MCP orchestrator that coordinates multiple Claude Code sessions (one session = one repository).

The orchestrator itself is a resident program with no LLM inside. It has three jobs:

- **Ledger**: stores the design decisions and task progress each session reports, in SQLite
- **git reader**: reads other sessions' commits, diffs, and files directly from each repository's git
- **Signal**: accepts "wait until that task is done", and when the condition is met, returns along with the changes

## Requirements

- Node.js 22.13 or later (uses the built-in `node:sqlite`; on 22.x it prints an experimental-feature warning)
- git

## Setup

Set up once for your user; every repository and worktree then works without per-repository files. The package installs two commands: `orc-mcp` (the orchestrator) and `orc-mcp-hook` (run by Claude Code hooks).

1. Install:

   ```sh
   npm install -g orc-mcp
   ```

2. Pick a token and export it from your shell profile (e.g. `~/.zshrc`), so both the orchestrator and Claude Code see it:

   ```sh
   export ORC_TOKEN=<output of: openssl rand -hex 16>
   ```

3. Register the MCP server for your user. Keep the single quotes so `${ORC_TOKEN}` is stored as-is and expanded by Claude Code at connect time:

   ```sh
   claude mcp add-json --scope user orc '{"type":"http","url":"http://127.0.0.1:4700/mcp","headers":{"Authorization":"Bearer ${ORC_TOKEN}"}}'
   ```

4. Add the hooks from [`hooks.settings.example.json`](hooks.settings.example.json) to `~/.claude/settings.json` (merge into an existing `"hooks"` key if you have one). See [Hooks](#hooks-enforcing-waits-and-guiding-reconnection) for what they do.

5. Start the orchestrator and leave it running:

   ```sh
   orc-mcp
   ```

| Environment variable | Default | Description |
|---|---|---|
| `ORC_PORT` | `4700` | Listening port (always bound to `127.0.0.1`). If you change it, change the URL in step 3 too |
| `ORC_DB` | `~/.orc-mcp/orc.db` | SQLite file |
| `ORC_TOKEN` | none | When set, `Authorization: Bearer` is required |
| `ORC_STALE_SEC` | `1800` | A session that has not called in for longer than this is considered stalled |
| `ORC_TAKEOVER_SEC` | `120` | A connection used within this many seconds is considered "live", and joining under the same name is rejected |

With user scope, sessions outside any project also see the `orc` tools, and when the orchestrator is running the SessionStart hook adds one line to their context saying the orchestrator is available. If the orchestrator is not running, Claude Code shows the `orc` server as failed to connect; the hooks do nothing.

### Per-repository setup instead

To enable orc-mcp only in specific repositories, use project scope: copy [`mcp.json.example`](mcp.json.example) to `.mcp.json` and put the hooks in `.claude/settings.json` in each repository. Commit both, or worktrees created for new sessions won't have them. Claude Code asks you to approve a project's MCP server the first time it is used.

## Joining a project

Tell each session the project name in chat.

> Join the orchestrator with project name `shop`

The session calls `join_project` and can then interact only with sessions that joined under the same project name. Tasks, design decisions, and repositories of sessions in other projects are completely invisible.

- **Project name**: a name shared by all participants. Alphanumerics, `_`, and `-`, up to 40 characters
- **Your name**: what you are called within the project. Defaults to the repository name; can be changed with `name`

### worktrees

This also works as-is when a repository has multiple sessions (when a worktree is created per session).

- The unit of registration is the worktree. Two worktrees of repository a can join different projects `foo` and `bar`
- The default name is the main repository's name (`a` in this example), not the worktree's directory name
- The changes other sessions see are the commits on the branch checked out in that worktree

Example: when repositories a and b each have a session for `foo` and one for `bar`, only the a and b that joined `foo` see each other, and only the a and b that joined `bar` see each other.

### Duplicate registration

The following are rejected as duplicate registrations.

| Situation | Result |
|---|---|
| In the same project, a different repository tries to use the same name | Rejected (specify a different `name`) |
| A registered repository (worktree) is registered under a different name or a different project | Rejected (`leave_project` first) |
| A session that has already joined tries to join another project as well | Rejected (`leave_project` first) |
| The same name and repository are in use by another live session | Rejected (can be taken over with `force: true`) |

Rejoining with the same project name, name, and repository is treated as a reconnection and keeps the tasks and base commit. After restarting the orchestrator, rejoin from each session.

"Live" means the connection called the orchestrator within the last `ORC_TAKEOVER_SEC` seconds (120 by default).

## Tools

| Category | Tool | Description |
|---|---|---|
| Join | `join_project` | Join by declaring a project name. HEAD at the first join becomes the base commit |
| | `leave_project` | Leave. The repository is released; tasks and design decisions left behind remain visible |
| Report | `publish_decision` | Record a design decision (topic, decision, rationale, scope of impact) |
| | `update_task` | Create tasks and update progress. `done` requires an existing commit SHA |
| Read | `get_overview` | Roles, tasks, recent decisions, and wait status of every session in the project |
| | `get_decisions` | List of design decisions |
| | `get_changes` | Another session's commits and changed files |
| | `get_diff` | Another session's diff |
| | `read_file` | Another session's committed files |
| Wait | `wait_for` | Wait for a task to complete or a decision to be published |
| | `cancel_wait` | Cancel a wait |

`wait_for` waits up to 110 seconds (50 by default); if the condition is not met it returns `pending` and a `wait_id`. Calling again with the same `wait_id` continues the wait. A circular wait is rejected with an error at registration time.

## Hooks (enforcing waits and guiding reconnection)

Calling `wait_for` again is only a request to the model, so Claude Code hooks reinforce it. The hooks run `orc-mcp-hook`, configured in [Setup](#setup) step 4. They read `ORC_PORT` and `ORC_TOKEN` from the environment Claude Code is started from.

| Hook | Behavior |
|---|---|
| Stop (`asyncRewake`) | When a turn ends with a wait still pending, it waits in the background. When the condition is met, it wakes Claude with the commits and design decisions. Uses no tokens while waiting |
| SessionStart | If the worktree is registered, tells Claude how to rejoin and which waits remain. If the session started in a new process, allows rejoining without `force` |

Hooks identify the session from the working directory (worktree). If the orchestrator is not running, they do nothing.

## Development

Run from a clone instead of the npm package:

```sh
npm install
npm run build
npm start          # same as orc-mcp
npm test
```

To use a local build with the hooks, replace `orc-mcp-hook` in the hook commands with `node /ABSOLUTE/PATH/TO/orc-mcp/dist/src/hook.js`.

`npm test` creates temporary repositories and worktrees, and checks end to end with clients for multiple sessions: joining, rejecting duplicate registration, isolation between projects, waits, cycle detection, completion notices, fetching diffs, takeover, leaving, joining from worktrees, and hooks.

## License

[MIT](LICENSE)
