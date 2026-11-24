import { CalendarClock, ExternalLink, ListPlus, Plus, Trash2 } from 'lucide-react';
/**
 * Composer layout follows inovector/mixpost (MIT) as a design reference
 * only: editor on the left, live preview on the right, account avatars on
 * top, actions in a bottom bar. No Mixpost source is copied.
 *
 * Pick time, queue slots, the toolbar, and auto thread splitting are
 * adapted from coollabsio/shoutrrr (Apache-2.0),
 * resources/js/components/compose/{composer,composer-toolbar,queue-preview}.tsx
 * and resources/js/lib/compose/x-preview.ts.
 * Copyright Shoutrrr contributors. SPDX-License-Identifier: Apache-2.0
 *
 * Open in X is an intent link. This composer never posts to X.
 */
import { useState, type MouseEvent, type ReactNode } from 'react';

import { AvatarChoices, EditorShell, openInHost } from '@socio/plugin-ui';
import {
    POST_STATUSES,
    POST_STATUS_LABEL,
    SUGGESTED_ACCOUNTS,
    formatZonedLocal,
    parseZonedLocal,
    type PostStatus,
} from '@socio/shared/planner';
import { intentUrl, threadIntents } from '@socio/shared/x-post';

import { plannerCall } from './api';
import { CountRing } from './CountRing';
import { accountColor, dayKey } from './dates';
import { PostPreview } from './Preview';
import { accountLimit, expandParts, nextQueueSlot } from './thread';
import type { PlannedPost, PlannerState, PostDraft } from './types';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

function draftFrom(post: PlannedPost | undefined, plannedLocal: string): PostDraft {
    return {
        id: post?.id,
        account: post?.account || SUGGESTED_ACCOUNTS[0],
        plannedLocal: post ? formatZonedLocal(post.plannedAt) : plannedLocal,
        status: post?.status ?? 'draft',
        topic: post?.topic ?? '',
        notes: post?.notes ?? '',
        parts: (post?.parts.length ? post.parts : [{ text: '' }]).map((part) => ({
            text: part.text,
            xId: part.xId ?? '',
        })),
    };
}

function openInX(url: string, event: MouseEvent<HTMLAnchorElement>) {
    if (openInHost(url)) {
        event.preventDefault();
    }
}

