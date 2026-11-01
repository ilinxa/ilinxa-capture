import { realpath } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import type { Env } from "../lib/env.js";
import {
  LocalPathForbiddenError,
  UnsupportedFormatError,
  ValidationError,
} from "../utils/errors.js";

/** How this process was reached: over the network, or started by its user. */
export type InputMode = "http" | "stdio";

// Two or more letters, so a Windows drive like `C:\` is not taken for a scheme.
const URL_SCHEME = /^[a-z][a-z0-9+.-]+:/i;

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

async function realpathIfExists(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/**
 * Decides which local paths a caller may read. Every path-shaped input goes
 * through here, so a value handed to FFmpeg is always a plain absolute path:
 * never a protocol like `concat:`, never something that parses as an option.
 */
export class InputPolicy {
  private readonly allowedDirs: string[] | "any";
  private readonly outputDir: string;

  constructor(opts: { allowedDirs: string[] | "any"; outputDir: string }) {
    this.allowedDirs =
      opts.allowedDirs === "any"
        ? "any"
        : opts.allowedDirs.map((dir) => resolve(dir));
    this.outputDir = resolve(opts.outputDir);
  }

  static fromEnv(
    env: Pick<Env, "ALLOWED_INPUT_DIRS" | "LOCAL_OUTPUT_DIR">,
    mode: InputMode,
  ): InputPolicy {
    const dirs = env.ALLOWED_INPUT_DIRS.split(delimiter)
      .map((dir) => dir.trim())
      .filter(Boolean);

    const any = dirs.includes("*") || (dirs.length === 0 && mode === "stdio");
    return new InputPolicy({
      allowedDirs: any ? "any" : dirs,
      outputDir: env.LOCAL_OUTPUT_DIR,
    });
  }

  /** The absolute path to read, or an error saying why it may not be read. */
  async resolve(input: string): Promise<string> {
    if (input.includes("\0")) {
      throw new ValidationError("Path contains a null byte");
    }
    if (URL_SCHEME.test(input)) {
      throw new UnsupportedFormatError(
        "Only http(s) URLs and local file paths are supported",
      );
    }

    const path = resolve(input);
    if (this.allowedDirs === "any") return path;

    const roots = [...this.allowedDirs, this.outputDir];

    // Checked before touching the disk, so refusals say nothing about what exists.
    if (!roots.some((root) => isInside(root, path))) {
      throw new LocalPathForbiddenError();
    }

    const real = await realpathIfExists(path);
    if (real === null) {
      throw new ValidationError("File not found");
    }

    // Checked again on the real path, so a link inside cannot point outside.
    const realRoots = await Promise.all(roots.map(realpathIfExists));
    if (!realRoots.some((root) => root !== null && isInside(root, real))) {
      throw new LocalPathForbiddenError();
    }

    return real;
  }
}
