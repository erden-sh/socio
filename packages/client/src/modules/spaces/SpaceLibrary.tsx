import { FileText, Plus, Search, LayoutGrid, List, ArrowUpRight, Trash2 } from 'lucide-react';
import { useContext, useMemo, useState, type ReactNode } from 'react';

import { compareText, lowerText } from '@socio/shared/locale';
import { MODULE_IDS } from '@socio/shared/modules';
import { pageHierarchy } from '@socio/shared/pages/page-hierarchy';
import { pageExcerpt, type PageCover, type PageSummary } from '@socio/shared/pages/page-library';
import {
    foldText,
    freshnessLabel,
    PAGE_SEARCH_MAX_LIMIT,
    PAGE_SEARCH_MIN_CHARS,
    type PageSearchResult,
} from '@socio/shared/pages/page-search';
import { isAdmin } from '@socio/shared/roles';
import type { Space } from '@socio/shared/types';

import { useSearchAsYouType } from '../../hooks/use-search-as-you-type';
import { api } from '../../lib/api';
import { LocalTime } from '../../lib/local-time';
import { CurrentUser } from '../../shell/current-user';
import { useFlag } from '../../shell/flags';
import { Snippet } from '../../shell/Snippet';
import { toneTile } from '../../shell/tones';
import { PageHeader } from '../../views/WorkspacePage';
import { useModules } from '../context';
import { canDeletePage, DeletePageDialog } from '../pages/DeletePageDialog';
import { LibraryEmpty, PagePrimaryButton } from '../pages/page-chrome';

import { notePageUse } from './page-commands';
import { SpaceDatasetActions } from './PlaceDatasetDialog';
import { spaceTitle } from './space-tabs';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

export { pageExcerpt };
const editedDate = (value: number) =>
    new Date(value).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
    });
const editedTime = (value: number) => new Date(value).toLocaleString();
/**
 * A Space's pages. `total` is how many it has while `pages` is only the
 * first screen (from the page's loader, before its first poll).
 */
