import { MODULE_IDS } from '@socio/shared/modules';

import { joinPath, workspaceLayout } from '../data/layout';
import type { WorkspaceRow } from '../data/registry';

import { HELP_HREF, switcherRows } from './account';

// The workspace drawer's rows (Slack's): every ready workspace on
// the phone, in the switcher's order (the open one first, then the most
// recently used; account.ts), each with its logo (the staged file the registry
// names, else the bundled mascot), name, host, unread and whether it is the
// open one; a state the person must know (signed out, locked, didn't open), or
// its queue waiting to send while another workspace is open, is said under the
// host. Then Add a workspace, Settings and Help, the web's help center in the
// in-app browser while the app has no help of its own. No React Native,
// so tests/shell runs it under Node.

export interface DrawerWorkspace {
    readonly id: string;
    readonly name: string;
    /** The origin's host (and port). */
    readonly host: string;
    /** The logo's path on the phone, or null for the bundled mascot. */
    readonly logoPath: string | null;
    /** `3`, or `99+`; null with no unread. */
    readonly unreadLabel: string | null;
    /** The open workspace: highlighted, and tapping it only closes the drawer. */
    readonly active: boolean;
    /** Signed out, Locked or Didn’t open; else Waiting to send while its outbox holds rows; null while it is fine. */
    readonly notice: string | null;
    readonly testID: string;
    readonly accessibilityLabel: string;
}

type Source = Pick<
    WorkspaceRow,
    | 'id'
    | 'origin'
    | 'state'
    | 'name'
    | 'logo'
    | 'personName'
    | 'personEmail'
    | 'lastUsed'
    | 'endedAt'
    | 'leaseLockedAt'
    | 'unread'
    | 'waiting'
>;

/** A logo file name the registry may hold: a plain name, never a path. */
const SAFE_LOGO = /^logo\.(?:png|jpg|webp)$/;

/** Where workspace `id`'s logo is on the phone, or null for the bundled mascot (none, or a name that isn't one). */
export const workspaceLogoPath = (root: string, id: string, logo: string | null): string | null =>
    logo !== null && SAFE_LOGO.test(logo) ? joinPath(workspaceLayout(root, id).directory, logo) : null;

/** The drawer's workspaces from the registry's rows; `root` is the app's document directory. */
export function drawerWorkspaces(
    rows: readonly Source[],
    openId: string | null,
    root: string,
    { failed = false }: { failed?: boolean } = {},
): DrawerWorkspace[] {
    const logos = new Map(rows.map((row) => [row.id, row.logo]));
    return switcherRows(rows, openId, { failed }).map((row) => {
        const logo = logos.get(row.id) ?? null;
        const notice = row.badge === 'open' || row.badge === 'signed-in' ? row.waitingLabel : row.badgeLabel;
        return {
            id: row.id,
            name: row.name,
            host: row.host,
            logoPath: workspaceLogoPath(root, row.id, logo),
            unreadLabel: row.unreadLabel,
            active: row.open,
            notice,
            testID: `drawer-workspace-${row.host}`,
            accessibilityLabel: [
                row.name,
                row.host,
                row.open ? 'current workspace' : null,
                notice,
                row.unread === null ? null : `${row.unread} unread`,
            ]
                .filter((part) => part !== null)
                .join(', '),
        };
    });
}

/** What a footer row does: start adding a workspace, open Settings' page, or open a page of the web. */
export type DrawerFooterAction =
    | { readonly kind: 'add-workspace' }
    | { readonly kind: 'settings'; readonly id: typeof MODULE_IDS.settings }
    /** The open workspace's page, in the in-app browser; shown only while a workspace is open. */
    | { readonly kind: 'web'; readonly href: string };

export interface DrawerFooterRow {
    readonly key: 'add-workspace' | 'settings' | 'help';
    readonly label: string;
    readonly action: DrawerFooterAction;
    readonly testID: string;
}

/** Under the list, as Slack's: Add a workspace, Settings (its page) and Help (the web's). */
export const DRAWER_FOOTER: readonly DrawerFooterRow[] = [
    {
        key: 'add-workspace',
        label: 'Add a workspace',
        action: { kind: 'add-workspace' },
        testID: 'drawer-add-workspace',
    },
    {
        key: 'settings',
        label: 'Settings',
        action: { kind: 'settings', id: MODULE_IDS.settings },
        testID: 'drawer-settings',
    },
    {
        key: 'help',
        label: 'Help',
        action: { kind: 'web', href: HELP_HREF },
        testID: 'drawer-help',
    },
];
