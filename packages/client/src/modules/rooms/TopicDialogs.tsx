import { Copy } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Trans, useTranslation } from '@socio/i18n/react';
import {
    ROOM_TOPIC_AUDIENCE,
    ROOM_TOPIC_CONVERT_TEXT,
    type RoomTopic,
    type RoomTopicCode,
    type RoomTopicSender,
    type RoomTopicView,
} from '@socio/shared/rooms/room-telegram';
import type { RoomPerson } from '@socio/shared/rooms/rooms';
import type { Conversation } from '@socio/shared/types';

import { onDemand } from '../../i18n/on-demand';
import { LocalTime } from '../../lib/local-time';
import { useShell } from '../../shell/shell-context';

import { failure, roomsApi } from './api';
import { useFocusReturn } from './focus-return';
import { Confirm, FormDialog, Problem, ROOM_DIALOG_NAMESPACES } from './RoomDialogs';
import { touchTarget } from './touch';

import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

/** "the General topic", "topic #12": a topic as a sentence names it. */
function useTopicName() {
    const { t } = useTranslation(['rooms.dialogs']);
    return (topic: Pick<RoomTopic, 'topicId'>) =>
        t('rooms.dialogs:topic.name', {
            id: topic.topicId,
            context: topic.topicId === 'general' ? 'general' : undefined,
        });
}

/**
 * What to post in the Telegram topic (CB-214): the command with its
 * one-time code, to copy, and how long it works.
 */
export function TopicCodeSteps({ issued }: { issued: RoomTopicCode }) {
    const { t } = useTranslation(['rooms.dialogs']);
    // "3:42 PM", in the reader's words once hydrated.
    const clock = (value: number) => t('rooms.dialogs:clock', { at: new Date(value) });
    return (
        <div data-slot="topic-code" className="grid gap-2 text-sm">
            <p>{t('rooms.dialogs:steps.send')}</p>
            <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 rounded-md border bg-muted/50 px-2.5 py-2 font-mono text-xs break-all">
                    {issued.command}
                </code>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={touchTarget}
                    // The code just came: focus on it, so it is read out (CB-219).
                    autoFocus
                    aria-label={t('rooms.dialogs:steps.copy-label')}
                    onClick={() =>
                        void navigator.clipboard?.writeText(issued.command).then(
                            () => toast.success(t('rooms.dialogs:steps.copied')),
                            () => toast.error(t('rooms.dialogs:steps.copy-failed')),
                        )
                    }
                >
                    <Copy /> {t('rooms.dialogs:steps.copy')}
                </Button>
            </div>
            <p className="text-xs text-muted-foreground">
                <Trans
                    t={t}
                    i18nKey="rooms.dialogs:steps.expires"
                    values={{ bot: issued.bot }}
                    components={{ time: <LocalTime value={issued.expiresAt} format={clock} /> }}
                />
            </p>
        </div>
    );
}

/** A person to invite, with Invite (room admins). */
function InviteRow({
    roomId,
    person,
    note,
    onInvited,
}: {
    roomId: string;
    person: RoomPerson;
    note?: string;
    onInvited: () => void;
}) {
    const { t } = useTranslation(['rooms.dialogs']);
    const [busy, setBusy] = useState(false);
    return (
        <li className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">
                {person.name}
                {note && <span className="text-muted-foreground"> · {note}</span>}
            </span>
            <Button
                type="button"
                size="sm"
                variant="outline"
                className={touchTarget}
                disabled={busy}
                onClick={async () => {
                    setBusy(true);
                    try {
                        await roomsApi.invite(roomId, person.userId);
                        toast.success(t('rooms.dialogs:topic.invited', { name: person.name }));
                        onInvited();
                    } catch (error) {
                        toast.error(failure(error, t('rooms.dialogs:topic.invite-failed')));
                    } finally {
                        setBusy(false);
                    }
                }}
            >
                {t('rooms.dialogs:topic.invite')}
            </Button>
        </li>
    );
}

/** Who wrote in the topic: their Socio name, their @username, or neither. */
function useSenderLabel() {
    const { t } = useTranslation(['rooms.dialogs']);
    return (sender: RoomTopicSender) =>
        sender.person
            ? sender.person.name
            : sender.username
              ? `@${sender.username}`
              : t('rooms.dialogs:topic.no-username');
}

/**
 * A room's Telegram topic (CB-214), from its ⋯ menu: whether one is
 * linked, and for its admins linking one (a code to post in the topic),
 * unlinking it, who the socio did not answer there and people seen in
 * the group to invite. Nobody is ever added without accepting.
 */
