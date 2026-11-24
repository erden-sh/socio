import { BookOpen, Check, MoreHorizontal, Plus, Sparkles, Trash2, UserRound } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import { PROFILE_FIELDS, PROFILE_LABELS, type MemoriesState, type MemoryItem } from '@socio/shared/memory';
import { MODULE_IDS } from '@socio/shared/modules';
import { movedTimeZoneText } from '@socio/shared/time-zone';

import { api, apiIfChanged, PollTags, UNCHANGED } from '../../lib/api';
import { useLiveTopic } from '../../lib/change-channel';
import { LocalTime } from '../../lib/local-time';
import { useLoaderSeed } from '../../lib/page-loader';
import { Mascot } from '../../locals/Mascot';
import { SectionTitle } from '../../shell/Home';
import { useShell } from '../../shell/shell-context';
import { WorkspacePage } from '../../views/WorkspacePage';

import { EpisodesSection } from './EpisodesSection';
import { MemoryEditor, ProfileEditor } from './MemoryDialogs';

import { ConfirmDelete } from '@/components/confirm-delete';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/** "Oct 12, 2026", in the reader's words once hydrated. */
const day = (value: number) => new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' });
const EMPTY: MemoriesState = { profile: null, memories: [], proposals: [] };
const failure = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

type Editing =
    | { kind: 'memory'; memory?: MemoryItem }
    | { kind: 'profile' }
    | { kind: 'forget'; memory: MemoryItem }
    | { kind: 'clear-profile' };

const ghost = 'size-7.25 text-muted-foreground';

/**
 * `/memories` (CB-106): what the person's socios know about them. Their
 * profile, the proposals their socios made (used only once approved) and
 * the memories in use, each with where it came from, when it was last
 * confirmed and whether team chats get it. Only theirs: the API serves
 * each person their own.
 */
