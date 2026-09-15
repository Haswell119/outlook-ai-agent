export type ApiErrorKind = "network" | "timeout" | "unauthorized" | "forbidden" | "validation" | "not_found" | "llm" | "graph" | "generic";

/** Error thrown by the API client; `i18nKey` maps to `errors.*` in the resources. */
export class ApiClientError extends Error {
  constructor(
    public readonly kind: ApiErrorKind,
    message: string,
    public readonly status?: number,
    public readonly code?: string,
    public readonly correlationId?: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }

  get i18nKey(): string {
    switch (this.kind) {
      case "network":
        return "errors.network";
      case "timeout":
        return "errors.timeout";
      case "unauthorized":
        return "errors.unauthorized";
      case "forbidden":
        return "errors.forbidden";
      case "validation":
        return "errors.validation";
      case "llm":
        return "errors.llm";
      case "graph":
        return "errors.graph";
      default:
        return "errors.generic";
    }
  }
}

export function kindFromStatus(status: number, code?: string): ApiErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 400 || status === 422 || code === "validation_error") return "validation";
  if (status === 404) return "not_found";
  if (status === 502 || code === "llm_unavailable") return "llm";
  if (status === 503 || code === "graph_unavailable") return "graph";
  return "generic";
}
