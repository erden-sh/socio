import { ArrowLeft, PanelLeft, Check, LoaderCircle, FileCode2 } from 'lucide-react';
import { type ComponentProps, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { pageAncestors, pageChildren } from '@socio/shared/pages/page-hierarchy';
import type { Page, PageCover, PageSummary } from '@socio/shared/pages/page-library';
import type { WorkspaceState } from '@socio/shared/types';

import { api } from '../../lib/api';
import { ClientOnly } from '../../lib/client-only';
import { importOrReload } from '../../shell/chunk-reload';
import { useCrumbTitle } from '../../shell/crumb-title';
import { CurrentUser } from '../../shell/current-user';
import { PromoteFindingDialog } from '../spaces/PromoteFindingDialog';

import { canDeletePage, DeletePageDialog } from './DeletePageDialog';
import { DocumentMenu } from './editor/DocumentMenu';
import { EditorLoading } from './editor/EditorLoading';
import { inspectMarkdown } from './editor/markdown';
import { usePageAutosave } from './editor/use-page-autosave';
import { MovePageDialog } from './MovePageDialog';
import { PageIconButton } from './page-chrome';
import { PageConversation } from './PageConversation';
import { PageCoverArea } from './PageCover';
import { PageAncestorLinks, PageChildLinks } from './PageHierarchyNavigation';
import { PageTitleField } from './PageTitleField';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const RichEditor = lazy(() => importOrReload(() => import('./editor/RichEditor')));
const editorLoading = <EditorLoading />;
export function PageDocument({
    page,
    cover = page.cover,
    pages,
    workspace,
    paused,
    onHome,
    onOutline,
    onSubpage,
    onDeleted,
    onMoved,
    onDirty,
    onSaved,
    onCover,
    onRefresh,
    onSchedule,
    onThread,
    onSettings,
    onCreateDot,
}: {
    page: Page;
    /** The page's cover as the Space's list has it now (CB-308): the open page's otherwise. */
    cover?: PageCover | null;
    /** The Space's pages, without their bodies. */
    pages: PageSummary[];
    workspace: WorkspaceState;
    paused: boolean;
    onHome: () => void;
    onOutline: () => void;
    onSubpage: () => void;
    onDeleted: (ids: string[]) => void;
    /** Moved to another Space (CB-142): where it is now, and every page that went. */
    onMoved: (page: Page, moved: string[]) => void;
    onDirty: (value: boolean) => void;
    onSaved: (page: Page) => void;
    /** The cover changed here (CB-308), with the page when the server sent it. */
    onCover?: (cover: PageCover | null, page?: Page) => void;
    onRefresh: () => void;
    onSchedule: (id: string) => void;
    onThread: (id: string) => void;
    onSettings: () => void;
    onCreateDot: () => void;
}) {
    const { controller, state } = usePageAutosave(page, onSaved);
    const draft = state.draft!;
    // The header's breadcrumb shows the title, as it is typed (CB-38).
    const hierarchyPage = useMemo(() => ({ ...page, parentId: draft.parentId }), [page, draft.parentId]);
    const ancestors = useMemo(() => pageAncestors(hierarchyPage, pages), [hierarchyPage, pages]);
    const children = useMemo(() => pageChildren(hierarchyPage, pages), [hierarchyPage, pages]);
    const ancestry = useMemo(
        () => ({
            spaceId: page.spaceId,
            pages: ancestors.map(({ id, title }) => ({ id, title })),
        }),
        [page.spaceId, ancestors],
    );
    useCrumbTitle(page.id, draft.title, ancestry);
    const [source, setSource] = useState(false);
    const [move, setMove] = useState(false);
    const [notice, setNotice] = useState('');
    const [chatOpen, setChatOpen] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [moveSpace, setMoveSpace] = useState(false);
    // CB-281: "Create follow-up" from a Space finding, and the seed that opens
    // the page chat to ask for a goal (the goal destination).
    const [promote, setPromote] = useState(false);
    const [goalSeed, setGoalSeed] = useState<{
        prompt: string;
        dotId: string;
    } | null>(null);
    const deletable = canDeletePage(useContext(CurrentUser), page);
    const safety = useMemo(() => inspectMarkdown(draft.content), [draft.content]);
    const sourceMode = source || !safety.supported;
    const viewPage = useMemo(() => ({ spaceId: page.spaceId, pageId: page.id }), [page.spaceId, page.id]);
    useEffect(() => {
        onDirty(controller.dirty);
        return () => onDirty(false);
    }, [state, controller, onDirty]);
    // Leaving with unsaved changes (navigation, reload) is guarded by the
    // shell (use-draft-guard.ts), from what onDirty reports.
    useEffect(() => {
        const save = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && !event.isComposing) {
                event.preventDefault();
                void controller.flush(true);
            }
        };
        window.addEventListener('keydown', save);
        return () => window.removeEventListener('keydown', save);
    }, [controller]);
    const beforeChat = useCallback(() => controller.flush(true), [controller]);
    const download = () => {
        const url = URL.createObjectURL(new Blob([draft.content], { type: 'text/markdown;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `${draft.title.replace(/[^\p{L}\p{N} -]/gu, '').slice(0, 80) || 'page'}.md`;
        link.click();
        URL.revokeObjectURL(url);
    };
    const latest = async () => {
        if (
            !window.confirm(
                'Load the latest saved page and replace this draft? Download your draft first if you want to keep it.',
            )
        ) {
            return;
        }
        try {
            controller.receive(await api<Page>(`/spaces/${page.spaceId}/pages/${page.id}`));
            controller.useLatest();
            setNotice('');
        } catch (error) {
            setNotice(
                error instanceof Error ? error.message : 'Could not load the latest page. Your draft is unchanged.',
            );
        }
    };
    const descendants = new Set([page.id]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const item of pages) {
            if (item.parentId && descendants.has(item.parentId) && !descendants.has(item.id)) {
                descendants.add(item.id);
                changed = true;
            }
        }
    }
    const status =
        state.status === 'saving'
            ? 'Saving…'
            : state.status === 'saved'
              ? 'All changes saved'
              : state.status === 'dirty'
                ? 'Unsaved changes'
                : state.status === 'conflict'
                  ? 'Changes need review'
                  : 'Could not save';
    // No data-slot on the frames around the page's text (page-chrome.tsx).
    return (
        <section
            className={cn(
                'relative flex min-h-0 min-w-0 flex-1 bg-card',
                chatOpen && 'max-[900px]:flex-col max-[900px]:overflow-auto',
            )}
            aria-label="Document workspace"
            data-tour="page-document"
        >
            <div
                className={cn(
                    'flex min-w-0 flex-1 flex-col',
                    chatOpen && 'max-[900px]:min-h-130 max-[900px]:flex-none',
                )}
            >
                <header
                    data-slot="page-header"
                    className="flex min-h-15.5 items-center gap-2 border-b border-border/70 px-[25px] py-2.5 max-[700px]:gap-1 max-[700px]:px-3.5 max-[700px]:py-2"
                >
                    <Button
                        variant="ghost"
                        className="h-auto min-h-10 gap-2 rounded-[9px] px-1.5 py-2 text-xs font-normal text-muted-foreground hover:text-foreground max-[700px]:min-h-11 max-[700px]:min-w-10 [&_svg:not([class*='size-'])]:size-4"
                        onClick={onHome}
                    >
                        <ArrowLeft />
                        <span className="max-[700px]:text-[11px]">All pages</span>
                    </Button>
                    <PageIconButton aria-label="Toggle page outline" onClick={onOutline}>
                        <PanelLeft className="size-[17px]" />
                    </PageIconButton>
                    <span
                        data-status={state.status}
                        className={cn(
                            'ml-auto flex items-center gap-1.5 px-2 text-[11px] whitespace-nowrap text-muted-foreground max-[700px]:gap-1 max-[700px]:px-0 max-[700px]:text-[10px]',
                            (state.status === 'error' || state.status === 'conflict') && 'text-destructive',
                        )}
                        role="status"
                        aria-live="polite"
                    >
                        {state.status === 'saved' ? (
                            <Check size={13} />
                        ) : state.status === 'saving' ? (
                            <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" />
                        ) : null}
                        {status}
                    </span>
                    <DocumentMenu
                        items={[
                            {
                                label: 'Save now · ⌘/Ctrl S',
                                action: () => void controller.flush(true),
                            },
                            {
                                label: sourceMode ? 'Visual editor' : 'Markdown source',
                                action: () => {
                                    if (sourceMode && !safety.supported) {
                                        setNotice(safety.reason ?? 'This document needs source mode.');
                                        return;
                                    }
                                    setSource(!sourceMode);
                                },
                            },
                            { label: 'Move within Space', action: () => setMove(!move) },
                            { label: 'Move to…', action: () => setMoveSpace(true) },
                            { label: 'New subpage', action: onSubpage },
                            { label: 'Create follow-up…', action: () => setPromote(true) },
                            { label: 'Download Markdown', action: download },
                            ...(page.sourceThreadId
                                ? [
                                      {
                                          label: 'Open source conversation',
                                          action: () => onThread(page.sourceThreadId!),
                                      },
                                  ]
                                : []),
                            ...(deletable
                                ? [
                                      {
                                          label: 'Delete page',
                                          action: () => setConfirmDelete(true),
                                      },
                                  ]
                                : []),
                        ]}
                    />
                    <MovePageDialog
                        page={{ ...page, title: draft.title }}
                        pages={pages}
                        spaces={workspace.spaces}
                        open={moveSpace}
                        onOpenChange={setMoveSpace}
                        beforeMove={beforeChat}
                        onMoved={onMoved}
                    />
                    {deletable && (
                        <DeletePageDialog
                            page={{ ...page, title: draft.title }}
                            pages={pages}
                            open={confirmDelete}
                            onOpenChange={setConfirmDelete}
                            onDeleted={onDeleted}
                        />
                    )}
                </header>
                <div className="min-h-0 flex-1 scroll-pb-42.5 overflow-auto">
                    <article
                        className={cn(
                            'mx-auto w-full max-w-195 px-[45px] pt-12.5 pb-[195px]',
                            chatOpen
                                ? 'max-[1150px]:px-[25px] max-[1150px]:pt-[35px] max-[1150px]:pb-20'
                                : 'max-[1150px]:px-[35px] max-[1150px]:pt-10 max-[1150px]:pb-[185px] max-[700px]:px-6 max-[700px]:pt-7.5 max-[700px]:pb-45',
                        )}
                    >
                        {state.error && (
                            <PageNotice role="alert" data-status={state.status}>
                                <p className="mt-0 mb-2.5">{state.error}</p>
                                <div className="flex flex-wrap gap-2">
                                    {state.status === 'error' && (
                                        <NoticeButton onClick={() => void controller.flush(true)}>
                                            Retry save
                                        </NoticeButton>
                                    )}
                                    <NoticeButton onClick={download}>Download draft</NoticeButton>
                                    {state.status === 'conflict' && (
                                        <NoticeButton onClick={() => void latest()}>Load latest</NoticeButton>
                                    )}
                                </div>
                            </PageNotice>
                        )}
                        {notice && (
                            <PageNotice role="status" className="flex items-center gap-3">
                                {notice}
                                <NoticeButton onClick={() => setNotice('')}>Dismiss</NoticeButton>
                            </PageNotice>
                        )}
                        {move && (
                            <div
                                data-slot="page-move"
                                className="mb-6 flex items-center gap-3 rounded-lg border bg-muted/40 p-3 max-[700px]:flex-wrap"
                                onKeyDown={(e) => {
                                    if (e.key === 'Escape') {
                                        setMove(false);
                                    }
                                }}
                            >
                                <label className="flex flex-1 items-center gap-3 text-xs max-[700px]:flex-wrap">
                                    Move under
                                    <select
                                        autoFocus
                                        data-slot="native-select"
                                        aria-label="Parent page"
                                        className="w-full max-w-62.5 min-w-0 rounded-[9px] border border-input bg-background p-[9px] text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-xs dark:bg-input/30"
                                        value={draft.parentId ?? ''}
                                        onChange={(e) => controller.edit({ parentId: e.target.value || null })}
                                    >
                                        <option value="">Space root</option>
                                        {pages
                                            .filter((p) => p.spaceId === page.spaceId && !descendants.has(p.id))
                                            .map((p) => (
                                                <option key={p.id} value={p.id}>
                                                    {p.title}
                                                </option>
                                            ))}
                                    </select>
                                </label>
                                <Button
                                    variant="outline"
                                    className="h-auto rounded-[9px] px-[13px] py-[9px] text-xs font-normal"
                                    onClick={() => setMove(false)}
                                >
                                    Done
                                </Button>
                            </div>
                        )}
                        <PageAncestorLinks pages={ancestors} />
                        {/* The cover and the title: hovering or focusing either shows Add cover. */}
                        <div className="group/page-top">
                            <PageCoverArea
                                spaceId={page.spaceId}
                                pageId={page.id}
                                cover={cover}
                                // Whoever opens a page may edit it: the page view has no read-only mode.
                                editable
                                onChange={(next, saved) => onCover?.(next, saved)}
                            />
                            <PageTitleField
                                // .document-title: a hook for globals.css, which leaves the
                                // title out of the 16 px rule for fields on touch screens.
                                className="document-title mb-6 block w-full resize-none overflow-hidden rounded-none border-0 bg-transparent p-0 text-[40px]/[1.3] font-[630] tracking-[-1.4px] [overflow-wrap:anywhere] text-foreground outline-none placeholder:text-muted-foreground focus-visible:shadow-[0_1px_var(--muted-foreground)] max-[900px]:text-[34px] max-[700px]:mb-5 max-[700px]:text-[32px] max-[700px]:tracking-[-0.8px]"
                                value={draft.title}
                                onChange={(title) => controller.edit({ title })}
                            />
                        </div>
                        {sourceMode ? (
                            <>
                                <div className="mt-0 mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                                    <FileCode2 size={15} />
                                    <span>Markdown source</span>
                                </div>
                                {!safety.supported && (
                                    <p className="text-xs/[1.7] text-muted-foreground">{safety.reason}</p>
                                )}
                                <Textarea
                                    className="field-sizing-fixed min-h-105 resize-y rounded-lg border bg-muted/30 p-4.5 font-mono text-base/[1.8] text-foreground shadow-none md:text-[13px]/[1.8]"
                                    aria-label="Page Markdown"
                                    spellCheck={false}
                                    value={draft.content}
                                    maxLength={100000}
                                    onChange={(event) => controller.edit({ content: event.target.value })}
                                />
                            </>
                        ) : (
                            // In the browser only: the server never runs the editor.
                            <ClientOnly fallback={editorLoading}>
                                {() => (
                                    <Suspense fallback={editorLoading}>
                                        <RichEditor
                                            value={draft.content}
                                            onChange={(content) => controller.edit({ content })}
                                            onNotice={setNotice}
                                            page={viewPage}
                                        />
                                    </Suspense>
                                )}
                            </ClientOnly>
                        )}
                        <PageChildLinks pages={children} />
                    </article>
                </div>
            </div>
            <div
                className={
                    chatOpen
                        ? 'min-h-0 w-90 shrink-0 border-l border-border max-[1150px]:w-82.5 max-[900px]:h-155 max-[900px]:min-h-155 max-[900px]:w-full max-[900px]:border-t max-[900px]:border-l-0'
                        : 'absolute bottom-6 left-1/2 z-5 w-[min(610px,calc(100%-80px))] -translate-x-1/2 max-[700px]:bottom-3.5 max-[700px]:w-[calc(100%-30px)]'
                }
            >
                <PageConversation
                    page={page}
                    workspace={workspace}
                    paused={paused}
                    beforeChat={beforeChat}
                    onRefresh={onRefresh}
                    onSchedule={onSchedule}
                    onSettings={onSettings}
                    onCreateDot={onCreateDot}
                    onOpenChange={setChatOpen}
                    seed={goalSeed}
                    onSeedConsumed={() => setGoalSeed(null)}
                />
            </div>
            {promote && (
                <PromoteFindingDialog
                    page={page}
                    workspace={workspace}
                    onClose={() => setPromote(false)}
                    onAskGoal={(prompt, dotId) => setGoalSeed({ prompt, dotId })}
                />
            )}
        </section>
    );
}

/** A notice above the page: a save that failed or conflicts, a paste refused. */
function PageNotice({ className, ...props }: ComponentProps<'div'>) {
    return (
        <div
            data-slot="page-notice"
            className={cn(
                'mb-[25px] rounded-[9px] border border-amber-300/60 bg-amber-50 px-4 py-3.5 text-[13px]/[1.6] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
                className,
            )}
            {...props}
        />
    );
}

function NoticeButton(props: ComponentProps<typeof Button>) {
    return (
        <Button
            variant="outline"
            className="h-auto min-h-[35px] rounded-[9px] border-amber-300/80 bg-transparent px-3 py-1.5 text-xs font-normal text-amber-900 shadow-none hover:bg-amber-100 hover:text-amber-950 dark:border-amber-500/40 dark:bg-transparent dark:text-amber-200 dark:hover:bg-amber-500/15"
            {...props}
        />
    );
}
