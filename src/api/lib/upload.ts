import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { ValidationError } from "../../utils/errors.js";

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

/** Add a form field. A repeated name collects into an array. */
function addField(
  fields: Record<string, unknown>,
  fieldname: string,
  value: string,
): void {
  if (value === "") return;

  const name = fieldname.replace(/\[\]$/, "");
  const existing = fields[name];
  fields[name] =
    existing === undefined ? value : [existing].flat().concat(value);
}

/**
 * Read a multipart form to its end. Reading only up to the first file would
 * lose any field sent after it, depending on how the bytes happened to arrive.
 */
async function readForm(request: FastifyRequest): Promise<VideoRequest> {
  const fields: Record<string, unknown> = {};
  let uploadPath: string | null = null;

  try {
    for await (const part of request.parts()) {
      if (part.type === "field") {
        if (typeof part.value === "string") {
          addField(fields, part.fieldname, part.value);
        }
      } else if (uploadPath === null) {
        uploadPath = uploadTempPath(part.filename);
        await pipeline(part.file, createWriteStream(uploadPath));
      } else {
        // Each job takes one video. The stream must still be drained to go on.
        await pipeline(
          part.file,
          new Writable({ write: (_chunk, _encoding, done) => done() }),
        );
      }
    }
  } catch (err) {
    if (uploadPath) {
      await unlink(uploadPath).catch(() => {
        // Temp file cleanup is best-effort
      });
    }
    throw err;
  }

  if (uploadPath === null) {
    throw new ValidationError("No file provided in multipart request");
  }

  // Set last: a form field can never stand in for the uploaded file.
  fields["source"] = uploadPath;
  return { fields, uploadPath };
}

/** Read a request that names a video source, as JSON or as a multipart upload. */
export async function readVideoRequest(
  request: FastifyRequest,
): Promise<VideoRequest> {
  if (request.isMultipart()) {
    return readForm(request);
  }

  const body = request.body as Record<string, unknown> | null;
  if (!body?.["source"]) {
    throw new ValidationError(
      "Missing 'source' field — provide a video URL or upload a file",
    );
  }
  return { fields: { ...body }, uploadPath: null };
}