export function SpaceLibrary({
    space,
    pages,
    total,
    hasCovers = false,
    onPage,
    onNew,
    onDeleted,
    tabs,
}: {
    space: Space;
    pages: PageSummary[];
    /**
     * Whether any page of the Space has a cover (CB-308): then every card
     * of the grid gets a band, its cover or the page tile.
     */
    hasCovers?: boolean;
    /** The Space's Pages, Memory and Settings tabs (CB-181), under its heading. */
    tabs?: ReactNode;
    total?: number;
    onPage: (id: string) => void;
    onNew: () => void;
    onDeleted: (ids: string[]) => void;
}) {
    const user = useContext(CurrentUser);
    const datasets = useFlag('datasets-in-spaces');
    const hierarchy = useMemo(() => pageHierarchy(pages, space.id), [pages, space.id]);
    // The page whose Delete was chosen, while its confirm dialog is open.
    const [deleting, setDeleting] = useState<PageSummary>();
    const [query, setQuery] = useState('');
    const [layout, setLayout] = useState<Layout>('grid');
    const [sort, setSort] = useState('recent');
    const filtered = useMemo(
        () =>
            pages
                .filter((page) => page.spaceId === space.id)
                .filter((page) => lowerText(`${page.title} ${page.excerpt}`).includes(lowerText(query)))
                .sort((a, b) =>
                    sort === 'name'
                        ? compareText(a.title, b.title)
                        : b.updatedAt - a.updatedAt || compareText(a.title, b.title),
                ),
        [pages, query, sort, space.id],
    );
    // Two or more characters: the server's search over titles and text, as
    // the user types.
    const [exact, setExact] = useState(false);
    const folded = foldText(query);
    const searching = folded.replaceAll(' ', '').length >= PAGE_SEARCH_MIN_CHARS;
    const remote = useSearchAsYouType<PageSearchResult>(
        searching ? `${exact ? 'exact' : 'any'}:${space.id}:${folded}` : null,
        (signal) =>
            api<PageSearchResult>(
                `/spaces/search?${new URLSearchParams({
                    q: query,
                    space: space.id,
                    limit: String(PAGE_SEARCH_MAX_LIMIT),
                    ...(exact ? { exact: 'true' } : {}),
                })}`,
                'GET',
                undefined,
                signal,
            ),
    );
    const hits = searching ? (remote.answer?.results ?? []) : [];
    const count = searching ? hits.length : query || total === undefined ? filtered.length : total;
    // The band's tile is the Spaces module's, in its tone.
    const tone = useModules().find((item) => item.id === MODULE_IDS.spaces)?.tone ?? 'sky';
    const card = (
        page: Pick<PageSummary, 'id' | 'title'>,
        body: ReactNode,
        meta: ReactNode,
        onOpen: () => void,
        deletable: PageSummary | undefined,
    ) => (
        <LibraryCard
            key={page.id}
            layout={layout}
            band={
                hasCovers && layout === 'grid' ? (
                    <CardBand cover={pages.find((item) => item.id === page.id)?.cover ?? null} tile={toneTile[tone]} />
                ) : undefined
            }
            title={page.title}
            body={body}
            meta={meta}
            onOpen={onOpen}
            onDelete={deletable && (() => setDeleting(deletable))}
        />
    );
    return (
        <section
            data-slot="space-library"
            data-tour="space-library"
            className="w-full pb-8"
            aria-label={`${space.name} page library`}
        >
            <PageHeader
                module={MODULE_IDS.spaces}
                title={spaceTitle(space)}
                actions={
                    <>
                        {/* Its editors place datasets in it (CB-451); the server checks the role. */}
                        {datasets && space.access === 'editor' && (
                            <SpaceDatasetActions space={space} admin={!!user && isAdmin(user)} />
                        )}
                        <Button size="sm" onClick={onNew} data-tour="new-page">
                            <Plus /> New page
                        </Button>
                    </>
                }
            >
                {space.description}
            </PageHeader>
            {tabs}
            <div className="px-4 pt-3 md:px-6">
                <div className="mb-6 flex items-center gap-2 max-[900px]:flex-wrap">
                    <label className="flex min-h-9 flex-1 items-center gap-2 rounded-lg bg-muted px-3 text-muted-foreground focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring max-[900px]:basis-full">
                        <Search className="size-4 shrink-0" />
                        <Input
                            aria-label="Search pages"
                            placeholder="Search pages"
                            className="h-auto min-w-0 rounded-none border-0 bg-transparent px-0 py-2 text-base text-foreground shadow-none placeholder:text-muted-foreground focus-visible:ring-0 md:text-sm dark:bg-transparent"
                            value={query}
                            onChange={(e) => {
                                setQuery(e.target.value);
                                setExact(false);
                            }}
                        />
                    </label>
                    <Select value={sort} onValueChange={setSort}>
                        <SelectTrigger
                            aria-label="Sort pages"
                            className="h-8 gap-2 rounded-lg border-0 bg-transparent px-3 text-sm font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground max-[900px]:flex-1 pointer-coarse:text-base dark:bg-transparent dark:hover:bg-accent [&_svg:not([class*='text-'])]:text-current"
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper" align="end">
                            <SelectItem value="recent">Recently edited</SelectItem>
                            <SelectItem value="name">Name A–Z</SelectItem>
                        </SelectContent>
                    </Select>
                    <div className="flex rounded-[9px] border p-[3px]" role="group" aria-label="Library view">
                        {(
                            [
                                ['grid', 'Grid view', <LayoutGrid key="grid" />],
                                ['list', 'List view', <List key="list" className="size-4.5" />],
                            ] as const
                        ).map(([value, label, icon]) => (
                            <Button
                                key={value}
                                variant="ghost"
                                aria-label={label}
                                aria-pressed={layout === value}
                                className="size-8.5 rounded-md p-0 text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground max-[700px]:size-10 [&_svg:not([class*='size-'])]:size-[17px]"
                                onClick={() => setLayout(value)}
                            >
                                {icon}
                            </Button>
                        ))}
                    </div>
                </div>
                <h2
                    className="m-0 mb-3 flex items-baseline gap-2 text-sm font-medium text-muted-foreground"
                    data-slot="library-count"
                >
                    {query ? 'Search results' : 'All pages'}
                    <span
                        className="font-mono text-xs text-muted-foreground/80 tabular-nums"
                        aria-label={`${count}${searching && remote.answer?.more ? ' or more' : ''} ${count === 1 ? 'page' : 'pages'}`}
                    >
                        {count}
                        {searching && remote.answer?.more ? '+' : ''}
                    </span>
                </h2>
                {searching && remote.answer?.corrected && (
                    <p className="-mt-2 mb-4 text-xs opacity-80" data-slot="library-correction">
                        Showing results for <strong>{remote.answer.corrected}</strong>.{' '}
                        <button
                            type="button"
                            data-slot="library-search-instead"
                            className="underline underline-offset-2"
                            onClick={() => setExact(true)}
                        >
                            Search instead for {query.trim()}
                        </button>
                    </p>
                )}
                {searching ? (
                    hits.length ? (
                        <LibraryPages layout={layout}>
                            {hits.map((hit) => {
                                const page = pages.find((item) => item.id === hit.id);
                                return card(
                                    hit,
                                    <span data-slot="library-snippet">
                                        {hit.snippet.length ? (
                                            <Snippet parts={hit.snippet} />
                                        ) : (
                                            'An empty page, ready to write.'
                                        )}
                                    </span>,
                                    <span data-slot="library-freshness" className="font-mono">
                                        {freshnessLabel(hit.freshness)}
                                    </span>,
                                    () => {
                                        notePageUse(space.id, hit.id);
                                        onPage(hit.id);
                                    },
                                    page && canDeletePage(user, page) ? page : undefined,
                                );
                            })}
                        </LibraryPages>
                    ) : (
                        <LibraryEmpty
                            icon={<Search size={30} strokeWidth={1.3} />}
                            title={remote.pending ? 'Searching pages…' : 'No matching pages'}
                        >
                            {!remote.pending && 'Try a different title or phrase.'}
                        </LibraryEmpty>
                    )
                ) : filtered.length ? (
                    <LibraryPages layout={layout}>
                        {filtered.map((page) =>
                            card(
                                page,
                                page.excerpt || 'An empty page, ready to write.',
                                <>
                                    <span className="font-mono tabular-nums">
                                        Edited{' '}
                                        <LocalTime value={page.updatedAt} format={editedDate} title={editedTime} />
                                    </span>
                                    {hierarchy.ancestors(page).length > 0 && (
                                        <span className="min-w-0 [overflow-wrap:anywhere]" aria-label="Parent pages">
                                            {hierarchy
                                                .ancestors(page)
                                                .map((parent) => parent.title.trim() || 'Untitled page')
                                                .join(' › ')}
                                        </span>
                                    )}
                                </>,
                                () => onPage(page.id),
                                canDeletePage(user, page) ? page : undefined,
                            ),
                        )}
                    </LibraryPages>
                ) : (
                    <LibraryEmpty
                        icon={<FileText size={30} strokeWidth={1.3} />}
                        title={query ? 'No matching pages' : 'No pages yet'}
                        action={
                            !query && (
                                <PagePrimaryButton onClick={onNew}>
                                    <Plus className="size-4" /> New page
                                </PagePrimaryButton>
                            )
                        }
                    >
                        {query
                            ? 'Try a different title or phrase.'
                            : 'Create your first page to start organizing this Space.'}
                    </LibraryEmpty>
                )}
                {deleting && (
                    <DeletePageDialog
                        page={deleting}
                        pages={pages}
                        open
                        onOpenChange={(open) => {
                            if (!open) {
                                setDeleting(undefined);
                            }
                        }}
                        onDeleted={onDeleted}
                    />
                )}
            </div>
        </section>
    );
}

