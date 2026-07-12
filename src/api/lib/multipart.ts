import type { Multipart } from "@fastify/multipart";

/**
 * Extract the string value of a non-file multipart field. Returns undefined
 * when the field is absent, is a file part, or has no array/single value.
 */
export function getMultipartFieldValue(
  field: Multipart | Multipart[] | undefined,
): string | undefined {
  if (!field) return undefined;
  // Handle array (take first value)
  const single = Array.isArray(field) ? field[0] : field;
  if (!single || "file" in single) return undefined;
  return typeof single.value === "string" ? single.value : undefined;
}
