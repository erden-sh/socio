import { Archive, ArrowUp, ArrowUpRight, Link2, MoreHorizontal, Phone, Settings2, X } from 'lucide-react';
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import type { ModelChoice } from '@socio/shared/inference';
import type { Conversation, Dot, Result } from '@socio/shared/types';
import { availableDictation, chooseDictation, type DictationMethod } from '@socio/shared/voice/dictation';

import { api, describeFailure } from '../lib/api';
import { useLiveTopic } from '../lib/change-channel';
import { ClientOnly } from '../lib/client-only';
import { Mascot } from '../locals/Mascot';
import { AttachButton, AttachmentTray } from '../modules/chat/attachments/AttachmentTray';
import { useAttachments } from '../modules/chat/attachments/use-attachments';
import { composerText, SendButton } from '../modules/chat/chat-chrome';
import { ChatIconButton } from '../modules/chat/chat-chrome';
import { shouldSubmitComposerOnKeyDown, useFitComposer, useFocusOnOpen } from '../modules/chat/chat-composer';
import { newChatDraft, useDraft } from '../modules/chat/chat-drafts';
import { ownsChat, useArchiveChat } from '../modules/chat/chat-menu';
import { ClientChat } from '../modules/chat/ClientChat';
import { ModelPicker, useInheritedModelLabel, useModelOptions, modelAvailability } from '../modules/chat/ModelSelect';
import { ResultPane } from '../modules/chat/ResultPane';
import { useSkillMenu } from '../modules/chat/SkillMenu';
import { RoomChat } from '../modules/rooms/RoomChat';
import { TeamTranscript } from '../modules/rooms/TeamTranscript';
import { DictationButton, DictationPanel } from '../modules/voice/DictationControls';
import {
    deviceDictationSupported,
    insertDictation,
    serverDictationSupported,
    useDictation,
} from '../modules/voice/use-dictation';
import { CurrentUser } from '../shell/current-user';
import { NoInferenceNotice } from '../shell/NoInferenceNotice';
import { applyCaptureResult } from '../shell/poll-notice';
import { findChat, useShell } from '../shell/shell-context';

import { NotFound } from './NotFound';

import { DotVisibilityBadge } from '@/components/dot-visibility-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * The chat column, with the computer pane docked beside it when open (a
 * Dot's home page too).
 */
export function ChatLayout({ dot, capture, children }: { dot: Dot; capture?: Result; children: ReactNode }) {
    const { workspace, pane, setPane } = useShell();
    return (
        // No data-slot on these: the legacy resets (a message's Markdown, the
        // computer pane) stop at data-slot elements.
        <div className="relative flex min-h-0 flex-[1_1_auto]">
            <div className="min-w-0 flex-1">{children}</div>
            {pane && (
                // Docked beside the chat; over it on narrow screens.
                <div className="w-[clamp(390px,40vw,660px)] shrink-0 overflow-auto *:min-h-full max-[1100px]:absolute max-[1100px]:inset-y-0 max-[1100px]:right-0 max-[1100px]:z-15 max-[1100px]:w-[min(600px,100vw)] max-[1100px]:shadow-[-8px_0_28px_rgb(32_38_52/0.09)] max-[700px]:w-full">
                    <ClientOnly>
                        {() => (
                            <ResultPane
                                key={dot.id}
                                dots={workspace.dots.filter((item) => !item.archivedAt)}
                                defaultDotId={dot.id}
                                latest={capture}
                                docked
                                dotState="idle"
                                onClose={() => setPane(false)}
                            />
                        )}
                    </ClientOnly>
                </div>
            )}
        </div>
    );
}

/** The new chat's suggested first messages (`chat.composer:new.starters`). */
const STARTERS = ['think', 'research', 'plan'] as const;

/**
 * Unarchive for an archived Dot: its owner or an admin may (`allowed`);
 * the server says why not when an admin archived it.
 */
