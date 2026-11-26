// The last screen of a workspace,
// kept in its cache.db's `kv` (src/sync/view-state.ts), so the workspace opens
// where the person left it. Only the shell's tabs and pages count, Search
// excepted, and a chat or room (`Chat/<id>`; a new chat's local id until its
// create resolves, then its server id: the new chat's re-keying,
// src/sync/new-chat.ts), and a page (`Page/<spaceId>/<pageId>`, which follows
// the page when it moves: src/sync/page-store.ts), and a Space's library
// (`Space/<spaceId>`), and an issue (`Issue/<key>`: its number, or an issue
// filed offline by its local key until its create resolves, then its number:
// the filing's re-keying, src/sync/issue-create.ts); anything else read back
// (a newer build's screen, a damaged value) opens Home. The modules' own
// screens join as their routes land (`Memories`, `Activity` and `Schedules`,
// `Learning` and `Runs`; a run's page never: reopening it would read a trace
// no one tapped; `Media`, its root folder: a file's page never, so a relaunch
// downloads nothing no one tapped).

import { issueNumber } from '@socio/shared/issues/issue-board';

import { isLocalIssue } from '../sync/local-ids';

export const LAST_SCREEN_KEY = 'lastScreen';

export const SHELL_SCREENS = [
    'Home',
    'Chats',
    'Spaces',
    'Board',
    'Memories',
    'Activity',
    'Schedules',
    'Learning',
    'Runs',
    'Media',
    'More',
] as const;
export type ShellScreen = (typeof SHELL_SCREENS)[number];

export const isShellScreen = (value: unknown): value is ShellScreen =>
    typeof value === 'string' && (SHELL_SCREENS as readonly string[]).includes(value);

/** Screens that are gone, kept by an older build, and the one that holds what they did (CB-455). */
const MOVED: ReadonlyMap<string, ShellScreen> = new Map([['Inbox', 'Chats']]);

/**
 * The screen to open: the one kept, else Home (a kept chat opens over Home: `keptChat`). A kept
 * Inbox opens Chats, whose top holds what the Inbox did (CB-455).
 */
export const lastScreen = (value: string | null | undefined): ShellScreen =>
    isShellScreen(value) ? value : ((typeof value === 'string' ? MOVED.get(value) : undefined) ?? 'Home');

const CHAT_PREFIX = 'Chat/';

/** What a chat or room keeps as the last screen. */
export const chatScreen = (id: string) => `${CHAT_PREFIX}${id}`;

/** The chat or room kept as the last screen, or null. */
export function keptChat(value: string | null | undefined): string | null {
    return typeof value === 'string' && value.startsWith(CHAT_PREFIX) && value.length > CHAT_PREFIX.length
        ? value.slice(CHAT_PREFIX.length)
        : null;
}

/** The slice of a workspace scope a cold start onto a chat reads. */
export interface KeptChatScope {
    readonly viewState: { get(key: string): string | null | undefined };
    readonly histories: { preload(threadId: string): Promise<unknown> };
}

/**
 * A cold start onto a chat: reads the kept chat's history
 * from disk, before the first frame, so the chat draws its runs at once. A read
 * that fails leaves the chat to load as it opens.
 */
export async function preloadKeptChat(scope: KeptChatScope, onError: (error: unknown) => void = () => {}) {
    const id = keptChat(scope.viewState.get(LAST_SCREEN_KEY));
    if (id === null) {
        return;
    }
    try {
        await scope.histories.preload(id);
    } catch (error) {
        onError(error);
    }
}

const PAGE_PREFIX = 'Page/';

/** What a page keeps as the last screen: its Space and its id. */
export const pageScreen = (spaceId: string, pageId: string): `Page/${string}/${string}` => `Page/${spaceId}/${pageId}`;

/** The page kept as the last screen, or null. A Space id holds no slash; the page's id is the rest. */
export function keptPage(value: string | null | undefined): { spaceId: string; pageId: string } | null {
    if (typeof value !== 'string' || !value.startsWith(PAGE_PREFIX)) {
        return null;
    }
    const rest = value.slice(PAGE_PREFIX.length);
    const at = rest.indexOf('/');
    return at <= 0 || at === rest.length - 1 ? null : { spaceId: rest.slice(0, at), pageId: rest.slice(at + 1) };
}

