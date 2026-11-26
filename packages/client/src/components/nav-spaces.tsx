import { ChevronRight, FileText, Folder, Lock, Sheet } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, useMatch } from 'react-router';

import type { PageTreeItem } from '@socio/shared/pages/page-library';
import {
    isKnownSpaceItem,
    type PrivateItemsResponse,
    type SpaceDatasetItem,
    type SpaceItemsResponse,
} from '@socio/shared/spaces/space-items';
import type { Space } from '@socio/shared/types';

import { apiIfChanged, PollTags, UNCHANGED } from '../lib/api';
import { useLiveTopic } from '../lib/change-channel';
import { onPagesChanged } from '../modules/pages/page-events';
import { spacePath } from '../modules/pages/page-navigation';
import { useFlag } from '../shell/flags';

import { PrivateSpaceIcon } from './private-space';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
    SidebarMenuAction,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarMenuSub,
    SidebarMenuSubButton,
    SidebarMenuSubItem,
} from '@/components/ui/sidebar';

/** One entry of a tree: a page, a dataset, or a kind this version doesn't know. */
interface TreeEntry {
    id: string;
    parentId: string | null;
    title: string;
    kind: string;
    /** A folder (CB-426): a page shown with a folder's icon. */
    folder?: boolean;
    /** A scratch dataset's socio, named beside it in the Private group. */
    socio?: SpaceDatasetItem['socio'];
}

/** Where a dataset opens: today's rows view, until its views land (CB-451). */
export const datasetPath = (id: string) => `/data/datasets/${encodeURIComponent(id)}`;

/**
 * Polls a tree's list while `enabled`: at once, every 3 s, on another
 * tab's note (`topic`) and when a page of `spaceId` is made or deleted
 * here. A poll with no change is a 304 (api.ts).
 */
function useTreePoll(
    path: string,
    enabled: boolean,
    read: (answer: unknown) => TreeEntry[],
    { topic, spaceId, error: failed }: { topic?: string; spaceId?: string; error: string },
) {
    const [entries, setEntries] = useState<TreeEntry[]>([]);
    const [error, setError] = useState('');
    const reload = useRef<() => Promise<void>>(undefined);
    const reader = useRef(read);
    reader.current = read;
    useLiveTopic(enabled ? topic : undefined, () => reload.current?.());
    useEffect(() => {
        if (!enabled) {
            return;
        }
        let current = true;
        const tags = new PollTags();
        const load = async () => {
            try {
                const answer = await apiIfChanged<unknown>(path, tags.get(path));
                if (!current) {
                    return;
                }
                if (answer !== UNCHANGED) {
                    setEntries(reader.current(answer.data));
                    tags.set(path, answer.tag);
                }
                setError('');
            } catch {
                if (current) {
                    setError(failed);
                }
            }
        };
        void load();
        reload.current = load;
        const timer = setInterval(() => void load(), 3000);
        const stop = onPagesChanged((id) => {
            if (id === spaceId) {
                void load();
            }
        });
        return () => {
            current = false;
            if (reload.current === load) {
                reload.current = undefined;
            }
            clearInterval(timer);
            stop();
        };
    }, [enabled, path, spaceId, failed]);
    return { entries, error };
}

/** The entries of a Space's items list (CB-451): an unknown kind is kept, never dropped. */
const itemEntries = (answer: unknown): TreeEntry[] =>
    ((answer as SpaceItemsResponse | PrivateItemsResponse).items as TreeEntry[]).map((item) => ({
        id: item.id,
        parentId: item.parentId,
        title: item.title,
        kind: item.kind,
        ...(item.folder ? { folder: true } : {}),
        ...(item.socio ? { socio: item.socio } : {}),
    }));
const pageEntries = (answer: unknown): TreeEntry[] =>
    (answer as PageTreeItem[]).map((page) => ({ ...page, kind: 'page' }));

/** A tree's branches under `parentId`: pages link to themselves, datasets to their rows. */
function Branches({
    entries,
    parentId,
    spaceId,
    pageId,
    datasetId,
    onNavigate,
}: {
    entries: TreeEntry[];
    parentId: string | null;
    spaceId?: string;
    pageId?: string;
    datasetId?: string;
    onNavigate: () => void;
}) {
    return entries
        .filter((entry) => entry.parentId === parentId)
        .map((entry) => {
            const children = entries.some((child) => child.parentId === entry.id);
            const known = isKnownSpaceItem(entry);
            return (
                <SidebarMenuSubItem key={entry.id} data-kind={entry.kind}>
                    {!known ? (
                        // A later kind (a dashboard): shown, never dropped (CB-451).
                        <SidebarMenuSubButton asChild aria-disabled>
                            <span title="Not supported in this version">
                                <FileText />
                                <span>{entry.title}</span>
                                <span className="sr-only">Not supported in this version</span>
                            </span>
                        </SidebarMenuSubButton>
                    ) : entry.kind === 'dataset' ? (
                        <SidebarMenuSubButton asChild isActive={datasetId === entry.id}>
                            <NavLink
                                to={datasetPath(entry.id)}
                                end
                                title={entry.socio ? `${entry.title} (${entry.socio.name ?? 'a socio'})` : entry.title}
                                onClick={onNavigate}
                            >
                                <Sheet />
                                <span>{entry.title}</span>
                                {entry.socio && (
                                    <span className="ml-auto truncate text-xs text-sidebar-muted-foreground">
                                        {entry.socio.name ?? 'Socio'}
                                    </span>
                                )}
                            </NavLink>
                        </SidebarMenuSubButton>
                    ) : (
                        <SidebarMenuSubButton asChild isActive={pageId === entry.id}>
                            <NavLink to={spacePath(spaceId!, entry.id)} end title={entry.title} onClick={onNavigate}>
                                {entry.folder ? <Folder data-icon="folder" /> : <FileText />}
                                <span>{entry.title}</span>
                            </NavLink>
                        </SidebarMenuSubButton>
                    )}
                    {children && (
                        <SidebarMenuSub className="mr-0 pr-0">
                            <Branches
                                entries={entries}
                                parentId={entry.id}
                                spaceId={spaceId}
                                pageId={pageId}
                                datasetId={datasetId}
                                onNavigate={onNavigate}
                            />
                        </SidebarMenuSub>
                    )}
                </SidebarMenuSubItem>
            );
        });
}