export function useUnarchiveDot(dot: Dot) {
    const { t } = useTranslation(['chat.menu']);
    const shell = useShell();
    const { workspace, admin } = shell;
    const [busy, setBusy] = useState(false);
    const mine = !!dot.ownerId && dot.ownerId === workspace.user.id;
    const unarchive = async () => {
        setBusy(true);
        try {
            await api(`/dots/${encodeURIComponent(dot.id)}/unarchive`, 'POST');
            void shell.refresh();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t('chat.menu:archived-notice.unarchive-failed'));
        } finally {
            setBusy(false);
        }
    };
    return { allowed: admin || mine, busy, unarchive };
}

/**
 * An archived Dot: its chats stay readable and it answers no more. Its
 * owner (or an admin) can bring it back from here, as nothing lists it.
 */
function DotArchivedNotice({ dot }: { dot: Dot }) {
    const { t } = useTranslation(['chat.menu']);
    const { allowed, busy, unarchive } = useUnarchiveDot(dot);
    return (
        <div role="status" data-slot="dot-archived" className={notice}>
            <Archive className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <p className="flex-1">{t('chat.menu:archived-notice.socio')}</p>
            {allowed && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void unarchive()}>
                    {t('chat.menu:unarchive')}
                </Button>
            )}
        </div>
    );
}

/** A note above a chat (archived chat, archived Dot), in the chat's column. */
const notice =
    'mx-auto my-3 flex w-[calc(100%-2rem)] max-w-2xl shrink-0 items-center gap-3 rounded-lg border bg-muted/60 px-4 py-2 text-sm text-foreground';

