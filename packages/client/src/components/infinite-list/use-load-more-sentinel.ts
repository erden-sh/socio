import { useEffect, useState } from 'react';

/**
 * A ref for the end of a list: while it is near the view and there is
 * more, the next page loads.
 */
export function useLoadMoreSentinel(hasMore: boolean, loadMore: () => void) {
    const [node, setNode] = useState<Element | null>(null);
    useEffect(() => {
        if (!node || !hasMore || typeof IntersectionObserver === 'undefined') {
            return;
        }
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry?.isIntersecting) {
                    loadMore();
                }
            },
            { rootMargin: '0px 0px 200px 0px' },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [node, hasMore, loadMore]);
    return setNode;
}
