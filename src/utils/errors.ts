import createError from "@fastify/error";

// 400 Bad Request
export const ValidationError = createError(
  "VALIDATION_ERROR",
  "%s",
  400,
);

export const UnsupportedFormatError = createError(
  "UNSUPPORTED_FORMAT",
  "%s",
  400,
);

// 403 Forbidden
export const ForbiddenHostError = createError(
  "FORBIDDEN_HOST",
  "Host '%s' is not allowed. Add it to ALLOWED_HOSTS to reach this server by that name",
  403,
);

export const ForbiddenOriginError = createError(
  "FORBIDDEN_ORIGIN",
  "Origin '%s' is not allowed. Add it to ALLOWED_ORIGINS to call this server from that site",
  403,
);

export const LocalPathForbiddenError = createError(
  "LOCAL_PATH_FORBIDDEN",
  "Local path is outside the allowed folders. Upload the file, or set ALLOWED_INPUT_DIRS",
  403,
);

// 404 Not Found
export const JobNotFoundError = createError(
  "JOB_NOT_FOUND",
  "Job '%s' not found",
  404,
);

export const FileNotFoundError = createError(
  "FILE_NOT_FOUND",
  "File '%s' not found in job '%s'",
  404,
);

// 409 Conflict
export const JobBusyError = createError(
  "JOB_BUSY",
  "Job '%s' is still running",
  409,
);

export const JobCancelledError = createError(
  "JOB_CANCELLED",
  "Job '%s' was cancelled",
  409,
);

// 410 Gone
export const JobExpiredError = createError(
  "JOB_EXPIRED",
  "Job '%s' has expired",
  410,
);

// 413 Payload Too Large
export const VideoTooLongError = createError(
  "VIDEO_TOO_LONG",
  "Video duration exceeds maximum of %s seconds",
  413,
);

// 504 Gateway Timeout
export const JobTimeoutError = createError(
  "JOB_TIMEOUT",
  "Job exceeded the JOB_TIMEOUT limit of %s seconds and was stopped",
  504,
);

// 500 Internal Server Error
export const DownloadFailedError = createError(
  "DOWNLOAD_FAILED",
  "Failed to download video: %s",
  500,
);

export const FormatListingFailedError = createError(
  "FORMAT_LISTING_FAILED",
  "Failed to list video formats: %s",
  500,
);

export const ProcessingError = createError(
  "PROCESSING_ERROR",
  "Processing failed: %s",
  500,
);

export const HlsParseError = createError(
  "HLS_PARSE_ERROR",
  "Failed to parse HLS playlist: %s",
  400,
);

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