export function MemoriesPage({ initial }: { initial?: MemoriesState } = {}) {
    const shell = useShell();
    const { workspace, state: shellState } = shell;
    const [state, setState] = useState<MemoriesState | undefined>(initial);
    const [editing, setEditing] = useState<Editing>();
    const seeded = useRef(!!initial);
    const [tags] = useState(() => new PollTags());
    useLoaderSeed(initial, (next) => {
        tags.forget();
        setState(next);
    });
    const load = useCallback(
        () =>
            apiIfChanged<MemoriesState>('/memories', tags.get('/memories'))
                .then((answer) => {
                    if (answer === UNCHANGED) {
                        return;
                    }
                    setState(answer.data);
                    tags.set('/memories', answer.tag);
                })
                .catch((error: unknown) => toast.error(failure(error, 'Could not load memories.'))),
        [tags],
    );
    // A socio's proposal arrives from the server: a poll finds it.
    useEffect(() => {
        if (seeded.current) {
            seeded.current = false;
        } else {
            void load();
        }
        const timer = setInterval(() => void load(), 15_000);
        return () => clearInterval(timer);
    }, [load]);
    useLiveTopic('memories', load);
    // A memory added from the palette (the shell's dialog).
    const shellMemories = shellState.memories;
    const firstShell = useRef(shellMemories);
    useEffect(() => {
        if (shellMemories !== firstShell.current) {
            void load();
        }
    }, [shellMemories, load]);

    /** Runs a write, then reloads; resolves to an error to show, if any. */
    const write = async (path: string, method: string, body: unknown = {}) => {
        try {
            await api(path, method, body);
            await load();
            return undefined;
        } catch (error) {
            return failure(error, 'Could not save. Try again.');
        }
    };
    const act = async (path: string, method: string) => {
        const failed = await write(path, method);
        if (failed) {
            toast.error(failed);
        }
    };
    const dotName = (id: string | null) => workspace.dots.find((dot) => dot.id === id)?.name ?? 'A socio';
    const chat = (id: string | null) =>
        id ? [...workspace.conversations, ...(workspace.archived ?? [])].find((thread) => thread.id === id) : undefined;
    const { profile, memories, proposals, timeZoneMoved } = state ?? EMPTY;
    const allowed = shellState.settings.memoryAllowed;
    // A detected time zone that followed the browser (CB-176): its note is
    // shown this once, for as long as the page is open.
    const [movedNote, setMovedNote] = useState<string>();
    useEffect(() => {
        if (!timeZoneMoved) {
            return;
        }
        setMovedNote(timeZoneMoved);
        void api('/memories/time-zone-note/seen', 'POST', {
            zone: timeZoneMoved,
        }).catch(() => undefined);
    }, [timeZoneMoved]);

    const origin = (memory: MemoryItem) => {
        // Asked of a socio in a chat (CB-172), it is the person's own too.
        const asked = memory.source === 'person' && !!memory.dotId;
        if (memory.source === 'person' && !asked) {
            return 'Added by you';
        }
        const thread = chat(memory.threadId);
        return (
            <>
                {asked ? `You asked ${dotName(memory.dotId)} to remember it` : `Proposed by ${dotName(memory.dotId)}`}
                {thread && (
                    <>
                        {' in '}
                        <Link
                            className="underline underline-offset-2 hover:text-foreground"
                            to={`/chats/${encodeURIComponent(thread.id)}`}
                        >
                            {thread.title}
                        </Link>
                    </>
                )}
                {memory.source === 'notes' && ', from the chat’s notes'}
            </>
        );
    };

    return (
        <WorkspacePage
            slot="memories-page"
            module={MODULE_IDS.memories}
            title="Memories"
            actions={
                <Button size="sm" onClick={() => setEditing({ kind: 'memory' })}>
                    <Plus />
                    Add memory
                </Button>
            }
            description="What your socios know about you, in every chat with them: your profile and the memories you approve. Only you see them."
        >
            {!allowed && (
                <p
                    data-slot="memories-off"
                    className="mb-5 rounded-xl border border-dashed p-4 text-xs text-muted-foreground"
                >
                    An admin turned memory off for the workspace: socios don’t use these for now.
                </p>
            )}

            <section aria-labelledby="memories-profile" className="mb-8">
                <SectionTitle id="memories-profile">About you</SectionTitle>
                <Card data-slot="memory-profile" className="gap-0 rounded-xl p-5.5 shadow-none">
                    <UserRound size={18} className="text-slate-400" />
                    {movedNote && (
                        <p
                            role="status"
                            data-slot="time-zone-moved"
                            className="mt-4 -mb-2 text-xs leading-[1.6] text-muted-foreground"
                        >
                            {movedTimeZoneText(movedNote)}
                        </p>
                    )}
                    {profile ? (
                        <dl className="mt-4 mb-5 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-[13px] leading-[1.6] max-[700px]:grid-cols-1 max-[700px]:gap-y-0.5">
                            {PROFILE_FIELDS.filter((name) => profile.fields[name]).map((name) => (
                                <div key={name} className="contents">
                                    <dt className="text-xs text-muted-foreground max-[700px]:mt-2">
                                        {PROFILE_LABELS[name]}
                                    </dt>
                                    <dd className="whitespace-pre-wrap">
                                        {profile.fields[name]}
                                        {name === 'timezone' && profile.timezoneDetected && (
                                            <span
                                                className="text-muted-foreground"
                                                data-slot="profile-timezone-detected"
                                            >
                                                {' · detected from your browser'}
                                            </span>
                                        )}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    ) : (
                        <p className="mt-4 mb-5 text-[13px] leading-[1.7] text-muted-foreground">
                            How to address you, your role, and how you like answers: written once, used in every chat.
                        </p>
                    )}
                    <div className="flex flex-wrap items-center gap-0.75">
                        <small className="mr-auto text-xs text-muted-foreground">
                            {profile ? (
                                <>
                                    {profile.shareable ? 'Your chats and team chats' : 'Your chats only'}
                                    {' · Updated '}
                                    <LocalTime value={profile.updatedAt} format={day} />
                                </>
                            ) : (
                                'Not filled in'
                            )}
                        </small>
                        {profile && (
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                className={ghost}
                                aria-label="Clear profile"
                                onClick={() => setEditing({ kind: 'clear-profile' })}
                            >
                                <Trash2 className="size-3.75" />
                            </Button>
                        )}
                        <Button
                            variant="outline"
                            size="sm"
                            className="text-xs"
                            onClick={() => setEditing({ kind: 'profile' })}
                        >
                            {profile ? 'Edit profile' : 'Add profile'}
                        </Button>
                    </div>
                </Card>
            </section>

            {proposals.length > 0 && (
                <section aria-labelledby="memories-proposals" className="mb-8">
                    <SectionTitle id="memories-proposals">Waiting for you</SectionTitle>
                    <div data-slot="memory-proposals" className="grid grid-cols-2 gap-4 max-[920px]:grid-cols-1">
                        {proposals.map((memory) => (
                            <Card
                                role="article"
                                key={memory.id}
                                data-proposal={memory.id}
                                className="gap-0 rounded-xl border-dashed p-5.5 shadow-none"
                            >
                                <Sparkles size={18} className="text-slate-400" />
                                <p className="mt-4 mb-2 text-[13px] leading-[1.7] whitespace-pre-wrap">{memory.text}</p>
                                <small className="mb-4.5 text-xs leading-[1.6] text-muted-foreground">
                                    {origin(memory)}
                                    {' · '}
                                    <LocalTime value={memory.createdAt} format={day} />
                                </small>
                                <div className="flex flex-wrap items-center gap-1.5">
                                    <Button
                                        size="sm"
                                        className="text-xs"
                                        onClick={() =>
                                            void act(`/memories/${encodeURIComponent(memory.id)}/approve`, 'POST')
                                        }
                                    >
                                        <Check className="size-3.5" />
                                        Remember
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="text-xs"
                                        onClick={() => setEditing({ kind: 'memory', memory })}
                                    >
                                        Edit
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="text-xs text-muted-foreground"
                                        onClick={() => void act(`/memories/${encodeURIComponent(memory.id)}`, 'DELETE')}
                                    >
                                        Not now
                                    </Button>
                                </div>
                            </Card>
                        ))}
                    </div>
                </section>
            )}

            {memories.length > 0 && (
                <section aria-labelledby="memories-kept">
                    <SectionTitle id="memories-kept">Remembered</SectionTitle>
                    <div data-slot="memory-list" className="grid grid-cols-2 gap-4 max-[920px]:grid-cols-1">
                        {memories.map((memory) => (
                            <Card
                                role="article"
                                key={memory.id}
                                data-memory={memory.id}
                                className="gap-0 rounded-xl p-5.5 shadow-none"
                            >
                                <div className="flex h-4.5 items-center justify-between gap-2">
                                    <BookOpen size={18} className="text-slate-400" />
                                    {memory.shareable && (
                                        <Badge variant="secondary" className="py-0 leading-5">
                                            Team chats too
                                        </Badge>
                                    )}
                                </div>
                                <p className="mt-4 mb-2 text-[13px] leading-[1.7] whitespace-pre-wrap">{memory.text}</p>
                                <small className="mb-4 text-xs leading-[1.6] text-muted-foreground">
                                    {origin(memory)}
                                </small>
                                <div className="flex items-center gap-0.75">
                                    <small className="mr-auto text-xs text-muted-foreground">
                                        {'Confirmed '}
                                        <LocalTime value={memory.confirmedAt ?? memory.updatedAt} format={day} />
                                    </small>
                                    <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        className={ghost}
                                        aria-label="Still true"
                                        title="Still true"
                                        onClick={() =>
                                            void act(`/memories/${encodeURIComponent(memory.id)}/confirm`, 'POST')
                                        }
                                    >
                                        <Check className="size-4" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        className={ghost}
                                        aria-label="Edit memory"
                                        onClick={() => setEditing({ kind: 'memory', memory })}
                                    >
                                        <MoreHorizontal className="size-4.25" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        className={ghost}
                                        aria-label="Forget memory"
                                        onClick={() => setEditing({ kind: 'forget', memory })}
                                    >
                                        <Trash2 className="size-3.75" />
                                    </Button>
                                </div>
                            </Card>
                        ))}
                    </div>
                </section>
            )}
            {state && !memories.length && !proposals.length && (
                <div data-slot="memories-empty" className="mx-auto my-15 max-w-110 text-center max-[700px]:mt-7.5">
                    <Mascot className="size-35 opacity-85" />
                    <h2 className="mb-4.5 text-[22px] font-semibold tracking-tight">
                        A little context goes a long way.
                    </h2>
                    <p className="text-xs leading-[1.9] text-muted-foreground">
                        Add a preference like “Keep my research briefs short,” or say “remember that” in a chat and
                        approve it here. You can change or forget it anytime.
                    </p>
                </div>
            )}

            <EpisodesSection dotName={dotName} chat={chat} />

            {editing?.kind === 'memory' && (
                <MemoryEditor
                    memory={editing.memory}
                    onClose={() => setEditing(undefined)}
                    onSave={(body) =>
                        editing.memory
                            ? write(`/memories/${encodeURIComponent(editing.memory.id)}`, 'PUT', body)
                            : write('/memories', 'POST', body)
                    }
                />
            )}
            {editing?.kind === 'profile' && (
                <ProfileEditor
                    profile={profile}
                    onClose={() => setEditing(undefined)}
                    onSave={(body) => write('/memories/profile', 'PUT', body)}
                />
            )}
            {editing?.kind === 'forget' && (
                <ConfirmDelete
                    title="Forget this memory?"
                    slot="forget-memory"
                    action="Forget"
                    onClose={() => setEditing(undefined)}
                    onConfirm={async () => {
                        await act(`/memories/${encodeURIComponent(editing.memory.id)}`, 'DELETE');
                        setEditing(undefined);
                    }}
                >
                    Your socios stop using it in every chat at once. It stays in the workspace’s records and backups, as
                    anything deleted does.
                </ConfirmDelete>
            )}
            {editing?.kind === 'clear-profile' && (
                <ConfirmDelete
                    title="Clear your profile?"
                    slot="clear-profile"
                    action="Clear"
                    onClose={() => setEditing(undefined)}
                    onConfirm={async () => {
                        await act('/memories/profile', 'DELETE');
                        setEditing(undefined);
                    }}
                >
                    Your socios stop using it in every chat at once. Earlier versions stay in the workspace’s records
                    and backups.
                </ConfirmDelete>
            )}
        </WorkspacePage>
    );
}
