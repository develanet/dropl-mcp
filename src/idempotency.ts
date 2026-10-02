import { createHash } from "node:crypto";
import { IDEMPOTENCY_KEY_MAX_LENGTH } from "@dropl/shared";

const IDEMPOTENCY_KEY_PREFIX = "dropl-mcp-";

/** JSON with object keys sorted, so equal values always serialize (and hash) the same. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
}

/**
 * Derived only from the operation and its inputs, so re-running after a crash sends the same key and
 * the API replays the first response instead of creating a duplicate.
 */
export function deriveIdempotencyKey(operation: string, ...inputs: unknown[]): string {
  const digest = createHash("sha256").update(stableStringify([operation, ...inputs])).digest("hex");
  const key = `${IDEMPOTENCY_KEY_PREFIX}${digest}`;
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) throw new Error("Idempotency key is too long");
  return key;
}
