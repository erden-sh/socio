import { useLoadMoreSentinel } from '../../components/infinite-list/use-load-more-sentinel';

import { ReleaseCard } from './ReleaseCard';
import { useWhatsNew } from './use-whats-new';

import { Skeleton } from '@/components/ui/skeleton';

/** A card's shape while its release loads. */
export function ReleaseCardSkeleton() {
    return (
        <div
            data-slot="release-card-skeleton"
            aria-hidden
            className="grid grid-cols-1 gap-2 rounded-xl border bg-card p-3 shadow-xs"
        >
            <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-14" />
                <Skeleton className="ml-auto h-3 w-20" />
            </div>
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-4/5" />
            <Skeleton className="h-3 w-2/3" />
        </div>
    );
}

/**
 * What's new's cards, newest first: the next page loads as the end comes
 * near (an IntersectionObserver), with skeletons while it does. The header
 * shows the same list. Home passes a `limit` to show only the most recent
 * cards and a link to the rest (CB-333), so it never loads the next page.
 */
export function ReleaseFeed({ onOpen, limit }: { onOpen?: () => void; limit?: number }) {
    const { releases, loading, hasMore, loadMore } = useWhatsNew();
    const capped = limit !== undefined;
    const sentinel = useLoadMoreSentinel(hasMore && !loading && !capped, loadMore);
    const shown = capped ? releases.slice(0, limit) : releases;
    return (
        <div data-slot="release-feed" aria-busy={loading} className="grid grid-cols-1 gap-2">
            {shown.map((release) => (
                <ReleaseCard key={release.version} release={release} onOpen={onOpen} />
            ))}
            {loading && (
                <>
                    <ReleaseCardSkeleton />
                    {!releases.length && <ReleaseCardSkeleton />}
                </>
            )}
            {!capped && hasMore && !loading && <div ref={sentinel} data-slot="release-feed-end" className="h-px" />}
        </div>
    );
}
