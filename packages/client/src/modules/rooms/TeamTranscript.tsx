import type { Message } from '@ag-ui/core';
import { useCallback, useEffect, useState } from 'react';

import { useTranslation } from '@socio/i18n/react';
import { roomsOn } from '@socio/shared/rooms/room-view';
import type { Conversation, Dot, MessageAuthor } from '@socio/shared/types';

import { useStickToBottom } from '../../hooks/use-stick-to-bottom';
import { useOnDemand } from '../../i18n/on-demand';
import { api } from '../../lib/api';
import { useLiveTopic } from '../../lib/change-channel';
import { useShell } from '../../shell/shell-context';
import { ChatError, ChatFrame, ChatHeader, ChatNote, ChatScroller, chatColumn } from '../chat/chat-chrome';
import { ChatTranscript } from '../chat/ChatTranscript';
import { ScrollToEnd } from '../chat/ScrollToEnd';
import { useReactions } from '../chat/use-reactions';

import { RoomLoading } from './RoomChat';
import { ConvertTopicDialog } from './TopicDialogs';

import { Button } from '@/components/ui/button';

/**
 * A team conversation from a Telegram topic: readable here, answered in
 * Telegram. With Rooms on, its readers may make the topic a room
 * (CB-214): the transcript stays as it is. Its words (`rooms`) load on
 * demand, as a room's do: the chat's loading state shows until then.
 */
export function TeamTranscript({ thread, dot }: { thread: Conversation; dot: Dot }) {
    const ready = useOnDemand(['rooms']);
    return ready ? <TeamTranscriptView thread={thread} dot={dot} /> : <RoomLoading thread={thread} dot={dot} />;
}

function TeamTranscriptView({ thread, dot }: { thread: Conversation; dot: Dot }) {
    const { t } = useTranslation(['rooms']);
    const [messages, setMessages] = useState<Array<Message & { author?: MessageAuthor }>>();
    const [error, setError] = useState('');
    const [converting, setConverting] = useState(false);
    const { state } = useShell();
    const scroll = useStickToBottom();
    const reactions = useReactions(thread.id, !!messages);
    const load = useCallback(
        (isActive: () => boolean) =>
            void api<{ messages: Array<Message & { author?: MessageAuthor }> }>(
                `/conversations/${thread.id}/transcript`,
            )
                .then((data) => {
                    if (!isActive()) {
                        return;
                    }
                    setMessages(data.messages);
                    setError('');
                })
                .catch((e) => {
                    if (isActive()) {
                        setError(e instanceof Error ? e.message : t('rooms:topic.load-failed'));
                    }
                }),
        [thread.id, t],
    );
    // At once on another tab's note; a tick waits while the shell re-reads
    // (a topic this user left is never asked for).
    const canPoll = useLiveTopic(`conversation:${thread.id}`, () => load(canPoll));
    useEffect(() => {
        let active = true;
        const isActive = () => active;
        load(isActive);
        const timer = setInterval(() => {
            if (canPoll()) {
                load(isActive);
            }
        }, 5000);
        return () => {
            active = false;
            clearInterval(timer);
        };
    }, [load, canPoll]);
    return (
        <ChatFrame>
            <ChatHeader
                identity={dot.id}
                mascotCharacter={dot.character}
                mascotName={dot.name}
                title={thread.title}
                status={t('rooms:topic.status')}
            />
            <ChatScroller scroller={scroll.scroller} content={scroll.content} end={scroll.end}>
                {messages && <ChatTranscript messages={messages} calls={[]} dotName={dot.name} reactions={reactions} />}
                {messages && !messages.length && (
                    <p className="mt-0 mb-3 text-[12px]/[1.7] text-muted-foreground/80">{t('rooms:topic.empty')}</p>
                )}
            </ChatScroller>
            <ScrollToEnd scroll={scroll} />
            {error && <ChatError>{error}</ChatError>}
            <div className={chatColumn}>
                <ChatNote>
                    {t('rooms:topic.reply')}
                    {/* CB-214: a reader may make the topic a room, adding nobody. */}
                    {roomsOn(state) && !thread.archivedAt && (
                        <>
                            {' '}
                            <Button
                                type="button"
                                variant="link"
                                size="sm"
                                className="h-auto p-0 text-[11px]"
                                onClick={() => setConverting(true)}
                            >
                                {t('rooms:topic.convert')}
                            </Button>
                        </>
                    )}
                </ChatNote>
            </div>
            {converting && <ConvertTopicDialog thread={thread} onClose={() => setConverting(false)} />}
        </ChatFrame>
    );
}
