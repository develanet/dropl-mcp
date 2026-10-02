import http from "node:http";
import https from "node:https";
import type { Readable } from "node:stream";
import { assertSecureUrl } from "./config.js";

/** Idle time (no bytes either way) before a storage request is abandoned and retried. */
export const STORAGE_IDLE_TIMEOUT_MS = 120_000;
/** Headers that are ours to set (or that must never reach storage), whatever the upload target says. */
const RESERVED_HEADER_NAMES = new Set(["authorization", "content-length", "host", "transfer-encoding", "connection"]);
const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX = 299;

/** Status 0: the request never got a response (network error, timeout). */
export class StoragePutError extends Error {
  constructor(
    readonly status: number,
    message: string = status === 0 ? "The connection to storage was interrupted." : `Storage rejected the upload with HTTP ${status}.`,
  ) {
    super(message);
    this.name = "StoragePutError";
  }
}

/** Reading the local file failed; retrying the request won't help. */
export class LocalReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalReadError";
  }
}

export interface StoragePutRequest {
  url: string;
  headers?: Record<string, string>;
  /** A buffer, or a factory for a fresh stream per attempt (a stream can only be sent once). */
  body: Buffer | (() => Readable);
  contentLength: number;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
}

export type StoragePut = (request: StoragePutRequest) => Promise<void>;

/**
 * Plain node:http rather than fetch: presigned S3/B2 PUTs need an explicit Content-Length (they
 * refuse chunked bodies), and a file stream can't be sent with one through fetch. No Authorization
 * header is ever sent; the URL's signature is the credential.
 */
export const putToStorage: StoragePut = (request) =>
  new Promise<void>((resolve, reject) => {
    const url = new URL(request.url);
    assertSecureUrl(url, "The storage upload URL");
    if (request.signal?.aborted) return reject(request.signal.reason);

    const headers: Record<string, string | number> = {};
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      if (!RESERVED_HEADER_NAMES.has(name.toLowerCase())) headers[name] = value;
    }
    headers["content-length"] = request.contentLength;

    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      request.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const transport = url.protocol === "https:" ? https : http;
    const outgoing = transport.request(url, { method: "PUT", headers }, (response) => {
      response.resume();
      response.on("error", () => settle(new StoragePutError(0)));
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        settle(status >= HTTP_SUCCESS_MIN && status <= HTTP_SUCCESS_MAX ? undefined : new StoragePutError(status));
      });
    });
    const onAbort = () => {
      outgoing.destroy();
      settle(request.signal?.reason instanceof Error ? request.signal.reason : new Error("Upload canceled"));
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    outgoing.setTimeout(request.idleTimeoutMs ?? STORAGE_IDLE_TIMEOUT_MS, () => {
      outgoing.destroy();
      settle(new StoragePutError(0, "The upload to storage timed out."));
    });
    outgoing.on("error", () => settle(new StoragePutError(0)));

    if (Buffer.isBuffer(request.body)) {
      outgoing.end(request.body);
      return;
    }
    const stream = request.body();
    stream.on("error", (error) => {
      outgoing.destroy();
      settle(new LocalReadError(`Couldn't read the file: ${error.message}`));
    });
    stream.pipe(outgoing);
  });