/** A new chat with a Dot: its persona, a composer and setup status. */
function NewConversation({ dot }: { dot: Dot }) {
    const { t } = useTranslation(['chat.composer']);
    const inheritedModelLabel = useInheritedModelLabel();
    const shell = useShell();
    const { state, workspace, admin, configured, busy } = shell;
    // Kept per person and Dot until the chat starts (CB-153).
    const draft = useDraft(useContext(CurrentUser)?.id, newChatDraft(dot.id));
    const prompt = draft.text;
    const setPrompt = draft.setText;
    const promptBox = useFitComposer(prompt);
    // The `/` menu of chat skills (CB-143).
    const skillMenu = useSkillMenu(prompt, setPrompt, promptBox);
    // This chat's own model; null: the Dot's default.
    const [model, setModel] = useState<ModelChoice | null>(null);
    const models = useModelOptions();
    // Pending until the conversation exists; its first turn binds them.
    const attachments = useAttachments();
    // Voice/dictation, the same setup as a running chat's composer (CB-101):
    // the mic is offered only when a way works in this browser and the
    // workspace allows it. The first message deserves the same mic as any
    // later one (CB-266).
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
        server: browser.server && !!workspace.setup.transcription,
        allowed: state.settings.dictationMethods,
    });
    // The person's pick, kept here at once while the server saves it.
    const [picked, setPicked] = useState<DictationMethod>();
    const dictationMode = chooseDictation(dictationMethods, picked ?? workspace.preferences?.dictation);
    const [choosing, setChoosing] = useState(false);
    // Where the cursor goes once the dictated text is in the prompt.
    const caret = useRef<number>(undefined);
    const dictation = useDictation(
        (text) => {
            const box = promptBox.current;
            setPrompt((current) => {
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
        { live: !!workspace.setup.transcriptionStreaming },
    );
    useLayoutEffect(() => {
        const box = promptBox.current;
        if (caret.current === undefined || !box) {
            return;
        }
        if (window.matchMedia?.('(pointer: fine)').matches) {
            box.focus();
        }
        box.setSelectionRange(caret.current, caret.current);
        caret.current = undefined;
    }, [prompt, promptBox]);
    const dictate = (method: DictationMethod) => {
        setChoosing(false);
        dictation.start(method);
    };
    // A source page link, as a running chat's composer has: prepended to the
    // message as `From <url>` on send (CB-266). The first message can carry
    // the same context a later one can.
    const [source, setSource] = useState('');
    const [sourceOpen, setSourceOpen] = useState(false);
    // Set up, and this user's chats have a model (theirs or the workspace's).
    const usable =
        configured && modelAvailability(model ?? dot.inference, models, workspace.setup.inference?.available) !== false;
    useFocusOnOpen(promptBox, usable);
    return (
        <div
            data-slot="new-chat"
            className="mx-auto flex h-full max-w-200 flex-col px-9.5 pt-[25px] pb-7 text-foreground max-[700px]:px-4.5 max-[700px]:py-5 keyboard-tight:py-1"
        >
            {/* What is above the composer, which stays at the bottom as a
          chat's does (CB-160): the welcome at the top, the starters just
          above the box. It scrolls on its own when the screen is short,
          and gives way to the composer while you type above a phone's
          keyboard (CB-155), so the box never moves for it. */}
            <div
                data-slot="new-chat-intro"
                className="-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto px-1 [scrollbar-width:thin]"
            >
                <div className="mb-[25px] text-center keyboard:hidden">
                    <Mascot
                        identity={dot.id}
                        character={dot.character}
                        name={dot.name}
                        state={state.settings.paused ? 'paused' : 'idle'}
                        className="mx-auto mb-1 flex size-17"
                    />
                    <h2 className="mt-0 mb-1.5 flex items-center justify-center gap-1.5 text-[17px]/[normal] font-[550] tracking-[-0.2px]">
                        {dot.name}
                        <DotVisibilityBadge dot={dot} />
                    </h2>
                    <p className="mx-auto mt-0 mb-2 max-w-105 text-[13px]/[1.7] text-muted-foreground">
                        {dot.instructions}
                    </p>
                    {(admin || (!!dot.ownerId && dot.ownerId === workspace.user.id)) && (
                        <Button
                            variant="ghost"
                            className="h-auto gap-[5px] p-0 text-[12px]/[normal] font-normal text-muted-foreground/80 hover:bg-transparent hover:text-foreground dark:text-muted-foreground dark:hover:bg-transparent"
                            onClick={() => shell.openDialog({ type: 'dot', dot, spaceId: dot.spaceId })}
                        >
                            {t('chat.composer:new.edit')} <MoreHorizontal className="size-3.5" />
                        </Button>
                    )}
                </div>
                {configured && <NoInferenceNotice choice={model ?? dot.inference} options={models} />}
                <div className="mt-auto">
                    {!configured && (
                        <div
                            data-slot="setup-card"
                            className="mb-5 flex items-start gap-[13px] rounded-[10px] border bg-muted/40 p-4.5 max-[700px]:mt-7.5 max-[700px]:gap-2.5 max-[700px]:p-3.5"
                        >
                            <span className="flex rounded-lg bg-muted p-2 text-muted-foreground max-[700px]:p-1.5">
                                <Settings2 size={20} />
                            </span>
                            <div>
                                <strong className="text-[13px] font-[550] text-foreground">
                                    {t('chat.composer:new.connect.title')}
                                </strong>
                                <p className="my-[7px] text-[13px]/[1.9] text-muted-foreground max-[700px]:wrap-anywhere">
                                    {t('chat.composer:new.connect.text')}
                                </p>
                            </div>
                        </div>
                    )}
                    <div
                        data-slot="new-chat-starters"
                        className="mb-3 flex flex-wrap justify-center gap-2 max-[700px]:flex-col keyboard:hidden"
                    >
                        {STARTERS.map((starter) => t(`chat.composer:new.starters.${starter}`)).map((text) => (
                            <Button
                                key={text}
                                variant="outline"
                                disabled={!usable}
                                onClick={() => setPrompt(text)}
                                className="h-auto gap-2 rounded-[9px] px-2.5 py-[9px] has-[>svg]:px-2.5 text-[12px]/[normal] font-normal text-muted-foreground/80 shadow-none max-[700px]:justify-between max-[700px]:px-[13px] max-[700px]:has-[>svg]:px-[13px] max-[700px]:py-2.5 dark:border-border dark:bg-transparent dark:text-muted-foreground"
                            >
                                {text}
                                <ArrowUpRight className="size-3" />
                            </Button>
                        ))}
                    </div>
                </div>
            </div>
            <form
                data-slot="new-chat-composer"
                data-tour="new-chat-composer"
                data-drop-active={attachments.dropActive || undefined}
                className="shrink-0 rounded-[22px] border keyboard-tight:py-1.5 border-input bg-card px-5 pt-[21px] pb-3.5 shadow-[0_3px_14px_rgb(0_0_0/0.024)] has-[textarea:focus-visible]:border-ring/60 data-drop-active:outline-2 data-drop-active:outline-offset-4 data-drop-active:outline-ring data-drop-active:outline-dashed max-[700px]:px-[15px] max-[700px]:pt-[19px] max-[700px]:pb-3"
                {...(usable ? attachments.dropProps : {})}
                onSubmit={(e) => {
                    e.preventDefault();
                    if (attachments.uploading) {
                        return;
                    }
                    // A source page link, as in a running chat: prepended to the
                    // message text, so the Dot sees the same `From <url>` context on
                    // the first message as on any later one (CB-266).
                    const body = source ? `From ${source}:\n\n${prompt}` : prompt;
                    void shell.newConversation(dot, body, model, attachments.refs).then((done) => {
                        if (!done) {
                            return;
                        }
                        setPrompt('');
                        setSource('');
                        setSourceOpen(false);
                        attachments.clear();
                    });
                }}
            >
                {skillMenu.menu}
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
                            () => shell.refresh(),
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
                            aria-label={t('chat.composer:source.url')}
                            type="url"
                            value={source}
                            onChange={(e) => setSource(e.target.value)}
                            // oxlint-disable-next-line socio/no-literal-text -- an example address, the same in every language
                            placeholder="https://example.com/page"
                            className="h-auto rounded-none border-0 bg-transparent p-2 leading-[normal] text-foreground shadow-none focus-visible:ring-0 md:text-[10px] dark:bg-transparent"
                        />
                        <ChatIconButton
                            aria-label={t('chat.composer:source.remove')}
                            onClick={() => {
                                setSourceOpen(false);
                                setSource('');
                            }}
                        >
                            <X size={14} />
                        </ChatIconButton>
                    </div>
                )}
                <Textarea
                    ref={promptBox}
                    aria-label={t('chat.composer:new.box')}
                    placeholder={
                        usable
                            ? t('chat.composer:box.placeholder', { name: dot.name })
                            : configured
                              ? t('chat.composer:new.no-model')
                              : t('chat.composer:new.after-setup')
                    }
                    rows={1}
                    value={prompt}
                    maxLength={4000}
                    onChange={(e) => setPrompt(e.target.value)}
                    onPaste={usable ? attachments.onPaste : undefined}
                    {...skillMenu.boxProps}
                    onKeyDown={(e) => {
                        if (skillMenu.onKeyDown(e)) {
                            return;
                        }
                        if (!shouldSubmitComposerOnKeyDown(e)) {
                            return;
                        }
                        e.preventDefault();
                        // The send button's rules: nothing to send, nothing happens.
                        if (prompt.trim() || attachments.refs.length) {
                            e.currentTarget.form?.requestSubmit();
                        }
                    }}
                    disabled={!usable}
                    className={cn(composerText, 'min-h-6.5 p-0 leading-[1.6] md:leading-[1.6]')}
                />
                {/* A toolbar under the text, as in the chat's composer on a phone
            (CB-97): the message actions at its start, the model and send at
            its end. The first message gets the same actions — source link,
            attach and dictation — as any later one (CB-266). */}
                <div data-slot="composer-toolbar" className="mt-2 flex items-center keyboard-tight:mt-1">
                    <div
                        data-slot="composer-tools"
                        role="group"
                        aria-label={t('chat.composer:tools')}
                        className="flex shrink-0 items-center gap-0 [&_button]:size-11 [&_button]:p-0"
                    >
                        <ChatIconButton
                            aria-label={t('chat.composer:source.add')}
                            aria-pressed={sourceOpen}
                            title={t('chat.composer:source.add-hint')}
                            onClick={() => setSourceOpen(!sourceOpen)}
                        >
                            <Link2 size={19} />
                        </ChatIconButton>
                        <AttachButton attachments={attachments} disabled={!usable} />
                        {dictationMode && (
                            <DictationButton
                                dictation={dictation}
                                disabled={!usable}
                                onStart={() =>
                                    dictationMode === 'ask' ? setChoosing(!choosing) : dictate(dictationMode)
                                }
                            />
                        )}
                        {/* Voice as the first message (CB-302): start a voice call on a
                new chat before any text. The same setup flags a running chat
                gates its header voice button on; tapping creates the
                conversation and the running chat starts the call. */}
                        {workspace.setup.voice && (
                            <ChatIconButton
                                data-slot="new-chat-voice"
                                aria-label={t('chat.composer:new.voice')}
                                title={t('chat.composer:new.voice-hint')}
                                disabled={!usable || busy}
                                onClick={() =>
                                    void shell.newConversation(dot, undefined, model, attachments.refs, { voice: true })
                                }
                            >
                                <Phone size={19} />
                            </ChatIconButton>
                        )}
                    </div>
                    <ModelPicker
                        aria-label={t('chat.composer:new.model')}
                        className="mr-2 ml-auto max-w-65 min-w-0"
                        value={model}
                        onChange={setModel}
                        options={models?.options ?? []}
                        disabled={!models || !configured}
                        inheritLabel={inheritedModelLabel(dot.inference, models)}
                        requireAvailable
                    />
                    <SendButton
                        type="submit"
                        className="size-8 min-w-8"
                        aria-label={t('chat.composer:new.start')}
                        title={attachments.uploading ? t('chat.composer:send.waiting-uploads') : undefined}
                        disabled={
                            !usable || busy || attachments.uploading || (!prompt.trim() && !attachments.refs.length)
                        }
                    >
                        <ArrowUp size={19} />
                    </SendButton>
                </div>
            </form>
        </div>
    );
}

