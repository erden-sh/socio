import { formatSize } from '@socio/shared/text/format-size';

import type { Appearance } from '../data/registry';

// Settings' words and rows: a big
// title with a line under it, as the web's settings page; Appearance (Light,
// Dark or System, then haptics); the person's name, read-only; the open
// workspace's local cache with Clear cache; Advanced mode; and "Everything
// else", the workspace's settings on the web. No React Native, so tests/shell
// runs it under Node.

export type SettingKey = 'haptics' | 'advanced';

export interface SwitchRow {
    readonly key: SettingKey;
    readonly title: string;
    readonly subtitle: string;
    readonly testID: string;
}

export const HAPTICS_ROW: SwitchRow = {
    key: 'haptics',
    title: 'Haptics',
    subtitle: 'A light tap when you send, stop or finish something.',
    testID: 'settings-haptics',
};

export const ADVANCED_ROW: SwitchRow = {
    key: 'advanced',
    title: 'Advanced mode',
    subtitle:
        'For software engineers: shows tool calls, models, tokens, ids and error codes. It never changes what you can do.',
    testID: 'settings-advanced',
};

/** The local cache row's line: its size once it has been measured. */
export function cacheLine(bytes: number | null): string {
    return bytes === null ? 'Measuring…' : `${formatSize(bytes)} on this phone`;
}

/** What the local cache section says under its row. */
export const CACHE_NOTE =
    'Copies of chats, pages and pictures kept so the app opens fast and works offline. Clearing them downloads them again; messages waiting to send stay.';

/** The question before Clear cache. */
export const CLEAR_CACHE_QUESTION = {
    title: 'Clear cache?',
    message: 'The app downloads this workspace again. Messages waiting to send stay.',
    cancel: 'Cancel',
    confirm: 'Clear cache',
} as const;

/** What shows when Clear cache didn't finish. */
export const CLEAR_CACHE_FAILED = 'Couldn’t clear the cache. Try again.';

/** The page's heading, as the web's settings page has one: a title and a line under it. */
export const SETTINGS_HEADING = {
    title: 'Settings',
    description: 'How Socio looks and works on this phone. Everything else is in your workspace’s settings on the web.',
} as const;

/** Appearance's choices, in order: Light, Dark or System. */
export const APPEARANCE_CHOICES: readonly {
    readonly value: Appearance;
    readonly label: string;
    readonly testID: string;
}[] = [
    { value: 'light', label: 'Light', testID: 'settings-appearance-light' },
    { value: 'dark', label: 'Dark', testID: 'settings-appearance-dark' },
    { value: 'system', label: 'System', testID: 'settings-appearance-system' },
];

/** The Appearance choice's label for screen readers: the group's name, the choice and its place. */
export function appearanceLabel(choice: Appearance): string {
    const index = APPEARANCE_CHOICES.findIndex((item) => item.value === choice);
    const item = APPEARANCE_CHOICES[index]!;
    return `${APPEARANCE_TITLE}: ${item.label}, ${index + 1} of ${APPEARANCE_CHOICES.length}`;
}

export const APPEARANCE_TITLE = 'Appearance';
export const APPEARANCE_HINT = 'System follows your phone’s light or dark mode.';

/** Account: the person's name in the open workspace, read-only here. */
export interface AccountRow {
    readonly name: string;
    readonly email: string | null;
    readonly accessibilityLabel: string;
}

export const ACCOUNT_TITLE = 'Account';
/** Said under the name: it changes on the web, until the app saves it. */
export const ACCOUNT_NOTE = 'Your name as your workspace shows it. Change it in your profile on the web.';

/** The person's row, from the account view's name and email; null before either is known. */
export function accountRow(person: { readonly name: string | null; readonly email: string | null }): AccountRow | null {
    const name = person.name?.trim() || null;
    const email = person.email?.trim() || null;
    const shown = name ?? email;
    if (shown === null) {
        return null;
    }
    return {
        name: shown,
        email: name === null ? null : email,
        accessibilityLabel: [`Your name, ${shown}`, name === null ? null : email].filter(Boolean).join(', '),
    };
}

/** "Everything else links to the web's settings": the workspace's /settings in the browser. */
export const WEB_SETTINGS_ROW = {
    title: 'Everything else',
    subtitle: 'People, permissions, socios and the rest of your workspace’s settings.',
    hint: 'Opens in your browser',
    href: '/settings',
    testID: 'settings-web',
} as const;
