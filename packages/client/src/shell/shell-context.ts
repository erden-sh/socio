import { createContext, useContext, type ReactNode } from 'react';
import { useMatches, type Params } from 'react-router';

import type { ModelChoice } from '@socio/shared/inference';
import type { AttachmentRef } from '@socio/shared/media-types';
import type { ModuleId } from '@socio/shared/modules';
import type { Conversation, Dot, State, WorkspaceState } from '@socio/shared/types';

import type { Dialog } from '../modules/settings/WorkspaceDialog';
import type { ModuleTarget } from '../modules/types';

import type { CrumbTitle } from './crumb-title';
import type { Notices } from './poll-notice';

/**
 * What every route reads from the shell. The shell polls `/state` and
 * `/workspace` once every 3 s; routes never start their own copy of that
 * poll, they read it from here.
 */
export interface Shell {
    state: State;
    workspace: WorkspaceState;
    admin: boolean;
    /** The model and conversation service are set up. */
    configured: boolean;
    refresh: () => Promise<void>;
    /** Calls the API, then refreshes; shows the error and returns false on failure. */
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
    /**
     * Patches one conversation in the workspace shown now (in `conversations`
     * or `archived`), without a server round-trip: an optimistic update a
     * view can show at once, reconciled on the next `refresh` (Rooms
     * follow-ups, for a room's mute state).
     */
    patchConversation: (id: string, patch: Partial<Conversation>) => void;
    setError: (message: string) => void;
    setNotices: (update: (current: Notices) => Notices) => void;
    openDialog: (dialog: Dialog) => void;
    /** Opens a module's target: navigates to its path or opens its dialog. */
    openTarget: (target: ModuleTarget) => void;
    /** The ⌘K command palette. */
    setPalette: (open: boolean) => void;
    /** The computer pane. */
    pane: boolean;
    setPane: (open: boolean) => void;
    /** The Dot the chat home shows: the last one opened, else the first. */
    homeDot: Dot;
    /**
     * Creates a conversation with a Dot and opens it; `text` and
     * `attachments` are sent first. `model`: the chat's own model; null or
     * omitted: the Dot's default.
     */
    newConversation: (
        dot: Dot,
        text?: string,
        model?: ModelChoice | null,
        attachments?: readonly AttachmentRef[],
        options?: { voice?: boolean },
    ) => Promise<boolean>;
    busy: boolean;
    /** The first message for a just-created conversation, sent once. */
    pendingPrompt?: {
        threadId: string;
        text: string;
        attachments?: readonly AttachmentRef[];
    };
    consumePrompt: () => void;
    /**
     * A voice call to start on a just-created conversation, started once
     * (CB-302): voice as the first message of a new chat, before any text.
     */
    pendingVoice?: { threadId: string };
    consumeVoice: () => void;
    /** A page draft has unsaved changes: navigation asks first. */
    setDirty: (dirty: boolean) => void;
    /** Signs out (Better Auth) or back to the user picker (mock). */
    switchUser?: () => void;
    /** Moves on after the session was already revoked: no draft warning. */
    sessionEnded?: () => void;
}

export const ShellContext = createContext<Shell | undefined>(undefined);

export function useShell() {
    const shell = useContext(ShellContext);
    if (!shell) {
        throw new Error('useShell outside the app shell');
    }
    return shell;
}

/** What a route's breadcrumb is built from. */
export interface CrumbContext {
    workspace: WorkspaceState;
    admin: boolean;
    /** The Dot of the current chat route (or the home Dot). */
    dot: Dot;
    params: Params;
    /**
     * The title the current view published (`useCrumbTitle`, e.g. a page's),
     * with the key it belongs to; check the key against `params`.
     */
    title?: CrumbTitle;
    /**
     * The loader data of the route this crumb is from, so the server's
     * render can name what the page shows before any view publishes it.
     */
    data?: unknown;
}

/** One breadcrumb; the last is the current page, the others link. */
export interface Crumb {
    label: string;
    to?: string;
    /**
     * Drawn instead of the crumb's label or link: the last one's a chat's
     * title and menu, the one before a chat a Dot's chats menu (CB-89).
     */
    node?: ReactNode;
}

/** Per-route data the shell reads through `useMatches()`. */
export interface RouteHandle {
    /**
     * Breadcrumbs after Home (the deepest match's win). Module routes
     * without one show the module's title.
     */
    crumb?: (context: CrumbContext) => Crumb[];
    /** A chat route: the computer pane docks beside it instead of over it. */
    chat?: boolean;
    /** Set by the registry on each module's layout route. */
    moduleId?: ModuleId;
}

/**
 * A chat by id, archived ones included: a link opens an
 * archived chat although no list shows it.
 */
export function findChat(workspace: WorkspaceState, id: string | undefined): Conversation | undefined {
    if (!id) {
        return undefined;
    }
    return workspace.conversations.find((item) => item.id === id) ?? workspace.archived?.find((item) => item.id === id);
}

/** The Dot a chat route is about, from its params. */
export function routeDot(workspace: WorkspaceState, params: Params): Dot | undefined {
    const dotId = params.dotId ?? findChat(workspace, params.threadId)?.dotId;
    return dotId ? workspace.dots.find((dot) => dot.id === dotId) : undefined;
}

/**
 * The params of the deepest matched route, wherever this is called from
 * (`useParams` in a parent route doesn't see its children's params).
 */
export function useRouteParams(): Params {
    return useMatches().at(-1)?.params ?? {};
}

/** The module of the current page (its layout route's `handle.moduleId`). */
export function usePageModuleId(): ModuleId | undefined {
    return useMatches()
        .map((match) => match.handle as RouteHandle | undefined)
        .findLast((handle) => handle?.moduleId)?.moduleId;
}
