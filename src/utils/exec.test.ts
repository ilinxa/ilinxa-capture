import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  // Regression: a descendant outside the process group holds stdout open, so
  // `close` never fires, and a job could never finish being cancelled.
  it("stops waiting for a descendant that escaped and holds the pipes", async () => {
    const parent = `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", "setTimeout(() => {}, 12000)"], {
        detached: true,
        stdio: ["ignore", "inherit", "inherit"],
      }).unref();
      console.log("ready");
      setInterval(() => {}, 1000);
    `;
    const controller = new AbortController();
    const started = Date.now();

    const run = execFileAsync(node, ["-e", parent], {
      signal: controller.signal,
      onStdoutLine: () => controller.abort(new Error("stop")),
    });

    await expect(run).rejects.toThrow("stop");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  // Regression: `close` waits for the pipes, so a process that had finished was
  // waited on for as long as anything it left behind kept running.
  it("does not wait on pipes a descendant kept after the process exited", async () => {
    const parent = `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", "setTimeout(() => {}, 12000)"], {
        detached: true,
        stdio: ["ignore", "inherit", "inherit"],
      }).unref();
      console.log("done");
      process.exit(0);
    `;
    const started = Date.now();

    const result = await execFileAsync(node, ["-e", parent]);

    expect(result.stdout.trim()).toBe("done");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it("still reports the exit code of a process that left pipes held", async () => {
    const parent = `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], {
        detached: true,
        stdio: ["ignore", "inherit", "inherit"],
      }).unref();
      process.exit(7);
    `;

    await expect(execFileAsync(node, ["-e", parent])).rejects.toThrow(/code 7/);
  }, 15_000);

  // A Node parent hides a missing tree kill on Windows, because libuv ties its
  // children to it. yt-dlp is Python, so the middle process here is not Node.
  it.runIf(process.platform === "win32")(
    "kills through a parent that is not Node",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "ilinxa-tree-"));
      const pidFile = join(dir, "pid");
      const script = join(dir, "grandchild.js");
      const launcher = join(dir, "run.cmd");
      writeFileSync(
        script,
        `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
          "setInterval(() => {}, 1000);",
      );
      writeFileSync(launcher, `@"${node}" "${script}" >NUL 2>&1 <NUL\r\n`);

      const controller = new AbortController();
      const run = execFileAsync("cmd.exe", ["/c", launcher], {
        signal: controller.signal,
      });

      for (let i = 0; i < 100 && !existsSync(pidFile); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 100));
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(isAlive(pid)).toBe(true);

      controller.abort(new Error("stop"));
      await expect(run).rejects.toThrow("stop");

      const gone = await waitForExit(pid);
      if (!gone) process.kill(pid, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
      expect(gone).toBe(true);
    },
    20_000,
  );

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