type Layout = 'grid' | 'list';

/** The library's pages: three columns of cards (two, then one, as it narrows) or rows. */
function LibraryPages({ layout, children }: { layout: Layout; children: ReactNode }) {
    return (
        <div
            data-slot="library-pages"
            data-layout={layout}
            className={
                layout === 'grid'
                    ? 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-3'
                    : 'flex flex-col gap-2'
            }
        >
            {children}
        </div>
    );
}

/**
 * One page of the library: a card (or a row) that opens it, and its
 * Delete, shown on hover and keyboard focus (always on touch screens).
 */
/**
 * A grid card's band in a Space with covers (CB-308): the page's cover, or
 * a neutral band with the page tile, 120 px tall.
 */
function CardBand({ cover, tile }: { cover: PageCover | null; tile: string }) {
    const [broken, setBroken] = useState(false);
    return (
        <span
            data-slot="library-card-band"
            data-cover={cover && !broken ? 'image' : 'tile'}
            className="flex h-30 w-full shrink-0 items-center justify-center overflow-hidden border-b bg-muted/60"
        >
            {cover && !broken ? (
                <img
                    src={cover.url}
                    alt=""
                    loading="lazy"
                    className="size-full object-cover object-center"
                    onError={() => setBroken(true)}
                />
            ) : (
                <span aria-hidden className={cn('flex size-8 items-center justify-center rounded-lg', tile)}>
                    <FileText className="size-4" />
                </span>
            )}
        </span>
    );
}

