import type { Message, ToolCall } from '@ag-ui/core';
import { CopilotChatToolCallsView, useRenderTool, useAgent, useCopilotKit } from '@copilotkit/react-core/v2';
import { FilePlus, ArrowUp, Clock3, Link2, Phone, PhoneOff, Square, X } from 'lucide-react';
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { approvalCardId } from '@socio/shared/approvals';
import type { HistoryRun } from '@socio/shared/chat/chat-history';
import { mergeHistory } from '@socio/shared/chat/history-chain';
import type { ModelChoice } from '@socio/shared/inference';
import type { AttachmentRef } from '@socio/shared/media-types';
import type { Page } from '@socio/shared/pages/page-library';
import { reconnectDelay, type Outcome } from '@socio/shared/reconnect';
import { movedTimeZoneText } from '@socio/shared/time-zone';
import type { CallReceipt, Conversation, Dot } from '@socio/shared/types';
import { availableDictation, chooseDictation, type DictationMethod } from '@socio/shared/voice/dictation';

import { useOffline } from '../../hooks/use-offline';
import { useStickToBottom } from '../../hooks/use-stick-to-bottom';
import { api, ApiError, browserOffline } from '../../lib/api';
import { postChanges, useLiveTopic } from '../../lib/change-channel';
import { AppLink } from '../../shell/AppLink';
import { CurrentUser } from '../../shell/current-user';
import { NoInferenceNotice } from '../../shell/NoInferenceNotice';
import { OFFLINE_NOTICE, UPDATING_NOTICE } from '../../shell/poll-notice';
import { pause, recoverTurn, serverAway, waitForServer } from '../../shell/reconnect';
import { ShellContext } from '../../shell/shell-context';
import { useTimeZoneMoved } from '../../shell/use-time-zone-moved';
import { ApprovalBar, ApprovalRegistry, showApprovalCard, usePendingApprovals } from '../approvals/ApprovalBar';
import { ApprovalCard } from '../approvals/ApprovalCard';
import { useToolRenderers } from '../context';
import type { PageContext } from '../pages/page-context';
import { openAppPath, spacePath } from '../pages/page-navigation';
import { CallView } from '../voice/CallView';
import { DictationButton, DictationPanel } from '../voice/DictationControls';
import {
    deviceDictationSupported,
    insertDictation,
    serverDictationSupported,
    useDictation,
} from '../voice/use-dictation';
import { useVoice } from '../voice/useVoice';

import { AttachButton, AttachmentTray } from './attachments/AttachmentTray';
import { useAttachments } from './attachments/use-attachments';
import {
    ChatError,
    ChatFrame,
    ChatNotice,
    ChatHeader,
    ChatIconButton,
    ChatNote,
    ChatScroller,
    chatColumn,
    ComposerRow,
    composerText,
    SendButton,
    type ChatPlacement,
} from './chat-chrome';
import {
    refusedForSize,
    runErrorMessage,
    shouldSubmitComposerOnKeyDown,
    UNSENT_TOO_LONG,
    useFitComposer,
    useFocusOnOpen,
} from './chat-composer';
import { chatDraft, joinDraft, useDraft } from './chat-drafts';
import { fetchNameSuggestion, type NameSuggestion } from './chat-name-suggestions';
import { skillFirst } from './chat-skills';
import { ChatTranscript, isInternalNote, messageParts, type MessageDelivery } from './ChatTranscript';
import { EarlierTurns } from './EarlierTurns';
import { ModelPicker, inheritedModelLabel, useModelOptions } from './ModelSelect';
import { NameSuggestionCard } from './NameSuggestionCard';
import { placeOutgoing, type Outgoing } from './outgoing';
import { QueuedMessages } from './QueuedMessages';
import { RunStatus } from './RunStatus';
import { ScrollToEnd } from './ScrollToEnd';
import { ActiveSkillBar, useActiveSkill, useSkillMenu } from './SkillMenu';
import { sendNewMessagesOnly } from './sync/new-messages';
import { sendReplayCursor } from './sync/replay-cursor';
import { useChatHistory } from './sync/use-chat-history';
import { useFullResults } from './trace/full-result';
import { useFollowRun } from './use-follow-run';
import { useReactions } from './use-reactions';
import { useRunPhase } from './use-run-phase';
import { useSteering } from './use-steering';
import { useTraceTimes } from './use-trace-times';

import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Array content with text or attachments (CB-54) shows as a bubble too. */
/** Messages this tab is sending now, from any chat (CB-153). */
const inFlight = new Set<string>();

function hasUserContent(content: unknown) {
    const { text, attachments } = messageParts(content);
    return !!text.trim() || attachments.length > 0;
}

