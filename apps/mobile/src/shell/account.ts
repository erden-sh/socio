import { DEFAULT_BRANDING } from '@socio/shared/branding';
import { normalizeRole } from '@socio/shared/roles';
import { unreadLabel } from '@socio/shared/rooms/rooms';
import type { Role } from '@socio/shared/types';

import { LEAVE_CHECK_FAILED } from '../data/leave-workspace';
import type { WorkspaceRow } from '../data/registry';
import { OUTBOX_COPY } from '../sync/outbox';
import type { ShellState, ShellWorkspace } from '../sync/shell';

import type { ChatRow } from './chat-list';

// The account sheet: the open workspace and the person in it, then the
// switcher, every workspace on the phone from the registry, and Add a
// workspace, and Sign out. The open workspace's names come from the server's
// rows when the scope has them, else from the registry's, which sign-in wrote.
// No React Native, so tests/shell runs it under Node.

export interface AccountView {
    readonly workspaceName: string;
    /** The origin's host (and port, if any). */
    readonly host: string;
    readonly personName: string | null;
    readonly personEmail: string | null;
    readonly role: string | null;
}

/**
 * The workspace's name as people see it: its branding's name (Settings →
 * Branding on the web, "Acme"), else its host. Never `settings.name`,
 * which is the default socio's name ("Dot") and must not be shown as the
 * workspace (owner, 2026-11-08). The product's default ("Socio") isn't a
 * workspace's name either, so a workspace that hasn't set one shows its host.
 */
export function workspaceName(
    state: Pick<ShellState, 'settings'> | null | undefined,
    fallback: { readonly name: string; readonly origin: string },
): string {
    const branded = state?.settings.branding?.name?.trim() ?? '';
    if (branded !== '' && branded !== DEFAULT_BRANDING.name) {
        return branded;
    }
    const kept = fallback.name.trim();
    // A name kept before 2026-11-08 may be the default socio's; the server's rows correct it once open.
    if (state === null || state === undefined) {
        if (kept !== '' && kept !== DEFAULT_BRANDING.name) {
            return kept;
        }
    }
    return new URL(fallback.origin).host;
}

const ROLE_LABEL: Readonly<Record<Role, string>> = { admin: 'Admin', member: 'Member' };

export function accountView(
    row: Pick<WorkspaceRow, 'origin' | 'name' | 'personName' | 'personEmail'>,
    workspace: ShellWorkspace | null | undefined,
    state: ShellState | null | undefined,
): AccountView {
    const user = workspace?.user;
    return {
        workspaceName: workspaceName(state, row),
        host: new URL(row.origin).host,
        personName: user?.name ?? row.personName,
        personEmail: row.personEmail,
        // An older server may still send the retired `operator` role: an admin (CB-390).
        role: user === undefined ? null : ROLE_LABEL[normalizeRole(user.role)],
    };
}

/** A workspace's state, as its badge in the switcher says it. */
export type WorkspaceBadge = 'open' | 'signed-in' | 'ended' | 'locked' | 'failed';

export const BADGE_LABEL: Readonly<Record<WorkspaceBadge, string>> = {
    open: 'Open',
    'signed-in': 'Signed in',
    ended: 'Signed out',
    locked: 'Locked',
    failed: 'Didn’t open',
};

/** One row of the switcher. */
export interface SwitcherRow {
    readonly id: string;
    readonly name: string;
    /** The origin's host (and port), which the row shows with its registrable domain emphasized. */
    readonly host: string;
    readonly personName: string | null;
    readonly personEmail: string | null;
    readonly badge: WorkspaceBadge;
    readonly badgeLabel: string;
    /** Unread when its scope was last open (the registry's summary); null with none or not known. */
    readonly unread: number | null;
    /** `3`, or `99+`; null with no unread. */
    readonly unreadLabel: string | null;
    /** The open workspace: tapping it changes nothing. */
    readonly open: boolean;
    /** "Waiting to send" while another workspace is open and this one's outbox holds rows; else null. */
    readonly waitingLabel: string | null;
    readonly accessibilityLabel: string;
}

type SwitcherSource = Pick<
    WorkspaceRow,
    | 'id'
    | 'origin'
    | 'state'
    | 'name'
    | 'personName'
    | 'personEmail'
    | 'lastUsed'
    | 'endedAt'
    | 'leaseLockedAt'
    | 'unread'
    | 'waiting'
>;

/**
 * The switcher's rows: every ready workspace on the phone (a pending sign-in
 * or a wipe isn't one), the open one first, then the most recently used.
 */
/**
 * The switcher's rows: `openId` is the workspace the app shows, first. With
 * `failed`, its scope didn't open (src/screens/workspace-failed.tsx), and its
 * badge says so.
 */
