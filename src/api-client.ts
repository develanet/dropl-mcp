import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAY_HEADER, PUBLIC_API_ERROR_CODES } from "@dropl/shared";
import { normalizeApiUrl } from "./config.js";
import { DroplApiError, NETWORK_ERROR_CODE, UserFacingError } from "./errors.js";
import { MAX_RETRY_AFTER_MS, parseRetryAfterMs, retryDelayMs, sleep as defaultSleep, type Random, type Sleep } from "./retry.js";
import { USER_AGENT } from "./version.js";

export const DEFAULT_MAX_API_ATTEMPTS = 5;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MIN = 500;
const HTTP_REDIRECT_MIN = 300;
const HTTP_REDIRECT_MAX = 399;
const MAX_ERROR_TEXT_LENGTH = 300;

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type QueryValue = string | number | boolean | null | undefined;

export interface ApiClientOptions {
  apiUrl: string;
  /** Omitted for the unauthenticated device sign-in endpoints. */
  apiKey?: string | null;
  fetch?: typeof fetch;
  sleep?: Sleep;
  random?: Random;
  maxAttempts?: number;
  requestTimeoutMs?: number;
}

export interface ApiRequestOptions {
  body?: unknown;
  query?: Record<string, QueryValue>;
  /** Sent as `Idempotency-Key`; required on every create/complete call so retries can't duplicate. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface ApiResponse<Data> {
  data: Data;
  status: number;
  /** The API served this from an earlier request with the same idempotency key. */
  replayed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads both `ApiErrorBody` and the OAuth shape the device token endpoint uses. */
function errorFromResponse(status: number, body: unknown, rawText: string, retryAfterMs: number | null): DroplApiError {
  if (isRecord(body)) {
    const error = body.error;
    if (isRecord(error) && typeof error.code === "string") {
      const message = typeof error.message === "string" ? error.message : error.code;
      const fieldErrors = isRecord(error.fieldErrors) ? (error.fieldErrors as Record<string, string[]>) : null;
      return new DroplApiError(status, error.code, message, fieldErrors, retryAfterMs);
    }
    if (typeof error === "string") {
      const description = typeof body.error_description === "string" ? body.error_description : error;
      return new DroplApiError(status, error, description, null, retryAfterMs);
    }
  }
  const text = rawText.trim().slice(0, MAX_ERROR_TEXT_LENGTH);
  return new DroplApiError(status, `HTTP_${status}`, text ? `Request failed with HTTP ${status}: ${text}` : `Request failed with HTTP ${status}.`, null, retryAfterMs);
}

function isRetriable(error: DroplApiError): boolean {
  return (
    error.status === 0 ||
    error.status === HTTP_TOO_MANY_REQUESTS ||
    error.status >= HTTP_SERVER_ERROR_MIN ||
    error.code === PUBLIC_API_ERROR_CODES.idempotencyKeyInProgress
  );
}

export class DroplApiClient {
  readonly apiUrl: string;
  private readonly apiKey: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: Sleep;
  private readonly random: Random;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;

  constructor(options: ApiClientOptions) {
    this.apiUrl = normalizeApiUrl(options.apiUrl);
    this.apiKey = options.apiKey ?? null;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_API_ATTEMPTS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) throw new Error("maxAttempts must be a positive integer");
  }

  get isAuthenticated(): boolean {
    return this.apiKey !== null;
  }

  get<Data>(path: string, options: ApiRequestOptions = {}): Promise<Data> {
    return this.request<Data>("GET", path, options).then((response) => response.data);
  }

  post<Data>(path: string, body: unknown, options: Omit<ApiRequestOptions, "body"> = {}): Promise<Data> {
    return this.request<Data>("POST", path, { ...options, body }).then((response) => response.data);
  }

  patch<Data>(path: string, body: unknown, options: Omit<ApiRequestOptions, "body"> = {}): Promise<Data> {
    return this.request<Data>("PATCH", path, { ...options, body }).then((response) => response.data);
  }

  delete<Data>(path: string, options: ApiRequestOptions = {}): Promise<Data> {
    return this.request<Data>("DELETE", path, options).then((response) => response.data);
  }

  async request<Data>(method: HttpMethod, path: string, options: ApiRequestOptions = {}): Promise<ApiResponse<Data>> {
    if (!path.startsWith("/")) throw new Error(`API paths must start with "/", got ${path}`);
    const url = new URL(`${this.apiUrl}${path}`);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
    }
    const headers: Record<string, string> = { accept: "application/json", "user-agent": USER_AGENT };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (options.idempotencyKey) headers[IDEMPOTENCY_KEY_HEADER] = options.idempotencyKey;
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined) headers["content-type"] = "application/json";

    for (let attempt = 1; ; attempt += 1) {
      let error: DroplApiError;
      try {
        return await this.send<Data>(method, url, headers, body, options.signal);
      } catch (caught) {
        if (!(caught instanceof DroplApiError)) throw caught;
        error = caught;
      }
      if (!isRetriable(error) || attempt >= this.maxAttempts) throw error;
      if (error.retryAfterMs !== null && error.retryAfterMs > MAX_RETRY_AFTER_MS) throw error;
      await this.sleep(error.retryAfterMs ?? retryDelayMs(attempt, this.random), options.signal);
    }
  }

  private async send<Data>(
    method: HttpMethod,
    url: URL,
    headers: Record<string, string>,
    body: string | undefined,
    callerSignal: AbortSignal | undefined,
  ): Promise<ApiResponse<Data>> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      // Redirects are refused: following one could carry the key to a host the user never configured.
      response = await this.fetchImpl(url, { method, headers, body, signal, redirect: "manual" });
    } catch (error) {
      if (callerSignal?.aborted) throw callerSignal.reason;
      const reason = timeoutSignal.aborted ? "the request timed out" : error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
      throw new DroplApiError(0, NETWORK_ERROR_CODE, `Couldn't reach Dropl at ${url.origin}: ${reason}.`);
    }

    if (response.status >= HTTP_REDIRECT_MIN && response.status <= HTTP_REDIRECT_MAX) {
      const location = response.headers.get("location");
      throw new DroplApiError(
        response.status,
        "UNEXPECTED_REDIRECT",
        `The Dropl API at ${this.apiUrl} redirected${location ? ` to ${location}` : ""}. Set DROPL_API_URL to the final API URL.`,
      );
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!response.ok) {
      throw errorFromResponse(response.status, parsed, text, parseRetryAfterMs(response.headers.get("retry-after")));
    }
    return {
      data: parsed as Data,
      status: response.status,
      replayed: response.headers.get(IDEMPOTENT_REPLAY_HEADER) === "true",
    };
  }
}

/** Path segment for an id the agent supplied; never lets it change the route. */
export function pathSegment(id: string): string {
  if (!id || id.trim() !== id) throw new UserFacingError(`Invalid id: "${id}"`);
  return encodeURIComponent(id);
}
