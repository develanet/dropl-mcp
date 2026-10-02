import path from "node:path";
import { GALLERY_FILE_NAME_MAX_LENGTH } from "@dropl/shared";
import type { DroplApiClient } from "./api-client.js";
import { DroplApiError } from "./errors.js";
import type { LocalFile, SkippedPath } from "./files.js";
import { truncateList } from "./format.js";
import { REJECTION_REASON_LABELS, type RejectionReason } from "./media.js";
import type { Random, Sleep } from "./retry.js";
import type { StoragePut } from "./storage-put.js";

export const MAX_LISTED_FILES = 20;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNPROCESSABLE = 422;
const FALLBACK_FILE_NAME = "upload";

export interface ProgressReporter {
  (progress: number, total: number, message: string): void;
}

export interface MediaUploadContext {
  client: DroplApiClient;
  configDirectory: string;
  putFile: StoragePut;
  sleep: Sleep;
  random: Random;
  now: () => number;
  warn: (message: string) => void;
  onProgress?: ProgressReporter;
  signal?: AbortSignal;
  /** Overridable for tests. */
  concurrency?: number;
  batchSize?: number;
}

export interface RejectedFile {
  path: string;
  reason: RejectionReason;
  detail: string;
}

export interface RejectedSummary {
  count: number;
  byReason: Partial<Record<string, number>>;
  files: { path: string; reason: string }[];
  omitted: number;
}

export interface FailedSummary {
  count: number;
  files: { path: string; error: string }[];
  omitted: number;
}

export function summarizeRejected(rejected: readonly RejectedFile[]): RejectedSummary {
  const byReason: Partial<Record<string, number>> = {};
  for (const file of rejected) {
    const label = REJECTION_REASON_LABELS[file.reason];
    byReason[label] = (byReason[label] ?? 0) + 1;
  }
  // Hidden files are expected (e.g. .DS_Store), so they're counted but not listed.
  const listed = truncateList(
    rejected.filter((file) => file.reason !== "hidden").map((file) => ({ path: file.path, reason: `${REJECTION_REASON_LABELS[file.reason]}: ${file.detail}` })),
    MAX_LISTED_FILES,
  );
  return { count: rejected.length, byReason, files: listed.items, omitted: listed.omitted };
}

export function summarizeFailed(failed: readonly { path: string; error: string }[]): FailedSummary {
  const listed = truncateList(failed, MAX_LISTED_FILES);
  return { count: failed.length, files: listed.items, omitted: listed.omitted };
}

export function rejectedFromSkipped(skipped: readonly SkippedPath[]): RejectedFile[] {
  return skipped.map((entry) => ({ path: entry.path, reason: entry.reason, detail: entry.detail }));
}

export function uploadFileName(fileName: string): string {
  return path.basename(fileName).trim().slice(0, GALLERY_FILE_NAME_MAX_LENGTH) || FALLBACK_FILE_NAME;
}

/** Validation problems only affect one request; anything else (no plan, storage full, lost access, outage) affects them all. */
export function isBlockingError(error: unknown): boolean {
  if (!(error instanceof DroplApiError)) return false;
  return error.status !== HTTP_BAD_REQUEST && error.status !== HTTP_UNPROCESSABLE;
}

/** The file must still be the one that was scanned; uploading a half-written or swapped file would be wrong. */
export function fileChangedSinceScan(file: LocalFile, current: { size: number; mtimeMs: number }): boolean {
  return current.size !== file.sizeBytes || current.mtimeMs !== file.mtimeMs;
}
