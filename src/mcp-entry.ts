import pino from "pino";
import { resolve } from "node:path";
import { loadEnv } from "./lib/env.js";
import { JobManager } from "./core/job-manager.js";
import { createMcpServer } from "./mcp/server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function main(): Promise<void> {
  const env = loadEnv();

  // CRITICAL: Logger must write to stderr (fd 2) — stdout is reserved for MCP JSON-RPC protocol
  const logger = pino({ level: env.LOG_LEVEL }, pino.destination(2));

  const jobManager = new JobManager(env, logger);
  await jobManager.recover();

  const mcpServer = createMcpServer({ env, jobManager });
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  logger.info("ilinxa-capture MCP server running on stdio");

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down`);
    try {
      await transport.close();
      await jobManager.shutdown();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Error during MCP shutdown");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
