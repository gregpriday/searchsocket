export type SiteScribeErrorCode =
  | "CONFIG_MISSING"
  | "EMBEDDING_MODEL_MISMATCH"
  | "VECTOR_BACKEND_UNAVAILABLE"
  | "RATE_LIMITED"
  | "INVALID_REQUEST"
  | "INTERNAL_ERROR";

export class SiteScribeError extends Error {
  public readonly code: SiteScribeErrorCode;
  public readonly status: number;

  constructor(code: SiteScribeErrorCode, message: string, status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function toErrorPayload(error: unknown): {
  error: {
    code: SiteScribeErrorCode;
    message: string;
  };
} {
  if (error instanceof SiteScribeError) {
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