/**
 * One Space in the sidebar: the Space itself, and its tree in a
 * collapsible sub-menu. Its titles and parents (no bodies) load when the
 * tree first opens and refresh every 3 s while it stays open, and at once
 * when a page is created or deleted in the app. With `datasets-in-spaces`
 * (CB-451) the tree is the Space's items, its datasets among its pages.
 */
export function NavSpace({
    space,
    onNavigate,
}: {
    space: Space;
    /** Called on a click, before the link navigates (closes the mobile sheet). */
    onNavigate: () => void;
}) {
    const open = useMatch('/spaces/:spaceId/*')?.params.spaceId === space.id;
    const pageId = useMatch('/spaces/:spaceId/pages/:pageId')?.params.pageId;
    const datasetId = useMatch('/data/datasets/:datasetId')?.params.datasetId;
    const [expanded, setExpanded] = useState(false);
    const items = useFlag('datasets-in-spaces');
    const { entries, error } = useTreePoll(
        `/spaces/${space.id}/${items ? 'items' : 'page-tree'}`,
        expanded,
        items ? itemEntries : pageEntries,
        {
            topic: `space:${space.id}`,
            spaceId: space.id,
            error: items ? 'Could not load items.' : 'Could not load pages.',
        },
    );
    return (
        <Collapsible asChild open={expanded} onOpenChange={setExpanded}>
            <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={open && !pageId} tooltip={space.name}>
                    <NavLink to={spacePath(space.id)} end onClick={onNavigate}>
                        <Folder />
                        <span>{space.name}</span>
                        {space.private && <PrivateSpaceIcon />}
                    </NavLink>
                </SidebarMenuButton>
                <CollapsibleTrigger asChild>
                    <SidebarMenuAction
                        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${space.name}`}
                        className="transition-transform data-[state=open]:rotate-90"
                    >
                        <ChevronRight />
                    </SidebarMenuAction>
                </CollapsibleTrigger>
                <CollapsibleContent>
                    <SidebarMenuSub>
                        {error ? (
                            <SidebarNote role="status">{error}</SidebarNote>
                        ) : entries.length ? (
                            <Branches
                                entries={entries}
                                parentId={null}
                                spaceId={space.id}
                                pageId={open ? pageId : undefined}
                                datasetId={datasetId}
                                onNavigate={onNavigate}
                            />
                        ) : (
                            <SidebarNote>{items ? 'Nothing here yet' : 'No pages yet'}</SidebarNote>
                        )}
                    </SidebarMenuSub>
                </CollapsibleContent>
            </SidebarMenuItem>
        </Collapsible>
    );
}

/**
 * "Private" at the top of the Spaces (CB-451): the person's
 * own datasets in no Space, a socio's scratch ones marked with its name.
 * Only they see it. Shown with `datasets-in-spaces`.
 */
export function NavPrivate({ onNavigate }: { onNavigate: () => void }) {
    const datasetId = useMatch('/data/datasets/:datasetId')?.params.datasetId;
    const [expanded, setExpanded] = useState(false);
    const { entries, error } = useTreePoll('/data/private-items', expanded, itemEntries, {
        error: 'Could not load your datasets.',
    });
    return (
        <Collapsible asChild open={expanded} onOpenChange={setExpanded}>
            <SidebarMenuItem data-slot="nav-private">
                <CollapsibleTrigger asChild>
                    <SidebarMenuButton tooltip="Private">
                        <Lock />
                        <span>Private</span>
                    </SidebarMenuButton>
                </CollapsibleTrigger>
                <CollapsibleTrigger asChild>
                    <SidebarMenuAction
                        aria-label={`${expanded ? 'Collapse' : 'Expand'} Private`}
                        className="transition-transform data-[state=open]:rotate-90"
                    >
                        <ChevronRight />
                    </SidebarMenuAction>
                </CollapsibleTrigger>
                <CollapsibleContent>
                    <SidebarMenuSub>
                        {error ? (
                            <SidebarNote role="status">{error}</SidebarNote>
                        ) : entries.length ? (
                            <Branches entries={entries} parentId={null} datasetId={datasetId} onNavigate={onNavigate} />
                        ) : (
                            <SidebarNote>No private datasets</SidebarNote>
                        )}
                    </SidebarMenuSub>
                </CollapsibleContent>
            </SidebarMenuItem>
        </Collapsible>
    );
}

/** A quiet line of text in a sidebar group (empty and error states). */
export function SidebarNote({ children, role }: { children: React.ReactNode; role?: 'status' }) {
    return (
        <li role={role} className="list-none px-2 py-1 text-xs text-sidebar-muted-foreground">
            {children}
        </li>
    );
}
