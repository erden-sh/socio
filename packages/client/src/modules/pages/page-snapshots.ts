/**
 * Merges a polled page list into the known one. The poll is the truth about
 * which pages exist (a page someone deleted drops out), with two
 * exceptions for responses that were in flight during a local change:
 * pages created here since the poll started (`fresh`) stay, so a new
 * document doesn't unmount, and pages deleted here (`deleted`) never come
 * back. A newer local revision is kept over an older polled one; at the
 * same revision, the newer change (a cover, CB-308, isn't a revision).
 */
export function mergePageSnapshot<Page extends { id: string; revision: number; updatedAt?: number }>(
    known: Page[],
    incoming: Page[],
    {
        fresh = new Set<string>(),
        deleted = new Set<string>(),
    }: { fresh?: ReadonlySet<string>; deleted?: ReadonlySet<string> } = {},
): Page[] {
    const previous = new Map(known.map((page) => [page.id, page]));
    const pages = new Map<string, Page>();
    for (const page of incoming) {
        if (deleted.has(page.id)) {
            continue;
        }
        const local = previous.get(page.id);
        pages.set(page.id, local && keepsLocal(local, page) ? local : page);
    }
    for (const page of known) {
        if (fresh.has(page.id) && !pages.has(page.id) && !deleted.has(page.id)) {
            pages.set(page.id, page);
        }
    }
    return [...pages.values()];
}

/** Whether the local copy is at least as new as the polled one. */
function keepsLocal(local: { revision: number; updatedAt?: number }, polled: { revision: number; updatedAt?: number }) {
    if (local.revision !== polled.revision) {
        return local.revision > polled.revision;
    }
    return (local.updatedAt ?? 0) >= (polled.updatedAt ?? 0);
}