/** The slice of a workspace scope a cold start onto a page reads. */
export interface KeptPageScope {
    readonly viewState: { get(key: string): string | null | undefined };
    readonly pages: { preload(spaceId: string, pageId: string): Promise<unknown> };
}

/**
 * A cold start onto a page: reads the Space's summaries and the page's
 * body from disk, before the first frame, so the page draws at once, or its
 * title and excerpt when no body was kept. A read that fails leaves the page to
 * load as it opens.
 */
export async function preloadKeptPage(scope: KeptPageScope, onError: (error: unknown) => void = () => {}) {
    const kept = keptPage(scope.viewState.get(LAST_SCREEN_KEY));
    if (kept === null) {
        return;
    }
    try {
        await scope.pages.preload(kept.spaceId, kept.pageId);
    } catch (error) {
        onError(error);
    }
}

const SPACE_PREFIX = 'Space/';

/** What a Space's library keeps as the last screen: its id. */
export const spaceScreen = (spaceId: string): `Space/${string}` => `Space/${spaceId}`;

/** The Space kept as the last screen, or null. A Space id holds no slash. */
export function keptSpace(value: string | null | undefined): string | null {
    if (typeof value !== 'string' || !value.startsWith(SPACE_PREFIX)) {
        return null;
    }
    const id = value.slice(SPACE_PREFIX.length);
    return id === '' || id.includes('/') ? null : id;
}

/** The slice of a workspace scope a cold start onto a Space reads. */
export interface KeptSpaceScope {
    readonly viewState: { get(key: string): string | null | undefined };
    readonly pages: { space(spaceId: string): { readonly loaded: Promise<void> } };
}

/**
 * A cold start onto a Space's library: reads its pages from cache.db
 * before the first frame, so the library draws them at once. A read that fails
 * leaves them to load as the screen opens.
 */
export async function preloadKeptSpace(scope: KeptSpaceScope, onError: (error: unknown) => void = () => {}) {
    const id = keptSpace(scope.viewState.get(LAST_SCREEN_KEY));
    if (id === null) {
        return;
    }
    try {
        await scope.pages.space(id).loaded;
    } catch (error) {
        onError(error);
    }
}

const ISSUE_SCREEN = 'Issue/';

/** What an issue's screen keeps as the last screen: the issue as the store keys it. */
export const issueScreen = (key: string): `Issue/${string}` => `${ISSUE_SCREEN}${key}`;

/** The issue kept as the last screen, or null. */
export function keptIssue(value: string | null | undefined): string | null {
    return typeof value === 'string' && value.startsWith(ISSUE_SCREEN) && value.length > ISSUE_SCREEN.length
        ? value.slice(ISSUE_SCREEN.length)
        : null;
}

/**
 * The Issue route's param for issue `key` as the store keys it (its number,
 * or a local key): `CB-12`, the web's path, or the local key as it is.
 */
export const issueParam = (key: string) => (isLocalIssue(key) ? key : `CB-${key}`);

/** The issue a route param names, as the store keys it (`CB-12` or `12`: '12'), or null for anything else. */
export function issueOfParam(param: string | null | undefined): string | null {
    if (typeof param !== 'string') {
        return null;
    }
    if (isLocalIssue(param)) {
        return param;
    }
    const number = issueNumber(param);
    return number === undefined || number < 1 ? null : String(number);
}

/** The slice of a workspace scope a cold start onto an issue reads. */
export interface KeptIssueScope {
    readonly viewState: { get(key: string): string | null | undefined };
    readonly issueDetails: { preload(key: string): Promise<unknown> };
}

/**
 * A cold start onto an issue: reads its detail from disk before the
 * first frame, so the issue draws at once. An issue filed offline has none
 * (the filing shows). A read that fails leaves it to load as it opens.
 */
export async function preloadKeptIssue(scope: KeptIssueScope, onError: (error: unknown) => void = () => {}) {
    const key = keptIssue(scope.viewState.get(LAST_SCREEN_KEY));
    if (key === null || isLocalIssue(key)) {
        return;
    }
    try {
        await scope.issueDetails.preload(key);
    } catch (error) {
        onError(error);
    }
}
