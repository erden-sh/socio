import { useCallback, useEffect, useRef, useState } from 'react';

import { useTranslation } from '@socio/i18n/react';
import {
    pageSummary,
    type Page,
    type PageCover,
    type PageLibrary,
    type PageSummary,
} from '@socio/shared/pages/page-library';
import type { Space, WorkspaceState } from '@socio/shared/types';

import { api, ApiError, apiIfChanged, PollTags, UNCHANGED } from '../../lib/api';
import { useLiveTopic } from '../../lib/change-channel';
import { useCrumbTitle } from '../../shell/crumb-title';
import { MissingPage } from '../pages/MissingPage';
import { LibraryEmpty } from '../pages/page-chrome';
import { notifyPagesChanged, reportPageFolder } from '../pages/page-events';
import { mergePageSnapshot } from '../pages/page-snapshots';
import { PageDocument } from '../pages/PageDocument';
import { PageOutline } from '../pages/PageOutline';

import { SpaceTabs } from './space-tabs';
import { SpaceLibrary } from './SpaceLibrary';
import { SpaceMemory } from './SpaceMemory';
import { SpaceRadar } from './SpaceRadar';
import { SpaceSettings } from './SpaceSettings';

import { cn } from '@/lib/utils';

export function SpaceWorkspace({
    space,
    library,
    pageId,
    memory = false,
    radar = false,
    settings = false,
    workspace,
    paused,
    onPage,
    onMoved,
    onDirty,
    onRefresh,
    onSchedule,
    onThread,
    onSettings,
    onCreateDot,
}: {
    space: Space;
    /**
     * The library's first screen from the page's loader: shown until the
     * first poll brings every page's summary. It never joins the polled
     * list (it is only part of it).
     */
    library?: PageLibrary;
    pageId?: string;
    /** The Space's Memory tab (CB-181) instead of its pages. */
    memory?: boolean;
    /** The Space's change radar (CB-282) instead of its pages. */
    radar?: boolean;
    /** The Space's Settings tab (CB-181): who sees it, and its people. */
    settings?: boolean;
    workspace: WorkspaceState;
    paused: boolean;
    onPage: (id?: string) => void;
    /** Opens a page that moved to another Space (CB-142). */
    onMoved: (spaceId: string, pageId: string) => void;
    onDirty: (value: boolean) => void;
    onRefresh: () => void;
    onSchedule: (threadId: string) => void;
    onThread: (threadId: string) => void;
    onSettings: () => void;
    onCreateDot: () => void;
}) {
    const { t } = useTranslation(['spaces', 'spaces.nav']);
    // Every page without its body (CB-71); the open page's body is `open`.
    const [pages, setPages] = useState<PageSummary[]>([]);
    const [open, setOpen] = useState<Page>();
    const [error, setError] = useState('');
    const [loaded, setLoaded] = useState(false);
    const [seed, setSeed] = useState(library);
    const seeded = loaded ? undefined : seed;
    const [outline, setOutline] = useState(false);
    // Polls in order: `polls` numbers them, `created` holds the poll number
    // current when this view created a page (polls from before it may lack
    // it), `deleted` the pages deleted here (polls in flight may still have
    // them).
    const polls = useRef({ started: 0, applied: 0 });
    const created = useRef(new Map<string, number>());
    const deleted = useRef(new Set<string>());
    // The poll's load, for another tab's note on this Space's pages.
    const reload = useRef<() => Promise<void>>(undefined);
    useLiveTopic(`space:${space.id}`, () => reload.current?.());
    useEffect(() => {
        let active = true;
        // The list's tag: a poll with no change is a 304 (api.ts).
        const tags = new PollTags();
        const path = `/spaces/${space.id}/pages`;
        const load = async () => {
            const poll = ++polls.current.started;
            try {
                const answer = await apiIfChanged<PageSummary[]>(path, tags.get(path));
                if (answer === UNCHANGED) {
                    if (active) {
                        setError('');
                    }
                    return;
                }
                const next = answer.data;
                if (active && poll > polls.current.applied) {
                    polls.current.applied = poll;
                    tags.set(path, answer.tag);
                    const fresh = new Set([...created.current].filter(([, since]) => since >= poll).map(([id]) => id));
                    setPages((previous) =>
                        mergePageSnapshot(previous, next, {
                            fresh,
                            deleted: deleted.current,
                        }),
                    );
                    setLoaded(true);
                    setError('');
                }
            } catch (e) {
                if (active) {
                    setError(e instanceof Error ? e.message : t('spaces:workspace.errors.load-pages'));
                }
            }
        };
        void load();
        reload.current = load;
        const timer = setInterval(() => void load(), 3000);
        return () => {
            active = false;
            if (reload.current === load) {
                reload.current = undefined;
            }
            clearInterval(timer);
        };
    }, [space.id, t]);
    // The open page with its body: read when it opens, and again when the
    // list shows a newer revision (someone else saved it). A failed read is
    // tried again 3 s later; a page that is gone (404, or 410 deleted)
    // leaves the list, and the view says so.
    const listed = pages.find((item) => item.id === pageId);
    const body = open?.id === pageId ? open : undefined;
    const stale = !!pageId && (!body || (listed?.revision ?? 0) > body.revision);
    const [retry, setRetry] = useState(0);
    useEffect(() => {
        if (!pageId || !stale) {
            return;
        }
        let active = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        api<Page>(`/spaces/${space.id}/pages/${pageId}`).then(
            (next) => {
                if (active) {
                    setOpen((current) => newer(current, next));
                }
            },
            (e: unknown) => {
                if (!active) {
                    return;
                }
                if (e instanceof ApiError && (e.status === 404 || e.status === 410)) {
                    return;
                }
                setError(e instanceof Error ? e.message : t('spaces:workspace.errors.load-page'));
                timer = setTimeout(() => setRetry((count) => count + 1), 3000);
            },
        );
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [space.id, pageId, stale, listed?.revision, retry, t]);
    // Shown once its body is here, unless the list says it is gone.
    const page = body && (listed || !loaded) ? body : undefined;
    // Whether the page shown is a folder, for the Ask panel (CB-426): as read, saved or switched.
    useEffect(() => {
        if (page) {
            reportPageFolder(page);
        }
    }, [page]);
    useEffect(() => {
        if (listed) {
            reportPageFolder(listed);
        }
    }, [listed]);
    const waiting = listed ?? seeded?.pages.find((item) => item.id === pageId);
    const saved = useCallback((next: Page) => {
        setOpen((current) => newer(current, next));
        setPages((previous) =>
            previous.map((item) => (item.id === next.id && item.revision < next.revision ? pageSummary(next) : item)),
        );
    }, []);
    // A cover set or removed here (CB-308): not a revision of the text, so
    // the list and the open page take it as it is; `updatedAt` (the
    // server's, when it sent the page) keeps an older poll from undoing it.
    const covered = useCallback((id: string, cover: PageCover | null, next?: Page) => {
        const updatedAt = next?.updatedAt;
        setPages((previous) =>
            previous.map((item) =>
                item.id === id ? { ...item, cover, updatedAt: Math.max(item.updatedAt, updatedAt ?? 0) } : item,
            ),
        );
        setSeed(
            (current) =>
                current && {
                    ...current,
                    pages: current.pages.map((item) => (item.id === id ? { ...item, cover } : item)),
                },
        );
        setOpen((current) => (current?.id === id ? { ...current, cover } : current));
    }, []);
    // Turned into a folder or back into a page here (CB-426): a new revision of the page with the
    // same title and body, so the list and the open page take it as a save's answer, and the
    // sidebar hears of it at once.
    const foldered = useCallback(
        (next: Page) => {
            saved(next);
            setSeed(
                (current) =>
                    current && {
                        ...current,
                        pages: current.pages.map((item) => (item.id === next.id ? pageSummary(next) : item)),
                    },
            );
            notifyPagesChanged(space.id);
        },
        [saved, space.id],
    );
    /** Makes a page, or a folder named `title` (CB-426), under `parentId`. */
    const make = async (parentId: string | null, folder?: { title: string }) => {
        const next = await api<Page>(`/spaces/${space.id}/pages`, 'POST', {
            title: folder?.title ?? t('spaces.nav:untitled-page'),
            content: '',
            parentId,
            ...(folder ? { folder: true } : {}),
        });
        created.current.set(next.id, polls.current.started);
        setPages((previous) => [...previous, pageSummary(next)]);
        setSeed(
            (current) =>
                current && { ...current, pages: [...current.pages, pageSummary(next)], total: current.total + 1 },
        );
        notifyPagesChanged(space.id);
        return next;
    };
    const create = async (parentId: string | null) => {
        try {
            const next = await make(parentId);
            setOpen(next);
            onPage(next.id);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('spaces:workspace.errors.create-page'));
        }
    };
    // A new folder stays where the person is: it shows among the pages there (its dialog says
    // why one was refused).
    const createFolder = (parentId: string | null, title: string) => make(parentId, { title });
    // After a delete: drop the pages here, refresh the sidebar, and leave a
    // deleted page for the Space's library (no unsaved-draft prompt: the
    // draft went with the page).
    const removed = (ids: string[]) => {
        for (const id of ids) {
            deleted.current.add(id);
        }
        setPages((previous) => previous.filter((item) => !ids.includes(item.id)));
        setSeed(
            (current) =>
                current && {
                    ...current,
                    pages: current.pages.filter((item) => !ids.includes(item.id)),
                    total: Math.max(0, current.total - ids.length),
                },
        );
        notifyPagesChanged(space.id);
        if (pageId && ids.includes(pageId)) {
            onDirty(false);
            onPage();
        }
    };
    // After a move to another Space: the pages leave this one (as after a
    // delete, without the "deleted" note), both Spaces' lists reload, and
    // the page opens where it is now.
    const moved = (next: Page, ids: string[]) => {
        setPages((previous) => previous.filter((item) => !ids.includes(item.id)));
        setSeed(
            (current) =>
                current && {
                    ...current,
                    pages: current.pages.filter((item) => !ids.includes(item.id)),
                    total: Math.max(0, current.total - ids.length),
                },
        );
        notifyPagesChanged(space.id);
        notifyPagesChanged(next.spaceId);
        onDirty(false);
        onMoved(next.spaceId, next.id);
    };
    return (
        // No data-slot on the frames around a page (page-chrome.tsx).
        <main
            aria-label={t('spaces:workspace.label')}
            className={cn(
                'flex min-h-0 flex-[1_1_auto] flex-col bg-card text-foreground',
                (!pageId || memory || radar || settings) && 'overflow-auto',
            )}
        >
            {error && (
                <div
                    role="alert"
                    data-slot="spaces-error"
                    className="bg-destructive/10 px-6 py-2.5 text-xs text-destructive"
                >
                    {error}
                </div>
            )}
            {memory ? (
                <SpaceMemory space={space} />
            ) : radar ? (
                <SpaceRadar space={space} />
            ) : settings ? (
                <SpaceSettings space={space} />
            ) : !pageId ? (
                <SpaceLibrary
                    space={space}
                    pages={seeded?.pages ?? pages}
                    total={seeded?.total}
                    // The first screen says for the whole Space; every page's summary, once polled.
                    hasCovers={seeded ? seeded.hasCovers : pages.some((item) => item.cover)}
                    onPage={onPage}
                    onNew={(parentId) => void create(parentId)}
                    onNewFolder={createFolder}
                    onDeleted={removed}
                    tabs={<SpaceTabs space={space} />}
                />
            ) : page ? (
                <div className="relative flex min-h-0 flex-1">
                    {outline && (
                        <PageOutline
                            pages={pages}
                            selected={page.id}
                            onPage={(id) => {
                                onPage(id);
                                if (window.innerWidth < 760) {
                                    setOutline(false);
                                }
                            }}
                            onNew={() => void create(null)}
                            onClose={() => setOutline(false)}
                        />
                    )}
                    <PageDocument
                        key={page.id}
                        page={page}
                        cover={listed ? listed.cover : page.cover}
                        pages={pages}
                        workspace={workspace}
                        paused={paused}
                        onHome={() => onPage()}
                        onOutline={() => setOutline(!outline)}
                        onSubpage={() => void create(page.id)}
                        onNewFolder={(title) => createFolder(page.id, title)}
                        onFolder={foldered}
                        onDeleted={removed}
                        onMoved={moved}
                        onDirty={onDirty}
                        onSaved={saved}
                        onCover={(cover, next) => covered(page.id, cover, next)}
                        onRefresh={onRefresh}
                        onSchedule={onSchedule}
                        onThread={onThread}
                        onSettings={onSettings}
                        onCreateDot={onCreateDot}
                    />
                </div>
            ) : waiting ? (
                <PageLoading pageId={pageId} title={waiting.title} />
            ) : (
                <MissingPage
                    key={pageId}
                    spaceId={space.id}
                    pageId={pageId}
                    loaded={loaded}
                    deleted={deleted.current.has(pageId)}
                    onHome={() => onPage()}
                    onMoved={onMoved}
                />
            )}
        </main>
    );
}

/** The newer of two copies of a page (the second when the first is another page). */
const newer = (current: Page | undefined, next: Page) =>
    current?.id === next.id && current.revision >= next.revision ? current : next;

/**
 * A listed page before its body is here: its title in the header, and
 * the page's usual loading line.
 */
function PageLoading({ pageId, title }: { pageId: string; title: string }) {
    const { t } = useTranslation(['spaces']);
    useCrumbTitle(pageId, title);
    return <LibraryEmpty title={t('spaces:workspace.loading-page')} />;
}
