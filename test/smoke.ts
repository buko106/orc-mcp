// Smoke test: sets up temporary repositories and a server, and checks the whole flow with clients for multiple sessions.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../src/server.js";

const tmp = mkdtempSync(join(tmpdir(), "orc-smoke-"));
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function makeRepo(name: string): string {
  const dir = join(tmp, name);
  execFileSync("git", ["init", "-q", dir]);
  sh(dir, "config", "user.email", "smoke@example.com");
  sh(dir, "config", "user.name", "smoke");
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "init");
  return dir;
}

const TOKEN = "smoke-token";
const srv = await startServer({ port: 0, dbPath: join(tmp, "orc.db"), token: TOKEN, staleSec: 1800, hookHoldSec: 2 });
const url = new URL(`http://127.0.0.1:${srv.port}/mcp`);

/** MCP connection for one Claude session. The name is declared via join_project, not a header. */
async function connect() {
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
    const text = r.content[0]?.text ?? "";
    return { isError: r.isError === true, text, data: r.isError ? null : JSON.parse(text) };
  };
}

/** Runs the hook command the same way Claude Code does (JSON on stdin). */
function runHook(mode: string, input: object): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--import", "tsx", "src/hook.ts", mode], { env: { ...process.env, ORC_PORT: String(srv.port), ORC_TOKEN: TOKEN } });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => resolve({ code, stdout, stderr: stderr.replace(/^\(node:.*\n\(Use.*\n/m, "") }));
    p.stdin.end(JSON.stringify(input));
  });
}

let passed = 0;
const step = (name: string) => console.log(`ok ${++passed} - ${name}`);

