import { describe, it, expect } from "vitest";
import { execFileAsync } from "./exec.js";

// Real child processes: `node -e` behaves the same on Windows and Linux.
const node = process.execPath;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe("execFileAsync", () => {
  it("resolves with stdout and stderr", async () => {
    const result = await execFileAsync(node, [
      "-e",
      "console.log('out'); console.error('err')",
    ]);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
  });

  it("rejects on a non-zero exit with the exit code and stderr tail", async () => {
    await expect(
      execFileAsync(node, ["-e", "console.error('boom'); process.exit(3)"]),
    ).rejects.toThrow(/code 3: boom/);
  });

  it("rejects when the command does not exist", async () => {
    await expect(execFileAsync("definitely-not-a-binary", [])).rejects.toThrow(
      /ENOENT/,
    );
  });

  it("delivers stdout by line and retains none of it", async () => {
    const lines: string[] = [];
    const result = await execFileAsync(
      node,
      ["-e", "process.stdout.write('a\\nb\\r\\nc')"],
      { onStdoutLine: (line) => lines.push(line) },
    );
    expect(lines).toEqual(["a", "b", "c"]);
    expect(result.stdout).toBe("");
  });

  it("keeps consumed stderr lines out of the tail", async () => {
    const result = await execFileAsync(
      node,
      ["-e", "console.error('progress=1'); console.error('real error')"],
      { onStderrLine: (line) => line.startsWith("progress=") },
    );
    expect(result.stderr.trim()).toBe("real error");
  });

  it("survives more stderr than the old 1 MiB execFile limit", async () => {
    const result = await execFileAsync(node, [
      "-e",
      "const l='x'.repeat(1023)+'\\n';for(let i=0;i<3000;i++)process.stderr.write(l);console.error('END')",
    ]);
    expect(result.stderr.trimEnd().endsWith("END")).toBe(true);
    expect(result.stderr.length).toBeLessThanOrEqual(16 * 1024);
  });

  it("kills the process and rejects with the abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("job timed out");
    let pid = 0;

    const run = execFileAsync(
      node,
      ["-e", "console.log(process.pid); setInterval(() => {}, 1000)"],
      {
        signal: controller.signal,
        onStdoutLine: (line) => {
          pid = Number(line);
          controller.abort(reason);
        },
      },
    );

    await expect(run).rejects.toBe(reason);
    expect(pid).toBeGreaterThan(0);
    expect(await waitForExit(pid)).toBe(true);
  });

  it("kills grandchildren too, as yt-dlp's ffmpeg would be", async () => {
    const controller = new AbortController();
    let grandchild = 0;

    const parent = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      console.log(child.pid);
      setInterval(() => {}, 1000);
    `;
    const run = execFileAsync(node, ["-e", parent], {
      signal: controller.signal,
      onStdoutLine: (line) => {
        grandchild = Number(line);
        controller.abort(new Error("stop"));
      },
    });

    await expect(run).rejects.toThrow("stop");
    expect(grandchild).toBeGreaterThan(0);
    expect(await waitForExit(grandchild)).toBe(true);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const reason = new Error("already gone");
    await expect(
      execFileAsync(node, ["-e", ""], { signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
  });

  it("enforces timeoutMs", async () => {
    await expect(
      execFileAsync(node, ["-e", "setInterval(() => {}, 1000)"], {
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/timed out after 200ms/);
  });

  it("rejects when stdout exceeds maxBuffer", async () => {
    await expect(
      execFileAsync(
        node,
        ["-e", "for(;;)process.stdout.write('x'.repeat(65536))"],
        { maxBuffer: 1024 },
      ),
    ).rejects.toThrow(/exceeded 1024 bytes/);
  });
});