export function Editor({
    post,
    posts,
    plannedLocal,
    onClose,
    onSaved,
}: {
    post?: PlannedPost;
    posts: PlannedPost[];
    plannedLocal: string;
    onClose: () => void;
    onSaved: (state: PlannerState, id?: string) => void;
}) {
    const [draft, setDraft] = useState(() => draftFrom(post, plannedLocal));
    const [active, setActive] = useState(0);
    const [autoSplit, setAutoSplit] = useState(true);
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const limit = accountLimit(draft.account);
    const visible = autoSplit ? expandParts(draft.parts, limit) : draft.parts;
    const links = threadIntents(
        visible.map((part) => ({
            text: part.text,
            ...(part.xId.trim() ? { xId: part.xId.trim() } : {}),
        })),
    );
    const index = Math.min(active, links.length - 1);
    const current = links[index];
    const previousId = index > 0 ? visible[index - 1]?.xId.trim() || undefined : undefined;
    const openUrl = current?.text.trim() ? intentUrl(current.text, previousId) : '';
    const patch = (next: Partial<PostDraft>) => setDraft((value) => ({ ...value, ...next }));
    const accounts = [...new Set([...SUGGESTED_ACCOUNTS, ...posts.map((item) => item.account)])];

    const persist = async (override?: Partial<PostDraft>) => {
        const next = { ...draft, ...override };
        const plannedAt = parseZonedLocal(next.plannedLocal);
        if (plannedAt === undefined) {
            setError('Enter a date and time.');
            return;
        }
        if (!next.account.trim()) {
            setError('Enter an account.');
            return;
        }
        const parts = autoSplit ? expandParts(next.parts, limit) : next.parts;
        setBusy(true);
        setError(undefined);
        const body = {
            account: next.account.replace(/^@+/, ''),
            plannedAt,
            plannedLocal: next.plannedLocal,
            status: next.status,
            topic: next.topic,
            notes: next.notes,
            parts: parts.map((part) => ({
                text: part.text,
                ...(part.xId.trim() ? { xId: part.xId.trim() } : {}),
            })),
        };
        try {
            const before = next.id;
            const state = await plannerCall<PlannerState>(
                before ? 'PATCH' : 'POST',
                before ? `/api/posts/${encodeURIComponent(before)}` : '/api/posts',
                body,
            );
            onSaved(state, before);
            if (override) {
                setDraft({ ...next, parts });
            }
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Could not save.');
        } finally {
            setBusy(false);
        }
    };

    const queue = () => {
        const day = draft.plannedLocal.slice(0, 10);
        const taken = posts
            .filter((item) => dayKey(item.plannedAt) === day && item.id !== draft.id)
            .map((item) => formatZonedLocal(item.plannedAt));
        const slot = nextQueueSlot(taken, draft.plannedLocal);
        void persist({
            plannedLocal: slot,
            status: 'scheduled-for-manual-posting',
        });
    };

    const avatarAccounts = accounts.map((account) => ({
        id: account,
        label: `@${account}`,
        color: accountColor(account),
        initial: account.slice(0, 1).toUpperCase(),
    }));

    return (
        <EditorShell
            title={draft.id ? 'Your post' : 'New post'}
            description="Socio keeps the draft. Open in X hands the text to you to publish."
            status={draft.status === 'draft' ? 'Draft' : POST_STATUS_LABEL[draft.status]}
            onClose={onClose}
            error={error}
            accounts={
                <>
                    <AvatarChoices
                        accounts={avatarAccounts}
                        value={draft.account}
                        onChange={(account) => patch({ account })}
                    />
                    <Input
                        value={draft.account}
                        list="planner-accounts"
                        maxLength={40}
                        aria-label="Account handle"
                        className="h-8 w-40"
                        onChange={(event) => patch({ account: event.target.value.replace(/^@+/, '') })}
                    />
                    <datalist id="planner-accounts">
                        {accounts.map((account) => (
                            <option key={account} value={account} />
                        ))}
                    </datalist>
                </>
            }
            previewMeta={
                <span className="text-xs text-muted-foreground">
                    {visible.length} {visible.length === 1 ? 'post' : 'posts'}
                </span>
            }
            preview={
                <PostPreview
                    account={draft.account.replace(/^@+/, '')}
                    parts={visible}
                    plannedAt={parseZonedLocal(draft.plannedLocal)}
                />
            }
            editor={
                <>
                    <div className="flex flex-wrap items-center gap-2">
                        <Select
                            value={draft.status}
                            onValueChange={(status) => patch({ status: status as PostStatus })}
                        >
                            <SelectTrigger className="h-8 w-52" aria-label="Status">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {POST_STATUSES.map((status) => (
                                    <SelectItem key={status} value={status}>
                                        {POST_STATUS_LABEL[status]}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Input
                            value={draft.topic}
                            maxLength={80}
                            placeholder="Product tag"
                            aria-label="Product tag"
                            className="h-8 w-40"
                            onChange={(event) => patch({ topic: event.target.value })}
                        />
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                            <input
                                type="checkbox"
                                checked={autoSplit}
                                onChange={(event) => setAutoSplit(event.target.checked)}
                            />
                            Auto-split at {limit}
                        </label>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => patch({ parts: expandParts(draft.parts, limit) })}
                        >
                            Split thread
                        </Button>
                    </div>
                    {visible.length > draft.parts.length && (
                        <p className="text-xs text-muted-foreground">
                            This draft becomes {visible.length} posts on X. Split thread writes those parts into the
                            editor.
                        </p>
                    )}
                    {draft.parts.map((part, partIndex) => (
                        <div key={partIndex} className="grid gap-2">
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-xs font-medium text-muted-foreground">
                                    {draft.parts.length > 1 ? `Part ${partIndex + 1}` : 'Post'}
                                </span>
                                <CountRing text={part.text} limit={limit} />
                            </div>
                            <Textarea
                                value={part.text}
                                aria-label={`Part ${partIndex + 1}`}
                                placeholder="Write something…"
                                className="min-h-32"
                                onFocus={() => setActive(partIndex)}
                                onChange={(event) => {
                                    const parts = draft.parts.slice();
                                    parts[partIndex] = { ...part, text: event.target.value };
                                    patch({ parts });
                                    setActive(partIndex);
                                }}
                            />
                            <div className="flex flex-wrap items-center gap-2">
                                <Input
                                    value={part.xId}
                                    maxLength={40}
                                    placeholder="X id, after you post it"
                                    aria-label={`X id for part ${partIndex + 1}`}
                                    className="h-8 max-w-xs"
                                    onChange={(event) => {
                                        const parts = draft.parts.slice();
                                        parts[partIndex] = { ...part, xId: event.target.value };
                                        patch({ parts });
                                    }}
                                />
                                {draft.parts.length > 1 && (
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                            patch({
                                                parts: draft.parts.filter((_, item) => item !== partIndex),
                                            })
                                        }
                                    >
                                        <Trash2 /> Remove
                                    </Button>
                                )}
                            </div>
                        </div>
                    ))}
                    <div className="flex flex-wrap gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => patch({ parts: [...draft.parts, { text: '', xId: '' }] })}
                        >
                            <Plus /> Add to thread
                        </Button>
                    </div>
                    <Field label="Notes">
                        <Textarea value={draft.notes} onChange={(event) => patch({ notes: event.target.value })} />
                    </Field>
                </>
            }
            footer={
                <>
                    <div className="flex flex-wrap items-center gap-2">
                        <Popover>
                            <PopoverTrigger asChild>
                                <Button type="button" variant="outline" size="sm">
                                    <CalendarClock /> Pick time
                                </Button>
                            </PopoverTrigger>
                            <PopoverContent align="start" className="grid gap-2">
                                <p className="text-sm font-medium">When (New York)</p>
                                <Input
                                    type="datetime-local"
                                    value={draft.plannedLocal}
                                    aria-label="When (New York)"
                                    onChange={(event) => patch({ plannedLocal: event.target.value })}
                                />
                            </PopoverContent>
                        </Popover>
                        <QueueMenu
                            day={draft.plannedLocal.slice(0, 10)}
                            posts={posts}
                            selfId={draft.id}
                            onPick={(slot) =>
                                void persist({
                                    plannedLocal: slot,
                                    status: 'scheduled-for-manual-posting',
                                })
                            }
                        />
                        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={queue}>
                            <ListPlus /> Queue
                        </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button type="button" variant="outline" disabled={busy} onClick={() => void persist()}>
                            Save draft
                        </Button>
                        {openUrl ? (
                            <Button asChild>
                                <a
                                    href={openUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(event) => openInX(openUrl, event)}
                                >
                                    <ExternalLink /> Open in X
                                </a>
                            </Button>
                        ) : (
                            <Button type="button" disabled>
                                <ExternalLink /> Open in X
                            </Button>
                        )}
                    </div>
                </>
            }
        />
    );
}

function QueueMenu({
    day,
    posts,
    selfId,
    onPick,
}: {
    day: string;
    posts: PlannedPost[];
    selfId?: string;
    onPick: (slot: string) => void;
}) {
    const taken = new Set(
        posts
            .filter((item) => dayKey(item.plannedAt) === day && item.id !== selfId)
            .map((item) => formatZonedLocal(item.plannedAt)),
    );
    const slots: string[] = [];
    for (let hour = 9; hour <= 17; hour += 1) {
        slots.push(`${day}T${String(hour).padStart(2, '0')}:00`);
        slots.push(`${day}T${String(hour).padStart(2, '0')}:30`);
    }
    return (
        <Popover>
            <PopoverTrigger asChild>
                <Button type="button" variant="ghost" size="sm">
                    Queue slots
                </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="grid max-h-72 gap-1 overflow-y-auto">
                <p className="text-sm font-medium">Queue slots</p>
                <p className="mb-1 text-xs text-muted-foreground">
                    Half hours from 9:00 to 17:30, New York. Picking one schedules the draft for you to post by hand.
                </p>
                {slots.map((slot) => {
                    const used = taken.has(slot);
                    return (
                        <button
                            key={slot}
                            type="button"
                            disabled={used}
                            onClick={() => onPick(slot)}
                            className="flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-40"
                        >
                            <span className="tabular-nums">{slot.slice(11)}</span>
                            <span className="text-xs text-muted-foreground">{used ? 'Taken' : 'Open'}</span>
                        </button>
                    );
                })}
            </PopoverContent>
        </Popover>
    );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <label className="grid gap-1.5 text-sm font-medium">
            {label}
            {children}
        </label>
    );
}
