/**
 * Run `fn` over `items`, at most `limit` at a time (the startup migrations' storage reads and writes: one at a
 * time, hundreds of R2 round trips outlast a deploy's health check). Resolves when all are done; rejects with the
 * first error, after the ones already started have finished.
 *
 * @param items - What to work through.
 * @param limit - How many at once.
 * @param fn - The work for one item.
 */
export async function in_parallel<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    let failed: { err: unknown } | null = null;
    const worker = async (): Promise<void> => {
        while (!failed && next < items.length) {
            const item = items[next++];
            try {
                await fn(item);
            } catch (err) {
                failed ??= { err };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    if (failed) throw (failed as { err: unknown }).err;
}
