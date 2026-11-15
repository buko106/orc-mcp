// Ledger: stores state in SQLite (Node's built-in node:sqlite).
// Every row belongs to a project (shared name), and every query filters by project. This is what isolation actually rests on.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = DatabaseSync;

export interface SessionRow {
  project: string;
  name: string;
  repo_path: string;
  role: string;
  base_sha: string | null;
  /** The MCP connection currently acting as this participant. Invalidated on server restart. */
  conn_id: string | null;
  registered_at: number;
  last_seen: number;
}
export interface TaskRow {
  project: string;
  id: string;
  owner: string;
  title: string;
  status: "todo" | "in_progress" | "blocked" | "done";
  note: string | null;
  commit_sha: string | null;
  updated_at: number;
}
export interface DecisionRow {
  id: number;
  project: string;
  session: string;
  topic: string;
  decision: string;
  rationale: string | null;
  affects: string | null;
  head_sha: string | null;
  created_at: number;
}
export interface WaitRow {
  id: string;
  project: string;
  waiter: string;
  kind: "task_done" | "decision_published";
  target_session: string;
  task_id: string | null;
  topic: string | null;
  status: "active" | "fulfilled" | "cancelled";
  created_at: number;
  resolved_at: number | null;
}

const SCHEMA_VERSION = 2;
const SCHEMA = `
CREATE TABLE sessions (
  project TEXT NOT NULL,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL UNIQUE,   -- a repository belongs to only one project and one name at a time
  role TEXT NOT NULL,
  base_sha TEXT,
  conn_id TEXT,
  registered_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (project, name)
);
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  session TEXT NOT NULL,
  topic TEXT NOT NULL,
  decision TEXT NOT NULL,
  rationale TEXT,
  affects TEXT,
  head_sha TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE tasks (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  owner TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  commit_sha TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project, id)
);
CREATE TABLE waits (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  waiter TEXT NOT NULL,
  kind TEXT NOT NULL,
  target_session TEXT NOT NULL,
  task_id TEXT,
  topic TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  session TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
`;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (user_version !== SCHEMA_VERSION) {
    // This is a prototype, so there are no migrations. Recreate if the schema differs.
    for (const t of ["sessions", "decisions", "tasks", "waits", "inbox"]) db.exec(`DROP TABLE IF EXISTS ${t}`);
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  // MCP connections exist only in-process, so treat them all as disconnected at startup.
  db.exec("UPDATE sessions SET conn_id = NULL");
  return db;
}

export const now = () => Date.now();

export function getMember(db: Db, project: string, name: string): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE project = ? AND name = ?").get(project, name) as SessionRow | undefined;
}

export function getMemberByConn(db: Db, connId: string): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE conn_id = ?").get(connId) as SessionRow | undefined;
}

export function getMemberByRepo(db: Db, repoPath: string): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE repo_path = ?").get(repoPath) as SessionRow | undefined;
}

export function touchMember(db: Db, m: Pick<SessionRow, "project" | "name">): void {
  db.prepare("UPDATE sessions SET last_seen = ? WHERE project = ? AND name = ?").run(now(), m.project, m.name);
}

export function getTask(db: Db, project: string, id: string): TaskRow | undefined {
  return db.prepare("SELECT * FROM tasks WHERE project = ? AND id = ?").get(project, id) as TaskRow | undefined;
}

export function pushInbox(db: Db, project: string, session: string, message: string): void {
  db.prepare("INSERT INTO inbox (project, session, message, created_at) VALUES (?, ?, ?, ?)").run(project, session, message, now());
}

/** Takes undelivered notices and marks them delivered. They are piggybacked on each tool response. */
export function drainInbox(db: Db, project: string, session: string): string[] {
  const rows = db
    .prepare("SELECT message FROM inbox WHERE project = ? AND session = ? AND delivered_at IS NULL ORDER BY id")
    .all(project, session) as { message: string }[];
  if (rows.length > 0) {
    db.prepare("UPDATE inbox SET delivered_at = ? WHERE project = ? AND session = ? AND delivered_at IS NULL").run(now(), project, session);
  }
  return rows.map((r) => r.message);
}
