import { Clock3, Paperclip, Pencil, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { OthersQueuedMessage, QueuedMessage } from '@socio/shared/chat/steering';
import { STEERING_MAX_CHARS } from '@socio/shared/chat/steering';
import type { AttachmentRef } from '@socio/shared/media-types';

import { PersonAvatar } from '../rooms/RoomSpeaker';

import { MessageAttachments, type AttachmentPart } from './attachments/MessageAttachments';
import { shouldSubmitComposerOnKeyDown } from './chat-composer';
import { Markdown } from './ChatMarkdown';
import { pendingOtherBubble, pendingUserBubble } from './ChatTranscript';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

/**
 * The person's messages waiting for the Dot (CB-151), at the end of the
 * transcript: their bubbles, pending (dashed, on a light tint), each
 * with when it goes and Edit and Cancel until a turn takes it. Once delivered it leaves this list and
 * shows in the transcript, where the turn read it. One with attachments
 * (CB-223), and those after it, go once the reply is done: `laterNote`.
 */
export function QueuedMessages({
    messages,
    note,
    laterNote = note,
    onEdit,
    onCancel,
    returnFocus,
}: {
    messages: readonly QueuedMessage[];
    /** When they go: "Dot reads this after its current step". */
    note: string;
    /** When one with attachments, or after it, goes. */
    laterNote?: string;
    onEdit: (id: string, text: string, attachments?: readonly AttachmentRef[]) => Promise<void>;
    onCancel: (id: string) => Promise<void>;
    /**
     * Where focus goes once a message it was on is canceled and gone (the
     * composer); without it, the browser's default.
     */
    returnFocus?: () => HTMLElement | null | undefined;
}) {
    if (!messages.length) {
        return null;
    }
    const later = messages.findIndex((message) => message.attachments?.length);
    return (
        <section aria-label="Queued messages" data-slot="queued-messages" className="flex flex-col gap-3">
            {messages.map((message, index) => (
                <Queued
                    key={message.id}
                    message={message}
                    note={later >= 0 && index >= later ? laterNote : note}
                    onEdit={onEdit}
                    onCancel={onCancel}
                    returnFocus={returnFocus}
                />
            ))}
        </section>
    );
}

function Queued({
    message,
    note,
    onEdit,
    onCancel,
    returnFocus,
}: {
    message: QueuedMessage;
    note: string;
    onEdit: (id: string, text: string, attachments?: readonly AttachmentRef[]) => Promise<void>;
    onCancel: (id: string) => Promise<void>;
    returnFocus?: () => HTMLElement | null | undefined;
}) {
    // The text being edited; undefined when not editing.
    const [editing, setEditing] = useState<string>();
    // The files it keeps while editing (CB-223): one can be taken off.
    const [files, setFiles] = useState<readonly AttachmentRef[]>([]);
    const had = message.attachments ?? [];
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState('');
    // An edit saved or put back (Keep as it was, Escape): focus goes back to
    // its Edit, not to the page (CB-219).
    const editButton = useRef<HTMLButtonElement>(null);
    const edited = useRef(false);
    useEffect(() => {
        if (editing !== undefined) {
            edited.current = true;
        } else if (edited.current) {
            edited.current = false;
            editButton.current?.focus();
        }
    }, [editing]);
    const act = async (action: () => Promise<void>) => {
        setBusy(true);
        setProblem('');
        try {
            await action();
            setEditing(undefined);
        } catch (error) {
            setProblem(error instanceof Error ? error.message : 'That didn’t save. Try again.');
        } finally {
            setBusy(false);
        }
    };
    // Words, or files alone: a message with files may lose its words.
    const savable = !!editing?.trim() || files.length > 0;
    const save = () =>
        editing !== undefined &&
        savable &&
        void act(() => onEdit(message.id, editing, sameFiles(files, had) ? undefined : files));
    return (
        <div className="flex min-w-0 flex-col items-end gap-1" data-queued-message={message.id}>
            {editing === undefined ? (
                // Pending as a message being sent is (CB-154): not with the socio yet.
                <div className={pendingUserBubble} data-chat-body="queued">
                    {message.text.trim() && <Markdown>{message.text}</Markdown>}
                    <MessageAttachments parts={partsOf(message)} />
                </div>
            ) : (
                <div className="flex w-full max-w-[80%] flex-col gap-1.5 rounded-[17px] border border-input bg-card p-2 has-[textarea:focus-visible]:border-ring/60">
                    <Textarea
                        aria-label="Edit queued message"
                        autoFocus
                        rows={2}
                        value={editing}
                        maxLength={STEERING_MAX_CHARS}
                        onChange={(e) => setEditing(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                                setEditing(undefined);
                            } else if (shouldSubmitComposerOnKeyDown(e)) {
                                e.preventDefault();
                                save();
                            }
                        }}
                        className="max-h-60 min-h-[43px] resize-none rounded-none border-0 bg-transparent px-1.5 py-1 text-base/[1.65] shadow-none focus-visible:ring-0 md:text-sm/[1.65] dark:bg-transparent"
                    />
                    {files.length > 0 && (
                        <ul aria-label="Files it sends" className="m-0 flex list-none flex-wrap gap-1.5 p-0 px-1">
                            {files.map((file) => (
                                <li
                                    key={file.id}
                                    className="inline-flex max-w-full items-center gap-1 rounded-[8px] border border-input py-0.5 pr-0.5 pl-2 text-[11px] text-muted-foreground"
                                >
                                    <Paperclip size={12} aria-hidden className="shrink-0" />
                                    <span className="min-w-0 truncate">{file.name}</span>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-xs"
                                        aria-label={`Remove ${file.name}`}
                                        disabled={busy}
                                        onClick={() =>
                                            setFiles((current) => current.filter((kept) => kept.id !== file.id))
                                        }
                                    >
                                        <X aria-hidden />
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                    <div className="flex justify-end gap-1.5">
                        <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className="pointer-coarse:min-h-11"
                            disabled={busy}
                            onClick={() => setEditing(undefined)}
                        >
                            Keep as it was
                        </Button>
                        <Button
                            type="button"
                            size="xs"
                            className="pointer-coarse:min-h-11"
                            disabled={busy || !savable}
                            onClick={save}
                        >
                            Save
                        </Button>
                    </div>
                </div>
            )}
            <div className="flex min-h-6 flex-wrap items-center justify-end gap-x-1 px-1 text-[11px] text-muted-foreground">
                <Clock3 size={12} aria-hidden className="shrink-0" />
                <span>Queued · {note}</span>
                {editing === undefined && (
                    <>
                        <Button
                            ref={editButton}
                            type="button"
                            variant="ghost"
                            size="xs"
                            className={touchable}
                            disabled={busy}
                            onClick={() => {
                                setEditing(message.text);
                                setFiles(had);
                            }}
                        >
                            <Pencil aria-hidden />
                            Edit
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className={touchable}
                            aria-label="Cancel queued message"
                            disabled={busy}
                            onClick={() =>
                                void act(async () => {
                                    await onCancel(message.id);
                                    // It is gone, and its buttons with it.
                                    returnFocus?.()?.focus();
                                })
                            }
                        >
                            <X aria-hidden />
                            Cancel
                        </Button>
                    </>
                )}
            </div>
            {problem && (
                <p role="alert" className="m-0 px-1 text-[12px] text-destructive">
                    {problem}
                </p>
            )}
        </div>
    );
}

/**
 * Everyone else's messages waiting in a room, as its admins see them
 * (CB-215): each by its author's name, pending (dashed), with Cancel only (an admin
 * stops others' work, never rewrites what they wrote). Cancel asks once
 * more, naming whose it is. One whose author can't send there now (they
 * left, say) says it won't go.
 */
export function OthersQueuedMessages({
    messages,
    note,
    onCancel,
    returnFocus,
}: {
    messages: readonly OthersQueuedMessage[];
    /** When they go. */
    note: string;
    onCancel: (id: string) => Promise<void>;
    /** Where focus goes once a canceled message is gone (the composer). */
    returnFocus?: () => HTMLElement | null | undefined;
}) {
    if (!messages.length) {
        return null;
    }
    return (
        <section
            aria-label="Others’ queued messages"
            data-slot="others-queued-messages"
            className="flex flex-col gap-3"
        >
            {messages.map((message) => (
                <OthersQueued
                    key={message.id}
                    message={message}
                    note={note}
                    onCancel={onCancel}
                    returnFocus={returnFocus}
                />
            ))}
        </section>
    );
}

function OthersQueued({
    message,
    note,
    onCancel,
    returnFocus,
}: {
    message: OthersQueuedMessage;
    note: string;
    onCancel: (id: string) => Promise<void>;
    returnFocus?: () => HTMLElement | null | undefined;
}) {
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState('');
    const name = message.author.name;
    // Kept after all (Keep it, Escape): focus goes back to its Cancel.
    const cancelButton = useRef<HTMLButtonElement>(null);
    const asked = useRef(false);
    useEffect(() => {
        if (confirming) {
            asked.current = true;
        } else if (asked.current) {
            asked.current = false;
            cancelButton.current?.focus();
        }
    }, [confirming]);
    const cancel = async () => {
        setBusy(true);
        setProblem('');
        try {
            await onCancel(message.id);
            // Kept from going back to this Cancel: the message is gone.
            asked.current = false;
            setConfirming(false);
            returnFocus?.()?.focus();
        } catch (error) {
            setProblem(error instanceof Error ? error.message : 'That didn’t work. Try again.');
        } finally {
            setBusy(false);
        }
    };
    return (
        <div
            className="flex min-w-0 flex-col items-start gap-1"
            data-others-queued-message={message.id}
            onKeyDown={(event) => {
                if (event.key === 'Escape' && confirming && !busy) {
                    event.stopPropagation();
                    setConfirming(false);
                }
            }}
        >
            <span className="flex max-w-full min-w-0 items-center gap-1.5 px-1 text-[12px] font-medium text-muted-foreground">
                <PersonAvatar name={name} />
                <span className="truncate">{name}</span>
            </span>
            <div className={pendingOtherBubble} data-chat-body="queued">
                {message.text.trim() && <Markdown>{message.text}</Markdown>}
                {message.files > 0 && (
                    <p className="m-0 flex items-center gap-1 text-[12px] text-muted-foreground">
                        <Paperclip size={12} aria-hidden />
                        {message.files === 1 ? '1 file' : `${message.files} files`}
                    </p>
                )}
            </div>
            <div className="flex min-h-6 flex-wrap items-center gap-x-1 px-1 text-[11px] text-muted-foreground">
                <Clock3 size={12} aria-hidden className="shrink-0" />
                <span>
                    {message.held ? `Queued · won’t be sent while ${name} can’t write here` : `Queued · ${note}`}
                </span>
                {confirming ? (
                    <>
                        <span className="text-foreground">{`Cancel ${name}’s message?`}</span>
                        <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className="pointer-coarse:min-h-11"
                            disabled={busy}
                            onClick={() => setConfirming(false)}
                        >
                            Keep it
                        </Button>
                        <Button
                            type="button"
                            variant="destructive"
                            size="xs"
                            className="pointer-coarse:min-h-11"
                            autoFocus
                            disabled={busy}
                            onClick={() => void cancel()}
                        >
                            Cancel message
                        </Button>
                    </>
                ) : (
                    <Button
                        ref={cancelButton}
                        type="button"
                        variant="ghost"
                        size="xs"
                        className={touchable}
                        aria-label={`Cancel ${name}’s queued message`}
                        disabled={busy}
                        onClick={() => setConfirming(true)}
                    >
                        <X aria-hidden />
                        Cancel
                    </Button>
                )}
            </div>
            {problem && (
                <p role="alert" className="m-0 px-1 text-[12px] text-destructive">
                    {problem}
                </p>
            )}
        </div>
    );
}

/** A queued message's Edit and Cancel: quiet, 44 px tall on a touch screen. */
const touchable = 'text-muted-foreground hover:text-foreground pointer-coarse:min-h-11';

/** A queued message's attachments as the transcript shows a message's. */
const partsOf = (message: QueuedMessage): AttachmentPart[] =>
    (message.attachments ?? []).map((ref) => ({
        type: 'binary',
        id: ref.id,
        mimeType: ref.mediaType,
        filename: ref.name,
    }));

/**
 * Whether an edit keeps exactly the files the message has now, by id: a
 * file another tab took off meanwhile is never kept by sending none.
 */
export const sameFiles = (kept: readonly AttachmentRef[], has: readonly AttachmentRef[]) =>
    kept.length === has.length && kept.every((file) => has.some((other) => other.id === file.id));
