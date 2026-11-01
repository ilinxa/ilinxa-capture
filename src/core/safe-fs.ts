import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

/** Marks a job directory being removed. Never a valid job ID. */
export const TOMBSTONE_SUFFIX = ".deleting";

const RENAME_ATTEMPTS = 5;

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/**
 * Write through a temp file, so a crash mid-write cannot leave a truncated file
 * where recovery expects a whole one. Windows refuses to replace a file another
 * process has open for a moment, as scanners do, so that gets a few tries.
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, data);

  for (let attempt = 1; ; attempt++) {
    try {
      await rename(temp, path);
      return;
    } catch (err) {
      const code = errorCode(err);
      if (attempt >= RENAME_ATTEMPTS || (code !== "EPERM" && code !== "EBUSY")) {
        await rm(temp, { force: true }).catch(() => {});
        throw err;
      }
      await new Promise((done) => setTimeout(done, 20 * attempt));
    }
  }
}

/**
 * Remove a job directory. Renaming first makes this all or nothing from the
 * outside: a locked file fails the rename with job.json still in place, rather
 * than deleting job.json and stranding the rest where nothing tracks it.
 */
export async function removeTree(dir: string): Promise<void> {
  const tombstone = `${dir}${TOMBSTONE_SUFFIX}`;

  try {
    await rename(dir, tombstone);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return;
    throw err;
  }

  await rm(tombstone, { recursive: true, force: true, maxRetries: 3 });
}
