// HTTP server. Listens on 127.0.0.1 only. Holds one MCP server per MCP connection (Mcp-Session-Id),
// and uses that connection ID to identify which session a call comes from.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openDb } from "./db.js";
import { buildServer } from "./tools.js";
import { hookSessionStart, hookStopWait } from "./hooks.js";

export interface Options {
  port: number;
  dbPath: string;
  /** When set, Authorization: Bearer <token> is required. */
  token?: string;
  staleSec?: number;
  /** If an existing connection was used within this many seconds, it is considered "live" and joining under the same name is rejected. */
  takeoverSec?: number;
  /** MCP connections unused for this many seconds are discarded. */
  connIdleSec?: number;
  /** Maximum seconds to hold a single hook wait request. The hook calls again while pending. */
  hookHoldSec?: number;
}

function send(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 4 * 1024 * 1024) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function tokenOk(header: string | undefined, token: string): boolean {
  const a = Buffer.from(header ?? "");
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface Conn {
  transport: StreamableHTTPServerTransport;
  mcp: McpServer;
  lastUsed: number;
}

export async function startServer(opts: Options): Promise<{ port: number; close: () => Promise<void> }> {
  const db = openDb(opts.dbPath);
  const staleSec = opts.staleSec ?? 1800;
  const takeoverMs = (opts.takeoverSec ?? 120) * 1000;
  const connIdleMs = (opts.connIdleSec ?? 86_400) * 1000;
  const conns = new Map<string, Conn>();
  const isLive = (id: string) => {
    const c = conns.get(id);
    return c !== undefined && Date.now() - c.lastUsed < takeoverMs;
  };

  const sweep = setInterval(() => {
    for (const [id, c] of conns) if (Date.now() - c.lastUsed > connIdleMs) void c.transport.close().catch(() => conns.delete(id));
  }, 600_000);
  sweep.unref();

  const http: Server = createServer(async (req, res) => {
    try {
      const port = (http.address() as AddressInfo).port;
      // DNS rebinding protection: reject if Host is not localhost. Also reject browser requests (with Origin).
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? "")) return send(res, 403, "forbidden host");
      if (req.headers.origin) return send(res, 403, "browser requests are not allowed");

      const url = new URL(req.url ?? "/", "http://localhost");
      if (opts.token && !tokenOk(req.headers.authorization, opts.token)) return send(res, 401, "unauthorized");

      // Endpoints for Claude Code hooks
      if (url.pathname.startsWith("/hooks/")) {
        if (req.method !== "POST") return send(res, 405, "method not allowed");
        let input: { cwd?: unknown; source?: unknown };
        try {
          input = ((await readJson(req)) ?? {}) as typeof input;
        } catch {
          return send(res, 400, "invalid JSON body");
        }
        const abort = new AbortController();
        res.on("close", () => abort.abort());
        let out: object;
        if (url.pathname === "/hooks/stop-wait") out = await hookStopWait(db, input, opts.hookHoldSec ?? 240, abort.signal);
        else if (url.pathname === "/hooks/session-start") out = await hookSessionStart(db, input);
        else return send(res, 404, "not found");
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
        return;
      }

      if (url.pathname !== "/mcp") return send(res, 404, "not found");

      let body: unknown;
      if (req.method === "POST") {
        try {
          body = await readJson(req);
        } catch {
          return send(res, 400, "invalid JSON body");
        }
      }

      const hdr = req.headers["mcp-session-id"];
      const sid = Array.isArray(hdr) ? hdr[0] : hdr;
      if (sid) {
        // Existing connection. For an unknown ID (e.g. after a server restart), return 404 so the client reinitializes.
        const conn = conns.get(sid);
        if (!conn) return send(res, 404, "unknown MCP session; initialize again");
        conn.lastUsed = Date.now();
        await conn.transport.handleRequest(req, res, body);
        return;
      }

      if (req.method !== "POST" || !isInitializeRequest(body)) return send(res, 400, "no MCP session; send initialize first");
      const connId = randomUUID();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => connId, enableJsonResponse: true });
      transport.onclose = () => conns.delete(connId);
      const mcp = buildServer({ db, connId, staleSec, isLive });
      conns.set(connId, { transport, mcp, lastUsed: Date.now() });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      console.error("[orc-mcp] request failed:", e);
      if (!res.headersSent) send(res, 500, "internal error");
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, "127.0.0.1", resolve);
  });
  return {
    port: (http.address() as AddressInfo).port,
    close: async () => {
      clearInterval(sweep);
      for (const c of [...conns.values()]) await c.transport.close().catch(() => {});
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      db.close();
    },
  };
}
