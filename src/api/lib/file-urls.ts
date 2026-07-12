import { relative, sep } from "node:path";

/**
 * Build public /api/v1/files/... URLs for absolute file paths produced by
 * the core engine (frames/sheets output under LOCAL_OUTPUT_DIR/<jobId>/...).
 *
 * The core engine may return paths using either POSIX or Windows separators
 * depending on platform, so we normalize by locating the jobId path segment
 * and computing the relative remainder with node:path.relative(), then
 * converting the result to forward slashes for the URL.
 */
export function buildFileUrls(jobId: string, absolutePaths: string[]): string[] {
  return absolutePaths.map((absolutePath) => buildFileUrl(jobId, absolutePath));
}

function buildFileUrl(jobId: string, absolutePath: string): string {
  const segments = absolutePath.split(/[\\/]+/);
  const jobIdx = segments.lastIndexOf(jobId);

  if (jobIdx === -1) {
    // jobId not found as a path segment — fall back to the normalized full path
    return `/api/v1/files/${jobId}/${segments.join("/")}`;
  }

  const jobDir = segments.slice(0, jobIdx + 1).join(sep);
  const normalizedFullPath = segments.join(sep);
  const relativePath = relative(jobDir, normalizedFullPath).split(sep).join("/");

  return `/api/v1/files/${jobId}/${relativePath}`;
}
