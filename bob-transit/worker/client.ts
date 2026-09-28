/**
 * GTFS-Realtime feed HTTP client.
 *
 * This is the ONLY part of the worker that touches the network. It is never
 * imported by the decode path or by the demo request path.
 */
/** Minimal shape of `fetch`, so tests can inject a stub. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Non-2xx response from the feed endpoint. */
export class FeedHttpError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string, statusText: string) {
    super(`feed returned HTTP ${status}${statusText ? ` ${statusText}` : ""} for ${url}`);
    this.name = "FeedHttpError";
    this.status = status;
    this.url = url;
  }
}

/** The request exceeded its configured timeout and was aborted. */
export class FeedTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly url: string;

  constructor(url: string, timeoutMs: number) {
    super(`feed request to ${url} timed out after ${timeoutMs}ms`);
    this.name = "FeedTimeoutError";
    this.timeoutMs = timeoutMs;
    this.url = url;
  }
}

/** Transport-level failure (DNS, TLS, connection reset, offline). */
export class FeedNetworkError extends Error {
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(
      `feed request to ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "FeedNetworkError";
    this.url = url;
    this.cause = cause;
  }
}

export interface FetchFeedOptions {
  url: string;
  /** Hard upper bound on the whole request, in milliseconds. */
  timeoutMs: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Optional parent abort signal (used by `--loop` shutdown). */
  signal?: AbortSignal;
}

export interface FetchFeedResult {
  bytes: Uint8Array;
  /** `content-type` header, informational. */
  contentType: string | null;
  /** URL after redirects (the feed 301s to a trailing-slash variant). */
  finalUrl: string;
}

const ACCEPT_HEADER = "application/x-protobuf, application/octet-stream, */*";

/**
 * GET the feed and return its raw bytes, enforcing a timeout.
 *
 * Redirects are followed (the public endpoint answers 301 before 200). Throws
 * {@link FeedHttpError}, {@link FeedTimeoutError} or {@link FeedNetworkError};
 * it never returns a non-2xx body.
 */
export async function fetchFeedBytes(
  options: FetchFeedOptions,
): Promise<FetchFeedResult> {
  const { url, timeoutMs } = options;
  const fetchImpl: FetchLike = options.fetchImpl ?? globalThis.fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new FeedTimeoutError(url, timeoutMs));
  }, timeoutMs);

  const onParentAbort = (): void => controller.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener("abort", onParentAbort, { once: true });
  }

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { accept: ACCEPT_HEADER },
    });

    if (!response.ok) {
      throw new FeedHttpError(response.status, response.url || url, response.statusText);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      bytes,
      contentType: response.headers.get("content-type"),
      finalUrl: response.url || url,
    };
  } catch (err) {
    if (
      err instanceof FeedHttpError ||
      err instanceof FeedTimeoutError ||
      err instanceof FeedNetworkError
    ) {
      throw err;
    }
    if (controller.signal.aborted) {
      const reason: unknown = controller.signal.reason;
      if (reason instanceof FeedTimeoutError) throw reason;
      throw new FeedTimeoutError(url, timeoutMs);
    }
    throw new FeedNetworkError(url, err);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onParentAbort);
  }
}
