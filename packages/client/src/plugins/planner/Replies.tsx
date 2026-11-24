import { ExternalLink } from 'lucide-react';
import { useState, type MouseEvent } from 'react';

import { openInHost } from '@socio/plugin-ui';
import { REPLY_STATUSES, REPLY_STATUS_LABEL, type ReplyStatus } from '@socio/shared/planner';
import { intentUrl } from '@socio/shared/x-post';

import { plannerCall } from './api';
import { CountRing } from './CountRing';
import type { PlannerState, ReplyItem } from './types';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

function openInX(url: string, event: MouseEvent<HTMLAnchorElement>) {
    if (openInHost(url)) {
        event.preventDefault();
    }
}

export function Replies({
    replies,
    onChange,
    onError,
}: {
    replies: ReplyItem[];
    onChange: (state: PlannerState) => void;
    onError: (message: string) => void;
}) {
    const [adding, setAdding] = useState(false);
    return (
        <div className="grid gap-3">
            {replies.length === 0 && !adding && (
                <Card>
                    <CardHeader>
                        <CardTitle>Nothing waiting on a reply</CardTitle>
                        <CardDescription>
                            Add a post worth answering. The draft stays here until you open it in X and publish it
                            yourself.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <Button type="button" onClick={() => setAdding(true)}>
                            Add a reply
                        </Button>
                    </CardContent>
                </Card>
            )}
            {replies.map((reply) => (
                <ReplyCard key={reply.id} reply={reply} onChange={onChange} onError={onError} />
            ))}
            {(adding || replies.length > 0) && <NewReply onChange={onChange} onError={onError} />}
        </div>
    );
}

function ReplyCard({
    reply,
    onChange,
    onError,
}: {
    reply: ReplyItem;
    onChange: (state: PlannerState) => void;
    onError: (message: string) => void;
}) {
    const [draft, setDraft] = useState(reply.draft);
    const [busy, setBusy] = useState(false);
    const url = intentUrl(draft, reply.sourceId);
    const save = async (status: ReplyStatus, text = draft) => {
        setBusy(true);
        try {
            onChange(
                await plannerCall<PlannerState>('PATCH', `/api/replies/${encodeURIComponent(reply.id)}`, {
                    draft: text,
                    status,
                }),
            );
        } catch (reason) {
            onError(reason instanceof Error ? reason.message : 'Could not save the reply.');
        } finally {
            setBusy(false);
        }
    };
    return (
        <Card>
            <CardHeader>
                <div className="flex items-start gap-3">
                    <div
                        className="grid size-10 shrink-0 place-items-center rounded-full bg-muted text-sm font-semibold"
                        aria-hidden="true"
                    >
                        {(reply.author || '?').slice(0, 1).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                        <CardTitle className="text-base">@{reply.author}</CardTitle>
                        <a
                            className="text-sm text-primary underline-offset-4 hover:underline"
                            href={reply.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            View source post
                        </a>
                    </div>
                </div>
                <CardAction>
                    <Badge variant={reply.status === 'todo' ? 'default' : 'outline'}>
                        {REPLY_STATUS_LABEL[reply.status]}
                    </Badge>
                </CardAction>
            </CardHeader>
            <CardContent className="grid gap-3">
                <blockquote className="border-l-2 border-border pl-3 text-sm text-muted-foreground">
                    {reply.excerpt.trim() || 'No excerpt saved for this post.'}
                </blockquote>
                <div className="grid gap-1">
                    <p className="text-xs font-medium text-muted-foreground">Why it matters</p>
                    <p className="text-sm">{reply.why.trim() || 'No note on why it matters yet.'}</p>
                </div>
                <Textarea
                    value={draft}
                    aria-label={`Draft reply to @${reply.author}`}
                    onChange={(event) => setDraft(event.target.value)}
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <CountRing text={draft} />
                    <div className="flex flex-wrap gap-2" role="group" aria-label="Reply status">
                        {REPLY_STATUSES.map((status) => (
                            <Button
                                key={status}
                                type="button"
                                size="sm"
                                variant={reply.status === status ? 'secondary' : 'outline'}
                                disabled={busy}
                                onClick={() => void save(status)}
                            >
                                {REPLY_STATUS_LABEL[status]}
                            </Button>
                        ))}
                        {draft.trim() ? (
                            <Button size="sm" asChild>
                                <a
                                    href={url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(event) => openInX(url, event)}
                                >
                                    <ExternalLink /> Open in X
                                </a>
                            </Button>
                        ) : (
                            <Button size="sm" type="button" disabled>
                                <ExternalLink /> Open in X
                            </Button>
                        )}
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}

function NewReply({
    onChange,
    onError,
}: {
    onChange: (state: PlannerState) => void;
    onError: (message: string) => void;
}) {
    const [sourceUrl, setSourceUrl] = useState('');
    const [sourceId, setSourceId] = useState('');
    const [author, setAuthor] = useState('');
    const [excerpt, setExcerpt] = useState('');
    const [why, setWhy] = useState('');
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const add = async () => {
        setBusy(true);
        try {
            onChange(
                await plannerCall<PlannerState>('POST', '/api/replies', {
                    sourceUrl,
                    sourceId,
                    author,
                    excerpt,
                    why,
                    draft,
                }),
            );
            setSourceUrl('');
            setSourceId('');
            setAuthor('');
            setExcerpt('');
            setWhy('');
            setDraft('');
        } catch (reason) {
            onError(reason instanceof Error ? reason.message : 'Could not add the reply.');
        } finally {
            setBusy(false);
        }
    };
    return (
        <Card>
            <CardHeader>
                <CardTitle>Add a reply</CardTitle>
                <CardDescription>The source post, why it is worth answering, and the draft.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
                <div className="grid gap-3 sm:grid-cols-2">
                    <label className="grid gap-1.5 text-sm font-medium">
                        Source URL
                        <Input
                            type="url"
                            value={sourceUrl}
                            placeholder="https://x.com/someone/status/1"
                            onChange={(event) => setSourceUrl(event.target.value)}
                        />
                    </label>
                    <label className="grid gap-1.5 text-sm font-medium">
                        Source post id
                        <Input value={sourceId} maxLength={40} onChange={(event) => setSourceId(event.target.value)} />
                    </label>
                    <label className="grid gap-1.5 text-sm font-medium">
                        Author
                        <Input
                            value={author}
                            maxLength={40}
                            placeholder="handle"
                            onChange={(event) => setAuthor(event.target.value)}
                        />
                    </label>
                </div>
                <label className="grid gap-1.5 text-sm font-medium">
                    Excerpt
                    <Textarea
                        value={excerpt}
                        placeholder="The part of their post you are answering"
                        onChange={(event) => setExcerpt(event.target.value)}
                    />
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                    Why it matters
                    <Textarea value={why} onChange={(event) => setWhy(event.target.value)} />
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                    Draft
                    <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
                </label>
                <CountRing text={draft} />
                <Button type="button" className="justify-self-start" disabled={busy} onClick={() => void add()}>
                    Add reply
                </Button>
            </CardContent>
        </Card>
    );
}
