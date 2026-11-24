import { BookOpenText } from 'lucide-react';
import { useEffect, useState } from 'react';

import { formatNumber } from '@socio/shared/locale';
import type { OpsChatGrounding, OpsChatRef } from '@socio/shared/operations/operations-grounding';

import { api } from '../../lib/api';

import { formatWhen } from './format';
import { REF_KIND_LABELS } from './GroundingCard';
import { useOpsSettings } from './use-ops';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/** One kind's name beside a reference: what the turn did with it. */
const KIND_NOTE: Record<OpsChatRef['kind'], string> = {
    page: 'read',
    search: 'in a search',
    context: 'the chat’s page',
    dataset: 'queried',
    recall: 'recalled',
};
const plural = (n: number, word: string) => `${formatNumber(n)} ${word}${n === 1 ? '' : 's'}`;

/**
 * Operations → a chat → what grounded it (CB-194): the pages and datasets
 * its turns read, newest first, with how many turns read each; recalls of
 * the chat itself are counted, not listed. Titles and names only. Read
 * when opened, which the server writes to the access log.
 */
export function ChatGrounding({ threadId, via }: { threadId: string; via: string }) {
    const [open, setOpen] = useState(false);
    return (
        <Card data-slot="ops-chat-grounding" className="gap-0 px-4 py-3 text-sm shadow-xs">
            <details onToggle={(e) => setOpen(e.currentTarget.open)}>
                <summary className="flex cursor-pointer list-none items-center gap-2 font-medium [&::-webkit-details-marker]:hidden">
                    <BookOpenText size={16} aria-hidden className="shrink-0" />
                    What grounded this chat
                    <span className="text-xs font-normal text-muted-foreground">pages and datasets its turns read</span>
                </summary>
                {open && <Refs threadId={threadId} via={via} />}
            </details>
        </Card>
    );
}

function Refs({ threadId, via }: { threadId: string; via: string }) {
    const { timeZone } = useOpsSettings();
    const [answer, setAnswer] = useState<OpsChatGrounding | null>();
    const [error, setError] = useState('');
    useEffect(() => {
        const controller = new AbortController();
        api<OpsChatGrounding | null>(
            `/operations/chats/${encodeURIComponent(threadId)}/grounding?via=${via}`,
            'GET',
            undefined,
            controller.signal,
        )
            .then((found) => !controller.signal.aborted && setAnswer(found))
            .catch((e: unknown) => {
                if (!controller.signal.aborted) {
                    setError(e instanceof Error ? e.message : 'Could not load.');
                }
            });
        return () => controller.abort();
    }, [threadId, via]);
    if (error) {
        return (
            <p role="alert" className="m-0 mt-3 text-destructive">
                {error}
            </p>
        );
    }
    if (answer === undefined) {
        return <Skeleton className="mt-3 h-16 w-full" />;
    }
    if (answer === null) {
        return <p className="m-0 mt-3 text-muted-foreground">Analytics isn’t answering yet; try again shortly.</p>;
    }
    const recalls = answer.refs.filter((ref) => ref.kind === 'recall');
    const listed = answer.refs.filter((ref) => ref.kind !== 'recall');
    return (
        <div className="mt-3 grid gap-2">
            {!answer.refs.length && (
                <p className="m-0 text-muted-foreground">
                    Its turns read no pages or datasets that were recorded. Turns before this was recorded show nothing.
                </p>
            )}
            {listed.length > 0 && (
                <ul data-slot="ops-chat-refs" className="m-0 grid list-none gap-1 p-0">
                    {listed.map((ref) => (
                        <li
                            key={`${ref.kind}:${ref.refId}:${ref.spaceId ?? ''}`}
                            data-kind={ref.kind}
                            className="flex flex-wrap items-center gap-x-2 gap-y-0.5"
                        >
                            <span className="min-w-0 truncate font-medium">
                                {ref.title ?? (ref.kind === 'dataset' ? 'A removed dataset' : 'A removed page')}
                            </span>
                            <Badge variant="outline" title={REF_KIND_LABELS[ref.kind]}>
                                {KIND_NOTE[ref.kind]}
                            </Badge>
                            {ref.spaceName && <span className="text-xs text-muted-foreground">{ref.spaceName}</span>}
                            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                                {plural(ref.runs, 'turn')} · last {formatWhen(ref.lastAt, timeZone)}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            {recalls.length > 0 && (
                <p data-slot="ops-chat-recalls" className="m-0 text-muted-foreground">
                    Recalled {plural(recalls.length, 'earlier part')} of this chat.
                </p>
            )}
            {answer.more && (
                <p className="m-0 text-xs text-muted-foreground">
                    Showing the most recent; older references are left out.
                </p>
            )}
        </div>
    );
}
