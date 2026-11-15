#!/usr/bin/env node
// Startup entry point. Configuration is passed via environment variables.
import { homedir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.js";

const port = Number(process.env.ORC_PORT ?? 4700);
const dbPath = process.env.ORC_DB ?? join(homedir(), ".orc-mcp", "orc.db");
const staleSec = Number(process.env.ORC_STALE_SEC ?? 1800);

const takeoverSec = Number(process.env.ORC_TAKEOVER_SEC ?? 120);

const { port: actual } = await startServer({ port, dbPath, token: process.env.ORC_TOKEN || undefined, staleSec, takeoverSec });
console.error(`[orc-mcp] listening on http://127.0.0.1:${actual}/mcp  (db: ${dbPath}${process.env.ORC_TOKEN ? ", token required" : ""})`);