try {
  const backendRepo = makeRepo("backend");
  const frontendRepo = makeRepo("frontend");
  const infraRepo = makeRepo("infra");
  const backend = await connect();
  const frontend = await connect();
  const third = await connect();

  const noAuth = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(noAuth.status, 401);
  step("token is required");

  const early = await backend("get_overview");
  assert.equal(early.isError, true);
  assert.match(early.text, /join_project/);
  step("nothing works before join_project");

  // Declaring a name. Your name defaults to the repository's directory name.
  const jb = await backend("join_project", { project: "shop", repo_path: backendRepo, role: "backend API" });
  assert.equal(jb.data.you, "backend");
  const jf = await frontend("join_project", { project: "shop", repo_path: frontendRepo, role: "web frontend" });
  assert.deepEqual(jf.data.members.map((m: { name: string }) => m.name), ["backend", "frontend"]);
  step("join_project");

  // Preventing duplicate registration
  const d1 = await third("join_project", { project: "shop", repo_path: infraRepo, role: "x", name: "backend" });
  assert.match(d1.text, /already taken/);
  const d2 = await third("join_project", { project: "shop", repo_path: backendRepo, role: "x", name: "backend2" });
  assert.match(d2.text, /already registered as "backend" in project "shop"/);
  const d3 = await third("join_project", { project: "other", repo_path: backendRepo, role: "x" });
  assert.match(d3.text, /already registered/);
  const d4 = await third("join_project", { project: "shop", repo_path: backendRepo, role: "x" });
  assert.match(d4.text, /held by another live session/);
  const d5 = await backend("join_project", { project: "other", repo_path: backendRepo, role: "x" });
  assert.match(d5.text, /leave_project first/);
  step("duplicate registration is rejected (name, repository, project, live session)");

  await backend("update_task", { task_id: "backend/auth", title: "Auth endpoint", status: "in_progress" });
  await frontend("update_task", { task_id: "frontend/login", title: "Login page", status: "todo" });
  await backend("publish_decision", { topic: "db", decision: "use postgres" });
  step("update_task and publish_decision");

  // Isolation: a session that joined under another project name sees nothing. The same name can be used in another project.
  const jo = await third("join_project", { project: "other", repo_path: infraRepo, role: "infra", name: "backend" });
  assert.deepEqual(jo.data.members, [{ name: "backend", role: "infra" }]);
  const oo = await third("get_overview");
  assert.equal(oo.data.project, "other");
  assert.equal(oo.data.sessions.length, 1);
  assert.equal(oo.data.sessions[0].tasks.length, 0);
  assert.equal((await third("get_decisions")).data.decisions.length, 0);
  assert.match((await third("get_changes", { session: "frontend" })).text, /unknown session/);
  assert.match((await third("read_file", { session: "frontend", path: "README.md" })).text, /unknown session/);
  assert.match((await third("wait_for", { task_id: "backend/auth", timeout_sec: 1 })).text, /unknown task/);
  assert.equal((await frontend("get_overview")).data.sessions.length, 2);
  step("projects are isolated from each other");

  // Wait: not done yet, so pending
  const w1 = await frontend("wait_for", { task_id: "backend/auth", timeout_sec: 1 });
  assert.equal(w1.data.status, "pending");
  const waitId: string = w1.data.wait_id;
  step("wait_for returns pending");

  const cyc = await backend("wait_for", { task_id: "frontend/login", timeout_sec: 1 });
  assert.match(cyc.text, /deadlock/);
  step("deadlock is rejected");

  const ov = await backend("get_overview");
  assert.ok((ov.data.inbox as string[]).some((m) => m.includes("frontend")));
  assert.equal(ov.data.active_waits.length, 1);
  step("inbox notice is piggybacked");

  const bad = await backend("update_task", { task_id: "backend/auth", status: "done", commit_sha: "deadbeef" });
  assert.equal(bad.isError, true);
  step("done requires an existing commit");

  // While frontend waits, backend commits and reports done
  const waiting = frontend("wait_for", { wait_id: waitId, timeout_sec: 20 });
  await new Promise((r) => setTimeout(r, 300));
  writeFileSync(join(backendRepo, "auth.ts"), "export const login = () => 'ok';\n");
  sh(backendRepo, "add", ".");
  sh(backendRepo, "commit", "-q", "-m", "add auth endpoint");
  const sha = sh(backendRepo, "rev-parse", "HEAD");
  await backend("publish_decision", { topic: "auth-api", decision: "POST /login returns a session cookie", rationale: "simplest for the web client" });
  const t0 = Date.now();
  await backend("update_task", { task_id: "backend/auth", status: "done", commit_sha: sha.slice(0, 8), note: "ready" });
  const w2 = await waiting;
  assert.equal(w2.data.status, "fulfilled");
  assert.ok(Date.now() - t0 < 5000, "wait should be released promptly");
  assert.equal(w2.data.result.task.commit_sha, sha);
  assert.equal(w2.data.result.commits_since_base[0].subject, "add auth endpoint");
  assert.equal(w2.data.result.recent_decisions[0].topic, "auth-api");
  step("wait_for is released with commits and decisions");

  const ch = await frontend("get_changes", { session: "backend" });
  assert.equal(ch.data.commits.length, 1);
  assert.deepEqual(ch.data.commits[0].files, [{ status: "A", path: "auth.ts" }]);
  assert.match((await frontend("get_diff", { session: "backend" })).data.diff, /\+export const login/);
  step("get_changes and get_diff");

  assert.match((await frontend("read_file", { session: "backend", path: "auth.ts" })).data.content, /login/);
  assert.equal((await frontend("read_file", { session: "backend", path: "../frontend/README.md" })).isError, true);
  assert.equal((await frontend("get_diff", { session: "backend", from: "--output=/tmp/x" })).isError, true);
  step("read_file, and unsafe path / ref are rejected");

  assert.equal((await frontend("wait_for", { session: "backend", topic: "auth-api", timeout_sec: 1 })).data.status, "fulfilled");
  const wc = await frontend("wait_for", { session: "backend", topic: "not-yet", timeout_sec: 1 });
  await frontend("cancel_wait", { wait_id: wc.data.wait_id });
  assert.equal((await frontend("wait_for", { wait_id: wc.data.wait_id, timeout_sec: 1 })).data.status, "cancelled");
  step("wait_for decision_published and cancel_wait");

  // Reconnection: a new connection joining with the same name and repository with force takes over, and the old connection is detached.
  const backend2 = await connect();
  const tk = await backend2("join_project", { project: "shop", repo_path: backendRepo, role: "backend API", force: true });
  assert.equal(tk.data.reconnected, true);
  assert.equal(tk.data.base_sha, jb.data.base_sha);
  assert.match((await backend("get_overview")).text, /join_project/);
  assert.equal((await backend2("get_overview")).data.sessions.length, 2);
  step("takeover with force keeps history and detaches the old connection");

  // Leaving: the repository is released and can join another project. Tasks left behind remain visible.
  await backend2("leave_project");
  const ov2 = await frontend("get_overview");
  assert.equal(ov2.data.sessions.length, 1);
  assert.equal(ov2.data.tasks_of_departed_sessions[0].id, "backend/auth");
  assert.equal((await backend2("join_project", { project: "third", repo_path: backendRepo, role: "x" })).isError, false);
  step("leave_project frees the repository");

  // worktrees: create a worktree for foo and one for bar in each of repositories a and b (multiple sessions per repository).
  const repoA = makeRepo("a");
  const repoB = makeRepo("b");
  const wt = (repo: string, name: string) => {
    const dir = join(tmp, "worktrees", `${name}-${repo.endsWith("a") ? "a" : "b"}-x7`);
    sh(repo, "worktree", "add", "-q", "-b", `claude/${name}`, dir);
    return dir;
  };
  const [aFooDir, bFooDir, aBarDir, bBarDir] = [wt(repoA, "foo"), wt(repoB, "foo"), wt(repoA, "bar"), wt(repoB, "bar")];
  const [aFoo, bFoo, aBar, bBar] = [await connect(), await connect(), await connect(), await connect()];
  const j1 = await aFoo("join_project", { project: "foo", repo_path: aFooDir, role: "a" });
  assert.equal(j1.data.you, "a"); // the main repository's name, not the worktree's directory name
  assert.equal(j1.data.branch, "claude/foo");
  await bFoo("join_project", { project: "foo", repo_path: join(bFooDir), role: "b" });
  await aBar("join_project", { project: "bar", repo_path: aBarDir, role: "a" });
  const j4 = await bBar("join_project", { project: "bar", repo_path: bBarDir, role: "b" });
  assert.deepEqual(j4.data.members.map((m: { name: string }) => m.name), ["a", "b"]);
  step("sessions in worktrees of the same repository join different projects");

  // Commit in a's worktree for foo. Visible to the foo peer; does not appear for a on the bar side.
  writeFileSync(join(aFooDir, "foo.txt"), "foo work\n");
  sh(aFooDir, "add", ".");
  sh(aFooDir, "commit", "-q", "-m", "foo work in a");
  const cf = await bFoo("get_changes", { session: "a" });
  assert.equal(cf.data.branch, "claude/foo");
  assert.equal(cf.data.commits[0].subject, "foo work in a");
  assert.match((await bFoo("read_file", { session: "a", path: "foo.txt" })).data.content, /foo work/);
  const cb = await bBar("get_changes", { session: "a" });
  assert.equal(cb.data.branch, "claude/bar");
  assert.equal(cb.data.commits.length, 0);
  assert.equal((await bBar("read_file", { session: "a", path: "foo.txt" })).isError, true);
  step("each project sees only its own worktree's branch");

  // A second session from the same worktree trying to join another project is a duplicate registration
  assert.match((await (await connect())("join_project", { project: "baz", repo_path: aFooDir, role: "x" })).text, /already registered/);
  step("one worktree cannot be registered twice");

  // ---- Hooks ----
  // With no wait, the Stop hook exits without doing anything
  const h0 = await runHook("stop-wait", { cwd: aFooDir, hook_event_name: "Stop" });
  assert.equal(h0.code, 0);
  assert.equal((await runHook("stop-wait", { cwd: tmp })).code, 0); // unregistered location
  step("stop hook exits quietly when there is nothing to wait for");

  // a(foo) ends its turn while waiting on b(foo)'s task → the hook waits in the background and wakes it with exit code 2 when fulfilled
  await bFoo("update_task", { task_id: "b/api", title: "API", status: "in_progress" });
  const hw = await aFoo("wait_for", { task_id: "b/api", timeout_sec: 1 });
  assert.equal(hw.data.status, "pending");
  const superseded = runHook("stop-wait", { cwd: aFooDir });
  await new Promise((r) => setTimeout(r, 1500));
  const hook = runHook("stop-wait", { cwd: join(aFooDir) });
  assert.equal((await superseded).code, 0); // when a new hook arrives, the old one exits quietly
  await new Promise((r) => setTimeout(r, 2500)); // past the hold time (2s), it calls again on pending and keeps waiting
  writeFileSync(join(bFooDir, "api.txt"), "api\n");
  sh(bFooDir, "add", ".");
  sh(bFooDir, "commit", "-q", "-m", "add api in b");
  await bFoo("update_task", { task_id: "b/api", status: "done", commit_sha: sh(bFooDir, "rev-parse", "HEAD") });
  const hr = await hook;
  assert.equal(hr.code, 2);
  assert.match(hr.stderr, /task "b\/api" is done/);
  assert.match(hr.stderr, /add api in b/);
  assert.equal((await aFoo("wait_for", { wait_id: hw.data.wait_id, timeout_sec: 1 })).data.status, "fulfilled");
  assert.equal((await runHook("stop-wait", { cwd: aFooDir })).code, 0); // does not wake twice for the same wait
  step("stop hook wakes the session once when the wait is fulfilled");

  // SessionStart: for a registered worktree, guide rejoining and allow reconnecting without force
  const ss = await runHook("session-start", { cwd: aFooDir, hook_event_name: "SessionStart", source: "resume" });
  assert.equal(ss.code, 0);
  assert.match(ss.stdout, /registered with the orchestrator as "a" in project "foo"/);
  const aFoo2 = await connect();
  assert.equal((await aFoo2("join_project", { project: "foo", repo_path: aFooDir, role: "a" })).data.reconnected, true);
  assert.match((await runHook("session-start", { cwd: tmp, source: "startup" })).stdout, /join_project/);
  step("session-start hook guides reconnection without force");

  console.log(`\nall ${passed} checks passed`);
} finally {
  await srv.close();
  rmSync(tmp, { recursive: true, force: true });
}
