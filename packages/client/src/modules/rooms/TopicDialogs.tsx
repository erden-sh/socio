import { Copy } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

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

import { LocalTime } from '../../lib/local-time';
import { useShell } from '../../shell/shell-context';

import { failure, roomsApi } from './api';
import { useFocusReturn } from './focus-return';
import { Confirm, FormDialog, Problem } from './RoomDialogs';
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

/** "3:42 PM", in the reader's words once hydrated. */
const clock = (value: number) =>
    new Date(value).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
    });
/** "Oct 12", in the reader's words once hydrated. */
const day = (value: number) =>
    new Date(value).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
    });

const topicName = (topic: Pick<RoomTopic, 'topicId'>) =>
    topic.topicId === 'general' ? 'the General topic' : `topic #${topic.topicId}`;

/**
 * What to post in the Telegram topic (CB-214): the command with its
 * one-time code, to copy, and how long it works.
 */
export function TopicCodeSteps({ issued }: { issued: RoomTopicCode }) {
    return (
        <div data-slot="topic-code" className="grid gap-2 text-sm">
            <p>In the Telegram topic, from your linked account and as an admin of the group, send:</p>
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
                    aria-label="Copy the command"
                    onClick={() =>
                        void navigator.clipboard?.writeText(issued.command).then(
                            () => toast.success('Copied'),
                            () => toast.error('Could not copy. Select the command instead.'),
                        )
                    }
                >
                    <Copy /> Copy
                </Button>
            </div>
            <p className="text-xs text-muted-foreground">
                It works once, until <LocalTime value={issued.expiresAt} format={clock} />. The bot (@
                {issued.bot}) answers in the topic.
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
                        toast.success(`Invited ${person.name}`);
                        onInvited();
                    } catch (error) {
                        toast.error(failure(error, 'Could not invite them.'));
                    } finally {
                        setBusy(false);
                    }
                }}
            >
                Invite
            </Button>
        </li>
    );
}

const senderLabel = (sender: RoomTopicSender) =>
    sender.person
        ? sender.person.name
        : sender.username
          ? `@${sender.username}`
          : 'A Telegram account without a username';

/**
 * A room's Telegram topic (CB-214), from its ⋯ menu: whether one is
 * linked, and for its admins linking one (a code to post in the topic),
 * unlinking it, who the socio did not answer there and people seen in
 * the group to invite. Nobody is ever added without accepting.
 */
export function RoomTopicDialog({ thread, onClose }: { thread: Conversation; onClose: () => void }) {
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
                    toast.error(failure(error, 'Could not read the room’s topic.'));
                    close.current();
                    return undefined;
                },
            ),
        [thread.id],
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
                toast.success('The Telegram topic is linked to this room.');
            });
        }, 3000);
        return () => clearInterval(timer);
    }, [issued, load]);
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
                    <DialogTitle>Telegram topic</DialogTitle>
                    <DialogDescription>
                        In a linked forum topic, room members talk to the room’s socio by mentioning the bot or replying
                        to it. It answers no one else.
                    </DialogDescription>
                </DialogHeader>
                {!view ? (
                    <p className="text-sm text-muted-foreground">Loading…</p>
                ) : (
                    <div className="grid gap-4 text-sm">
                        <p data-slot="room-topic-status">
                            {topic && active ? (
                                <>
                                    Linked to {topicName(topic)} in the Telegram group
                                    {topic.boundByName ? ` by ${topic.boundByName}` : ''},{' '}
                                    <LocalTime value={topic.boundAt} format={day} />.
                                </>
                            ) : topic?.endedAt ? (
                                <>
                                    Not linked. It was linked to {topicName(topic)} until{' '}
                                    <LocalTime value={topic.endedAt} format={day} />.
                                </>
                            ) : (
                                'Not linked to a Telegram topic.'
                            )}
                        </p>
                        {admin && !active && !issued && (
                            <>
                                {!view.available ? (
                                    <p className="text-muted-foreground">Telegram isn’t connected on this server.</p>
                                ) : !view.linked ? (
                                    <p className="text-muted-foreground">
                                        Link your Telegram account first: choose Telegram in the sidebar. The code works
                                        only from your account.
                                    </p>
                                ) : (
                                    <>
                                        <p className="rounded-md border bg-muted/50 p-3">{ROOM_TOPIC_AUDIENCE}</p>
                                        <Confirm checked={confirmed} onChange={setConfirmed}>
                                            I understand who reads the topic.
                                        </Confirm>
                                    </>
                                )}
                            </>
                        )}
                        {issued && <TopicCodeSteps issued={issued} />}
                        {admin && view.unanswered && view.unanswered.length > 0 && (
                            <section className="grid gap-1.5">
                                <h3 className="font-medium">Not answered in the topic</h3>
                                <ul className="grid gap-1.5">
                                    {view.unanswered.map((sender) =>
                                        sender.person ? (
                                            <InviteRow
                                                key={`p:${sender.person.userId}`}
                                                roomId={thread.id}
                                                person={sender.person}
                                                note="not in the room"
                                                onInvited={refresh}
                                            />
                                        ) : (
                                            <li
                                                key={`u:${sender.username ?? sender.lastSeenAt}`}
                                                className="text-muted-foreground"
                                            >
                                                {senderLabel(sender)} · not linked to Socio
                                            </li>
                                        ),
                                    )}
                                </ul>
                            </section>
                        )}
                        {admin && view.suggested && view.suggested.length > 0 && (
                            <section className="grid gap-1.5">
                                <h3 className="font-medium">Seen in the Telegram group</h3>
                                <p className="text-xs text-muted-foreground">
                                    People with a linked account who wrote in the group and aren’t in the room. They
                                    join only if they accept.
                                </p>
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
                        Close
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
                                    toast.success('The Telegram topic is unlinked.');
                                }, 'Could not unlink the topic.')
                            }
                        >
                            Unlink topic
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
                                    'Could not get a code.',
                                )
                            }
                        >
                            Get a code
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/**
 * A legacy team topic made a room by one of its readers (CB-214): a new
 * room they are the admin of, bound to the topic once they post the code
 * there as an admin of the group. The topic's transcript stays here as it
 * is, for the people who read it; nobody is added to the room.
 */
export function ConvertTopicDialog({ thread, onClose }: { thread: Conversation; onClose: () => void }) {
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
                        <DialogTitle>Make this topic a room</DialogTitle>
                        <DialogDescription>
                            The room appears under Rooms once the bot confirms it in the topic. Then invite people from
                            its Members. This transcript stays as it is, for the people who can read it now.
                        </DialogDescription>
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
                            Done
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
            title="Make this topic a room?"
            slot="convert-topic"
            focus={focus}
            description="A new room you are the admin of, with this topic’s socio, linked to the Telegram topic."
            action={busy ? 'Getting a code…' : 'Get a code'}
            busy={busy}
            disabled={!confirmed}
            problem={problem}
            onSubmit={async () => {
                setBusy(true);
                setProblem('');
                try {
                    setIssued(await roomsApi.convertTopicCode(thread.id));
                } catch (error) {
                    setProblem(failure(error, 'Could not get a code.'));
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
                I understand who reads the topic.
            </Confirm>
        </FormDialog>
    );
}