export function Chat({
    thread,
    dot,
    initialPrompt,
    initialAttachments,
    onConsumed,
    pendingVoice,
    onVoiceConsumed,
    voiceReady,
    calls,
    paused,
    onSaved,
    onSchedule,
    onComputer,
    placement = 'column',
}: {
    thread: Conversation;
    dot: Dot;
    /** The chat view's column, or the page's side panel. */
    placement?: ChatPlacement;
    initialPrompt?: string;
    /** Sent with the first message (attached in the new-chat composer). */
    initialAttachments?: readonly AttachmentRef[];
    onConsumed: () => void;
    /** A voice call to start once, as the first message (CB-302). */
    pendingVoice?: boolean;
    onVoiceConsumed?: () => void;
    voiceReady: boolean;
    calls: CallReceipt[];
    paused: boolean;
    onSaved: () => void;
    onSchedule: () => void;
    onComputer?: () => void;
}) {
    const { agent, isReady } = useAgent({
        agentId: `chat-${thread.id}`,
        runtimeAgentId: dot.id,
        threadId: thread.id,
    });
    const { copilotkit } = useCopilotKit();
    // The conversation's history on the client store (CB-136): shown from
    // it at once, synced from the server by what came after. CopilotKit's
    // agent holds what its connection replays: the newest turn and every
    // one since the chat opened. Without it (`failed`), the connection
    // replays the whole conversation, as before.
    const user = useContext(CurrentUser);
    const history = useChatHistory(thread.id, user?.id);
    const store = history.failed ? undefined : history.history;
    // Where the connection starts, fixed when it first connects: every
    // reconnect replays each turn since, which the no-double-send check
    // (recoverTurn) reads.
    const replayAfter = useRef<number>(undefined);
    // Its requests carry only what the server doesn't have (CB-156): the
    // whole history, screenshots included, grew past what a request may be.
    useEffect(() => {
        const cursor = sendReplayCursor(agent, () => replayAfter.current);
        const slim = sendNewMessagesOnly(agent);
        return () => {
            slim();
            cursor();
        };
    }, [agent]);
    /** Whether the server stored a message (after a pull of what's new). */
    const storedMessage = async (id: string) => {
        if (!store) {
            return false;
        }
        await store.pull();
        return store.has(id);
    };
    /**
     * Whether the server has message `id` (CB-154): its store's say, or
     * without one its transcript's. False when it can't tell.
     */
    const serverHas = async (id: string) => {
        try {
            if (store) {
                return await storedMessage(id);
            }
            const transcript = await api<{ messages: { id: string }[] }>(`/conversations/${thread.id}/transcript`);
            return transcript.messages.some((message) => message.id === id);
        } catch {
            return false;
        }
    };
    const models = useModelOptions();
    const [model, setModel] = useState<ModelChoice | null>(thread.inference ?? null);
    const [pageContext, setPageContext] = useState<PageContext | null>();
    const [contextError, setContextError] = useState('');
    const [contextAttempt, setContextAttempt] = useState(0);
    const contextReady = pageContext !== undefined;
    useEffect(() => {
        let active = true;
        setPageContext(undefined);
        setContextError('');
        void api<PageContext | null>(
            `/conversations/${thread.id}/page-context`,
            'GET',
            undefined,
            AbortSignal.timeout(10000),
        )
            .then((page) => {
                if (active) {
                    setPageContext(page);
                }
            })
            .catch(() => {
                if (active) {
                    setContextError('Conversation context could not load. Retry before sending your message.');
                }
            });
        return () => {
            active = false;
        };
    }, [thread.id, contextAttempt]);
    // The box's text, kept per person and chat until it is sent (CB-153).
    const kept = useDraft(user?.id, chatDraft(thread.id));
    const draft = kept.text;
    const setDraft = kept.setText;
    const draftBox = useFitComposer(draft);
    // The `/` menu of chat skills (CB-143).
    const skillMenu = useSkillMenu(draft, setDraft, draftBox);
    // Dictation (CB-101): only the ways that work in this browser, on this
    // server, and that the admin allows. Read after mounting: the server
    // render can't know the browser.
    const shell = useContext(ShellContext);
    const [browser, setBrowser] = useState({ device: false, server: false });
    useEffect(
        () =>
            setBrowser({
                device: deviceDictationSupported(),
                server: serverDictationSupported(),
            }),
        [],
    );
    const dictationMethods = availableDictation({
        device: browser.device,
        server: browser.server && !!shell?.workspace.setup.transcription,
        allowed: shell?.state.settings.dictationMethods,
    });
    // The person's pick, kept here at once while the server saves it.
    const [picked, setPicked] = useState<DictationMethod>();
    const dictationMode = chooseDictation(dictationMethods, picked ?? shell?.workspace.preferences?.dictation);
    const [choosing, setChoosing] = useState(false);
    // Where the cursor goes once the dictated text is in the draft.
    const caret = useRef<number>(undefined);
    const dictation = useDictation(
        (text) => {
            const box = draftBox.current;
            setDraft((current) => {
                const next = insertDictation(
                    current,
                    text,
                    box?.selectionStart ?? current.length,
                    box?.selectionEnd ?? current.length,
                );
                caret.current = next.caret;
                return next.value;
            });
        },
        { live: !!shell?.workspace.setup.transcriptionStreaming },
    );
    useLayoutEffect(() => {
        const box = draftBox.current;
        if (caret.current === undefined || !box) {
            return;
        }
        // A phone's keyboard stays down: the draft is there to read or send.
        if (window.matchMedia?.('(pointer: fine)').matches) {
            box.focus();
        }
        box.setSelectionRange(caret.current, caret.current);
        caret.current = undefined;
    }, [draft, draftBox]);
    const dictate = (method: DictationMethod) => {
        setChoosing(false);
        dictation.start(method);
    };
    const [source, setSource] = useState('');
    const [sourceOpen, setSourceOpen] = useState(false);
    const [error, setError] = useState('');
    const [loaded, setLoaded] = useState(false);
    // A turn already running when the chat opened, which its first connect
    // streams to its end (CB-223): shown running meanwhile.
    const joined = useRef(false);
    const [running, setRunning] = useState(false);
    // The skill on in this chat until it ends (CB-143), read after each turn.
    const activeSkill = useActiveSkill(thread.id, running);
    // The server is away or restarting (CB-108): the chat waits for the next
    // one, to connect or to send a turn, instead of showing an error.
    const [updating, setUpdating] = useState(false);
    // Waiting with the browser offline says that instead: no network here.
    const offline = useOffline();
    // While a connect or a turn listens (`capture`), CopilotKit's error for
    // this chat is kept here for it to decide on, instead of being shown.
    const listening = useRef(0);
    const failure = useRef<unknown>(undefined);
    // A turn riding out a restart. Stop ends the wait; once the server is
    // back (`live`) it also stops the run being streamed or sent again.
    const waiting = useRef<{ stop: AbortController; live: boolean }>(undefined);
    // A turn given up on while the server may have had it: once a connect
    // shows it doesn't, it shows as not sent.
    const unsure = useRef<{ id: string; text: string }>(undefined);
    // Your messages the server doesn't have yet (CB-154): dimmed in their
    // place while sending, or not sent, with Retry.
    const [outgoing, setOutgoing] = useState<Outgoing[]>([]);
    const outgoingNow = useRef(outgoing);
    outgoingNow.current = outgoing;
    const dropOutgoing = (id: string) => setOutgoing((items) => items.filter((item) => item.message.id !== id));
    /** The server never took it: out of the agent, shown as not sent. */
    const notSent = (id: string) => {
        if (agent.messages.some((shown) => shown.id === id)) {
            agent.setMessages(agent.messages.filter((shown) => shown.id !== id));
        }
        setOutgoing((items) => items.map((item) => (item.message.id === id ? { ...item, status: 'failed' } : item)));
    };
    // Pending ones the server's history now has went, whatever they show.
    useEffect(() => {
        if (!outgoingNow.current.length) {
            return;
        }
        const stored = new Set(history.runs.flatMap((run) => run.messages.map((message) => message.id)));
        for (const { message } of outgoingNow.current) {
            if (stored.has(message.id)) {
                dropOutgoing(message.id);
                kept.settle(message.id, false);
            }
        }
        // Runs only when the server’s history changes; kept is read, not watched.
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [history.runs]);
    // While a turn's request is out: what its RUN_STARTED does, the server
    // having taken its message.
    const started = useRef<() => void>(undefined);
    // The chat's connection: a reconnect stops when the chat goes.
    const connection = useRef<AbortController>(undefined);
    // A call's receipt goes after the last message shown: the agent's, or
    // the store's when the agent replayed nothing (CB-136).
    const voiceTurn = useRef<() => void>(undefined);
    const voice = useVoice(
        thread.id,
        onSaved,
        agent.messages.at(-1)?.id ?? history.runs.at(-1)?.messages.at(-1)?.id,
        // The backend in force (CB-265), and cloud to fall back to; each turn
        // of a self-hosted call shows in the chat behind it as it ends.
        {
            backend: shell?.workspace.setup.voiceBackend,
            cloud: !!shell?.workspace.setup.voiceCloud,
            onTurn: () => voiceTurn.current?.(),
        },
    );
    const attachments = useAttachments(thread.id);
    const phase = useRunPhase(agent, running, joined);
    const movedZone = useTimeZoneMoved(agent, running);
    // Before the connection below: it replays the times too (CB-72).
    const times = useTraceTimes(agent);
    const sent = useRef(false);
    // The current turn's RUN_ERROR message (a turn that fails before it
    // starts, e.g. without a model, ends with no assistant message).
    const runError = useRef('');
    const scroll = useStickToBottom();
    useEffect(() => {
        const subscription = copilotkit.subscribe({
            onError: ({ error, context }) => {
                const mine = !context?.agentId || context.agentId === agent.agentId;
                if (listening.current && mine) {
                    failure.current ??= error;
                } else {
                    setError(runErrorMessage(error));
                }
            },
        });
        const events = agent.subscribe({
            onRunErrorEvent: ({ event }) => {
                runError.current = event.message;
                setError(event.message);
            },
            onRunStartedEvent: () => started.current?.(),
        });
        return () => {
            subscription.unsubscribe();
            events.unsubscribe();
        };
    }, [agent, copilotkit]);
    /** Runs `action`, with the error CopilotKit reported for it, if any. */
    const capture = async <T,>(action: () => Promise<T>): Promise<Outcome<T>> => {
        listening.current += 1;
        failure.current = undefined;
        try {
            const value = await action();
            return failure.current === undefined ? { value } : { value, error: failure.current };
        } finally {
            listening.current -= 1;
            failure.current = undefined;
        }
    };
    /**
     * Connects the chat, which replays the conversation. While the server
     * is away (CB-108) it waits for the next one and connects again, with
     * backoff, until `signal` aborts. False once aborted.
     */
    const connectChat = async (signal: AbortSignal) => {
        // A connect only adds what the replay has: to tell whether a turn
        // given up on arrived, start from none, as a reconnect does.
        const shown = agent.messages;
        const replayed = !!unsure.current;
        if (replayed) {
            agent.setMessages([]);
        }
        try {
            for (let attempt = 0; ; attempt++) {
                const { error } = await capture(() => copilotkit.connectAgent({ agent }));
                if (signal.aborted) {
                    return false;
                }
                if (error && serverAway(error)) {
                    setUpdating(true);
                    await pause(reconnectDelay(attempt), signal);
                    await waitForServer({ signal });
                    agent.setMessages([]);
                    continue;
                }
                if (error) {
                    // A replay cut short: keep the transcript shown.
                    if (agent.messages.length < shown.length) {
                        agent.setMessages(shown);
                    }
                    setError(error instanceof Error ? runErrorMessage(error) : 'Conversation could not connect.');
                } else {
                    unsure.current = undefined;
                    await settleSends(replayed);
                }
                return true;
            }
        } catch {
            return false;
        } finally {
            if (!signal.aborted) {
                setUpdating(false);
            }
        }
    };
    /**
     * After a connect, each send from this box not known to have arrived
     * and no longer going (CB-153, CB-154): arrived, it is forgotten; never,
     * it shows as not sent here, or after a reload its text joins the box.
     * The agent's messages only count when the connect replayed them.
     */
    const settleSends = async (replayed: boolean) => {
        for (const sent of kept.unsettled()) {
            if (inFlight.has(sent.id)) {
                continue;
            }
            const arrived =
                (replayed && agent.messages.some((shown) => shown.id === sent.id)) || (await serverHas(sent.id));
            if (arrived) {
                dropOutgoing(sent.id);
                kept.settle(sent.id, false);
            } else if (outgoingNow.current.some((item) => item.message.id === sent.id)) {
                notSent(sent.id);
            } else {
                kept.settle(sent.id, true);
            }
        }
    };
    /**
     * Once a later message was taken, the earlier ones still dimmed (one
     * given up on while the server may have had it) are settled by what
     * the server has (CB-154): they never stay dimmed.
     */
    const settleEarlier = async (latest: string) => {
        for (const item of outgoingNow.current) {
            const { id } = item.message;
            if (item.status !== 'sending' || id === latest || inFlight.has(id)) {
                continue;
            }
            if (await serverHas(id)) {
                dropOutgoing(id);
                kept.settle(id, false);
            } else {
                notSent(id);
            }
        }
    };
    // The store first: its first pull says where the connection starts.
    const historySettled = history.settled || history.failed;
    useEffect(() => {
        if (!isReady || !historySettled) {
            return;
        }
        // A send from this box not known to have arrived, and no longer going
        // (a reload, or it gave up while the chat was closed): the connect
        // replays from none and tells, giving its text back if it never did
        // (CB-153).
        const left = kept.unsettled().find((sent) => !inFlight.has(sent.id));
        if (left && !unsure.current) {
            unsure.current = left;
        }
        replayAfter.current ??= store?.connectAfter();
        const connecting = new AbortController();
        connection.current = connecting;
        void connectChat(connecting.signal).then((connected) => {
            if (connected) {
                setLoaded(true);
            }
            // The turn it streamed has ended, or the chat went.
            if (joined.current) {
                joined.current = false;
                setRunning(false);
            }
        });
        return () => connecting.abort();
        // Connects when the store is ready; store, connectChat and kept are read
        // at that moment.
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [agent, copilotkit, isReady, historySettled]);
    // A turn waiting for the server stops waiting when the chat goes.
    useEffect(() => () => waiting.current?.stop.abort(), []);
    /**
     * Runs the turn whose `message` was just added. When the server is away
     * or restarting (CB-108), it waits for the next one and sends the turn
     * again, unless that one has it already (`recoverTurn`): never twice.
     */
    const runTurn = async (message: Message) => {
        // Whether the server took the message (`taken`): its turn started.
        let taken = false;
        const run = () => {
            started.current = () => {
                started.current = undefined;
                taken = true;
                dropOutgoing(message.id);
            };
            return capture(() => copilotkit.runAgent({ agent }));
        };
        const first = await run();
        started.current = undefined;
        if (!first.error || !serverAway(first.error)) {
            return { ...first, resent: false, taken };
        }
        const wait = { stop: new AbortController(), live: false };
        waiting.current = wait;
        try {
            const recovery = await recoverTurn({
                agent,
                message,
                failed: first.error,
                signal: wait.stop.signal,
                // A replay's turns started long ago.
                connect: () => {
                    started.current = undefined;
                    return capture(() => copilotkit.connectAgent({ agent }));
                },
                run,
                stored: storedMessage,
                onWait: () => {
                    wait.live = false;
                    setUpdating(true);
                },
                onBack: () => {
                    wait.live = true;
                    setUpdating(false);
                },
            });
            // Not sent again: the replay or the store had it. A connect that
            // failed says nothing (`deliver` asks the server).
            return {
                ...recovery,
                taken: taken || (!recovery.resent && !recovery.error),
            };
        } finally {
            started.current = undefined;
            waiting.current = undefined;
            setUpdating(false);
        }
    };
    /**
     * Stopped waiting for the server, or it didn't come back in time. A turn
     * the server is known not to have shows as not sent, to retry or edit
     * (CB-154). One it may have stays shown, dimmed, never offered to send
     * again: the next connect shows whether it arrived.
     */
    const gaveUp = (id: string, text: string, why: 'stopped' | 'timeout', unsent: boolean) => {
        if (unsent) {
            notSent(id);
            if (why === 'timeout') {
                setError(
                    browserOffline()
                        ? 'You’re still offline, so your message wasn’t sent. Send it again once you’re back online.'
                        : 'Socio is still updating, so your message wasn’t sent. Send it again in a minute.',
                );
            }
            return;
        }
        unsure.current = { id, text };
        setError(
            why === 'stopped'
                ? 'Stopped waiting for Socio. Reconnect to see whether your message arrived.'
                : browserOffline()
                  ? 'You’re still offline. Reconnect once you’re back online to see whether your message arrived.'
                  : 'Socio is still updating. Reconnect in a minute to see whether your message arrived.',
        );
    };
    const send = async (text: string, refs: readonly AttachmentRef[] = []) => {
        if ((!text.trim() && !refs.length) || running || follow.syncing || !loaded || !contextReady || paused) {
            return;
        }
        // The text as typed: the server gives the socio the chat's page in
        // the turn's note, never in the person's words (CB-158), so a retry
        // sends the same words (CB-154). With attachments, a text part and
        // their references (never bytes):
        // the server resolves them for the model when the turn runs (CB-54).
        const message: Message = {
            id: crypto.randomUUID(),
            role: 'user',
            content: refs.length
                ? [
                      ...(text.trim()
                          ? [
                                {
                                    type: 'text' as const,
                                    text,
                                },
                            ]
                          : []),
                      ...refs.map((ref) => ({
                          type: 'binary' as const,
                          id: ref.id,
                          mimeType: ref.mediaType,
                          filename: ref.name,
                      })),
                  ]
                : text,
        };
        attachments.clear();
        setSource('');
        setSourceOpen(false);
        await deliver(message, text);
    };
    /**
     * Sends a message shown as not sent again, unless the server has it
     * after all: then it only shows it (CB-154).
     */
    const retry = async (message: Message, text: string) => {
        if (await serverHas(message.id)) {
            dropOutgoing(message.id);
            kept.settle(message.id, false);
            const signal = connection.current?.signal;
            if (signal) {
                void connectChat(signal);
            }
            return;
        }
        await deliver(message, text, true);
    };
    /**
     * Sends `message` (`text` as typed), shown at once in its place and
     * dimmed until the server takes it (CB-154): sent, or `again` after a
     * failure.
     */
    const deliver = async (message: Message, text: string, again = false) => {
        setError('');
        runError.current = '';
        unsure.current = undefined;
        setRunning(true);
        // Sending always goes to the end, and follows the reply.
        scroll.toEnd();
        setOutgoing((items) => [
            ...items.filter((item) => item.message.id !== message.id),
            { message, text, status: 'sending', after: messages.at(-1)?.id },
        ]);
        agent.addMessage(message);
        // The box empties; its draft stays until the send is settled (CB-153).
        // A retry leaves what is being typed there.
        kept.sending(message.id, text, again);
        inFlight.add(message.id);
        let settled = true;
        let taken = false;
        try {
            const outcome = await runTurn(message);
            if (outcome.gaveUp) {
                // Not sent, or maybe not: unsettled, so a reload gives it back
                // if it never arrived.
                settled = false;
                gaveUp(message.id, text, outcome.gaveUp, !!outcome.unsent);
                return;
            }
            const { value: result, error } = outcome;
            // Never taken for its size (CB-156): it leaves the transcript, so
            // later requests don't carry it, and its draft comes back in the box.
            if (refusedForSize(error)) {
                agent.setMessages(agent.messages.filter((shown) => shown.id !== message.id));
                dropOutgoing(message.id);
                settled = false;
                kept.settle(message.id, true);
                setError(UNSENT_TOO_LONG);
                return;
            }
            // A reply says the server took it too, its start unseen; so does
            // its history (a Stop just after it stored the message).
            taken =
                outcome.taken ||
                !!result?.newMessages.some((reply) => reply.role === 'assistant') ||
                (await serverHas(message.id));
            if (!taken) {
                // Not sent, with Retry; unsettled for a reload (CB-153).
                notSent(message.id);
                settled = false;
                if (error) {
                    throw error;
                }
                return;
            }
            dropOutgoing(message.id);
            // Without a result, the server had the turn already: the replay
            // showed what it stored.
            if (result && !result.newMessages.some((reply) => reply.role === 'assistant')) {
                throw (
                    error ??
                    new Error(
                        runError.current ||
                            'The current turn returned no response. Check the runtime connection and retry.',
                    )
                );
            }
            if (error instanceof Error) {
                setError(runErrorMessage(error));
            }
            onSaved();
        } catch (e) {
            setError(e instanceof Error ? runErrorMessage(e) : 'The turn failed. Your conversation remains saved.');
        } finally {
            inFlight.delete(message.id);
            // Gave back already when it never arrived; otherwise it went.
            if (settled) {
                kept.settle(message.id, false);
            }
            if (taken) {
                void settleEarlier(message.id);
            }
            setRunning(false);
            // The turn went through the runtime, not api(): tell the other tabs.
            postChanges([{ topic: 'conversation', id: thread.id }]);
            // The finished run goes into the store.
            void store?.pull();
        }
    };
    // The Dot carrying on after an approval runs on the server; the chat
    // follows it (CB-58).
    const follow = useFollowRun({
        agent,
        copilotkit,
        running,
        setRunning,
        onDone: () => {
            postChanges([{ topic: 'conversation', id: thread.id }]);
            void store?.pull();
            onSaved();
        },
        onError: (e) => setError(e instanceof Error ? e.message : 'Conversation could not connect.'),
        // With the store, a pull of what's new; the connection replays the
        // turns since `replayAfter`, so those are what it must show.
        stored: store
            ? () => store.pull().then(() => store.idsAfter(replayAfter.current ?? 0))
            : () =>
                  api<{ messages: { id: string }[] }>(`/conversations/${thread.id}/transcript`).then(
                      (transcript) => transcript.messages,
                  ),
    });
    // A self-hosted call's turn (CB-265) ran on the server: the chat catches
    // up quietly, as with another tab's turn.
    voiceTurn.current = () => void follow.catchUp();
    // Reactions on the Dot's messages (CB-133), fetched alongside the history.
    const reactions = useReactions(thread.id, loaded && !!user);
    // Messages sent while the Dot works (CB-151): queued on the server until
    // the turn's next safe point, or the next turn. Read from the start, so
    // a reload shows them while the chat reconnects.
    const steering = useSteering(thread.id, running);
    // Opened or reloaded while a turn runs (CB-223): the first connect only
    // ends with that turn, so until then the chat shows it running, with
    // Stop and Queue, as for a turn sent from here.
    useEffect(() => {
        if (loaded || running || !steering.running) {
            return;
        }
        joined.current = true;
        setRunning(true);
    }, [loaded, running, steering.running]);
    // The store's runs, then what the agent has that they don't. The
    // agent's addMessage pushes onto the same array: its length says it
    // changed, or a message just sent wasn't shown until the run's first
    // event (CB-154).
    const merged = useMemo(
        () => mergeHistory(history.runs, follow.messages),
        // The agent pushes onto the same array: its length is the change signal.
        // oxlint-disable-next-line react-hooks/exhaustive-deps
        [history.runs, follow.messages, follow.messages.length],
    );
    const messages = merged.messages;
    // With your messages the server doesn't have yet in their places.
    const shown = useMemo(() => placeOutgoing(messages, outgoing), [messages, outgoing]);
    const delivery = new Map<string, MessageDelivery>(
        outgoing.map(({ message, text, status }) => [
            message.id,
            status === 'sending'
                ? { status }
                : {
                      status,
                      onRetry:
                          running || follow.syncing || !loaded || !contextReady || paused
                              ? undefined
                              : () => {
                                    // Not the page: Retry goes as it sends.
                                    draftBox.current?.focus();
                                    void retry(message, text);
                                },
                      onEdit: () => {
                          dropOutgoing(message.id);
                          setDraft((current) => joinDraft(current, text));
                          // In the box now: nothing to give back on a reload.
                          kept.settle(message.id, false);
                          draftBox.current?.focus();
                      },
                  },
        ]),
    );
    // Those the transcript shows have reached the Dot.
    const queued = steering.queued.filter((message) => !messages.some((shown) => shown.id === message.id));
    // A turn that ended before taking them left them to the next one, which
    // the server starts: the chat follows it, once per message.
    const nextQueued = queued[0]?.id;
    useEffect(() => {
        if (!loaded || running || follow.syncing || !nextQueued) {
            return;
        }
        follow.onContinuation(`steering:${nextQueued}`);
        // Once per queued message; follow is read when it fires.
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [loaded, running, follow.syncing, nextQueued]);
    // The turn the server started with them, when the chat missed its start:
    // after a Stop the chat may follow the stopped turn to its end, and the
    // next one starts after (CB-170). Followed once. One the server reports
    // while the chat follows a turn is the turn it follows.
    const followedTurns = useRef(new Set<string>());
    if (running && steering.turn) {
        followedTurns.current.add(steering.turn);
    }
    const serverTurn = steering.turn;
    useEffect(() => {
        if (!loaded || running || follow.syncing || !serverTurn) {
            return;
        }
        if (followedTurns.current.has(serverTurn)) {
            return;
        }
        follow.onContinuation(`steering-turn:${serverTurn}`);
        // Once per server turn; follow is read when it fires.
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [loaded, running, follow.syncing, serverTurn]);
    // At most the admin's limit wait (CB-170): another stays in the box.
    const queueFull = steering.limit !== undefined && steering.queued.length >= steering.limit;
    // Something to queue: words, or files attached or on their way (CB-223).
    const queueable = !!draft.trim() || !!attachments.refs.length || attachments.uploading;
    // Why the box can't send or queue what is in it now, in words beside it:
    // a button's tooltip never shows on a phone (CB-223). A full queue and an
    // update have notes of their own.
    const held =
        !queueable || updating
            ? undefined
            : attachments.uploading
              ? 'Your files are still uploading. You can send once they’re done.'
              : !contextReady
                ? contextError
                    ? undefined
                    : 'Getting this chat ready. You can send in a moment.'
                : running
                  ? undefined
                  : paused
                    ? 'Socio is paused, so your message stays here until an admin resumes it.'
                    : !loaded
                      ? 'Connecting to your conversation. You can send once it’s ready.'
                      : follow.syncing
                        ? 'Catching up with this chat. You can send in a moment.'
                        : undefined;
    // Sent while the Dot works: queued for it, as `send` would have sent it,
    // its attachments too (CB-223).
    const [queueing, setQueueing] = useState(false);
    const queue = async (text: string, refs: readonly AttachmentRef[] = []) => {
        if ((!text.trim() && !refs.length) || queueing || !contextReady || queueFull) {
            return;
        }
        setError('');
        setQueueing(true);
        try {
            await steering.add(text, refs);
            // Sent with it: the tray empties, the files stay with the message.
            if (refs.length) {
                attachments.clear();
            }
            setDraft('');
            setSource('');
            setSourceOpen(false);
            scroll.toEnd();
        } catch (e) {
            // Full meanwhile (another tab): the queue read again says so.
            if (e instanceof ApiError && e.code === 'queue_full') {
                return;
            }
            setError(e instanceof Error ? e.message : 'Your message couldn’t be queued.');
        } finally {
            setQueueing(false);
        }
    };
    // Their times (CB-72) under the ones the connection streamed, once per
    // run into each set of times (a new agent starts a new one).
    const absorbed = useRef(new WeakMap<object, WeakSet<HistoryRun>>());
    let into = absorbed.current.get(times);
    if (!into) {
        absorbed.current.set(times, (into = new WeakSet()));
    }
    for (const run of history.runs) {
        if (!into.has(run)) {
            into.add(run);
            times.absorb(run.times);
        }
    }
    // Calls before the oldest turn shown wait for it, as their turns do.
    const oldestShown = history.earlier ? history.runs[0]?.startedAt : undefined;
    const shownCalls = oldestShown === undefined ? calls : calls.filter((call) => call.startedAt >= oldestShown);
    // Older turns' long results load whole when their step opens.
    useFullResults(
        merged.light,
        useMemo(() => store && ((id: string) => store.fullResult(id)), [store]),
    );
    // Another tab sent here, or the Dot answered there (CB-74): pick up the
    // new messages without a reload. The catch-up posts no note of its own.
    // Not before the chat has loaded (its first connect reads everything),
    // nor while the shell re-reads (a chat deleted there is never asked for).
    const canCatchUp = useLiveTopic(`conversation:${thread.id}`, () =>
        loaded && canCatchUp() ? follow.catchUp() : undefined,
    );
    // CB-292: the inline name-suggestion card. Refetched when the conversation
    // changes, a turn ends (the live topic fires), or a settle is reported.
    const [nameSuggestion, setNameSuggestion] = useState<NameSuggestion | null>(null);
    const [nameSuggestionNonce, setNameSuggestionNonce] = useState(0);
    useEffect(() => {
        if (!loaded) {
            return;
        }
        const controller = new AbortController();
        void fetchNameSuggestion(thread.id, controller.signal)
            .then((view) => {
                if (!controller.signal.aborted) {
                    setNameSuggestion(view.suggestion);
                }
            })
            .catch(() => undefined);
        return () => controller.abort();
        // Re-fetch on load, thread change, and after each settle (nonce).
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [loaded, thread.id, nameSuggestionNonce]);
    useEffect(() => {
        if (loaded && contextReady && !paused && (initialPrompt || initialAttachments?.length) && !sent.current) {
            sent.current = true;
            onConsumed();
            void send(initialPrompt ?? '', initialAttachments);
        }
        // A one-shot send guarded by sent; send and onConsumed are read when it fires.
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [loaded, contextReady, paused, initialPrompt, initialAttachments]);
    // Voice as the first message of a new chat (CB-302): start the call once
    // the chat has loaded, the same gating the initial-prompt send uses. The
    // call's first turn becomes the first message of the conversation.
    const voiceStarted = useRef(false);
    useEffect(() => {
        if (
            !voiceStarted.current &&
            loaded &&
            contextReady &&
            !paused &&
            pendingVoice &&
            voiceReady &&
            voice.status === 'idle'
        ) {
            voiceStarted.current = true;
            onVoiceConsumed?.();
            void voice.start();
        }
    }, [loaded, contextReady, paused, pendingVoice, voiceReady, voice, onVoiceConsumed]);
    // A new chat takes typing at once (CB-116); the page's side chat and
    // chats with history leave the focus where it is.
    useFocusOnOpen(draftBox, placement === 'column' && loaded && !paused && !messages.length);
    useEffect(() => {
        if (paused && voice.status !== 'idle') {
            void voice.end();
        }
        if (paused) {
            dictation.cancel();
        }
        // Fires on pausing only; voice and dictation are read then.
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [paused]);
    // How the modules' agent tools show here: page reviews, the computer.
    const toolRenderers = useToolRenderers();
    const assistantCalls = messages.flatMap((message) =>
        message.role === 'assistant' ? (message.toolCalls ?? []) : [],
    );
    // The approval cards report here; the composer's bar reads it (CB-66).
    const [approvals] = useState(() => new ApprovalRegistry());
    const pendingApprovals = usePendingApprovals(approvals);
    // Tool results that wait for the user's approval (data space, and later
    // schedules, messages and apps), or that an auto review decided, show as
    // an approval card.
    const approvalCalls = new Set(
        messages.flatMap((message) =>
            message.role === 'tool' && approvalCardId(message.content) ? [message.toolCallId] : [],
        ),
    );
    // Page reviews and approval results show as cards; every other call is
    // a step of its turn's trace (CB-72).
    const isCard = (call: ToolCall) =>
        toolRenderers.some((renderer) => renderer.cards?.includes(call.function.name)) || approvalCalls.has(call.id);
    useRenderTool(
        {
            name: '*',
            render: (props: { result?: unknown }) => {
                const approval = approvalCardId(props.result);
                // The anchor the composer's Show request scrolls to (CB-66).
                return approval ? (
                    <div
                        className="min-w-0 rounded-[0.75rem] outline-none transition-shadow duration-200 focus-visible:shadow-[0_0_0_2px_var(--ring)] data-highlight:shadow-[0_0_0_3px_color-mix(in_oklab,var(--ring)_60%,transparent)] motion-reduce:transition-none"
                        data-approval-id={approval}
                        tabIndex={-1}
                    >
                        <ApprovalCard
                            id={approval}
                            linkToPage
                            onContinuation={follow.onContinuation}
                            registry={approvals}
                        />
                    </div>
                ) : null;
            },
        },
        [
            follow.onContinuation,
            // Not `approvals`: CopilotKit compares these as JSON, and the
            // registry is the same object for the chat's lifetime.
        ],
    );
    const visible = shown.filter(
        (message) =>
            !isInternalNote(message) &&
            ['user', 'assistant', 'reasoning'].includes(message.role) &&
            ((typeof message.content === 'string' && message.content.trim()) ||
                (message.role === 'user' && hasUserContent(message.content)) ||
                (message.role === 'assistant' && !!message.toolCalls?.length)),
    );
    // A link to one turn (`#message-<id>`, from a schedule's runs, CB-88)
    // scrolls to its message once it is there, once per address.
    const shownTurn = useRef('');
    useEffect(() => {
        const hash = window.location.hash;
        if (!loaded || !hash.startsWith('#message-') || shownTurn.current === hash) {
            return;
        }
        const element = document.querySelector<HTMLElement>(
            `[data-message-id="${CSS.escape(decodeURIComponent(hash.slice(9)))}"]`,
        );
        if (!element) {
            // An older turn than the store holds: page back to it.
            if (history.earlier && !history.loadingEarlier) {
                void store?.loadEarlier();
            }
            return;
        }
        shownTurn.current = hash;
        scroll.toElement(element);
        // Re-tries as the transcript grows; scroll and store are read then.
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [loaded, visible.length, history.earlier, history.loadingEarlier]);
    return (
        <ChatFrame placement={placement}>
            {toolRenderers.map(({ moduleId, Register }) =>
                Register ? (
                    <Register key={moduleId} threadId={thread.id} dot={dot} onSaved={onSaved} onComputer={onComputer} />
                ) : null,
            )}
            <ChatHeader
                placement={placement}
                identity={dot.id}
                mascotCharacter={dot.character}
                mascotName={dot.name}
                mascotState={updating ? 'waiting' : running ? 'working' : paused ? 'paused' : 'idle'}
                title={dot.name}
                status={
                    paused
                        ? 'Paused'
                        : updating
                          ? offline
                              ? 'Offline'
                              : 'Updating…'
                          : (loaded || joined.current) && contextReady
                            ? 'Here with you'
                            : 'Connecting to your conversation…'
                }
                actions={
                    <TooltipProvider delayDuration={300}>
                        <HeaderTip label="The model this chat runs on" className="min-w-0">
                            <ModelPicker
                                aria-label="Model for this chat"
                                className="max-w-55 @max-[47.5rem]/chat:max-w-[9.5rem]"
                                value={model}
                                options={models?.options ?? []}
                                disabled={!models || running}
                                inheritLabel={inheritedModelLabel(dot.inference, models)}
                                requireAvailable
                                onChange={async (next) => {
                                    const previous = model;
                                    setModel(next);
                                    try {
                                        await api(`/conversations/${thread.id}`, 'PATCH', {
                                            inference: next,
                                        });
                                        onSaved();
                                    } catch (e) {
                                        setModel(previous);
                                        setError(e instanceof Error ? e.message : 'Could not change the model.');
                                    }
                                }}
                            />
                        </HeaderTip>
                        <HeaderTip
                            label={running ? 'Save as a page once the reply is done' : 'Save conversation as page'}
                        >
                            <ChatIconButton
                                className={headerButton}
                                aria-label="Save conversation as page"
                                disabled={running}
                                onClick={async () => {
                                    const title = window.prompt('Page title', thread.title);
                                    if (!title) {
                                        return;
                                    }
                                    try {
                                        const page = await api<Page>(`/conversations/${thread.id}/page`, 'POST', {
                                            title,
                                        });
                                        openAppPath(spacePath(page.spaceId, page.id));
                                    } catch (e) {
                                        setError(e instanceof Error ? e.message : 'Could not save conversation.');
                                    }
                                }}
                            >
                                <FilePlus size={18} />
                            </ChatIconButton>
                        </HeaderTip>
                        <HeaderTip label="Schedule a task in this conversation">
                            <ChatIconButton
                                className={headerButton}
                                aria-label="Schedule a task in this conversation"
                                onClick={onSchedule}
                            >
                                <Clock3 size={18} />
                            </ChatIconButton>
                        </HeaderTip>
                        <HeaderTip
                            label={
                                !voiceReady
                                    ? shell?.workspace.setup.voiceBackend === 'self-hosted'
                                        ? 'Self-hosted voice calls need a transcription server with a realtime socket (Settings → General → Transcription)'
                                        : 'Voice calls need VOICE_API_KEY and VOICE_MODEL'
                                    : voice.status === 'idle'
                                      ? 'Start a voice call with your socio'
                                      : 'End the voice call'
                            }
                        >
                            <ChatIconButton
                                className={cn(
                                    headerButton,
                                    voice.status === 'active' &&
                                        'bg-brand/15 text-brand hover:bg-brand/20 hover:text-brand dark:text-brand dark:hover:text-brand',
                                )}
                                aria-label={voice.status === 'idle' ? 'Start voice call' : 'End voice call'}
                                disabled={!voiceReady || paused || !loaded || !contextReady}
                                onClick={() => (voice.status === 'idle' ? void voice.start() : void voice.end())}
                            >
                                {voice.status === 'idle' ? <Phone size={18} /> : <PhoneOff size={18} />}
                            </ChatIconButton>
                        </HeaderTip>
                    </TooltipProvider>
                }
            />
            {shell && <NoInferenceNotice choice={model ?? dot.inference} options={models} />}
            {pageContext && (
                <div
                    data-slot="page-chat-context"
                    className={cn(chatColumn, 'bg-brand/10 px-5 py-2.5 text-xs/[normal] text-foreground/80')}
                >
                    Working on{' '}
                    <AppLink
                        href={spacePath(pageContext.spaceId, pageContext.id)}
                        className="font-medium text-brand underline underline-offset-3"
                    >
                        {pageContext.title}
                    </AppLink>
                </div>
            )}
            <ChatScroller placement={placement} scroller={scroll.scroller} content={scroll.content} end={scroll.end}>
                <EarlierTurns
                    scroller={scroll.scroller}
                    earlier={!!store && history.earlier}
                    loading={history.loadingEarlier}
                    oldest={history.runs[0]?.seq}
                    onLoad={() => void store?.loadEarlier()}
                />
                {!visible.length && (!store || history.ready) && (
                    <div data-slot="chat-welcome" className="mx-auto my-15 max-w-110 text-center max-[700px]:my-10">
                        <h1
                            className={cn(
                                'my-[15px] font-medium tracking-[-0.04em] text-foreground',
                                placement === 'page' ? 'text-[28px]/[normal]' : 'text-2xl/[normal]',
                            )}
                        >
                            What’s on your mind?
                        </h1>
                        <p className={welcomeText}>{dot.instructions}</p>
                        <p className={welcomeText}>Your conversation stays with this socio, across text and calls.</p>
                    </div>
                )}
                <ChatTranscript
                    messages={shown.filter((message) =>
                        ['user', 'assistant', 'reasoning', 'tool'].includes(message.role),
                    )}
                    delivery={delivery}
                    calls={shownCalls}
                    streamingId={running ? messages.at(-1)?.id : undefined}
                    running={running}
                    dotName={dot.name}
                    times={times}
                    isCard={isCard}
                    renderTools={(message) => <CopilotChatToolCallsView message={message} messages={messages} />}
                    reactions={reactions}
                    traceExtra={(turnCalls) =>
                        toolRenderers.map(({ moduleId, afterSteps }) => {
                            if (!afterSteps) {
                                return null;
                            }
                            const latest = assistantCalls.findLast((call) =>
                                afterSteps.tools.includes(call.function.name),
                            );
                            return latest && turnCalls.some((call) => call.id === latest.id) ? (
                                <afterSteps.Component
                                    key={moduleId}
                                    threadId={thread.id}
                                    dot={dot}
                                    onSaved={onSaved}
                                    onComputer={onComputer}
                                />
                            ) : null;
                        })
                    }
                />
                {running && phase && !updating && <RunStatus phase={phase} dotName={dot.name} />}
                <QueuedMessages
                    messages={queued}
                    note={
                        running
                            ? `${dot.name} reads this after its current step`
                            : `${dot.name} reads this on its next turn`
                    }
                    laterNote={
                        running
                            ? `${dot.name} reads this once its reply is done`
                            : `${dot.name} reads this on its next turn`
                    }
                    onEdit={steering.edit}
                    onCancel={steering.cancel}
                />
                {movedZone && (
                    <p
                        role="status"
                        data-slot="time-zone-moved"
                        className="text-center text-[11px]/[1.8] text-muted-foreground"
                    >
                        {movedTimeZoneText(movedZone)}
                    </p>
                )}
            </ChatScroller>
            <ScrollToEnd scroll={scroll} />
            {contextError && (
                <ChatError action="Retry context" onAction={() => setContextAttempt((value) => value + 1)}>
                    {contextError}
                </ChatError>
            )}
            {updating && (
                <ChatNotice>
                    {offline
                        ? running
                            ? 'You’re offline. Your message will send once you’re back online.'
                            : OFFLINE_NOTICE
                        : running
                          ? 'Socio is updating. Your message will send as soon as it’s back.'
                          : UPDATING_NOTICE}
                </ChatNotice>
            )}
            {running && queueFull && queueable && !updating && (
                <ChatNotice icon={<Clock3 size={14} className="shrink-0" />}>
                    {queueFullNote(steering.limit!, dot.name)}
                </ChatNotice>
            )}
            {held && <ChatNotice icon={<Clock3 size={14} className="shrink-0" />}>{held}</ChatNotice>}
            {(error || voice.error) && !updating && (
                <ChatError
                    action={
                        error && error !== UNSENT_TOO_LONG
                            ? 'Reconnect'
                            : !error && voice.canFallBack && voice.status === 'idle'
                              ? 'Use cloud voice'
                              : undefined
                    }
                    onAction={() => {
                        // A self-hosted call that couldn't connect (CB-265): the
                        // person picks cloud voice for this call.
                        if (!error && voice.canFallBack) {
                            voice.fallBack();
                            return;
                        }
                        setError('');
                        const signal = connection.current?.signal;
                        if (signal) {
                            void connectChat(signal).then((connected) => {
                                if (connected) {
                                    setLoaded(true);
                                }
                            });
                        }
                    }}
                >
                    {error || voice.error}
                </ChatError>
            )}
            <CallView
                key={voice.status === 'idle' ? 'idle' : 'call'}
                dot={dot}
                voice={voice}
                className={placement === 'column' ? 'mx-auto max-w-3xl' : undefined}
            />
            {nameSuggestion && nameSuggestion.status === 'pending' && (
                <div className={cn(chatColumn, 'shrink-0')}>
                    <NameSuggestionCard
                        threadId={thread.id}
                        suggestion={nameSuggestion}
                        onApplied={(title) => {
                            postChanges([{ topic: 'conversation', id: thread.id }]);
                            void title;
                        }}
                        onSettled={() => setNameSuggestionNonce((value) => value + 1)}
                    />
                </div>
            )}
            <form
                data-slot="chat-composer"
                data-drop-active={attachments.dropActive || undefined}
                className={cn(
                    chatColumn,
                    'shrink-0 rounded-2xl border border-input bg-card px-2 pt-1.5 pb-1.5 text-foreground shadow-[0_3px_14px_rgb(0_0_0/0.024)] has-[textarea:focus-visible]:border-ring/60 data-drop-active:outline-2 data-drop-active:outline-offset-4 data-drop-active:outline-ring data-drop-active:outline-dashed',
                    placement === 'page' && 'm-3 w-auto',
                )}
                {...attachments.dropProps}
                onSubmit={(e) => {
                    e.preventDefault();
                    if (attachments.uploading) {
                        return;
                    }
                    // While the Dot works, a message waits for its next step (CB-151);
                    // one with attachments for its reply's end (CB-223).
                    if (running) {
                        if (!updating) {
                            void queue(
                                draft.trim()
                                    ? skillFirst(
                                          draft,
                                          skillMenu.skills,
                                          (text) => `${source ? `From ${source}:\n\n` : ''}${text}`,
                                      )
                                    : '',
                                attachments.refs,
                            );
                        }
                        return;
                    }
                    void send(
                        draft.trim()
                            ? skillFirst(
                                  draft,
                                  skillMenu.skills,
                                  (text) => `${source ? `From ${source}:\n\n` : ''}${text}`,
                              )
                            : '',
                        attachments.refs,
                    );
                }}
            >
                {skillMenu.menu}
                <ActiveSkillBar active={activeSkill.active} onEnd={() => void activeSkill.end()} disabled={running} />
                {/* Above the text box, which stays usable: a draft survives the bar. */}
                <ApprovalBar pending={pendingApprovals} onShow={showApprovalCard} />
                <AttachmentTray attachments={attachments} />
                <DictationPanel
                    dictation={dictation}
                    choosing={choosing && dictationMode === 'ask'}
                    methods={dictationMethods}
                    onCloseChooser={() => setChoosing(false)}
                    onChoose={(method) => {
                        setPicked(method);
                        dictate(method);
                        // Saved for every device; it is only a default if this fails.
                        void api('/preferences', 'PATCH', { dictation: method }).then(
                            () => shell?.refresh(),
                            () => {},
                        );
                    }}
                />
                {sourceOpen && (
                    <div
                        data-slot="source-input"
                        className="mt-1 mb-0.5 flex items-center gap-1.5 rounded-[14px] bg-muted py-0.5 pr-1.5 pl-2.5 text-muted-foreground"
                    >
                        <Link2 size={15} className="shrink-0" />
                        <Input
                            aria-label="Source page URL"
                            type="url"
                            value={source}
                            onChange={(e) => setSource(e.target.value)}
                            placeholder="https://example.com/page"
                            className="h-auto rounded-none border-0 bg-transparent p-2 leading-[normal] text-foreground shadow-none focus-visible:ring-0 md:text-[10px] dark:bg-transparent"
                        />
                        <ChatIconButton
                            aria-label="Remove source"
                            onClick={() => {
                                setSourceOpen(false);
                                setSource('');
                            }}
                        >
                            <X size={14} />
                        </ChatIconButton>
                    </div>
                )}
                <ComposerRow
                    tools={
                        <>
                            <ChatIconButton
                                aria-label="Add source page link"
                                aria-pressed={sourceOpen}
                                title="Add a source page link — prepend “From <url>” to your message"
                                onClick={() => setSourceOpen(!sourceOpen)}
                            >
                                <Link2 size={19} />
                            </ChatIconButton>
                            <AttachButton attachments={attachments} disabled={paused} />
                            {dictationMode && (
                                <DictationButton
                                    dictation={dictation}
                                    disabled={paused || voice.status !== 'idle'}
                                    onStart={() =>
                                        dictationMode === 'ask' ? setChoosing(!choosing) : dictate(dictationMode)
                                    }
                                />
                            )}
                        </>
                    }
                    text={
                        <Textarea
                            ref={draftBox}
                            aria-label="Message your socio"
                            placeholder={`Message ${dot.name}…`}
                            rows={1}
                            value={draft}
                            maxLength={4000}
                            onChange={(e) => setDraft(e.target.value)}
                            onPaste={attachments.onPaste}
                            {...skillMenu.boxProps}
                            onKeyDown={(e) => {
                                if (skillMenu.onKeyDown(e)) {
                                    return;
                                }
                                if (shouldSubmitComposerOnKeyDown(e)) {
                                    e.preventDefault();
                                    e.currentTarget.form?.requestSubmit();
                                }
                            }}
                            className={composerText}
                        />
                    }
                    send={
                        running ? (
                            <div className="flex items-center gap-1.5">
                                <SendButton
                                    aria-label="Stop response"
                                    className={cn(
                                        queueable && !updating && 'bg-muted text-foreground hover:bg-muted/80',
                                    )}
                                    onClick={() => {
                                        const wait = waiting.current;
                                        wait?.stop.abort();
                                        if (!wait || wait.live) {
                                            copilotkit.stopAgent({ agent });
                                        }
                                    }}
                                >
                                    <Square size={16} />
                                </SendButton>
                                {queueable && !updating && (
                                    <SendButton
                                        type="submit"
                                        aria-label="Queue message"
                                        title={
                                            attachments.uploading
                                                ? 'Waiting for uploads to finish'
                                                : queueFull
                                                  ? queueFullNote(steering.limit!, dot.name)
                                                  : attachments.refs.length
                                                    ? `${dot.name} reads it once its reply is done`
                                                    : `${dot.name} reads it after its current step`
                                        }
                                        disabled={attachments.uploading || queueing || queueFull || !contextReady}
                                    >
                                        <ArrowUp size={19} />
                                    </SendButton>
                                )}
                            </div>
                        ) : (
                            <SendButton
                                type="submit"
                                aria-label="Send message"
                                title={attachments.uploading ? 'Waiting for uploads to finish' : undefined}
                                disabled={
                                    (!draft.trim() && !attachments.refs.length) ||
                                    attachments.uploading ||
                                    follow.syncing ||
                                    !loaded ||
                                    !contextReady ||
                                    paused
                                }
                            >
                                <ArrowUp size={19} />
                            </SendButton>
                        )
                    }
                />
            </form>
            {/* Under the composer, not in it; on a phone the header's call
          button says as much. Without voice, the disabled call button's
          tooltip says what it needs. */}
            {voiceReady && (
                <div className={cn(chatColumn, 'max-[700px]:hidden keyboard-tight:hidden')}>
                    <ChatNote>Text and voice, one conversation.</ChatNote>
                </div>
            )}
        </ChatFrame>
    );
}

/** The header's icon buttons: 30 px, or 32 px in the page's panel. */
const headerButton = 'in-data-[placement=page]:size-8 in-data-[placement=page]:p-0';

/** Why a message isn't queued (CB-170): the most that may wait already do. */
const queueFullNote = (limit: number, name: string) =>
    `${limit === 1 ? 'A message is' : `${limit} messages are`} waiting for ${name}, as many as a chat can queue. Yours stays here until ${name} reads them, or you cancel one.`;

/** The welcome's two lines, under its heading. */
const welcomeText = 'mt-0 mb-[13px] text-[13px]/[1.9] text-muted-foreground';

/**
 * A tooltip for an icon-only header button. The span keeps it working on a
 * disabled button, which gets no pointer events of its own.
 */
function HeaderTip({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className={cn('inline-flex', className)}>{children}</span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{label}</TooltipContent>
        </Tooltip>
    );
}
