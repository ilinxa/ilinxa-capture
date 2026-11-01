import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ZodObject, ZodRawShape } from "zod";
import {
  audioRequestSchema,
  combinedRequestSchema,
  composeRequestSchema,
  extractRequestSchema,
  shotsRequestSchema,
  videoDownloadRequestSchema,
} from "../api/schemas.js";
import type { JobManager } from "../core/job-manager.js";
import { createTestEnv } from "../test/env.js";
import { createMcpServer } from "./server.js";

// Webhooks are for callers with a URL to be called on. An agent polls instead.
const REST_ONLY = new Set(["webhook_url"]);

const PAIRS: Array<[string, ZodObject<ZodRawShape>]> = [
  ["capture_extract", extractRequestSchema],
  ["capture_compose", composeRequestSchema],
  ["capture_extract_and_compose", combinedRequestSchema],
  ["capture_shots", shotsRequestSchema],
  ["capture_audio", audioRequestSchema],
  ["capture_video_download", videoDownloadRequestSchema],
];

/** Fails when an option reaches one interface and not the other. */
describe("REST and MCP stay in step", () => {
  let tools: Map<string, Record<string, unknown>>;

  beforeAll(async () => {
    const server = createMcpServer({
      env: createTestEnv(),
      jobManager: {} as JobManager,
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);

    const client = new Client({ name: "parity", version: "0" });
    await client.connect(clientSide);

    const list = await client.listTools();
    tools = new Map(
      list.tools.map((tool) => [
        tool.name,
        (tool.inputSchema.properties ?? {}) as Record<string, unknown>,
      ]),
    );
  });

  it.each(PAIRS)("%s has every REST option, and no others", (tool, schema) => {
    const rest = Object.keys(schema.shape)
      .filter((key) => !REST_ONLY.has(key))
      .sort();
    const mcp = Object.keys(tools.get(tool) ?? {}).sort();

    expect(mcp).toEqual(rest);
  });

  it.each(PAIRS)("every option of %s is described for agents", (tool) => {
    for (const [name, option] of Object.entries(tools.get(tool) ?? {})) {
      expect(
        (option as { description?: string }).description,
        `${tool}.${name} has no description`,
      ).toBeTruthy();
    }
  });
});
