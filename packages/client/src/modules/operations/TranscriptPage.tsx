import type { Message } from '@ag-ui/core';
import { Eye } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';

import { ACCESS_VIA, type OpsChatView, type OpsTranscriptRun } from '@socio/shared/operations/operations-access';
import { TraceTimes } from '@socio/shared/runs/trace-times';
import type { MessageAuthor } from '@socio/shared/types';

import { useCursorList } from '../../components/infinite-list/use-cursor-list';
import { api } from '../../lib/api';
import { useCrumbTitle } from '../../shell/crumb-title';
import { chatColumn } from '../chat/chat-chrome';
import { ChatTranscript } from '../chat/ChatTranscript';

import { ChatGrounding } from './ChatGrounding';
import { formatWhen } from './format';
import { OperationsLayout } from './OperationsLayout';
import { RoomAudit, roomPeople } from './RoomAudit';
import { opsPath } from './sections';
import { useOpsSettings } from './use-ops';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

type Shown = Message & { author?: MessageAuthor };

/**
 * The heading's line under the title: the socio, who it's with, since
 * when. A room (CB-213) names its people, admins marked, never an owner.
 */
function about(chat: OpsChatView | undefined, timeZone: string) {
    if (!chat) {
        return 'Loading the chat…';
    }
    const since = `since ${formatWhen(chat.createdAt, timeZone)}${chat.archivedAt ? ' · archived' : ''}. Read-only.`;
    if (chat.room) {
        const socios = chat.room.socios.map((socio) => socio.name).join(', ') || 'No socio now';
        return `A room: ${socios} with ${roomPeople(chat.room)}, ${since}`;
    }
    const socio = chat.socioName ?? 'A removed socio';
    const owner = chat.ownerName ?? 'someone no longer here';
    return `${socio} with ${owner}, ${since}`;
}

/**
 * The transcript itself, once the heading is in: the newest turns first,
 * older ones on request, shown oldest to newest as in the chat. People's
 * messages sit on the left with their names, as another person's do in a
 * team chat, since the reader isn't the one who wrote them. The server
 * names each message's author: in a team topic, several people write.
 */
function Transcript({ chat, via }: { chat: OpsChatView; via: string }) {
    const turns = useCursorList<OpsTranscriptRun>(
        `/operations/chats/${encodeURIComponent(chat.id)}/history?via=${via}`,
    );
    const runs = useMemo(() => [...turns.items].reverse(), [turns.items]);
    const { messages, times } = useMemo(() => {
        const times = new TraceTimes();
        const messages: Shown[] = [];
        for (const run of runs) {
            times.absorb(run.times);
            messages.push(...run.messages);
        }
        return { messages, times };
    }, [runs]);
    const { loading, error, hasMore, loadMore } = turns;
    return (
        <div
            data-slot="ops-transcript"
            aria-busy={loading}
            className={cn(
                chatColumn,
                'flex min-w-0 flex-col gap-5.5 [overflow-wrap:anywhere] *:min-w-0 max-[700px]:gap-5',
            )}
        >
            {hasMore && !loading && !error && runs.length > 0 && (
                <div className="self-center">
                    <Button variant="outline" size="sm" onClick={loadMore}>
                        Load earlier turns
                    </Button>
                </div>
            )}
            {loading && (
                <div aria-hidden className="grid gap-3">
                    <Skeleton className="h-10 w-2/3" />
                    <Skeleton className="h-16 w-full" />
                </div>
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
            {!loading && !error && !hasMore && !runs.length && (
                <p className="m-0 text-sm text-muted-foreground">No finished turns in this chat yet.</p>
            )}
            {runs.length > 0 && (
                <ChatTranscript messages={messages} calls={[]} times={times} dotName={chat.socioName ?? undefined} />
            )}
            <p role="status" className="sr-only">
                {loading
                    ? 'Loading…'
                    : runs.length
                      ? `Showing ${runs.length} turns${hasMore ? '; earlier ones to load' : ', all of them'}.`
                      : ''}
            </p>
        </div>
    );
}

/**
 * Operations → a chat (CB-188): any chat in the workspace, read-only, for
 * admins. Opening it is written to the access log (the server does it),
 * which the note at the top says, so the reader knows.
 */
export function TranscriptPage({
    threadId,
    via: asked,
}: {
    threadId: string;
    /** The section it was opened from, kept with the access log entry. */
    via: string | null;
}) {
    const { timeZone } = useOpsSettings();
    const via = asked && ACCESS_VIA.test(asked) ? asked : 'link';
    const [chat, setChat] = useState<OpsChatView>();
    const [error, setError] = useState('');
    useEffect(() => {
        const controller = new AbortController();
        setChat(undefined);
        setError('');
        api<OpsChatView>(
            `/operations/chats/${encodeURIComponent(threadId)}?via=${via}`,
            'GET',
            undefined,
            controller.signal,
        )
            .then((view) => !controller.signal.aborted && setChat(view))
            .catch((e: unknown) => {
                if (!controller.signal.aborted) {
                    setError(e instanceof Error ? e.message : 'Could not open the chat.');
                }
            });
        return () => controller.abort();
    }, [threadId, via]);
    useCrumbTitle(threadId, chat?.title ?? 'Chat');
    return (
        <OperationsLayout
            section={{
                label: chat?.title || 'Chat',
                description: error ? 'This chat couldn’t be opened.' : about(chat, timeZone),
                ranged: false,
            }}
        >
            {/* A chat reads at a chat's width, not the dashboard's (CB-220). */}
            <div className="grid max-w-4xl min-w-0 gap-6">
                <Card
                    data-slot="ops-transcript-note"
                    className="flex-row items-start gap-3 px-4 py-3 text-sm text-muted-foreground shadow-xs"
                >
                    <Eye size={16} className="mt-0.5 shrink-0" aria-hidden />
                    <p className="m-0">
                        You’re reading this {chat?.room ? 'room' : 'chat'} as an admin. Opening it was written to the{' '}
                        <Link to={opsPath('access-log')} className="text-foreground underline underline-offset-3">
                            access log
                        </Link>
                        , which every admin can see.
                    </p>
                </Card>
                {error ? (
                    <p role="alert" className="m-0 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                        {error}
                    </p>
                ) : chat ? (
                    <>
                        {chat.room && <RoomAudit roomId={chat.id} via={via} />}
                        <ChatGrounding threadId={chat.id} via={via} />
                        <Transcript chat={chat} via={via} />
                    </>
                ) : (
                    <Skeleton className="h-40 w-full" />
                )}
            </div>
        </OperationsLayout>
    );
}
