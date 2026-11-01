import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const manifestFrameSchema = z.object({
  index: z.number().int().nonnegative(),
  file: z.string(),
  pts_time: z.number(),
  shot: z.number().int().positive().optional(),
  position: z.enum(["first", "middle", "last"]).optional(),
});

const manifestShotSchema = z.object({
  index: z.number().int().positive(),
  start: z.number(),
  end: z.number(),
  duration: z.number(),
  frames: z.array(z.number().int().nonnegative()),
});

const manifestSheetSchema = z.object({
  file: z.string(),
  frames: z.array(z.number().int().nonnegative()),
});

const manifestSchema = z.object({
  version: z.literal(1),
  preset: z.enum(["llm", "high", "custom"]).nullable(),
  fps: z.number().nullable(),
  range: z.object({ start: z.number(), end: z.number() }).nullable(),
  frames: z.array(manifestFrameSchema),
  shots: z.array(manifestShotSchema).optional(),
  sheets: z.array(manifestSheetSchema).optional(),
});

export type ManifestFrame = z.infer<typeof manifestFrameSchema>;
export type ManifestShot = z.infer<typeof manifestShotSchema>;
export type ManifestSheet = z.infer<typeof manifestSheetSchema>;
export type Manifest = z.infer<typeof manifestSchema>;

const MANIFEST_FILE = "manifest.json";

export function manifestPath(jobDir: string): string {
  return join(jobDir, MANIFEST_FILE);
}

/**
 * The job's timeline, kept beside its output: the true time of every frame,
 * its shot, and which frames each sheet holds. Holds no absolute paths, so it
 * is safe to serve.
 */
export async function writeManifest(
  jobDir: string,
  manifest: Manifest,
): Promise<void> {
  await writeFile(manifestPath(jobDir), JSON.stringify(manifest, null, 2));
}

/** Null when absent or unreadable, as for jobs made before manifests existed. */
export async function readManifest(jobDir: string): Promise<Manifest | null> {
  try {
    const content = await readFile(manifestPath(jobDir), "utf-8");
    const result = manifestSchema.safeParse(JSON.parse(content));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
