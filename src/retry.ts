const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;
/** Up to ±20% so requests that failed together don't retry in lockstep. */
const RETRY_JITTER_RATIO = 0.2;
/** A server asking for a longer pause than this is treated as unavailable rather than waited on. */
export const MAX_RETRY_AFTER_MS = 60_000;
const MS_PER_SECOND = 1_000;

export type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
export type Random = () => number;

export const sleep: Sleep = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Exponential backoff for the nth retry (1-based), capped, with jitter. */
export function retryDelayMs(retryNumber: number, random: Random = Math.random): number {
  if (!Number.isInteger(retryNumber) || retryNumber < 1) throw new Error(`Invalid retry number: ${retryNumber}`);
  const exponential = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (retryNumber - 1));
  const jitter = 1 + (random() * 2 - 1) * RETRY_JITTER_RATIO;
  return Math.round(exponential * jitter);
}

/** `Retry-After` as delta seconds or an HTTP date; null when absent or unparseable. */
export function parseRetryAfterMs(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * MS_PER_SECOND;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/** Network errors (0), timeouts, throttling, and server errors are worth retrying against storage. */
export function isRetriableStorageStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}
