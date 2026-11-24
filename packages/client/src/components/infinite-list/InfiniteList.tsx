import type { ReactNode } from 'react';

import type { CursorList } from './use-cursor-list';
import { useLoadMoreSentinel } from './use-load-more-sentinel';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * A cursor-paged list (`useCursorList`) that loads its next page as its
 * end scrolls near (CB-164), with a visible Load more button that does the
 * same for the keyboard and screen readers. No page numbers: the list
 * only grows. Skeleton rows while a page loads; a failed page says why
 * and offers to try again.
 */
export function InfiniteList<T>({
    list,
    label,
    itemKey,
    renderItem,
    empty,
    className,
}: {
    list: CursorList<T>;
    /** The list's accessible name ("Recent turns"). */
    label: string;
    itemKey: (item: T) => string;
    renderItem: (item: T) => ReactNode;
    /** Shown when the list has nothing at all. */
    empty: ReactNode;
    className?: string;
}) {
    const { items, loading, error, hasMore, loadMore } = list;
    const sentinel = useLoadMoreSentinel(hasMore && !loading && !error, loadMore);
    return (
        <div data-slot="infinite-list" aria-busy={loading} className={cn('grid gap-2', className)}>
            {items.length > 0 && (
                <ul aria-label={label} className="m-0 grid list-none gap-0 divide-y p-0">
                    {items.map((item) => (
                        <li key={itemKey(item)} className="min-w-0">
                            {renderItem(item)}
                        </li>
                    ))}
                </ul>
            )}
            {loading && (
                <div aria-hidden className="grid gap-2 py-1">
                    {Array.from({ length: items.length ? 2 : 4 }, (_, index) => (
                        <Skeleton key={index} className="h-9 w-full" />
                    ))}
                </div>
            )}
            {!loading && !error && !hasMore && !items.length && (
                <p className="py-2 text-sm text-muted-foreground">{empty}</p>
            )}
            {error && !loading && (
                <div
                    role="alert"
                    className="flex flex-wrap items-center gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
                >
                    <span>{error}</span>
                    <Button variant="outline" size="sm" onClick={loadMore}>
                        Try again
                    </Button>
                </div>
            )}
            {hasMore && !loading && !error && (
                <>
                    <div ref={sentinel} data-slot="infinite-list-end" className="h-px" />
                    <div>
                        <Button variant="outline" size="sm" onClick={loadMore}>
                            Load more
                        </Button>
                    </div>
                </>
            )}
            <p role="status" className="sr-only">
                {loading
                    ? 'Loading…'
                    : items.length
                      ? `Showing ${items.length}${hasMore ? '; more to load' : ', all of them'}.`
                      : ''}
            </p>
        </div>
    );
}
