#!/usr/bin/env node
// A small command run from Claude Code hooks. Reads the hook input (JSON) from stdin and queries the orchestrator.
//   node dist/src/hook.js session-start   … SessionStart hook. stdout goes into Claude's context.
//   node dist/src/hook.js stop-wait       … Stop hook (asyncRewake). Wakes Claude with exit code 2 when a wait is fulfilled.
// If the orchestrator is unreachable, does nothing and exits with code 0 (stays out of the session's way).

const base = `http://127.0.0.1:${process.env.ORC_PORT ?? 4700}`;
const headers: Record<string, string> = { "content-type": "application/json" };
if (process.env.ORC_TOKEN) headers.authorization = `Bearer ${process.env.ORC_TOKEN}`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim() || "{}";
}

async function post(path: string, body: string): Promise<Record<string, unknown>> {
  const res = await fetch(base + path, { method: "POST", headers, body });
  if (!res.ok) throw new Error(`orchestrator returned ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

const mode = process.argv[2];
try {
  const input = await readStdin();
  if (mode === "session-start") {
    const r = await post("/hooks/session-start", input);
    if (typeof r.context === "string") process.stdout.write(r.context + "\n");
  } else if (mode === "stop-wait") {
    for (;;) {
      const r = await post("/hooks/stop-wait", input);
      if (r.status === "fulfilled") {
        process.stderr.write(String(r.message) + "\n");
        process.exit(2);
      }
      if (r.status !== "pending") break; // none / superseded
    }
  } else {
    process.stderr.write("usage: hook.js session-start | stop-wait\n");
    process.exit(1);
  }
} catch {
  // e.g. the orchestrator is not running. Exit quietly.
}
process.exit(0);
