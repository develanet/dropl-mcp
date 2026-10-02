const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
/** Decimal units, matching how plan limits and the per-file caps are stated. */
const BYTES_PER_UNIT = 1_000;
const SMALL_VALUE_THRESHOLD = 10;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  let value = bytes;
  let unitIndex = 0;
  while (value >= BYTES_PER_UNIT && unitIndex < BYTE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT;
    unitIndex += 1;
  }
  const rounded = unitIndex === 0 || value >= SMALL_VALUE_THRESHOLD ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${BYTE_UNITS[unitIndex]}`;
}

export interface TruncatedList<Item> {
  items: Item[];
  /** How many were left out. */
  omitted: number;
}

export function truncateList<Item>(items: readonly Item[], maxItems: number): TruncatedList<Item> {
  return { items: items.slice(0, maxItems), omitted: Math.max(0, items.length - maxItems) };
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
