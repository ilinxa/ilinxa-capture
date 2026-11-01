import { loadDotEnv, loadEnv } from "./lib/env.js";
import { buildApp } from "./app.js";
import { exposureWarning } from "./api/lib/net-guard.js";
import { CleanupScheduler } from "./core/cleanup.js";

async function main(): Promise<void> {
  // Set by `npm run dev`, so a plain start never gets development behavior.
  if (process.argv.includes("--dev")) {
    process.env["NODE_ENV"] ??= "development";
  }

  loadDotEnv();

  let env;
  try {
    env = loadEnv();
  } catch (err) {
    // Pre-logger — console is the only option here
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const app = await buildApp({ env });

  // Start cleanup scheduler (outside buildApp to avoid interfering with tests)
  const cleanupScheduler = new CleanupScheduler({
    outputDir: env.LOCAL_OUTPUT_DIR,
    ttlSeconds: env.LOCAL_TTL_SECONDS,
    logger: app.log,
    onJobRemoved: (jobId) => app.jobManager.forgetJob(jobId),
    isBusy: (jobId) => app.jobManager.isBusy(jobId),
  });
  cleanupScheduler.start();

  try {
    const address = await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`Server listening on ${address}`);
    const warning = exposureWarning(env.HOST);
    if (warning) app.log.warn(warning);
    app.log.info(`Health check: ${address}/api/v1/health`);
    app.log.info(`Web UI: ${address}`);
  } catch (err) {
    app.log.fatal(err, "Failed to start server");
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Received ${signal}, shutting down`);
    try {
      cleanupScheduler.stop();
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error(err, "Error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