/** `/dots/:dotId/new`: a new chat with that Dot (its home page links here). */
export function DotChat() {
    const { workspace } = useShell();
    const { dotId } = useParams();
    const dot = workspace.dots.find((item) => item.id === dotId);
    if (!dot) {
        return <NotFound what="Socio" />;
    }
    return (
        <ChatLayout dot={dot}>
            {dot.archivedAt ? <DotArchivedNotice dot={dot} /> : <NewConversation key={dot.id} dot={dot} />}
        </ChatLayout>
    );
}

/**
 * The latest computer capture of a conversation, polled every 3 s, and at
 * once on another tab's note about it. A tick waits while the shell
 * re-reads after a note, and stops once the chat has left the list (a
 * chat deleted in another tab is never asked for: no 404).
 */
function useCapture(threadId: string | undefined) {
    const { t } = useTranslation(['shell']);
    const failed = t('shell:notices.connect-failed');
    const { setNotices } = useShell();
    const [capture, setCapture] = useState<Result>();
    const [shown, setShown] = useState(threadId);
    if (shown !== threadId) {
        setShown(threadId);
        setCapture(undefined);
    }
    const load = useCallback(
        (isActive: () => boolean = () => true) => {
            if (!threadId) {
                return;
            }
            void api<Result | null>(`/conversations/${threadId}/capture`)
                .then((result) => {
                    if (!isActive()) {
                        return;
                    }
                    setCapture(result ?? undefined);
                    setNotices((current) => applyCaptureResult(current, { ok: true }));
                })
                .catch((e) => {
                    if (!isActive()) {
                        return;
                    }
                    setNotices((current) => applyCaptureResult(current, describeFailure(e, failed)));
                });
        },
        [threadId, setNotices, failed],
    );
    const canPoll = useLiveTopic(threadId && `conversation:${threadId}`, () => load(canPoll));
    useEffect(() => {
        if (!threadId) {
            return;
        }
        let active = true;
        const isActive = () => active;
        load(isActive);
        const timer = setInterval(() => {
            if (canPoll()) {
                load(isActive);
            }
        }, 3000);
        return () => {
            active = false;
            clearInterval(timer);
        };
    }, [threadId, load, canPoll]);
    return capture;
}

