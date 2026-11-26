import { Archive, ArrowUp, CircleAlert, Pin, Square, Users } from 'lucide-react';
import { useContext, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';

import { STEERING_MAX_CHARS, type QueuedMessage } from '@socio/shared/chat/steering';
import type { MentionablePerson } from '@socio/shared/rooms/room-people-mentions';
import { personLabels } from '@socio/shared/rooms/room-speakers';
import {
    answeringSocios,
    fitName,
    mentionablePeople,
    mentionableSocios,
    messageTargets,
    problemText,
    readOnlyReason,
    replySocio,
    roomsOn,
    roomStatus,
    runningNote,
    soleSocio,
    targetsLine,
    transcriptProblem,
    withMention,
} from '@socio/shared/rooms/room-view';
import type { RoomSocioView, RoomView } from '@socio/shared/rooms/rooms';
import { messageAuthor } from '@socio/shared/runs/socio-fields';
import type { Conversation, Dot, TranscriptTurnProblem } from '@socio/shared/types';

import { useStickToBottom } from '../../hooks/use-stick-to-bottom';
import { api, ApiError } from '../../lib/api';
import { Mascot } from '../../locals/Mascot';
import { CurrentUser } from '../../shell/current-user';
import { useShell } from '../../shell/shell-context';
import {
    ChatError,
    ChatFrame,
    ChatHeader,
    ChatIconButton,
    ChatNote,
    ChatNotice,
    ChatScroller,
    SendButton,
    chatColumn,
    composerText,
} from '../chat/chat-chrome';
import { shouldSubmitComposerOnKeyDown, useFitComposer } from '../chat/chat-composer';
import { chatDraft, useDraft } from '../chat/chat-drafts';
import { Markdown } from '../chat/ChatMarkdown';
import { ChatTranscript, pendingUserBubble } from '../chat/ChatTranscript';
import { OthersQueuedMessages, QueuedMessages } from '../chat/QueuedMessages';
import { ScrollToEnd } from '../chat/ScrollToEnd';
import { useReactions } from '../chat/use-reactions';

import { failure } from './api';
import { stillQueued, useRoomFeed, type RoomMessage } from './feed';
import { MembersPanel } from './MembersPanel';
import { usePeopleMentions } from './PeopleMentions';
import { PinsPanel } from './PinsPanel';
import { useOthersQueued } from './queue';
import { useMarkRoomRead } from './read-state';
import { useRoomInviteCommand } from './RoomInviteCommand';
import { useArchiveRoom } from './RoomMenu';
import { RoomPresence } from './RoomPresence';
import { RoomSpeaker, personTones } from './RoomSpeaker';
import { HandoffNotice, SocioPicker } from './SocioPicker';
import { touchTarget } from './touch';
import { useRoom } from './use-room';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/** A note above the room (archived, read-only), in the chat's column. */
const notice =
    'mx-auto my-3 flex w-[calc(100%-2rem)] max-w-2xl shrink-0 flex-wrap items-center gap-3 rounded-lg border bg-muted/60 px-4 py-2 text-sm text-foreground';

/** Active socios that answer in the room, lead first. */
function activeSocios(room: RoomView | undefined) {
    if (!room) {
        return [];
    }
    return room.socios.filter((socio) => socio.status === 'active').sort((a, b) => Number(b.lead) - Number(a.lead));
}

const SOCIO_STACK_SHOWN = 3;

/** The room's active socios as a small stacked-avatar cluster (CB-293). */
function RoomSocios({
    socios,
    dots,
    state,
}: {
    socios: readonly RoomSocioView[];
    dots: readonly Dot[];
    state: 'idle' | 'working' | 'paused';
}) {
    if (!socios.length) {
        return null;
    }
    return (
        <div
            data-slot="room-socios"
            className="flex shrink-0 items-center -space-x-2"
            aria-label={socios.map((socio) => socio.name).join(', ')}
        >
            {socios.slice(0, SOCIO_STACK_SHOWN).map((socio) => {
                const dot = dots.find((item) => item.id === socio.dotId);
                return (
                    <Mascot
                        key={socio.dotId}
                        identity={socio.dotId}
                        character={dot?.character}
                        name={socio.name}
                        state={state}
                        small
                        className="size-7 ring-2 ring-background"
                    />
                );
            })}
            {socios.length > SOCIO_STACK_SHOWN && (
                <span className="flex size-7 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-2 ring-background">
                    +{socios.length - SOCIO_STACK_SHOWN}
                </span>
            )}
        </div>
    );
}

/**
 * A room (CB-212): the shared conversation of its members and its lead
 * socio. Every message says who wrote it (avatar and name, the socio's
 * mascot, "You"); a member writes to the room's queue, and the socio
 * answers each person's messages as that person, in order. The Members
 * panel holds its people and socios. Live updates come from the room
 * feed (feed.ts); with Rooms off or the room archived it is read-only.
 * Each member sees, edits and cancels only their own queued messages; a
 * room admin also sees everyone else's and may cancel them (CB-215).
 * Looking at the room clears its unread count for the reader.
 */
export function RoomChat({ thread, dot }: { thread: Conversation; dot: Dot }) {
    const shell = useShell();
    const on = roomsOn(shell.state);
    const { room, update, reload } = useRoom(thread.id);
    const feed = useRoomFeed(thread.id);
    const scroll = useStickToBottom();
    const reactions = useReactions(thread.id, !!feed.messages && !feed.gone);
    const [params, setParams] = useSearchParams();
    const membersButton = useRef<HTMLButtonElement>(null);
    const pinsButton = useRef<HTMLButtonElement>(null);
    const membersOpen = params.has('members');
    const pinsOpen = params.has('pins');
    const setPanel = (panel: 'members' | 'pins', open: boolean) =>
        setParams(
            (current) => {
                const next = new URLSearchParams(current);
                if (open) {
                    next.set(panel, '1');
                } else {
                    next.delete(panel);
                }
                return next;
            },
            { replace: true },
        );
    const setMembersOpen = (open: boolean) => setPanel('members', open);
    const setPinsOpen = (open: boolean) => setPanel('pins', open);
    const readOnly = readOnlyReason(thread, room, on);
    const queued = stillQueued(feed.queued, feed.messages);
    const admin = room?.role === 'admin';
    const roomSocios = activeSocios(room);
    // Others' waiting messages, which a room admin may cancel (CB-215).
    const othersQueue = useOthersQueued(thread.id, admin && on && !thread.archivedAt && !feed.gone);
    const shownIds = new Set(feed.messages?.map((message) => message.id));
    const othersQueued = othersQueue.others.filter((message) => !shownIds.has(message.id));
    // Reading the room clears its unread count, on every device (CB-215).
    useMarkRoomRead(feed.gone ? { ...thread, unread: 0 } : thread, shell.refresh);
    // Two people with one name get different avatars (CB-212).
    const tones = useMemo(
        () =>
            personTones([
                ...(room?.members ?? []).map((member) => ({
                    id: member.userId,
                    name: member.name,
                })),
                ...(feed.messages ?? []).flatMap((message) => messageAuthor(message) ?? []),
            ]),
        [room?.members, feed.messages],
    );
    // ...and, in words, a number by join order: "Ana Lima · 2".
    const labels = useMemo(() => personLabels(room?.members ?? []), [room?.members]);
    // Each turn that went unanswered, after the message it follows.
    const problems = useMemo(() => {
        const by = new Map<string, TranscriptTurnProblem[]>();
        for (const problem of feed.problems) {
            by.set(problem.after ?? '', [...(by.get(problem.after ?? '') ?? []), problem]);
        }
        return by;
    }, [feed.problems]);
    // Several socios (CB-206): who a message goes to, and whose turn runs.
    const several = answeringSocios(room?.socios).length > 1;
    // A handoff the live stream brought has ids only: the room's names.
    const running = runningNote(several ? 'A socio' : dot.name, feed.phase);
    // Where focus goes once a queued message it was on is gone (CB-219).
    const composerBox = () => document.querySelector<HTMLTextAreaElement>('[data-slot="room-composer"] textarea');
    const socioNamed = (id: string, name: string) =>
        name ||
        room?.socios.find((socio) => socio.dotId === id)?.name ||
        shell.workspace.dots.find((item) => item.id === id)?.name ||
        'A socio';
    const mascots = roomSocios.length ? (
        <RoomSocios
            socios={roomSocios}
            dots={shell.workspace.dots}
            state={shell.state.settings.paused ? 'paused' : feed.running ? 'working' : 'idle'}
        />
    ) : undefined;
    const roomHeaderStatus = roomStatus(room, roomSocios, shell.state.settings.paused);
    if (feed.gone) {
        return (
            <ChatFrame>
                <ChatHeader
                    identity={dot.id}
                    mascotCharacter={dot.character}
                    mascotName={dot.name}
                    title={thread.title}
                    status="Room"
                />
                <div role="status" data-slot="room-gone" className={notice}>
                    <p className="flex-1">You are no longer in this room, so you can’t read it here.</p>
                </div>
            </ChatFrame>
        );
    }
    return (
        <ChatFrame data-room={thread.id}>
            <ChatHeader
                identity={dot.id}
                mascotCharacter={dot.character}
                mascotName={dot.name}
                mascotState={shell.state.settings.paused ? 'paused' : feed.running ? 'working' : 'idle'}
                mascotNode={mascots}
                title={thread.title}
                status={roomHeaderStatus}
                actions={
                    <div className="flex items-center gap-1.5">
                        <RoomPresence roomId={thread.id} enabled={!!room} tones={tones} labels={labels} />
                        <Button
                            ref={pinsButton}
                            variant="outline"
                            size="sm"
                            // The label hides on a phone (sr-only), so the button would be
                            // only its icon's width; give the touch target a min-width too,
                            // not just the min-height the touch rule sets (CB-219).
                            className={cn('h-9 gap-1.5', touchTarget, 'pointer-coarse:min-w-11')}
                            aria-haspopup="dialog"
                            aria-expanded={pinsOpen}
                            onClick={() => setPinsOpen(true)}
                        >
                            <Pin aria-hidden />
                            <span className="max-[520px]:sr-only">Pinned</span>
                        </Button>
                        <Button
                            ref={membersButton}
                            variant="outline"
                            size="sm"
                            className={cn('h-9 gap-1.5', touchTarget, 'pointer-coarse:min-w-11')}
                            aria-haspopup="dialog"
                            aria-expanded={membersOpen}
                            onClick={() => setMembersOpen(true)}
                            disabled={!room}
                        >
                            <Users aria-hidden />
                            <span className="max-[420px]:sr-only">Members</span>
                        </Button>
                    </div>
                }
            />
            {thread.archivedAt && <ArchivedRoomNotice thread={thread} admin={admin && on} />}
            <ChatScroller scroller={scroll.scroller} content={scroll.content} end={scroll.end}>
                {feed.messages && (problems.get('') ?? []).map(problemNote)}
                {feed.messages && (
                    <ChatTranscript
                        messages={feed.messages}
                        calls={[]}
                        dotName={soleSocio(room, dot)?.name ?? 'A socio'}
                        reactions={reactions}
                        streamingId={feed.streamingId}
                        running={feed.running}
                        times={feed.times}
                        speaker={(message) => {
                            const author = messageAuthor(message)?.id;
                            return (
                                <RoomSpeaker
                                    message={message}
                                    {...replySocio(message as RoomMessage, room, dot, shell.workspace.dots)}
                                    tone={author ? tones.get(author) : undefined}
                                    shownName={author ? labels.get(author) : undefined}
                                />
                            );
                        }}
                        notice={(message) => {
                            const { handoff } = message as RoomMessage;
                            return handoff ? (
                                <HandoffNotice
                                    handoff={{
                                        ...handoff,
                                        from: {
                                            ...handoff.from,
                                            name: socioNamed(handoff.from.id, handoff.from.name),
                                        },
                                        to: {
                                            ...handoff.to,
                                            name: socioNamed(handoff.to.id, handoff.to.name),
                                        },
                                    }}
                                />
                            ) : undefined;
                        }}
                        after={(message) => (problems.get(message.id) ?? []).map(problemNote)}
                    />
                )}
                {feed.messages && !feed.messages.length && (
                    <p className="mt-0 mb-3 text-[12px]/[1.7] text-muted-foreground">
                        No messages yet. Everyone in the room reads what is written here.
                    </p>
                )}
                {feed.delivering.map((message) => (
                    <div
                        key={message.id}
                        data-delivering-message={message.id}
                        className="flex min-w-0 flex-col items-end gap-1"
                    >
                        <span className="px-1 text-[12px] font-medium text-muted-foreground">You</span>
                        <div className={pendingUserBubble}>
                            <Markdown>{message.text}</Markdown>
                        </div>
                        <span className="px-1 text-[11px] text-muted-foreground">
                            {`${several ? (messageTargets(message.text, room?.socios ?? [])[0]?.name ?? 'A socio') : dot.name} is reading this`}
                        </span>
                    </div>
                ))}
                <QueuedMessages
                    messages={queued}
                    returnFocus={composerBox}
                    note={`${dot.name} reads this after its current step`}
                    laterNote={`${dot.name} reads this once the reply is done`}
                    onEdit={async (id, text) => {
                        await api(
                            `/conversations/${encodeURIComponent(thread.id)}/steering/${encodeURIComponent(id)}`,
                            'PATCH',
                            { text },
                        );
                        feed.refresh();
                    }}
                    onCancel={async (id) => {
                        await api(
                            `/conversations/${encodeURIComponent(thread.id)}/steering/${encodeURIComponent(id)}`,
                            'DELETE',
                        );
                        feed.refresh();
                    }}
                />
                <OthersQueuedMessages
                    messages={othersQueued}
                    returnFocus={composerBox}
                    note={`${dot.name} reads it in turn`}
                    onCancel={othersQueue.cancel}
                />
            </ChatScroller>
            <ScrollToEnd scroll={scroll} />
            {/* What the socio does now, said politely as it changes (thinking,
          writing), never the reply's words as they stream: always there,
          so a screen reader hears each change (CB-219). */}
            <p role="status" className="sr-only" data-slot="room-live-status">
                {feed.running ? running : ''}
            </p>
            {feed.running && <ChatNotice announce={false}>{running}</ChatNotice>}
            {feed.error && <ChatError>{feed.error}</ChatError>}
            <div className={chatColumn}>
                {readOnly ? (
                    <ChatNote>{readOnly}</ChatNote>
                ) : (
                    <RoomComposer
                        thread={thread}
                        dot={dot}
                        people={mentionablePeople(room?.members ?? [], shell.workspace.user.id)}
                        tones={tones}
                        labels={labels}
                        socios={room?.socios ?? []}
                        dots={shell.workspace.dots}
                        running={feed.running}
                        admin={admin}
                        onInvited={() => {
                            feed.refresh();
                            reload();
                        }}
                        onSent={(message) => {
                            if (message) {
                                feed.sent(message);
                            } else {
                                feed.refresh();
                            }
                            scroll.toEnd(true);
                        }}
                    />
                )}
            </div>
            <PinsPanel
                roomId={thread.id}
                open={pinsOpen}
                onOpenChange={setPinsOpen}
                returnFocus={() => pinsButton.current}
            />
            {room && (
                <MembersPanel
                    room={room}
                    open={membersOpen}
                    onOpenChange={setMembersOpen}
                    onChanged={(next) => (next ? update(next) : void reload())}
                    returnFocus={() => membersButton.current}
                    tones={tones}
                    labels={labels}
                />
            )}
        </ChatFrame>
    );
}

/**
 * A turn that went unanswered (CB-212): refused (its sender may not work
 * in the room now, a limit), failed or cut off, so the room doesn't just
 * see a message with no reply. In words, after the message it follows.
 */
function problemNote(problem: TranscriptTurnProblem) {
    return (
        <p
            key={`problem-${problem.runId}`}
            role="note"
            data-turn-problem={problem.runId}
            className="my-1 flex max-w-full min-w-0 items-start gap-2 self-stretch rounded-md border border-dashed px-3 py-2 text-[12px]/[1.6] text-muted-foreground"
        >
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 [overflow-wrap:anywhere]">{problemText(transcriptProblem(problem))}</span>
        </p>
    );
}

/** Above an archived room: it's kept; its admins can bring it back. */
function ArchivedRoomNotice({ thread, admin }: { thread: Conversation; admin: boolean }) {
    const { unarchive } = useArchiveRoom();
    const [busy, setBusy] = useState(false);
    return (
        <div role="status" data-slot="archived-room" className={notice}>
            <Archive className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <p className="min-w-0 flex-1">This room is archived.</p>
            {admin && (
                <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={async () => {
                        setBusy(true);
                        try {
                            await unarchive(thread);
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    Unarchive
                </Button>
            )}
        </div>
    );
}

/**
 * The room's message box: the person's own draft (kept per person and
 * room, CB-153), sent to the room's queue. The socio takes each person's
 * messages in turn and answers as them; while it answers, a new message
 * waits in the queue, with Edit and Cancel. A refusal (too many messages
 * a minute, a full queue, the room archived meanwhile) keeps the text.
 * Stop ends the running answer: its sender's or a room admin's to stop.
 */
function RoomComposer({
    thread,
    dot,
    people,
    tones,
    labels,
    socios,
    dots,
    running,
    admin,
    onInvited,
    onSent,
}: {
    thread: Conversation;
    dot: Dot;
    /** Whom a message may mention (CB-216): the room's other active members. */
    people: readonly MentionablePerson[];
    /** Each person's avatar tone in the room, for the mention picker. */
    tones?: ReadonlyMap<string, string>;
    /** Same-named people's names in the room (`personLabels`), for it too. */
    labels?: ReadonlyMap<string, string>;
    /** The room's socios (CB-206): its picker, and who a message goes to. */
    socios: readonly RoomSocioView[];
    /** The workspace's socios, for the @mention picker's mascots (CB-284). */
    dots: readonly Dot[];
    running: boolean;
    /** The reader is a room admin: only they may use `/invite` (CB-285). */
    admin: boolean;
    /** After an invite is sent, to refresh the room's members (CB-285). */
    onInvited: () => void;
    /** After a send (the queued message) or a stop (none). */
    onSent: (message?: QueuedMessage) => void;
}) {
    const userId = useContext(CurrentUser)?.id;
    const draft = useDraft(userId, chatDraft(thread.id));
    const box = useFitComposer(draft.text);
    const [busy, setBusy] = useState(false);
    const [stopping, setStopping] = useState(false);
    const [problem, setProblem] = useState('');
    // The room's active socios as @mention candidates too (CB-284): a socio
    // pick inserts @Name and routes by the text the server parses.
    const socioCandidates = mentionableSocios(socios);
    const mentions = usePeopleMentions({
        text: draft.text,
        setText: draft.setText,
        box,
        people,
        tones,
        labels,
        socios: socioCandidates,
        renderSocio: (socio) => {
            const dot = dots.find((item) => item.id === socio.dotId);
            return (
                <Mascot
                    identity={socio.dotId!}
                    character={dot?.character}
                    name={socio.name}
                    small
                    decorative
                    className="size-5 shrink-0"
                />
            );
        },
    });
    // The `/invite` slash command (CB-285): admins only, lists invitable
    // people and invites the one picked. A member's composer shows nothing.
    const invite = useRoomInviteCommand({
        draft: draft.text,
        setDraft: draft.setText,
        box,
        roomId: thread.id,
        admin,
        onInvited,
        tones,
        labels,
    });
    const several = answeringSocios(socios).length > 1;
    // Who it goes to, as the server will route it, before it is sent.
    const targets = several ? messageTargets(draft.text, socios) : [];
    const named = targets.some((socio) => !socio.lead) || targets.length > 1;
    const pick = (socio: RoomSocioView) => {
        const textarea = box.current;
        const next = withMention(draft.text, socio.name, textarea?.selectionStart ?? draft.text.length);
        draft.setText(next.text);
        // Back to the message, after the name.
        requestAnimationFrame(() => {
            textarea?.focus();
            textarea?.setSelectionRange(next.caret, next.caret);
        });
    };
    const send = async () => {
        const text = draft.text.trim();
        // `/invite` is a command, not a message (CB-285): the picker handles it.
        if (!text || busy || invite.active) {
            return;
        }
        setBusy(true);
        setProblem('');
        try {
            const answer = await api<{ message: QueuedMessage }>(
                `/conversations/${encodeURIComponent(thread.id)}/steering`,
                'POST',
                { text, ...mentions.payload(text) },
            );
            draft.setText('');
            mentions.reset();
            onSent(answer.message);
        } catch (error) {
            setProblem(failure(error, 'Your message wasn’t sent. Try again.'));
        } finally {
            setBusy(false);
        }
    };
    const stop = async () => {
        setStopping(true);
        try {
            const response = await fetch(
                `/api/copilotkit/agent/${encodeURIComponent(dot.id)}/stop/${encodeURIComponent(thread.id)}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: '{}',
                },
            );
            if (!response.ok) {
                const data = (await response.json().catch(() => ({}))) as {
                    error?: string;
                };
                throw new ApiError(data.error ?? 'Could not stop the answer.', response.status);
            }
            onSent();
        } catch (error) {
            toast.error(failure(error, 'Could not stop the answer.'));
        } finally {
            setStopping(false);
        }
    };
    return (
        <form
            data-slot="room-composer"
            className="mt-2 rounded-[22px] border border-input bg-card px-4 pt-2 pb-2 shadow-[0_3px_14px_rgb(0_0_0/0.024)] has-[textarea:focus-visible]:border-ring/60 max-[700px]:px-3 keyboard-tight:mt-1 keyboard-tight:py-1"
            onSubmit={(event) => {
                event.preventDefault();
                void send();
            }}
        >
            {problem && (
                <p
                    role="alert"
                    data-slot="room-send-problem"
                    className="mt-1 rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
                >
                    {problem}
                </p>
            )}
            {mentions.list}
            {mentions.status}
            {invite.menu}
            {invite.status}
            <Textarea
                ref={box}
                {...mentions.inputProps}
                {...(invite.active ? invite.inputProps : {})}
                aria-label="Message the room"
                // One line on a phone (CB-219): who answers is said under the box.
                // A long lead socio name is truncated so the placeholder stays on
                // one line rather than wrapping (Rooms follow-ups). An admin gets a
                // hint for the `/invite` command (CB-285).
                placeholder={
                    admin
                        ? several
                            ? 'Message the room, @ a socio, or /invite…'
                            : `Message the room and ${fitName(dot.name)}, or /invite…`
                        : several
                          ? 'Message the room, or @ a socio…'
                          : `Message the room and ${fitName(dot.name)}…`
                }
                rows={1}
                value={draft.text}
                maxLength={STEERING_MAX_CHARS}
                onChange={(event) => {
                    draft.setText(event.target.value);
                    if (problem) {
                        setProblem('');
                    }
                }}
                onKeyDown={(event) => {
                    if (invite.onKeyDown(event)) {
                        return;
                    }
                    if (mentions.onKeyDown(event)) {
                        return;
                    }
                    if (!shouldSubmitComposerOnKeyDown(event)) {
                        return;
                    }
                    event.preventDefault();
                    void send();
                }}
                className={cn(composerText, 'min-h-6.5')}
            />
            <div className="flex items-center gap-2">
                <SocioPicker socios={socios} onPick={pick} disabled={busy} />
                <span
                    // Two lines at most on a phone, rather than cut short (CB-219).
                    className="line-clamp-2 min-w-0 flex-1 text-[11px]/[1.45] text-muted-foreground"
                    data-slot="room-send-to"
                    aria-live="polite"
                >
                    {named
                        ? `To ${targetsLine(targets)} · everyone in the room reads it`
                        : running
                          ? `Waits for the current step`
                          : several
                            ? `To ${dot.name}, the lead · everyone in the room reads it`
                            : 'Everyone in the room reads it'}
                </span>
                {running && (
                    <ChatIconButton
                        aria-label="Stop the answer"
                        title="Stop the answer (yours, or any as a room admin)"
                        disabled={stopping}
                        onClick={() => void stop()}
                        className="size-11"
                    >
                        <Square size={16} />
                    </ChatIconButton>
                )}
                <SendButton
                    type="submit"
                    aria-label={running ? 'Queue message' : 'Send message'}
                    disabled={busy || !draft.text.trim() || invite.active}
                >
                    <ArrowUp size={19} />
                </SendButton>
            </div>
        </form>
    );
}
