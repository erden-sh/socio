import type { FlagKey } from '@socio/shared/flags';
import { isAdmin, isOperator } from '@socio/shared/roles';
import type { WorkspaceState } from '@socio/shared/types';

/** The pages under `/settings/:section`. */
export const SETTINGS_SECTIONS = [
    'workspace',
    'people',
    'access',
    'secrets',
    'data-api',
    'chat-skills',
    'deleted-spaces',
    'features',
    'coding',
    'account',
    'notifications',
    'inference',
    'archived-chats',
    'connected-agents',
    'telegram',
    'socio-access',
    'early-access',
    'features-dev',
    'performance',
] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];

/** Where `/settings` (the old Settings dialog's address) lands. */
export const SETTINGS_HOME = '/settings/workspace';
export const settingsPath = (section: SettingsSectionId) => `/settings/${section}`;

/**
 * Old section addresses and where they went: Service accounts became a tab
 * of People (CB-360). Each opens for whoever may open its new page.
 */
export const MOVED_SECTIONS: Record<string, { section: SettingsSectionId; to: string }> = {
    'service-accounts': { section: 'people', to: '/settings/people?tab=service-accounts' },
};
export const movedSection = (id: string | undefined) =>
    id && Object.hasOwn(MOVED_SECTIONS, id) ? MOVED_SECTIONS[id] : undefined;

/** Who is looking: what decides which sections they have. */
export interface SettingsAccess {
    admin: boolean;
    operator: boolean;
    /** Real accounts (Better Auth); unknown (false) until the session loads. */
    signIn: boolean;
    /** The Telegram bot is configured. */
    telegram: boolean;
    /** The feature flags on for them (CB-169); a flagged section needs its. */
    flags?: readonly string[];
    /** An internal deployment (CB-503): it lists flags in development. */
    internal?: boolean;
}

export interface SettingsEntry {
    id: SettingsSectionId | 'operator';
    label: string;
    path: string;
    /**
     * For admins. `operator` is the former operators-only marker, now the
     * admin check too (CB-390), kept for the Platform page until it
     * moves.
     */
    role?: 'admin' | 'operator';
    /** Only with real accounts (Better Auth). */
    signIn?: boolean;
    telegram?: boolean;
    /** Only while this feature flag is on for them (a dark feature). */
    flag?: FlagKey;
    /** Only in an internal deployment (`SOCIO_DEPLOYMENT_KIND=internal`, CB-503). */
    internal?: boolean;
    /** Has pages below it (People's person pages): its link stays current there. */
    nested?: boolean;
}

export interface SettingsGroup {
    label: string;
    description: string;
    entries: SettingsEntry[];
}

const entry = (id: SettingsSectionId, label: string, rest: Partial<SettingsEntry> = {}): SettingsEntry => ({
    id,
    label,
    path: settingsPath(id),
    ...rest,
});

/**
 * The section nav, in two groups: what the workspace may do and how it is
 * set up, then the signed-in person's own account (the "Account → …" the
 * app's messages name). Platform, for admins, lives at
 * `/settings/operator` in its own module.
 */
export const SETTINGS_GROUPS: SettingsGroup[] = [
    {
        label: 'Workspace',
        description: 'Your workspace, your rules: what socios may do, who signs in, and how this server is set up.',
        entries: [
            entry('workspace', 'General'),
            // Everyone who signs in, and the service accounts as its tab
            // (CB-360); its People tab needs real accounts and says so.
            entry('people', 'People', { role: 'admin', nested: true }),
            // Sign-in (CB-124): admins (CB-390).
            entry('access', 'Access', { role: 'admin' }),
            // Socio Secrets, phase 1: workspace apps' secrets, write-only.
            entry('secrets', 'Secrets', { role: 'admin' }),
            // Admins' data API tokens, for their own scripts on the company's datasets.
            entry('data-api', 'Data API', { role: 'admin' }),
            entry('chat-skills', 'Chat skills', { role: 'admin' }),
            // Deleted Spaces and their restore (CB-277).
            entry('deleted-spaces', 'Deleted Spaces', { role: 'admin' }),
            // Feature flags (CB-503): released ones that stay as switches,
            // experimental early access, and, in an internal deployment only,
            // flags in development. Admins decide each; no one opts in alone.
            entry('features', 'Optional features', { role: 'admin' }),
            entry('early-access', 'Early access', { role: 'admin' }),
            entry('features-dev', 'In development', { role: 'admin', internal: true }),
            // The coding gateway's models and limits (CB-239), while dark.
            entry('coding', 'Coding', { role: 'admin', flag: 'coding-sessions' }),
            {
                id: 'operator',
                label: 'Platform',
                path: '/settings/operator',
                role: 'operator',
            },
        ],
    },
    {
        label: 'Account',
        description:
            'The model your chats use, how socios reach you, your archived chats, and how you sign in to Socio.',
        entries: [
            entry('account', 'Profile'),
            entry('notifications', 'Notifications'),
            entry('inference', 'Inference'),
            entry('archived-chats', 'Archived chats'),
            entry('connected-agents', 'Connected agents', { signIn: true }),
            entry('telegram', 'Telegram', { telegram: true }),
            // CB-232: which socios may use apps for this person.
            entry('socio-access', 'Socio access', { flag: 'socio-actor-access' }),
            entry('performance', 'Performance'),
        ],
    },
];

/** The group a page is listed in (Platform's, for its own module). */
export const groupOf = (id: SettingsEntry['id']) =>
    SETTINGS_GROUPS.find((group) => group.entries.some((item) => item.id === id))!;

export const settingsAccess = (workspace: WorkspaceState, signIn: boolean): SettingsAccess => ({
    admin: isAdmin(workspace.user),
    operator: isOperator(workspace.user),
    signIn,
    telegram: workspace.setup.telegram !== 'not_configured',
    flags: workspace.flags?.on ?? [],
    internal: workspace.flags?.internal === true,
});

/**
 * Whether a section may open at all: its role, Telegram and its feature
 * flag. Sections that
 * need real accounts open anyway and say so, since the sign-in methods
 * load after the page renders.
 */
export const allowed = (item: SettingsEntry, access: SettingsAccess) =>
    (!item.role || access[item.role]) &&
    (!item.telegram || access.telegram) &&
    (!item.internal || access.internal === true) &&
    (!item.flag || !!access.flags?.includes(item.flag));

/** Whether the nav lists a section. */
export const listed = (item: SettingsEntry, access: SettingsAccess) =>
    allowed(item, access) && (!item.signIn || access.signIn);

/** A settings page by its `:section`, with its group. */
export function findSection(
    id: string | undefined,
): { group: SettingsGroup; item: SettingsEntry & { id: SettingsSectionId } } | undefined {
    for (const group of SETTINGS_GROUPS) {
        for (const item of group.entries) {
            if (item.id === id && item.id !== 'operator') {
                return { group, item: { ...item, id: item.id } };
            }
        }
    }
    return undefined;
}