/**
 * Above an archived chat opened by its link. Sending a
 * message works and leaves it archived: neither reference says sending
 * unarchives.
 */
function ArchivedNotice({ thread }: { thread: Conversation }) {
    const { t } = useTranslation(['chat.menu']);
    const { unarchive } = useArchiveChat();
    const [busy, setBusy] = useState(false);
    return (
        <div role="status" data-slot="archived-chat" className={notice}>
            <Archive className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <p className="flex-1">{t('chat.menu:archived-notice.chat')}</p>
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
                {t('chat.menu:unarchive')}
            </Button>
        </div>
    );
}

/** `/chats/:threadId`: a conversation, the user's own, a team one or a room. */
export function ChatThread() {
    const shell = useShell();
    const { state, workspace, configured, pendingPrompt, pendingVoice } = shell;
    const { threadId } = useParams();
    // Archived chats too: no list shows them, but their link opens them.
    const thread = findChat(workspace, threadId);
    const dot = workspace.dots.find((item) => item.id === thread?.dotId);
    // A room a member was removed from leaves their chat list on the next
    // workspace poll: while they had it open, remember the thread and its
    // socio so the room's own "you are no longer in this room" notice stays
    // (RoomChat's feed.gone), instead of the generic "Conversation not
    // found." the route shows a thread it can no longer see (Rooms
    // follow-ups). Forgotten as soon as the route changes to another chat.
    const lastRoom = useRef<{ thread: Conversation; dot: Dot } | undefined>(undefined);
    if (thread && dot && thread.kind === 'room') {
        lastRoom.current = { thread, dot };
    }
    if (threadId !== lastRoom.current?.thread.id) {
        lastRoom.current = undefined;
    }
    const kept = !thread && lastRoom.current;
    const roomThread = kept ? lastRoom.current!.thread : thread;
    const roomDot = kept ? lastRoom.current!.dot : dot;
    // Captures are the owner's (the route answers 404 to anyone else): a
    // team topic the user is only in has none to ask for (CB-73).
    const capture = useCapture(thread && dot && ownsChat(thread, workspace.user.id) ? thread.id : undefined);
    if (!thread || !dot) {
        if (kept && roomThread && roomDot) {
            return (
                <ChatLayout dot={roomDot}>
                    <RoomChat key={roomThread.id} thread={roomThread} dot={roomDot} />
                </ChatLayout>
            );
        }
        return <NotFound what="Conversation" />;
    }
    return (
        <ChatLayout dot={dot} capture={capture}>
            {thread.kind === 'room' ? (
                // A shared room (CB-212): its people, their messages and its socio.
                <RoomChat key={thread.id} thread={thread} dot={dot} />
            ) : thread.team ? (
                <TeamTranscript key={thread.id} thread={thread} dot={dot} />
            ) : configured ? (
                // A column: the notices take their height, the chat the rest, so
                // the composer stays on screen under them.
                <div className="flex h-full min-h-0 flex-col">
                    {thread.archivedAt && <ArchivedNotice thread={thread} />}
                    {dot.archivedAt && <DotArchivedNotice dot={dot} />}
                    <div className="min-h-0 flex-1">
                        <ClientChat
                            key={thread.id}
                            thread={thread}
                            dot={dot}
                            initialPrompt={pendingPrompt?.threadId === thread.id ? pendingPrompt.text : undefined}
                            initialAttachments={
                                pendingPrompt?.threadId === thread.id ? pendingPrompt.attachments : undefined
                            }
                            onConsumed={shell.consumePrompt}
                            pendingVoice={pendingVoice?.threadId === thread.id || undefined}
                            onVoiceConsumed={shell.consumeVoice}
                            voiceReady={workspace.setup.voice}
                            calls={workspace.calls.filter((call) => call.threadId === thread.id)}
                            // An archived Dot answers no more: its chat is read-only.
                            paused={state.settings.paused || !!dot.archivedAt}
                            onSaved={shell.refresh}
                            onComputer={() => shell.setPane(true)}
                            onSchedule={() => shell.openDialog({ type: 'schedule', threadId: thread.id })}
                        />
                    </div>
                </div>
            ) : (
                <NewConversation dot={dot} />
            )}
        </ChatLayout>
    );
}