export function switcherRows(
    rows: readonly SwitcherSource[],
    openId: string | null,
    { failed = false }: { failed?: boolean } = {},
): SwitcherRow[] {
    return rows
        .filter((row) => row.state === 'ready')
        .sort((a, b) => {
            if ((a.id === openId) !== (b.id === openId)) {
                return a.id === openId ? -1 : 1;
            }
            return b.lastUsed - a.lastUsed || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        })
        .map((row) => {
            const open = row.id === openId;
            const badge: WorkspaceBadge =
                row.endedAt !== null
                    ? 'ended'
                    : row.leaseLockedAt !== null
                      ? 'locked'
                      : open
                        ? failed
                            ? 'failed'
                            : 'open'
                        : 'signed-in';
            const unread = row.unread !== null && row.unread > 0 ? row.unread : null;
            const host = new URL(row.origin).host;
            // Only the open workspace's outbox sends; every other one's waits.
            const waitingLabel = !open && row.waiting !== null && row.waiting > 0 ? OUTBOX_COPY.waitingToSend : null;
            return {
                id: row.id,
                name: row.name,
                host,
                personName: row.personName,
                personEmail: row.personEmail,
                badge,
                badgeLabel: BADGE_LABEL[badge],
                unread,
                unreadLabel: unread === null ? null : unreadLabel(unread),
                open,
                waitingLabel,
                accessibilityLabel: [
                    row.name,
                    host,
                    row.personName,
                    row.personEmail,
                    BADGE_LABEL[badge],
                    waitingLabel,
                    unread === null ? null : `${unread} unread`,
                ]
                    .filter((part) => part !== null && part !== '')
                    .join(', '),
            };
        });
}

/** The open workspace's unread, for the registry's summary: its chat list's (a room's unread, each capped). */
export const workspaceUnread = (chats: readonly Pick<ChatRow, 'unread'>[]): number =>
    chats.reduce((sum, chat) => sum + (chat.unread ?? 0), 0);

/** The registry's summary of the open workspace: its name as people see it (`workspaceName`) and its unread. */
export function workspaceSummary(
    state: Pick<ShellState, 'settings'>,
    chats: readonly Pick<ChatRow, 'unread'>[],
    row: { readonly name: string; readonly origin: string },
): { name: string; unread: number } {
    return { name: workspaceName(state, row), unread: workspaceUnread(chats) };
}

/** The question before signing out of a workspace with unsent items. Cancel is the default. */
export interface SignOutQuestion {
    readonly title: string;
    readonly message: string;
    readonly confirm: string;
    readonly cancel: string;
}

/**
 * The question to ask before signing out, or null when there's nothing to ask:
 * `unsent` is the workspace's outbox and unsent rows, or null when they
 * couldn't be counted, which is never taken as none.
 */
export function signOutQuestion(unsent: number | null): SignOutQuestion | null {
    if (unsent === 0) {
        return null;
    }
    const items =
        unsent === null ? "Anything you haven't sent yet" : unsent === 1 ? '1 unsent item' : `${unsent} unsent items`;
    return {
        title: 'Sign out?',
        message: `${items} will be deleted from this phone with the rest of this workspace.`,
        confirm: 'Sign out',
        cancel: 'Cancel',
    };
}

/** Leave workspace (CB-383): the row's words, as the web's Settings → Account → Profile → Leave workspace. */
export const LEAVE_WORKSPACE = 'Leave workspace';

/** The question before leaving (CB-383). Cancel is the default; Leave workspace is destructive. */
export function leaveQuestion(workspace: string, unsent: number | null): SignOutQuestion {
    const lost =
        unsent === 0
            ? ''
            : unsent === null
              ? ' Anything you haven’t sent yet will be deleted from this phone.'
              : ` ${unsent === 1 ? '1 unsent item' : `${unsent} unsent items`} will be deleted from this phone.`;
    return {
        title: `Leave ${workspace}?`,
        message:
            'You’ll be signed out on every device and lose access. What you shared stays with the team. ' +
            `An admin can let you back in.${lost}`,
        confirm: LEAVE_WORKSPACE,
        cancel: 'Cancel',
    };
}

/** The alert's title when leaving didn't happen: the reason (the server's, or ours) goes under it. */
export const LEAVE_REFUSED_TITLE = 'Couldn’t leave the workspace';

/**
 * The Leave workspace row, by the server's check: hidden for a server without
 * the endpoint, shown off while checking, off with the reason under it when
 * refused or unknown.
 */
