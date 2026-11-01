import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ZodObject, ZodRawShape } from "zod";
import {
  audioRequestSchema,
  combinedRequestSchema,
  composeRequestSchema,
  extractRequestSchema,
  hlsDiscoverRequestSchema,
  metadataRequestSchema,
  shotsRequestSchema,
  videoDownloadRequestSchema,
  videoFormatsRequestSchema,
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

  it.each(PAIRS)("%s has the same defaults as REST", (tool, schema) => {
    const options = tools.get(tool) ?? {};

    for (const [name, option] of Object.entries(options)) {
      const field = schema.shape[name];
      const parsed = field?.safeParse(undefined);
      if (!parsed?.success || parsed.data === undefined) continue;

      expect((option as { default?: unknown }).default, `${tool}.${name}`).toEqual(
        parsed.data,
      );
    }
  });

  it("covers the tools that take options but start no job", () => {
    expect(Object.keys(tools.get("capture_metadata") ?? {})).toEqual(
      Object.keys(metadataRequestSchema.shape),
    );
    for (const tool of ["capture_video_formats", "capture_hls_discover"]) {
      const schema =
        tool === "capture_video_formats"
          ? videoFormatsRequestSchema
          : hlsDiscoverRequestSchema;
      expect(Object.keys(tools.get(tool) ?? {}).sort()).toEqual(
        Object.keys(schema.shape).sort(),
      );
    }
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
