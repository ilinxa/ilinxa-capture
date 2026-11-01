import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { ValidationError } from "../../utils/errors.js";
import { getMultipartFieldValue } from "./multipart.js";

export interface VideoRequest {
  /** Request fields. `source` is the temp path when a file was uploaded. */
  fields: Record<string, unknown>;
  /** Set when an upload was saved. The caller owns the file. */
  uploadPath: string | null;
}

/** A temp name built only from what we choose, never from the client's name. */
function uploadTempPath(filename: string): string {
  const ext = extname(filename).toLowerCase();
  const safeExt = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : "";
  return join(tmpdir(), `ilinxa-capture-${randomUUID()}${safeExt}`);
}

/** Read a request that names a video source, as JSON or as a multipart upload. */
export async function readVideoRequest(
  request: FastifyRequest,
): Promise<VideoRequest> {
  if (!request.isMultipart()) {
    const body = request.body as Record<string, unknown> | null;
    if (!body?.["source"]) {
      throw new ValidationError(
        "Missing 'source' field — provide a video URL or upload a file",
      );
    }
    return { fields: { ...body }, uploadPath: null };
  }

  const file = await request.file();
  if (!file) {
    throw new ValidationError("No file provided in multipart request");
  }

  const uploadPath = uploadTempPath(file.filename);
  try {
    await pipeline(file.file, createWriteStream(uploadPath));
  } catch (err) {
    await unlink(uploadPath).catch(() => {
      // Temp file cleanup is best-effort
    });
    throw err;
  }

  const fields: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(file.fields)) {
    const value = getMultipartFieldValue(field);
    if (value !== undefined) fields[name] = value;
  }

  // Set last: a form field can never stand in for the uploaded file.
  fields["source"] = uploadPath;
  return { fields, uploadPath };
}