export function leaveRow(
    check:
        | { readonly kind: 'checking' | 'allowed' | 'unsupported' | 'unknown' }
        | { readonly kind: 'refused'; readonly message: string },
): { readonly enabled: boolean; readonly note: string | null } | null {
    switch (check.kind) {
        case 'unsupported':
            return null;
        case 'allowed':
            return { enabled: true, note: null };
        case 'checking':
            return { enabled: false, note: null };
        case 'refused':
            return { enabled: false, note: check.message };
        case 'unknown':
            return { enabled: false, note: LEAVE_CHECK_FAILED };
    }
}

/** The web's Help: its written help center (packages/client's help module, `opens: { path: '/docs' }`). */
export const HELP_HREF = '/docs';

/** Where a row of the person's menus goes: a screen of the app's own, or a page of the web in the in-app browser. */
export type AccountLinkTarget = { readonly kind: 'file-issue' } | { readonly kind: 'web'; readonly href: string };

/** A row of the account sheet's links. */
export interface AccountLink {
    readonly key: 'report-issue' | 'guides' | 'release-notes' | 'account-security';
    readonly label: string;
    readonly target: AccountLinkTarget;
    readonly testID: string;
}

/** The hint of a row that opens the web, as Settings' "Everything else". */
export const OPENS_ON_THE_WEB = 'Opens in your browser';

/**
 * The account sheet's links, the web's person menu (components/nav-user.tsx,
 * in its order): Report issue (the app's own File an issue), Getting started &
 * guides (the getting-started guide's article, the web's guides being an
 * overlay with no address), Release notes (`/releases`) and Account & security
 * (`settingsPath('account')`). Theme is the app's Settings → Appearance, and Sign
 * out follows them.
 */
export const ACCOUNT_LINKS: readonly AccountLink[] = [
    { key: 'report-issue', label: 'Report issue', target: { kind: 'file-issue' }, testID: 'account-report-issue' },
    {
        key: 'guides',
        label: 'Getting started & guides',
        target: { kind: 'web', href: '/docs/getting-started' },
        testID: 'account-guides',
    },
    {
        key: 'release-notes',
        label: 'Release notes',
        target: { kind: 'web', href: '/releases' },
        testID: 'account-release-notes',
    },
    {
        key: 'account-security',
        label: 'Account & security',
        target: { kind: 'web', href: '/settings/account' },
        testID: 'account-security',
    },
];

/** Home's ⋯ menu, the web's phone header menu (shell/AppHeader.tsx): what each row does. */
export type HomeMenuName = 'report-issue' | 'pause-all' | 'resume-all';

export const REPORT_ISSUE = 'Report issue';
export const PAUSE_ALL = 'Pause all socios';
export const RESUME_ALL = 'Resume all socios';
export const HOME_MENU_LABEL = 'More actions';

/**
 * Home's ⋯ menu: Report issue, then for an admin Pause all socios, or Resume
 * all socios while the workspace is paused (the web shows Pause to admins
 * only: the server takes `paused` from admins alone).
 */
export function homeMenu(
    role: Role | null | undefined,
    paused: boolean,
): readonly { readonly name: HomeMenuName; readonly label: string; readonly destructive?: boolean }[] {
    // An older server may still send the retired `operator` role (CB-390).
    const admin = normalizeRole(role) === 'admin';
    return [
        { name: 'report-issue', label: REPORT_ISSUE },
        ...(admin
            ? [
                  paused
                      ? { name: 'resume-all' as const, label: RESUME_ALL }
                      : { name: 'pause-all' as const, label: PAUSE_ALL },
              ]
            : []),
    ];
}

/** The question before pausing every socio. Cancel is the default; resuming asks nothing (the web asks neither). */
export const PAUSE_QUESTION: SignOutQuestion = {
    title: 'Pause all socios?',
    message: 'Active compute stops and scheduled tasks wait until an admin resumes them.',
    confirm: 'Pause all',
    cancel: 'Cancel',
};

/** The workspace's settings, where `paused` lives (the web's `PATCH /api/settings`, admins only). */
export const SETTINGS_PATH = '/api/settings';

/** Said when the server didn't take a pause or a resume. */
export const PAUSE_FAILED = 'Couldn’t change that. Check your connection and try again.';

/**
 * Pauses (or resumes) every socio, as the web's header does: `PATCH
 * /api/settings` with `{ paused }`, online only. Resolves whether the server
 * took it; never rejects.
 */
export async function setAllPaused(
    fetch: (path: string, init: { method: string; json: unknown }) => Promise<{ readonly ok: boolean }>,
    paused: boolean,
): Promise<boolean> {
    try {
        const response = await fetch(SETTINGS_PATH, { method: 'PATCH', json: { paused } });
        return response.ok;
    } catch {
        return false;
    }
}
