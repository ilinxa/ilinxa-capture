import type { ZodType } from "zod";
import { ValidationError } from "../../utils/errors.js";

/**
 * Parse and validate a request body against a Zod schema, throwing a
 * ValidationError (400) with a consistent, human-readable message when
 * validation fails. Used in place of ad-hoc safeParse + format blocks
 * across handlers.
 */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ValidationError(formatted);
  }
  return parsed.data;
}
