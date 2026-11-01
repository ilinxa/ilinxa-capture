import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JobManager } from "../core/job-manager.js";
import { createTestEnv } from "../test/env.js";
import { createMcpServer } from "./server.js";

// Regression: a URL probe has no job ID, so nothing else could ever stop it.
describe("capture_metadata on a URL", () => {
  it("hands the caller's cancel signal to the queued work", async () => {
    const runTransient = vi.fn().mockResolvedValue({ duration: 1 });
    const server = createMcpServer({
      env: createTestEnv(),
      jobManager: { runTransient } as unknown as JobManager,
    });

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "cancel", version: "0" });
    await client.connect(clientSide);

    await client.callTool({
      name: "capture_metadata",
      arguments: { source: "https://example.com/film.mp4" },
    });

    expect(runTransient).toHaveBeenCalledWith(expect.any(Function), expect.any(AbortSignal));
  });
});