function LibraryCard({
    layout,
    band,
    title,
    body,
    meta,
    onOpen,
    onDelete,
}: {
    layout: Layout;
    /** A grid card's band, in a Space with covers (CB-308). */
    band?: ReactNode;
    title: string;
    body: ReactNode;
    meta: ReactNode;
    onOpen: () => void;
    onDelete?: () => void;
}) {
    const list = layout === 'list';
    return (
        <div className="group/page relative flex min-w-0">
            <button
                type="button"
                data-slot="library-page-card"
                className={cn(
                    'relative flex min-w-0 flex-1 rounded-[12px] border bg-card text-left text-card-foreground outline-none transition-[border-color,box-shadow] hover:border-muted-foreground/50 hover:shadow-[0_5px_15px_rgb(0_0_0/0.03)] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:transition-none',
                    list
                        ? 'min-h-16 flex-row items-center gap-4 px-5 py-3.5 max-[700px]:pr-12'
                        : band
                          ? 'flex-col items-start justify-start overflow-hidden'
                          : 'min-h-37 flex-col items-start justify-start p-5',
                )}
                onClick={onOpen}
            >
                {band}
                <div
                    className={cn(
                        'w-full min-w-0',
                        !list && 'flex flex-1 flex-col',
                        band && 'min-h-37 p-5',
                        list && 'grid grid-cols-[minmax(0,1fr)_130px] gap-x-6 max-[700px]:block',
                    )}
                >
                    <h3
                        className={cn(
                            'm-0 text-[15px]/[22px] font-medium [overflow-wrap:anywhere]',
                            list ? 'col-start-1 mb-1 line-clamp-1' : 'mb-2 line-clamp-2',
                        )}
                    >
                        {title}
                    </h3>
                    <p
                        className={cn(
                            'm-0 text-[13px]/5 text-muted-foreground',
                            list ? 'col-start-1 line-clamp-1' : 'mb-3 line-clamp-2',
                        )}
                    >
                        {body}
                    </p>
                    <div
                        className={cn(
                            'flex items-center gap-2.5 text-xs text-muted-foreground/80',
                            !list && 'mt-auto',
                            list &&
                                'col-start-2 row-span-2 row-start-1 flex-col items-start justify-center max-[700px]:mt-[7px]',
                        )}
                    >
                        {meta}
                    </div>
                </div>
                {/* A row keeps its arrow; a card is plain, as approved (CB-308). */}
                {list && <ArrowUpRight size={15} className="shrink-0 text-muted-foreground max-[700px]:hidden" />}
            </button>
            {onDelete && (
                <Button
                    variant="ghost"
                    aria-label={`Delete ${title.trim() || 'Untitled page'}`}
                    title="Delete page"
                    className={cn(
                        'absolute size-7.5 rounded-lg p-0 text-muted-foreground opacity-0 transition-[opacity,background-color] group-hover/page:opacity-100 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 [@media(hover:none)]:opacity-100 dark:hover:bg-destructive/15',
                        list ? 'top-1/2 right-11.5 -translate-y-1/2 max-[700px]:right-3' : 'right-3.5 bottom-3.5',
                    )}
                    onClick={onDelete}
                >
                    <Trash2 className="size-[15px]" />
                </Button>
            )}
        </div>
    );
}
