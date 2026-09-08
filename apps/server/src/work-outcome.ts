/** Safe operational metadata. Provider bodies, queries, URLs and credentials never belong here. */
export type FailureCode =
  | "quota"
  | "capacity"
  | "rate_limit"
  | "transport"
  | "http"
  | "invalid_response"
  | "persistence"
  | "unavailable"
  | "extraction"
  | "interrupted";

export interface WorkFailure {
  provider: string;
  code: FailureCode;
  deferred: boolean;
  retryAt?: string;
  httpStatus?: number;
}

export type WorkOutcome<T> =
  | { status: "ok" | "empty"; value: T }
  | { status: "deferred" | "failed"; failure: WorkFailure };

export class WorkError extends Error {
  readonly failure: WorkFailure;
  get status(): number | undefined {
    return this.failure.httpStatus;
  }
  get retryAfterMs(): number | undefined {
    return this.failure.retryAt
      ? Math.max(0, Date.parse(this.failure.retryAt) - Date.now())
      : undefined;
  }
  constructor(failure: WorkFailure) {
    super(`${failure.provider}: ${failure.code}`);
    this.name = "WorkError";
    this.failure = failure;
  }
}

export function retryTime(
  response: Pick<Response, "headers">,
  now = Date.now(),
): string | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  const at = Number.isFinite(seconds)
    ? now + Math.max(0, seconds) * 1000
    : Date.parse(raw);
  return Number.isFinite(at)
    ? new Date(Math.max(now + 1000, at)).toISOString()
    : undefined;
}

export function httpFailure(
  provider: string,
  response: Pick<Response, "status" | "headers">,
): WorkError {
  const deferred = response.status === 429 || response.status >= 500;
  return new WorkError({
    provider,
    code: response.status === 429 ? "rate_limit" : "http",
    deferred,
    httpStatus: response.status,
    ...(deferred
      ? {
          retryAt:
            retryTime(response) ?? new Date(Date.now() + 60_000).toISOString(),
        }
      : {}),
  });
}

export function workFailure(
  error: unknown,
  provider: string,
  code: FailureCode = "transport",
): WorkFailure {
  if (error instanceof WorkError) return error.failure;
  const e = error as {
    name?: string;
    message?: string;
    status?: number;
    retryAfterMs?: number;
  } | null;
  if (e?.name === "AbortError")
    return { provider, code: "interrupted", deferred: true };
  const quota = /budget reached|budget.*exhausted/.test(e?.message ?? "");
  const capacity = /capacity reached/.test(e?.message ?? "");
  const deferred =
    quota ||
    capacity ||
    e?.status === 429 ||
    (e?.status ?? 0) >= 500 ||
    e?.name === "TimeoutError" ||
    code === "transport";
  return {
    provider,
    code: quota
      ? "quota"
      : capacity
        ? "capacity"
        : e?.status === 429
          ? "rate_limit"
          : code,
    deferred,
    ...(e?.status ? { httpStatus: e.status } : {}),
    ...(deferred
      ? {
          retryAt: new Date(
            Date.now() +
              Math.max(1000, e?.retryAfterMs ?? (quota ? 3_600_000 : 60_000)),
          ).toISOString(),
        }
      : {}),
  };
}

export function failedOutcome<T = never>(
  error: unknown,
  provider: string,
  code?: FailureCode,
): Extract<WorkOutcome<T>, { failure: WorkFailure }> {
  const failure = workFailure(error, provider, code);
  return { status: failure.deferred ? "deferred" : "failed", failure };
}

/** Local admission failures must not advance a provider's negative-cache lifetime. */
export function rethrowDeferred(error: unknown, provider: string): void {
  if (
    error instanceof WorkError &&
    ["quota", "capacity", "interrupted"].includes(error.failure.code)
  )
    throw error;
  const message = (error as Error | null)?.message ?? "";
  if (/budget reached|capacity reached/.test(message))
    throw new WorkError(workFailure(error, provider));
}
