import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getVideoMetadata } from "../core/metadata.js";
import { isUrl, downloadVideo } from "../core/downloader.js";
import { ValidationError } from "../utils/errors.js";
import { metadataRequestSchema } from "./schemas.js";
import type { MetadataResponse } from "./schemas.js";
import { parseBody } from "./lib/validate.js";

export async function metadataHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  let source: string;

  if (request.isMultipart()) {
    const file = await request.file();
    if (!file) {
      throw new ValidationError("No file provided in multipart request");
    }

    const tempPath = join(tmpdir(), `ilinxa-capture-${randomUUID()}-${file.filename}`);
    try {
      await pipeline(file.file, createWriteStream(tempPath));
      const metadata = await getVideoMetadata(tempPath);
      void reply.code(200).send(metadata satisfies MetadataResponse);
      return;
    } finally {
      await unlink(tempPath).catch(() => {
        // Temp file cleanup is best-effort
      });
    }
  }

  // JSON body mode
  const parsed = parseBody(metadataRequestSchema, request.body);
  source = parsed.source;

  // Download URL via yt-dlp if source is a platform URL
  if (isUrl(source)) {
    const dlPath = await downloadVideo(source);
    try {
      const metadata = await getVideoMetadata(dlPath);
      void reply.code(200).send(metadata satisfies MetadataResponse);
      return;
    } finally {
      await unlink(dlPath).catch(() => {
        // Temp file cleanup is best-effort
      });
    }
  }

  const metadata = await getVideoMetadata(source);
  void reply.code(200).send(metadata satisfies MetadataResponse);
}
