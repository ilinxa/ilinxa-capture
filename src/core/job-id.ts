import { ValidationError } from "../utils/errors.js";

/** Job IDs become directory names, so nothing else may ever pass for one. */
export const JOB_ID_PATTERN = /^cap_[0-9a-f]{8}$/;

export function isValidJobId(jobId: string): boolean {
  return JOB_ID_PATTERN.test(jobId);
}

export function assertValidJobId(jobId: string): void {
  if (!isValidJobId(jobId)) {
    throw new ValidationError("Invalid job ID");
  }
}
