import type { Message } from '@ag-ui/core';
import { Eye } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';

import { Trans, useTranslation } from '@socio/i18n/react';
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
import { RoomAudit, useRoomPeople } from './RoomAudit';
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
function useAbout() {
    const { t } = useTranslation(['operations.transcript']);
    const roomPeople = useRoomPeople();
    return (chat: OpsChatView | undefined, timeZone: string) => {
        if (!chat) {
            return t('operations.transcript:about.loading');
        }
        const since = t('operations.transcript:about.since', {
            when: formatWhen(chat.createdAt, timeZone),
            context: chat.archivedAt ? 'archived' : undefined,
        });
        if (chat.room) {
            const names = chat.room.socios.map((socio) => socio.name);
            const socios = names.length
                ? t('operations.transcript:about.names', { names })
                : t('operations.transcript:about.no-socio');
            return t('operations.transcript:about.room', { socios, people: roomPeople(chat.room), since });
        }
        return t('operations.transcript:about.chat', {
            socio: chat.socioName ?? t('operations.transcript:about.removed-socio'),
            owner: chat.ownerName ?? t('operations.transcript:about.gone-owner'),
            since,
        });
    };
}

/**
 * The transcript itself, once the heading is in: the newest turns first,
 * older ones on request, shown oldest to newest as in the chat. People's
 * messages sit on the left with their names, as another person's do in a
 * team chat, since the reader isn't the one who wrote them. The server
 * names each message's author: in a team topic, several people write.
 */
function Transcript({ chat, via }: { chat: OpsChatView; via: string }) {
    const { t } = useTranslation(['operations.transcript']);
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
                        {t('operations.transcript:load-earlier')}
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
                        {t('operations.transcript:try-again')}
                    </Button>
                </div>
            )}
            {!loading && !error && !hasMore && !runs.length && (
                <p className="m-0 text-sm text-muted-foreground">{t('operations.transcript:empty')}</p>
            )}
            {runs.length > 0 && (
                <ChatTranscript messages={messages} calls={[]} times={times} dotName={chat.socioName ?? undefined} />
            )}
            <p role="status" className="sr-only">
                {loading
                    ? t('operations.transcript:loading')
                    : runs.length
                      ? hasMore
                          ? t('operations.transcript:showing-more', { count: runs.length })
                          : t('operations.transcript:showing-all', { count: runs.length })
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
    const { t } = useTranslation(['operations.transcript', 'operations']);
    const about = useAbout();
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
                    setError(e instanceof Error ? e.message : t('operations.transcript:open-failed'));
                }
            });
        return () => controller.abort();
    }, [threadId, via, t]);
    useCrumbTitle(threadId, chat?.title ?? t('operations:crumbs.chat'));
    return (
        <OperationsLayout
            section={{
                label: chat?.title || t('operations:crumbs.chat'),
                description: error ? t('operations.transcript:failed') : about(chat, timeZone),
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
                        <Trans
                            t={t}
                            i18nKey="operations.transcript:note"
                            context={chat?.room ? 'room' : undefined}
                            components={{
                                link: (
                                    <Link
                                        to={opsPath('access-log')}
                                        className="text-foreground underline underline-offset-3"
                                    />
                                ),
                            }}
                        />
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
