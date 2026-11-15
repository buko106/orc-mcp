// Signal: wait registration, cycle detection, fulfillment checks, long polling. Everything stays within a single project.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { type Db, type DecisionRow, type SessionRow, type WaitRow, getMember, getTask, now, pushInbox } from "./db.js";
import { log, type CommitInfo } from "./git.js";

/** Emits "change" whenever the ledger changes. Pending wait_for calls use it to re-check. */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export class WaitError extends Error {}

export type WaitCondition =
  | { kind: "task_done"; task_id: string }
  | { kind: "decision_published"; session: string; topic: string };

export interface WaitResult {
  wait_id: string;
  status: "fulfilled" | "pending" | "stalled" | "cancelled";
  condition: WaitCondition;
  target_session: string;
  target_last_seen_sec?: number;
  hint?: string;
  result?: unknown;
}

type Me = Pick<SessionRow, "project" | "name">;

function getWait(db: Db, me: Me, id: string): WaitRow {
  const w = db.prepare("SELECT * FROM waits WHERE id = ?").get(id) as WaitRow | undefined;
  if (!w || w.project !== me.project || w.waiter !== me.name) throw new WaitError(`unknown wait: ${id}`);
  return w;
}

function conditionOf(w: WaitRow): WaitCondition {
  return w.kind === "task_done"
    ? { kind: "task_done", task_id: w.task_id ?? "" }
    : { kind: "decision_published", session: w.target_session, topic: w.topic ?? "" };
}

/** If following the chain of waits from target leads back to waiter, it's a cycle (deadlock). */
function findCycle(db: Db, project: string, waiter: string, target: string): string[] | null {
  const edges = db.prepare("SELECT waiter, target_session FROM waits WHERE project = ? AND status = 'active'").all(project) as {
    waiter: string;
    target_session: string;
  }[];
  const stack: string[][] = [[waiter, target]];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const path = stack.pop()!;
    const cur = path[path.length - 1]!;
    if (cur === waiter) return path;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const e of edges) if (e.waiter === cur) stack.push([...path, e.target_session]);
  }
  return null;
}

export function createWait(db: Db, me: Me, cond: WaitCondition): string {
  let target: string;
  if (cond.kind === "task_done") {
    const task = getTask(db, me.project, cond.task_id);
    if (!task) throw new WaitError(`unknown task: ${cond.task_id} (check get_overview for task ids)`);
    target = task.owner;
  } else {
    if (!getMember(db, me.project, cond.session)) throw new WaitError(`unknown session: ${cond.session}`);
    target = cond.session;
  }
  if (target === me.name) throw new WaitError("cannot wait on your own work");
  const cycle = findCycle(db, me.project, me.name, target);
  if (cycle) throw new WaitError(`deadlock: this wait would create a cycle (${cycle.join(" -> ")})`);

  const id = randomUUID();
  db.prepare(
    "INSERT INTO waits (id, project, waiter, kind, target_session, task_id, topic, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)",
  ).run(id, me.project, me.name, cond.kind, target, cond.kind === "task_done" ? cond.task_id : null, cond.kind === "decision_published" ? cond.topic : null, now());
  const what = cond.kind === "task_done" ? `task "${cond.task_id}" to be done` : `a decision on topic "${cond.topic}"`;
  pushInbox(db, me.project, target, `Session "${me.name}" is waiting for ${what}.`);
  bus.emit("change");
  return id;
}

export function cancelWait(db: Db, me: Me, id: string): void {
  const w = getWait(db, me, id);
  if (w.status === "active") {
    db.prepare("UPDATE waits SET status = 'cancelled', resolved_at = ? WHERE id = ?").run(now(), id);
    bus.emit("change");
  }
}

/** When a participant leaves, cancel the waits that participant holds. */
export function cancelWaitsOf(db: Db, me: Me): void {
  db.prepare("UPDATE waits SET status = 'cancelled', resolved_at = ? WHERE project = ? AND waiter = ? AND status = 'active'").run(now(), me.project, me.name);
  bus.emit("change");
}

