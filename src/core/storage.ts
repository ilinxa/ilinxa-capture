import { createReadStream, type ReadStream } from "node:fs";
import { access, readFile, stat, readdir, rm } from "node:fs/promises";
import { join, resolve, normalize, sep } from "node:path";
import { ValidationError } from "../utils/errors.js";

export interface FileInfo {
  path: string;
  relativePath: string;
  size: number;
}

export interface Storage {
  fileExists(jobId: string, relativePath: string): Promise<boolean>;
  readFile(jobId: string, relativePath: string): Promise<Buffer>;
  getFileStream(jobId: string, relativePath: string): ReadStream;
  getFileInfo(jobId: string, relativePath: string): Promise<FileInfo>;
  listFiles(jobId: string, subDir?: "frames" | "sheets"): Promise<FileInfo[]>;
  deleteJobDir(jobId: string): Promise<void>;
  getJobDir(jobId: string): string;
}

export class LocalStorage implements Storage {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
  }

  getJobDir(jobId: string): string {
    return join(this.baseDir, jobId);
  }

  private resolveSecure(jobId: string, relativePath: string): string {
    const jobDir = this.getJobDir(jobId);
    // Treat backslashes as separators regardless of platform. POSIX `path`
    // (used on Linux, our Docker target) does not recognize "\" as a separator,
    // so a Windows-style "..\..\" would otherwise slip past the traversal check
    // as a single literal filename and bypass the guard.
    const normalizedInput = relativePath.replace(/\\/g, "/");
    const resolved = normalize(join(jobDir, normalizedInput));
    if (resolved !== jobDir && !resolved.startsWith(jobDir + sep)) {
      throw new ValidationError("Path traversal detected");
    }
    return resolved;
  }

  async fileExists(jobId: string, relativePath: string): Promise<boolean> {
    const filePath = this.resolveSecure(jobId, relativePath);
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async readFile(jobId: string, relativePath: string): Promise<Buffer> {
    const filePath = this.resolveSecure(jobId, relativePath);
    return readFile(filePath);
  }

  getFileStream(jobId: string, relativePath: string): ReadStream {
    const filePath = this.resolveSecure(jobId, relativePath);
    return createReadStream(filePath);
  }

  async getFileInfo(jobId: string, relativePath: string): Promise<FileInfo> {
    const filePath = this.resolveSecure(jobId, relativePath);
    const fileStat = await stat(filePath);
    return {
      path: filePath,
      relativePath,
      size: fileStat.size,
    };
  }

  async listFiles(
    jobId: string,
    subDir?: "frames" | "sheets",
  ): Promise<FileInfo[]> {
    const dirs = subDir ? [subDir] : ["frames", "sheets"];
    const results: FileInfo[] = [];

    for (const dir of dirs) {
      const dirPath = this.resolveSecure(jobId, dir);
      let entries: string[];
      try {
        entries = await readdir(dirPath);
      } catch (err: unknown) {
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code: string }).code === "ENOENT"
        ) {
          continue;
        }
        throw err;
      }

      for (const entry of entries) {
        const filePath = join(dirPath, entry);
        const fileStat = await stat(filePath);
        if (fileStat.isFile()) {
          results.push({
            path: filePath,
            relativePath: `${dir}/${entry}`,
            size: fileStat.size,
          });
        }
      }
    }

    return results;
  }

  async deleteJobDir(jobId: string): Promise<void> {
    const jobDir = this.getJobDir(jobId);
    await rm(jobDir, { recursive: true, force: true });
  }
}
