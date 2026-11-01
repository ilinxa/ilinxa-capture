import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ffmpeg, makeClip } from "./helpers.js";

const REPO = resolve(import.meta.dirname, "..", "..");

/**
 * The real stdio server as an MCP client starts it: its own process, in an
 * arbitrary working directory, speaking JSON-RPC over stdin and stdout.
 */
describe("MCP over stdio (real process)", () => {
  let dir: string;
  let home: string;
  let cwd: string;
  let clip: string;
  let client: Client;
  let transport: StdioClientTransport;

  type ToolResult = { isError?: boolean; content: Array<{ text: string }> };

  async function call<T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;
    expect(result.isError ?? false, result.content[0]?.text).toBe(false);
    return JSON.parse(result.content[0]!.text) as T;
  }

  async function callError(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;
    expect(result.isError).toBe(true);
    return result.content[0]!.text;
  }

  async function waitForJob<T>(jobId: string): Promise<T & { status: string }> {
    for (let i = 0; i < 400; i++) {
      const job = await call<T & { status: string }>("capture_job_status", {
        job_id: jobId,
      });
      if (job.status === "completed" || job.status === "failed") return job;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("job did not finish");
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ilinxa-capture-stdio-"));
    home = join(dir, "home");
    cwd = join(dir, "client folder with spaces");
    await mkdir(cwd, { recursive: true });

    clip = join(dir, "clip with spaces é.mp4");
    await makeClip(clip, { seconds: 30, size: "320x180", rate: 10 });

    // A finished job past its TTL, for the cleanup test.
    const expired = join(home, ".ilinxa-capture", "jobs", "cap_0000e0e0");
    await mkdir(expired, { recursive: true });
    await writeFile(
      join(expired, "job.json"),
      JSON.stringify({
        id: "cap_0000e0e0",
        type: "extract",
        status: "completed",
        created_at: "2020-01-01T00:00:00.000Z",
        completed_at: "2020-01-01T00:00:00.000Z",
      }),
    );

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: home,
      USERPROFILE: home,
      LOG_LEVEL: "error",
    };
    delete env["LOCAL_OUTPUT_DIR"];

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        join(REPO, "node_modules", "tsx", "dist", "cli.mjs"),
        join(REPO, "src", "mcp-entry.ts"),
      ],
      cwd,
      env,
      stderr: "ignore",
    });
    client = new Client({ name: "stdio-test", version: "0" });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("offers the full tool list", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["capture_shots", "capture_audio", "capture_job_delete"]),
    );
    expect(tools).toHaveLength(12);
  });

  it("reads a local path with spaces and accents, with no configuration", async () => {
    const meta = await call<{ duration: number }>("capture_metadata", { source: clip });
    expect(meta.duration).toBeCloseTo(30, 0);
  });

  it("writes output under the home folder, not the client's working directory", async () => {
    const result = await call<{ job_id: string; frames: { files: string[] } }>(
      "capture_extract",
      { source: clip, fps: 1 },
    );

    expect(result.frames.files[0]).toContain(join(home, ".ilinxa-capture", "jobs"));
    await access(join(home, ".ilinxa-capture", "jobs", result.job_id, "manifest.json"));
    await expect(access(join(cwd, "data"))).rejects.toThrow();
  });

  it("runs cleanup, unlike earlier versions", async () => {
    await expect(
      access(join(home, ".ilinxa-capture", "jobs", "cap_0000e0e0")),
    ).rejects.toThrow();
  });

  it("returns a job at once with async, and progress via status", async () => {
    const started = await call<{ job_id: string; status: string }>("capture_extract", {
      source: clip,
      fps: 5,
      async: true,
    });
    expect(started.status).toBe("pending");

    const done = await waitForJob<{ result: { frames: { count: number } } }>(started.job_id);
    expect(done.status).toBe("completed");
    expect(done.result.frames.count).toBe(150);
  });

  it("sends progress notifications when asked", async () => {
    const seen: string[] = [];
    await client.callTool(
      {
        name: "capture_extract",
        arguments: { source: clip, fps: 10, preset: "high" },
      },
      undefined,
      {
        onprogress: (progress) => {
          if (progress.message) seen.push(progress.message);
        },
      },
    );

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((m) => m.startsWith("extracting"))).toBe(true);
  });

  it("sends no progress after an async response", async () => {
    const seen: string[] = [];
    const result = (await client.callTool(
      { name: "capture_extract", arguments: { source: clip, fps: 10, async: true } },
      undefined,
      {
        onprogress: (progress) => {
          if (progress.message) seen.push(progress.message);
        },
      },
    )) as ToolResult;

    const { job_id: jobId } = JSON.parse(result.content[0]!.text) as { job_id: string };
    await waitForJob(jobId);
    expect(seen).toEqual([]);
  });

  it("shows progress in status while a job runs", async () => {
    const slow = join(dir, "slow.mp4");
    await makeClip(slow, { seconds: 60, size: "1280x720", rate: 30 });

    const { job_id: jobId } = await call<{ job_id: string }>("capture_extract", {
      source: slow,
      fps: 30,
      preset: "high",
      async: true,
    });

    let progress: { stage: string; percent: number | null } | null = null;
    for (let i = 0; i < 400 && progress === null; i++) {
      const job = await call<{ progress: typeof progress }>("capture_job_status", {
        job_id: jobId,
      });
      progress = job.progress;
    }

    expect(progress).toMatchObject({ stage: "extracting" });
    await call("capture_job_delete", { job_id: jobId });
  });

  // Regression: a client's timeout left a hidden job holding a slot, with no ID
  // for anyone to stop it by.
  it("stops a sync job when the client cancels the call", async () => {
    const slow = join(dir, "cancel.mp4");
    await makeClip(slow, { seconds: 60, size: "1280x720", rate: 30 });

    const controller = new AbortController();
    const started = client
      .callTool(
        { name: "capture_extract", arguments: { source: slow, fps: 30, preset: "high" } },
        undefined,
        { signal: controller.signal },
      )
      .catch((err: unknown) => err);

    const jobsDir = join(home, ".ilinxa-capture", "jobs");
    const before = new Set(await readdir(jobsDir));
    let jobId: string | undefined;
    for (let i = 0; i < 200 && !jobId; i++) {
      await new Promise((r) => setTimeout(r, 25));
      jobId = (await readdir(jobsDir)).find(
        (entry) => !before.has(entry) && entry.startsWith("cap_"),
      );
    }
    expect(jobId).toBeDefined();

    await new Promise((r) => setTimeout(r, 300));
    controller.abort();
    await started;

    let status = "";
    for (let i = 0; i < 200 && status !== "failed"; i++) {
      const job = await call<{ status: string; error_code: string | null }>(
        "capture_job_status",
        { job_id: jobId },
      );
      status = job.status;
      if (status === "failed") expect(job.error_code).toBe("JOB_CANCELLED");
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(status).toBe("failed");
  }, 60_000);

  it("keeps output small on a big job, and pages the rest from the manifest", async () => {
    const result = await client.callTool({
      name: "capture_extract",
      arguments: { source: clip, fps: 10 },
    });
    const text = (result as ToolResult).content[0]!.text;
    const body = JSON.parse(text) as {
      job_id: string;
      manifest_file: string;
      frames: { count: number; files: string[]; truncated: boolean };
    };

    expect(body.frames.count).toBe(300);
    expect(body.frames.files).toHaveLength(200);
    expect(body.frames.truncated).toBe(true);
    await stat(body.manifest_file);

    const page = await call<{ total: number; items: Array<{ index: number; pts_time: number }> }>(
      "capture_job_manifest",
      { job_id: body.job_id, offset: 250, limit: 10 },
    );
    expect(page.total).toBe(300);
    expect(page.items).toHaveLength(10);
    expect(page.items[0]).toMatchObject({ index: 250, pts_time: 25 });
  });

  it("detects shots and exports audio", async () => {
    const film = join(dir, "film.mkv");
    await ffmpeg(
      "-f", "lavfi", "-i", "color=c=red:s=160x90:r=25:d=2",
      "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=25:d=2",
      "-f", "lavfi", "-i", "sine=d=4",
      "-filter_complex", "[0][1]concat=n=2:v=1:a=0[v]",
      "-map", "[v]",
      "-map", "2:a",
      film,
    );

    const shots = await call<{ shots: { count: number }; frames: { count: number } }>(
      "capture_shots",
      { source: film },
    );
    expect(shots.shots.count).toBe(2);
    expect(shots.frames.count).toBe(2);

    const audio = await call<{ audio: { file: string; sample_rate: number } }>("capture_audio", {
      source: film,
      sample_rate: 16000,
      channels: 1,
    });
    expect(audio.audio.sample_rate).toBe(16000);
    await access(audio.audio.file);
  });

  it("deletes a job and its files", async () => {
    const { job_id: jobId } = await call<{ job_id: string }>("capture_extract", {
      source: clip,
      fps: 1,
    });

    await call("capture_job_delete", { job_id: jobId });

    await expect(
      access(join(home, ".ilinxa-capture", "jobs", jobId)),
    ).rejects.toThrow();
    expect(await callError("capture_job_status", { job_id: jobId })).toContain("not found");
  });

  it("refuses non-file sources and bad job IDs", async () => {
    expect(
      await callError("capture_extract", { source: "concat:a|b", fps: 1 }),
    ).toContain("Only http(s)");

    const res = (await client.callTool({
      name: "capture_compose",
      arguments: { job_id: "../outside", mode: 4 },
    })) as ToolResult;
    expect(res.isError).toBe(true);
  });

  it("composes only real images", async () => {
    const note = join(dir, "note.txt");
    await writeFile(note, "not an image");
    const { frames } = await call<{ frames: { files: string[] } }>("capture_extract", {
      source: clip,
      fps: 1,
    });

    expect(
      await callError("capture_compose", { frames: [frames.files[0], note], mode: 1 }),
    ).toContain("not a readable image");
  });

  // The SDK client hides unparseable lines, so this reads the raw stream.
  it("writes nothing but JSON-RPC to stdout", async () => {
    const child = spawn(
      process.execPath,
      [join(REPO, "node_modules", "tsx", "dist", "cli.mjs"), join(REPO, "src", "mcp-entry.ts")],
      {
        cwd,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          LOG_LEVEL: "trace",
        },
        stdio: ["pipe", "pipe", "ignore"],
      },
    );

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));

    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "raw", version: "0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "capture_metadata", arguments: { source: clip } },
    });

    for (let i = 0; i < 600 && !stdout.includes('"id":3'); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    child.stdin.end();

    const lines = stdout.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect((JSON.parse(line) as { jsonrpc: string }).jsonrpc).toBe("2.0");
    }
  }, 60_000);

  // Regression: with the client gone, a job kept running for nobody.
  it("exits when the client goes away, stopping any running job", async () => {
    const pid = transport.pid;
    expect(pid).toBeTruthy();

    const slow = join(dir, "orphan.mp4");
    await makeClip(slow, { seconds: 60, size: "1280x720", rate: 30 });
    await call("capture_extract", { source: slow, fps: 30, preset: "high", async: true });

    await client.close();

    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try {
        process.kill(pid!, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });
});
