import { z } from "zod";

const envSchema = z
  .object({
    // Server
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default("0.0.0.0"),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),

    // Logging
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),

    // Storage
    STORAGE_MODE: z.enum(["local", "s3"]).default("local"),
    LOCAL_OUTPUT_DIR: z.string().default("./data/jobs"),
    LOCAL_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

    // S3 (optional — validated conditionally via refine)
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_ENDPOINT: z.string().url().optional(),
    S3_URL_EXPIRY: z.coerce.number().int().positive().optional(),

    // UI
    UI_DIR: z.string().default("./ui/dist"),

    // Processing limits
    MAX_VIDEO_DURATION: z.coerce.number().int().positive().default(600),
    MAX_UPLOAD_SIZE: z.coerce.number().int().positive().default(524288000),
    MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().default(3),
    JOB_TIMEOUT: z.coerce.number().int().positive().default(300),

    // MCP
    MCP_SESSION_TTL: z.coerce.number().int().positive().default(1800),
  })
  .refine(
    (data) => {
      if (data.STORAGE_MODE === "s3") {
        return !!(
          data.S3_BUCKET &&
          data.S3_REGION &&
          data.S3_ACCESS_KEY_ID &&
          data.S3_SECRET_ACCESS_KEY
        );
      }
      return true;
    },
    {
      message:
        "S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY are required when STORAGE_MODE=s3",
    },
  );

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

export function loadEnv(): Env {
  if (cachedEnv) return cachedEnv;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${formatted}`);
  }

  cachedEnv = result.data;
  return cachedEnv;
}

export function resetEnvCache(): void {
  cachedEnv = null;
}
