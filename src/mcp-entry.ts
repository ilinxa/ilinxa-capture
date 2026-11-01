#!/usr/bin/env node
import pino from "pino";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "./lib/env.js";
import { CleanupScheduler } from "./core/cleanup.js";
import { JobManager } from "./core/job-manager.js";
import { createMcpServer } from "./mcp/server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function main(): Promise<void> {
  // MCP clients start this process in arbitrary folders, so the output folder
  // must not follow the working directory unless asked to.
  const env = {
    ...loadEnv(),
    ...(process.env["LOCAL_OUTPUT_DIR"] === undefined && {
      LOCAL_OUTPUT_DIR: join(homedir(), ".ilinxa-capture", "jobs"),
    }),
  };

  // CRITICAL: Logger must write to stderr (fd 2) — stdout is reserved for MCP JSON-RPC protocol
  const logger = pino({ level: env.LOG_LEVEL }, pino.destination(2));

  const jobManager = new JobManager(env, logger);
  await jobManager.recover();

  const cleanupScheduler = new CleanupScheduler({
    outputDir: env.LOCAL_OUTPUT_DIR,
    ttlSeconds: env.LOCAL_TTL_SECONDS,
    logger,
    onJobRemoved: (jobId) => jobManager.forgetJob(jobId),
    isBusy: (jobId) => jobManager.isBusy(jobId),
  });
  cleanupScheduler.start();

  const mcpServer = createMcpServer({ env, jobManager, inputMode: "stdio" });
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  logger.info(
    { outputDir: env.LOCAL_OUTPUT_DIR },
    "ilinxa-capture MCP server running on stdio",
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down`);
    try {
      cleanupScheduler.stop();
      await transport.close();
      await jobManager.shutdown();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Error during MCP shutdown");
      process.exit(1);
    }
  };

  // The SDK does not notice its client leaving. A job left running with no
  // timeout would otherwise keep going for nobody.
  process.stdin.once("end", () => void shutdown("stdin closed"));

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