function RoomTopic({ thread, onClose }: { thread: Conversation; onClose: () => void }) {
    const { t } = useTranslation(['rooms.dialogs']);
    const topicName = useTopicName();
    const senderLabel = useSenderLabel();
    // "Oct 12", in the reader's words once hydrated.
    const day = (value: number) => t('rooms.dialogs:day', { at: new Date(value) });
    const focus = useFocusReturn();
    const [view, setView] = useState<RoomTopicView>();
    const [issued, setIssued] = useState<RoomTopicCode>();
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState('');
    const close = useRef(onClose);
    close.current = onClose;
    const load = useCallback(
        (signal?: AbortSignal) =>
            roomsApi.topic(thread.id, signal).then(
                (next) => {
                    setView(next);
                    return next;
                },
                (error) => {
                    if (signal?.aborted) {
                        return undefined;
                    }
                    toast.error(failure(error, t('rooms.dialogs:topic.read-failed')));
                    close.current();
                    return undefined;
                },
            ),
        [thread.id, t],
    );
    useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [load]);
    // While a code waits to be posted, see when the topic is linked.
    useEffect(() => {
        if (!issued) {
            return;
        }
        const timer = setInterval(() => {
            void load().then((next) => {
                if (next?.topic?.status !== 'active') {
                    return;
                }
                setIssued(undefined);
                toast.success(t('rooms.dialogs:topic.now-linked'));
            });
        }, 3000);
        return () => clearInterval(timer);
    }, [issued, load, t]);
    const admin = thread.roomRole === 'admin';
    const topic = view?.topic;
    const active = topic?.status === 'active';
    const act = async (work: () => Promise<unknown>, fallback: string) => {
        setBusy(true);
        setProblem('');
        try {
            await work();
            await load();
        } catch (error) {
            setProblem(failure(error, fallback));
        } finally {
            setBusy(false);
        }
    };
    const refresh = () => void load();
    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent
                onCloseAutoFocus={focus.onCloseAutoFocus}
                data-slot="room-topic"
                className="max-h-[90svh] overflow-y-auto sm:max-w-md"
            >
                {focus.mark}
                <DialogHeader>
                    <DialogTitle>{t('rooms.dialogs:topic.title')}</DialogTitle>
                    <DialogDescription>{t('rooms.dialogs:topic.description')}</DialogDescription>
                </DialogHeader>
                {!view ? (
                    <p className="text-sm text-muted-foreground">{t('rooms.dialogs:topic.loading')}</p>
                ) : (
                    <div className="grid gap-4 text-sm">
                        <p data-slot="room-topic-status">
                            {topic && active ? (
                                <Trans
                                    t={t}
                                    i18nKey="rooms.dialogs:topic.linked"
                                    context={topic.boundByName ? 'by' : undefined}
                                    values={{ topic: topicName(topic), name: topic.boundByName ?? '' }}
                                    components={{ date: <LocalTime value={topic.boundAt} format={day} /> }}
                                />
                            ) : topic?.endedAt ? (
                                <Trans
                                    t={t}
                                    i18nKey="rooms.dialogs:topic.ended"
                                    values={{ topic: topicName(topic) }}
                                    components={{ date: <LocalTime value={topic.endedAt} format={day} /> }}
                                />
                            ) : (
                                t('rooms.dialogs:topic.not-linked')
                            )}
                        </p>
                        {admin && !active && !issued && (
                            <>
                                {!view.available ? (
                                    <p className="text-muted-foreground">{t('rooms.dialogs:topic.unavailable')}</p>
                                ) : !view.linked ? (
                                    <p className="text-muted-foreground">{t('rooms.dialogs:topic.link-account')}</p>
                                ) : (
                                    <>
                                        <p className="rounded-md border bg-muted/50 p-3">{ROOM_TOPIC_AUDIENCE}</p>
                                        <Confirm checked={confirmed} onChange={setConfirmed}>
                                            {t('rooms.dialogs:topic.understood')}
                                        </Confirm>
                                    </>
                                )}
                            </>
                        )}
                        {issued && <TopicCodeSteps issued={issued} />}
                        {admin && view.unanswered && view.unanswered.length > 0 && (
                            <section className="grid gap-1.5">
                                <h3 className="font-medium">{t('rooms.dialogs:topic.unanswered')}</h3>
                                <ul className="grid gap-1.5">
                                    {view.unanswered.map((sender) =>
                                        sender.person ? (
                                            <InviteRow
                                                key={`p:${sender.person.userId}`}
                                                roomId={thread.id}
                                                person={sender.person}
                                                note={t('rooms.dialogs:topic.not-in-room')}
                                                onInvited={refresh}
                                            />
                                        ) : (
                                            <li
                                                key={`u:${sender.username ?? sender.lastSeenAt}`}
                                                className="text-muted-foreground"
                                            >
                                                {t('rooms.dialogs:topic.not-on-socio', {
                                                    sender: senderLabel(sender),
                                                })}
                                            </li>
                                        ),
                                    )}
                                </ul>
                            </section>
                        )}
                        {admin && view.suggested && view.suggested.length > 0 && (
                            <section className="grid gap-1.5">
                                <h3 className="font-medium">{t('rooms.dialogs:topic.seen')}</h3>
                                <p className="text-xs text-muted-foreground">{t('rooms.dialogs:topic.seen-hint')}</p>
                                <ul className="grid gap-1.5">
                                    {view.suggested.map((person) => (
                                        <InviteRow
                                            key={person.userId}
                                            roomId={thread.id}
                                            person={person}
                                            onInvited={refresh}
                                        />
                                    ))}
                                </ul>
                            </section>
                        )}
                        <Problem>{problem}</Problem>
                    </div>
                )}
                <DialogFooter>
                    <Button type="button" variant="outline" className={touchTarget} disabled={busy} onClick={onClose}>
                        {t('rooms.dialogs:topic.close')}
                    </Button>
                    {view && admin && active && (
                        <Button
                            type="button"
                            variant="destructive"
                            className={touchTarget}
                            disabled={busy}
                            onClick={() =>
                                void act(async () => {
                                    await roomsApi.unbindTopic(thread.id);
                                    toast.success(t('rooms.dialogs:topic.unlinked'));
                                }, t('rooms.dialogs:topic.unlink-failed'))
                            }
                        >
                            {t('rooms.dialogs:topic.unlink')}
                        </Button>
                    )}
                    {view && admin && !active && !issued && view.available && view.linked && (
                        <Button
                            type="button"
                            className={touchTarget}
                            disabled={busy || !confirmed}
                            onClick={() =>
                                void act(
                                    async () => setIssued(await roomsApi.topicCode(thread.id)),
                                    t('rooms.dialogs:topic.code-failed'),
                                )
                            }
                        >
                            {t('rooms.dialogs:topic.get-code')}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
export const RoomTopicDialog = onDemand([...ROOM_DIALOG_NAMESPACES], RoomTopic);

/**
 * A legacy team topic made a room by one of its readers (CB-214): a new
 * room they are the admin of, bound to the topic once they post the code
 * there as an admin of the group. The topic's transcript stays here as it
 * is, for the people who read it; nobody is added to the room.
 */
function ConvertTopic({ thread, onClose }: { thread: Conversation; onClose: () => void }) {
    const { t } = useTranslation(['rooms.dialogs']);
    const shell = useShell();
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState('');
    const [issued, setIssued] = useState<RoomTopicCode>();
    const focus = useFocusReturn();
    if (issued) {
        return (
            <Dialog open onOpenChange={(open) => !open && onClose()}>
                <DialogContent
                    // What opened the first step gets the focus back (its mark).
                    onCloseAutoFocus={focus.onCloseAutoFocus}
                    data-slot="convert-topic"
                    className="max-h-[90svh] overflow-y-auto sm:max-w-md"
                >
                    <DialogHeader>
                        <DialogTitle>{t('rooms.dialogs:convert-topic.code-title')}</DialogTitle>
                        <DialogDescription>{t('rooms.dialogs:convert-topic.code-description')}</DialogDescription>
                    </DialogHeader>
                    <TopicCodeSteps issued={issued} />
                    <DialogFooter>
                        <Button
                            type="button"
                            className={touchTarget}
                            onClick={() => {
                                void shell.refresh();
                                onClose();
                            }}
                        >
                            {t('rooms.dialogs:convert-topic.done')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        );
    }
    return (
        <FormDialog
            open
            onOpenChange={(open) => !open && onClose()}
            title={t('rooms.dialogs:convert-topic.title')}
            slot="convert-topic"
            focus={focus}
            description={t('rooms.dialogs:convert-topic.description')}
            action={busy ? t('rooms.dialogs:convert-topic.busy') : t('rooms.dialogs:convert-topic.action')}
            busy={busy}
            disabled={!confirmed}
            problem={problem}
            onSubmit={async () => {
                setBusy(true);
                setProblem('');
                try {
                    setIssued(await roomsApi.convertTopicCode(thread.id));
                } catch (error) {
                    setProblem(failure(error, t('rooms.dialogs:topic.code-failed')));
                } finally {
                    setBusy(false);
                }
            }}
        >
            <p data-slot="convert-topic-transcript" className="text-sm">
                {ROOM_TOPIC_CONVERT_TEXT}
            </p>
            <p className="rounded-md border bg-muted/50 p-3 text-sm">{ROOM_TOPIC_AUDIENCE}</p>
            <Confirm checked={confirmed} onChange={setConfirmed}>
                {t('rooms.dialogs:topic.understood')}
            </Confirm>
        </FormDialog>
    );
}
export const ConvertTopicDialog = onDemand([...ROOM_DIALOG_NAMESPACES], ConvertTopic);
