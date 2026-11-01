import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

/** Marks a job directory being removed. Never a valid job ID. */
export const TOMBSTONE_SUFFIX = ".deleting";

const RENAME_ATTEMPTS = 5;
const RETIRED_SUFFIX = ".old";

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/** Windows refuses to move or replace a file another program has open. */
export function isFileInUse(err: unknown): boolean {
  const code = errorCode(err);
  return code === "EPERM" || code === "EBUSY";
}

/** Scanners hold a file open for a moment, so that gets a few tries. */
async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      if (attempt >= RENAME_ATTEMPTS || !isFileInUse(err)) throw err;
      await new Promise((done) => setTimeout(done, 20 * attempt));
    }
  }
}

/**
 * Write through a temp file, so a crash mid-write cannot leave a truncated file
 * where recovery expects a whole one.
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, data);

  try {
    await renameRetrying(temp, path);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Where to build the replacement for a directory, before `replaceDir`. */
export function buildPath(target: string): string {
  return `${target}.tmp`;
}

/**
 * Swap the finished build in for `target`. Moved aside rather than deleted
 * first, so a file held open fails the swap with the old directory whole,
 * instead of partway through deleting it.
 */
export async function replaceDir(target: string): Promise<void> {
  const retired = `${target}${RETIRED_SUFFIX}`;
  await rm(retired, { recursive: true, force: true });

  let hadTarget = true;
  try {
    await renameRetrying(target, retired);
  } catch (err) {
    if (errorCode(err) !== "ENOENT") throw err;
    hadTarget = false;
  }

  try {
    await renameRetrying(buildPath(target), target);
  } catch (err) {
    if (hadTarget) await rename(retired, target).catch(() => {});
    throw err;
  }

  // In use is harmless here: the next swap, or deleting the job, clears it.
  await rm(retired, { recursive: true, force: true }).catch(() => {});
}

/** After a crash: put back what a swap had moved aside, and drop the build. */
export async function settleSwap(target: string): Promise<void> {
  const retired = `${target}${RETIRED_SUFFIX}`;
  // Fails when the swap got as far as the new directory, which then stands.
  await rename(retired, target).catch(() => {});
  await rm(retired, { recursive: true, force: true }).catch(() => {});
  await rm(buildPath(target), { recursive: true, force: true }).catch(() => {});
}

/**
 * Remove a job directory. Renaming first makes this all or nothing from the
 * outside: a locked file fails the rename with job.json still in place, rather
 * than deleting job.json and stranding the rest where nothing tracks it.
 */
export async function removeTree(dir: string): Promise<void> {
  const tombstone = `${dir}${TOMBSTONE_SUFFIX}`;

  try {
    await renameRetrying(dir, tombstone);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return;
    throw err;
  }

  // The job is gone by now. What is left is a tombstone, and the sweep ends those.
  await rm(tombstone, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
