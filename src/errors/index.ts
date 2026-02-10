export type SearchSocketErrorCode =
  | "CONFIG_MISSING"
  | "EMBEDDING_MODEL_MISMATCH"
  | "ROUTE_MAPPING_FAILED"
  | "VECTOR_BACKEND_UNAVAILABLE"
  | "RATE_LIMITED"
  | "INVALID_REQUEST"
  | "INTERNAL_ERROR";

export class SearchSocketError extends Error {
  public readonly code: SearchSocketErrorCode;
  public readonly status: number;

  constructor(code: SearchSocketErrorCode, message: string, status = 500) {
    super(message);
    this.code = code;
    this.status = status;
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
