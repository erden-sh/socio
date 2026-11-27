import { ArrowUp, LoaderCircle } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

import { useTranslation } from '@socio/i18n/react';

import { Button } from '@/components/ui/button';

/** Earlier turns load this far before the reader reaches the top. */
const AHEAD_PX = 600;

/**
 * The top of a long chat (CB-136): its earlier turns come from the server
 * as the reader scrolls up to it, or asks with the button, and the
 * reader stays where they were while they come in above.
 */
export function EarlierTurns({
    scroller,
    earlier,
    loading,
    oldest,
    onLoad,
}: {
    scroller: RefObject<HTMLDivElement | null>;
    /** The server has turns before the ones shown. */
    earlier: boolean;
    loading: boolean;
    /** The oldest turn shown: it changes when earlier ones come. */
    oldest: number | undefined;
    onLoad: () => void;
}) {
    const { t } = useTranslation(['chat']);
    const sentinel = useRef<HTMLDivElement>(null);
    // The first message shown and its place in view, before the load.
    const anchor = useRef<{ id: string; top: number }>(undefined);
    const latest = useRef({ earlier, loading, onLoad });
    latest.current = { earlier, loading, onLoad };
    const load = useRef(() => {
        const { earlier, loading, onLoad } = latest.current;
        const box = scroller.current;
        if (!earlier || loading || !box) {
            return;
        }
        const first = box.querySelector<HTMLElement>('[data-message-id]');
        anchor.current = first
            ? {
                  id: first.dataset.messageId!,
                  top: first.getBoundingClientRect().top - box.getBoundingClientRect().top,
              }
            : undefined;
        onLoad();
    });
    // Back where the reader was: the anchor's place in view, unless the
    // browser kept it there itself (scroll anchoring).
    useLayoutEffect(() => {
        const box = scroller.current;
        const held = anchor.current;
        if (!box || !held) {
            return;
        }
        anchor.current = undefined;
        const first = box.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(held.id)}"]`);
        if (!first) {
            return;
        }
        const moved = first.getBoundingClientRect().top - box.getBoundingClientRect().top - held.top;
        if (moved) {
            box.scrollTop += moved;
        }
    }, [oldest, scroller]);
    useEffect(() => {
        const box = scroller.current;
        const target = sentinel.current;
        if (!box || !target || typeof IntersectionObserver === 'undefined') {
            return;
        }
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) {
                    load.current();
                }
            },
            { root: box, rootMargin: `${AHEAD_PX}px 0px 0px 0px` },
        );
        observer.observe(target);
        return () => observer.disconnect();
    }, [scroller, earlier, oldest]);
    if (!earlier && !loading) {
        return null;
    }
    return (
        <div
            ref={sentinel}
            data-slot="earlier-turns"
            className="flex min-h-6 justify-center text-xs text-muted-foreground"
        >
            {loading ? (
                <span role="status" className="flex items-center gap-2">
                    <LoaderCircle size={13} className="shrink-0 animate-spin motion-reduce:animate-none" />
                    {t('chat:earlier.loading')}
                </span>
            ) : (
                <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="text-muted-foreground"
                    onClick={() => load.current()}
                >
                    <ArrowUp aria-hidden="true" />
                    {t('chat:earlier.show')}
                </Button>
            )}
        </div>
    );
}
