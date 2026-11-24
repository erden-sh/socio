import { History, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import type { Episode, EpisodesState } from '@socio/shared/memory';

import { api } from '../../lib/api';
import { useLiveTopic } from '../../lib/change-channel';
import { LocalTime } from '../../lib/local-time';
import { SectionTitle } from '../../shell/Home';

import { ConfirmDelete } from '@/components/confirm-delete';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const day = (value: number) => new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' });
const failure = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);
const plural = (n: number, one: string) => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`;

type Confirming = { kind: 'one'; episode: Episode } | { kind: 'all' };

/**
 * The Memories page's episodes (CB-180): what the person's socios kept of
 * their own chats once those were compacted (decisions, results, what a
 * chat was about), recalled in their other chats of their own and never in
 * one with other people in it. The person searches them and deletes one or
 * all; deleting removes them at once.
 */
export function EpisodesSection({
    dotName,
    chat,
}: {
    dotName: (id: string | null) => string;
    chat: (id: string | null) => { id: string; title: string } | undefined;
}) {
    const [state, setState] = useState<EpisodesState>();
    const [query, setQuery] = useState('');
    const [confirming, setConfirming] = useState<Confirming>();
    const latest = useRef(0);
    const load = useCallback(async (words: string) => {
        const asked = ++latest.current;
        try {
            const next = await api<EpisodesState>(
                `/memories/episodes${words.trim() ? `?q=${encodeURIComponent(words.trim())}` : ''}`,
            );
            // Only the newest search's answer.
            if (asked === latest.current) {
                setState(next);
            }
        } catch (error) {
            if (asked === latest.current) {
                toast.error(failure(error, 'Could not load episodes.'));
            }
        }
    }, []);
    // As the person types, a moment after they stop.
    useEffect(() => {
        const timer = setTimeout(() => void load(query), query ? 250 : 0);
        return () => clearTimeout(timer);
    }, [query, load]);
    useLiveTopic('memories', () => load(query));

    const remove = async (path: string) => {
        try {
            await api(path, 'DELETE');
            await load(query);
        } catch (error) {
            toast.error(failure(error, 'Could not delete. Try again.'));
        }
    };

    const episodes = state?.episodes ?? [];
    const total = state?.total ?? 0;
    return (
        <section aria-labelledby="memories-episodes" data-slot="memory-episodes" className="mt-8">
            <SectionTitle id="memories-episodes">From your chats</SectionTitle>
            <p className="mb-4 max-w-160 text-xs leading-[1.7] text-muted-foreground">
                What your socios keep of your own chats once they get long: decisions, results and what each chat was
                about. They recall them in your other chats of your own, never in team chats or rooms.
                {state && ` Each is deleted after ${plural(state.retentionDays, 'day')} without coming up.`}
            </p>
            {total > 0 && (
                <div className="mb-4 flex flex-wrap items-center gap-2">
                    <div className="relative min-w-0 flex-1 basis-60">
                        <Search
                            aria-hidden
                            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                        />
                        <Input
                            type="search"
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder="Search episodes"
                            aria-label="Search episodes"
                            maxLength={300}
                            className="h-8 pl-8 text-xs md:text-xs"
                        />
                    </div>
                    <small className="text-xs text-muted-foreground">{plural(total, 'episode')}</small>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs text-muted-foreground"
                        onClick={() => setConfirming({ kind: 'all' })}
                    >
                        Delete all
                    </Button>
                </div>
            )}
            {episodes.length > 0 ? (
                <ul data-slot="episode-list" className="divide-y rounded-xl border text-[13px]">
                    {episodes.map((episode) => {
                        const thread = chat(episode.threadId);
                        return (
                            <li key={episode.id} data-episode={episode.id} className="flex items-start gap-3 px-4 py-3">
                                <History aria-hidden size={16} className="mt-0.5 shrink-0 text-slate-400" />
                                <div className="min-w-0 flex-1">
                                    <p className="leading-[1.6] break-words whitespace-pre-wrap">
                                        {episode.kind === 'summary' && (
                                            <Badge variant="secondary" className="mr-1.5 py-0 align-[1px] leading-5">
                                                What the chat was about
                                            </Badge>
                                        )}
                                        {episode.text}
                                    </p>
                                    <small className="text-xs leading-[1.6] text-muted-foreground">
                                        {thread ? (
                                            <>
                                                {'From '}
                                                <Link
                                                    className="underline underline-offset-2 hover:text-foreground"
                                                    to={`/chats/${encodeURIComponent(thread.id)}`}
                                                >
                                                    {thread.title}
                                                </Link>
                                            </>
                                        ) : (
                                            'From a chat'
                                        )}
                                        {` with ${dotName(episode.dotId)} · `}
                                        <LocalTime value={episode.occurredAt} format={day} />
                                    </small>
                                </div>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    className="size-7.25 shrink-0 text-muted-foreground"
                                    aria-label="Delete episode"
                                    title="Delete episode"
                                    onClick={() => setConfirming({ kind: 'one', episode })}
                                >
                                    <Trash2 className="size-3.75" />
                                </Button>
                            </li>
                        );
                    })}
                </ul>
            ) : (
                state && (
                    <p
                        data-slot="episodes-empty"
                        className="rounded-xl border border-dashed p-4 text-xs text-muted-foreground"
                    >
                        {total
                            ? 'No episode matches. Try other words.'
                            : 'Nothing yet. Episodes come from your own chats once they are long enough to be compacted, or when you send /compact.'}
                    </p>
                )
            )}
            {confirming?.kind === 'one' && (
                <ConfirmDelete
                    title="Delete this episode?"
                    slot="delete-episode"
                    onClose={() => setConfirming(undefined)}
                    onConfirm={async () => {
                        await remove(`/memories/episodes/${encodeURIComponent(confirming.episode.id)}`);
                        setConfirming(undefined);
                    }}
                >
                    Your socios stop recalling it at once, and it is removed from the workspace. Backups keep it until
                    they age out. The chat it came from is not changed.
                </ConfirmDelete>
            )}
            {confirming?.kind === 'all' && (
                <ConfirmDelete
                    title="Delete all your episodes?"
                    slot="delete-all-episodes"
                    action="Delete all"
                    onClose={() => setConfirming(undefined)}
                    onConfirm={async () => {
                        await remove('/memories/episodes');
                        setConfirming(undefined);
                    }}
                >
                    {`All ${plural(total, 'episode')} go at once, and your socios stop recalling them. Your chats and memories are not changed. New ones are kept as your chats go on.`}
                </ConfirmDelete>
            )}
        </section>
    );
}
