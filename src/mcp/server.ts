import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { registerTools } from "./tools.js";
import type { ToolDeps } from "./tools.js";

const SESSION_SWEEP_INTERVAL_MS = 60_000;

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
  // Requests (or open SSE streams) currently inside handleRequest — the
  // sweep must never close a session out from under an in-flight call,
  // even when a long tool call outlives MCP_SESSION_TTL.
  inFlight: number;
}

export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer({
    name: "ilinxa-capture",
    version: "0.1.0",
  });
  registerTools(server, deps);
  return server;
}

export interface McpPluginOptions {
  env: ToolDeps["env"];
  jobManager: ToolDeps["jobManager"];
}

export async function mcpHttpPlugin(
  app: FastifyInstance,
  opts: McpPluginOptions,
): Promise<void> {
  const sessions = new Map<string, SessionEntry>();
  const ttlMs = opts.env.MCP_SESSION_TTL * 1000;

  // Idle session sweep — closes + removes sessions that haven't been
  // touched (POST or GET) in over MCP_SESSION_TTL seconds. unref()d so it
  // never keeps the process alive on its own.
  const sweepInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of sessions) {
      if (entry.inFlight === 0 && now - entry.lastActivity > ttlMs) {
        void entry.transport.close();
        sessions.delete(id);
      }
    }
  }, SESSION_SWEEP_INTERVAL_MS);
  sweepInterval.unref();

  // POST /mcp — Initialize session or send tool calls
  app.post("/mcp", async (request, reply) => {
    reply.hijack();
    const sessionId = request.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;
    let isNewSession = false;

    let existingEntry: SessionEntry | undefined;
    if (sessionId && sessions.has(sessionId)) {
      existingEntry = sessions.get(sessionId)!;
      existingEntry.lastActivity = Date.now();
      existingEntry.inFlight++;
      transport = existingEntry.transport;
    } else {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const mcpServer = createMcpServer(opts);
      await mcpServer.connect(transport);
      isNewSession = true;
    }

    try {
      await transport.handleRequest(
        request.raw,
        reply.raw,
        request.body as Record<string, unknown>,
      );
    } finally {
      if (existingEntry) {
        existingEntry.inFlight--;
        existingEntry.lastActivity = Date.now();
      }
    }

    // transport.sessionId is only populated once handleRequest() has
    // processed the "initialize" call, so registration must happen after —
    // checking it beforehand would silently drop every new session.
    if (isNewSession && transport.sessionId) {
      sessions.set(transport.sessionId, {
        transport,
        lastActivity: Date.now(),
        inFlight: 0,
      });
    }
  });

  // GET /mcp — SSE stream for server-to-client notifications
  app.get("/mcp", async (request, reply) => {
    reply.hijack();
    const sessionId = request.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      reply.raw.writeHead(400, { "Content-Type": "text/plain" });
      reply.raw.end("Invalid or missing session ID");
      return;
    }
    const entry = sessions.get(sessionId)!;
    entry.lastActivity = Date.now();
    entry.inFlight++;
    try {
      await entry.transport.handleRequest(request.raw, reply.raw);
    } finally {
      entry.inFlight--;
      entry.lastActivity = Date.now();
    }
  });

  // DELETE /mcp — Close session
  app.delete("/mcp", async (request, reply) => {
    const sessionId = request.headers["mcp-session-id"] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      const entry = sessions.get(sessionId)!;
      await entry.transport.close();
      sessions.delete(sessionId);
    }
    void reply.code(200).send();
  });

  // Cleanup all sessions + stop the sweep on app close
  app.addHook("onClose", async () => {
    clearInterval(sweepInterval);
    for (const [id, entry] of sessions) {
      await entry.transport.close();
      sessions.delete(id);
    }
  });
}
