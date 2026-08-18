export type SearchSocketErrorCode =
  | "CONFIG_MISSING"
  | "EMBEDDING_MODEL_MISMATCH"
  | "ROUTE_MAPPING_FAILED"
  | "VECTOR_BACKEND_UNAVAILABLE"
  | "SEARCH_NOT_CONFIGURED"
  | "RATE_LIMITED"
  | "INVALID_REQUEST"
  | "INTERNAL_ERROR"
  | "EMBEDDING_FAILED"
  | "BUILD_MANIFEST_NOT_FOUND"
  | "BUILD_SERVER_FAILED";

export interface SearchSocketErrorOptions {
  status?: number;
  /**
   * The underlying error. Preserved for logging and diagnosis; never included
   * in a public error payload, which could leak credentials or internals.
   */
  cause?: unknown;
}

export class SearchSocketError extends Error {
  public readonly code: SearchSocketErrorCode;
  public readonly status: number;

  constructor(
    code: SearchSocketErrorCode,
    message: string,
    statusOrOptions: number | SearchSocketErrorOptions = 500
  ) {
    const options: SearchSocketErrorOptions =
      typeof statusOrOptions === "number" ? { status: statusOrOptions } : statusOrOptions;
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SearchSocketError";
    this.code = code;
    this.status = options.status ?? 500;
  }
}

export function toErrorPayload(error: unknown): {
  error: {
    code: SearchSocketErrorCode;
    message: string;
  };
} {
  if (error instanceof SearchSocketError) {
    return {
      error: {
        code: error.code,
        message: error.message
      }
    };
  }

  return {
    error: {
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : "Unknown error"
    }
  };
}
