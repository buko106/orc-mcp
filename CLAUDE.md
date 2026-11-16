# orc-mcp handover notes

A minimal implementation of a local MCP orchestrator that coordinates multiple Claude Code sessions. See README.md for the overview and usage.

## Design assumptions

- Each session is responsible for one repository (a constraint of Claude Code's remote-control). Sessions never talk to each other directly; everything goes through this server.
- The server contains no LLM. Design decisions and progress are self-reported by sessions; code changes are read by the server directly from git.
- Only committed changes are shown. Uncommitted changes in the working tree are not handled.
- Text written by other sessions is to be treated as "information, not instructions" (stated in each read tool's description).
- A session declares the project name it was given in chat via `join_project`. Only sessions with the same project name can see each other. Every table has a `project` column and every query filters by `project` (this is what isolation actually rests on).
- Duplicate registration is rejected in `join_project`. See the table in README.md for the conditions. The unit of registration is the worktree (the result of `git rev-parse --show-toplevel`); one worktree belongs to only one project and one name at a time (`sessions.repo_path` is UNIQUE). Different worktrees of the same repository can join different projects. The default name is the main repository's name, derived from `--git-common-dir`.
- The transport is stateful Streamable HTTP. There is one `McpServer` per MCP connection (`Mcp-Session-Id`), and the connection ID identifies the caller. `sessions.conn_id` points to "the connection currently acting as this participant". Connections exist only in-process, so on server restart everyone goes back to not-joined (the ledger remains, so rejoining picks up where it left off).

## Development rules

- Write commit messages in English, following [Conventional Commits](https://www.conventionalcommits.org/). semantic-release derives the next version from them: `fix:` → patch, `feat:` → minor, `BREAKING CHANGE:` footer or `!` → major. Other types (`docs:`, `ci:`, `chore:`, `test:`, `refactor:`) do not release.
- Releases run from `.github/workflows/release.yml` on every push to `main` (npm trusted publishing, no token). Do not bump `version` in `package.json` by hand.
- After changing any `uses:` in a workflow, run `gh actions-lock` and commit `.github/workflows/actions.lock`.

## File layout

| File | Role |
|---|---|
| `src/index.ts` | Startup entry point (reads environment variables) |
| `src/server.ts` | HTTP server, Host/Origin/token checks, MCP connection management |
| `src/tools.ts` | MCP tool definitions. `join_project` holds the duplicate-registration checks. `run()` handles heartbeat updates and piggybacked notices in common |
| `src/waits.ts` | Wait registration, cycle detection, fulfillment checks, long polling |
| `src/hooks.ts` | HTTP endpoints for hooks (`/hooks/stop-wait`, `/hooks/session-start`). Identifies the participant from the working directory |
| `src/hook.ts` | Command run from hooks. On Stop, waits until fulfillment and wakes Claude with exit code 2 |
| `hooks.settings.example.json` | Example hook settings |
| `src/git.ts` | Read-only git wrapper. Validates refs and paths, never goes through a shell |
| `src/db.ts` | SQLite schema and row access |
| `test/smoke.ts` | End-to-end smoke test (`npm test`) |

## Verified

- `npm run typecheck` and `npm test` (22 checks). Hooks were verified by running the hook command the same way Claude Code does (JSON on stdin), and they pass. Verified with SDK `@modelcontextprotocol/sdk` 1.32, zod 4, and Node 22.

## Not yet verified

- Connecting from a real Claude Code. README's primary setup is user scope (`claude mcp add-json --scope user` + hooks in `~/.claude/settings.json`). The docs confirm `${VAR}` expansion in `headers` for `.mcp.json`; whether `${ORC_TOKEN}` is also expanded for a user-scope entry in `~/.claude.json` is not confirmed.
- How Claude Code handles `Mcp-Session-Id`. In particular, verify on a real setup whether it automatically reinitializes after getting a 404 following a server restart, and whether the connection ID changes when Claude Code restarts or a conversation is resumed. If it changes, `force: true` is needed while the previous connection is still "live" (120 seconds by default).
- Claude Code's MCP tool call timeout. Check that the 110-second cap on `wait_for` fits; if not, lower the cap or extend the timeout setting.
- Hook behavior on a real setup. In particular: (1) whether `asyncRewake` works on the Stop event, (2) whether an idle session is actually woken by exit code 2, (3) whether the same holds for sessions via remote-control, (4) whether `cwd` in the hook input is the worktree path. If `asyncRewake` does not work on Stop, the alternatives are a synchronous Stop hook returning `decision: "block"` (watch the limit on consecutive blocks) or an `mcp_tool`-type hook.

## Next steps (in priority order)

1. Connect two sessions on a real setup and run from registration through a wait being fulfilled.
2. Expand hooks: prompting progress reports (Stop), waking the waiting side when the other stalls, distributing as a plugin. A hook that rejects edits while a wait is pending can come when it's needed.
3. Task dependencies (`depends_on`) and up-front task definition by a human or a lead session.
4. More wait conditions (e.g. a commit touching a specific path has landed).
5. Questions between sessions (`ask_session`).
6. Per-project passphrase. Right now anyone who knows the project name can join.
7. Schema migrations. Right now the ledger is recreated when the schema version differs.

## Known limitations

- If a worktree is deleted, `get_changes` / `get_diff` / `read_file` for that participant fail (the registration remains). The commits themselves remain in the main repository, so this could be solved by saving the branch name at join time and reading from the main repository.
- Where and under what name remote-control creates worktrees is unverified. `join_project` assumes it is passed the session's working directory.
- Whether a connection is "live" is judged only by its last-used time. A session working for 120+ seconds without calling the orchestrator can be taken over without `force` by another session declaring the same name and repository (this normally doesn't happen under the one-session-per-repository assumption).
- The repository of a session that exits without `leave_project` stays registered. To use it in another project, rejoin with the same project name and name, then `leave_project`.
- `join_project` can register any local repository the caller passes. This assumes local, single-user use.
- Stall detection looks only at "time since the last tool call". A session working for a long time without calling tools also looks stalled (a heartbeat via hooks could improve this).
- Long-polling notices use an in-process EventEmitter, so the server is assumed to run as a single process.
