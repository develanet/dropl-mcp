/**
 * Runs `worker` over `items` with at most `limit` in flight; results keep the input order.
 * After a failure no new items start, and the first error is thrown only once the running ones
 * have settled, so callers can safely release shared resources (like a file handle) afterwards.
 */
export async function mapWithConcurrency<Item, Result>(
  items: readonly Item[],
  limit: number,
  worker: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`Concurrency must be a positive integer, got ${limit}`);
  const results = new Array<Result>(items.length);
  let nextIndex = 0;
  let failure: { error: unknown } | null = null;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length && !failure) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await worker(items[index]!, index);
      } catch (error) {
        failure ??= { error };
      }
    }
  });
  await Promise.all(runners);
  if (failure) throw (failure as { error: unknown }).error;
  return results;
}

export function chunk<Item>(items: readonly Item[], size: number): Item[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error(`Chunk size must be a positive integer, got ${size}`);
  const chunks: Item[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}