/** If fulfilled, returns enough information for the waiter to resume right away. Otherwise null. */
export async function evaluate(db: Db, w: WaitRow): Promise<unknown | null> {
  if (w.kind === "task_done") {
    const task = getTask(db, w.project, w.task_id ?? "");
    if (!task || task.status !== "done") return null;
    const target = getMember(db, w.project, w.target_session);
    let commits: CommitInfo[] = [];
    if (target && task.commit_sha) {
      try {
        commits = await log(target.repo_path, target.base_sha, 30);
      } catch {
        /* fulfill the wait even if the repository can't be read */
      }
    }
    const decisions = db
      .prepare("SELECT id, topic, decision, rationale, affects, head_sha, created_at FROM decisions WHERE project = ? AND session = ? ORDER BY id DESC LIMIT 5")
      .all(w.project, w.target_session);
    return { task, commits_since_base: commits, recent_decisions: decisions };
  }
  const decision = db
    .prepare("SELECT * FROM decisions WHERE project = ? AND session = ? AND topic = ? ORDER BY id DESC LIMIT 1")
    .get(w.project, w.target_session, w.topic) as DecisionRow | undefined;
  return decision ? { decision } : null;
}

/**
 * Long-polls a wait for at most timeoutSec seconds.
 * MCP tool calls have a timeout, so this does not wait indefinitely;
 * if not fulfilled, it returns pending and the caller calls again.
 */
export async function poll(db: Db, me: Me, waitId: string, timeoutSec: number, staleSec: number, signal?: AbortSignal): Promise<WaitResult> {
  const deadline = now() + timeoutSec * 1000;
  for (;;) {
    const w = getWait(db, me, waitId);
    const base = { wait_id: w.id, condition: conditionOf(w), target_session: w.target_session };
    if (w.status === "cancelled") return { ...base, status: "cancelled" };

    const result = await evaluate(db, w);
    if (result) {
      if (w.status === "active") db.prepare("UPDATE waits SET status = 'fulfilled', resolved_at = ? WHERE id = ?").run(now(), w.id);
      return { ...base, status: "fulfilled", result };
    }

    const remaining = deadline - now();
    if (remaining <= 0 || signal?.aborted) {
      const target = getMember(db, w.project, w.target_session);
      const idleSec = target ? Math.round((now() - target.last_seen) / 1000) : undefined;
      const stalled = idleSec === undefined || idleSec > staleSec;
      return {
        ...base,
        status: stalled ? "stalled" : "pending",
        target_last_seen_sec: idleSec,
        hint: stalled
          ? "The target session has left the project or has not contacted the orchestrator for a long time. Tell the user instead of waiting further."
          : "Not fulfilled yet. Call wait_for again with this wait_id to keep waiting. If you have nothing else to do and end your turn, tell the user what you are waiting for; when the orchestrator's Stop hook is installed you are woken automatically once it is fulfilled.",
      };
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        bus.off("change", done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, remaining);
      bus.once("change", done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}

// ---------- For hooks: keep waiting in the background after the turn ends, and wake Claude when fulfilled ----------

export type HookWaitResult =
  | { status: "none" | "pending" | "superseded" }
  | { status: "fulfilled"; wait_id: string; condition: WaitCondition; result: unknown };

/** Only the latest background wait per participant is kept. When a new request arrives, the old one is ended. */
const hookWaiters = new Map<string, AbortController>();

/**
 * Blocks for at most holdSec seconds until any of the participant's waits is fulfilled.
 * A fulfilled wait can be "claimed" only once (so other concurrent callers don't notify again).
 */
export async function waitForAnyFulfilled(db: Db, me: Me, holdSec: number, signal?: AbortSignal): Promise<HookWaitResult> {
  const key = `${me.project}/${me.name}`;
  hookWaiters.get(key)?.abort();
  const mine = new AbortController();
  hookWaiters.set(key, mine);
  const deadline = now() + holdSec * 1000;
  try {
    for (;;) {
      if (mine.signal.aborted) return { status: "superseded" };
      const active = db.prepare("SELECT * FROM waits WHERE project = ? AND waiter = ? AND status = 'active' ORDER BY created_at").all(me.project, me.name) as unknown as WaitRow[];
      if (active.length === 0) return { status: "none" };
      for (const w of active) {
        const result = await evaluate(db, w);
        if (!result) continue;
        const claimed = db.prepare("UPDATE waits SET status = 'fulfilled', resolved_at = ? WHERE id = ? AND status = 'active'").run(now(), w.id);
        if (Number(claimed.changes) === 1) return { status: "fulfilled", wait_id: w.id, condition: conditionOf(w), result };
      }
      const remaining = deadline - now();
      if (remaining <= 0 || signal?.aborted) return { status: "pending" };
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          bus.off("change", done);
          signal?.removeEventListener("abort", done);
          mine.signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, remaining);
        bus.once("change", done);
        signal?.addEventListener("abort", done, { once: true });
        mine.signal.addEventListener("abort", done, { once: true });
      });
    }
  } finally {
    if (hookWaiters.get(key) === mine) hookWaiters.delete(key);
  }
}
