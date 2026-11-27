import { useTranslation } from '@socio/i18n/react';
import { ASSET_KINDS, type AssetKind, type DeactivationImpact, type RosterPerson } from '@socio/shared/auth';
import { APP_LOCALE, compareText, lowerText } from '@socio/shared/locale';
import { normalizeRole } from '@socio/shared/roles';
import type { Role } from '@socio/shared/types';

/**
 * The words People shows for each person (CB-360), from the roster
 * (`GET /api/accounts/roster`). The words come from `usePeopleFormat()`
 * (`settings.people`) and `useAssetWords()` (`settings.person`); the rest
 * of this file sorts, filters and decides, without copy.
 */

export type PersonState = 'active' | 'invited' | 'invite-expired' | 'deactivated';

/** Every state, in the Status filter's order. */
export const PERSON_STATES: readonly PersonState[] = ['active', 'invited', 'invite-expired', 'deactivated'];

export const stateOf = (person: RosterPerson): PersonState =>
    person.status === 'invited' && person.invite?.expired ? 'invite-expired' : person.status;

/** Their initials, for the avatar: "Ana Ops" is AO, "CI" is CI, "cleo" is CL. */
export function initials(name: string) {
    const words = name.trim().split(/\s+/).filter(Boolean);
    const letters =
        words.length > 1 ? [[...words[0]!][0]!, [...words[words.length - 1]!][0]!] : [...(words[0] ?? '')].slice(0, 2);
    return letters.join('').toLocaleUpperCase(APP_LOCALE) || '?';
}

/** "Ben Admin" is Ben: what the deactivate dialog's button says. */
export const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** Active by name, then invited, then deactivated. */
const ORDER: Record<RosterPerson['status'], number> = { active: 0, invited: 1, deactivated: 2 };
export const byStatusThenName = (a: RosterPerson, b: RosterPerson) =>
    ORDER[a.status] - ORDER[b.status] || compareText(a.name, b.name);

export interface PeopleFilter {
    query: string;
    role: Role | '';
    state: PersonState | '';
}

export const matches = (person: RosterPerson, { query, role, state }: PeopleFilter) => {
    const words = lowerText(query.trim());
    return (
        (!words || lowerText(`${person.name} ${person.email}`).includes(words)) &&
        (!role || person.role === role) &&
        (!state || stateOf(person) === state)
    );
};

/** Active in the last 10 minutes: the list's green dot. */
export const ACTIVE_NOW_MS = 10 * 60_000;

/** One sign-in method chip; `warn` for "Password only". */
export interface SignInChip {
    label: string;
    warn?: boolean;
}

/**
 * A provider's id as its name: `google` is Google (a brand name, not copy).
 * The Socio app's own Google and Apple links (CB-570) are `google-native`
 * and `apple-native`: `usePeopleFormat` names them (`signIn.native`).
 */
const providerLabel = (id: string) => (id ? id[0]!.toLocaleUpperCase(APP_LOCALE) + id.slice(1) : id);

/** A provider's name, the app's own links (`settings:providers`) included. */
export function useProviderLabel() {
    const { t } = useTranslation(['settings']);
    return (id: string) =>
        id === 'google-native' || id === 'apple-native' ? t(`settings:providers.${id}`) : providerLabel(id);
}

/** Taking something away: admin to member. */
const RANK: Record<Role, number> = { admin: 1, member: 0 };
export const isDemotion = (from: Role, to: Role) => RANK[to] < RANK[from];

/** One "Also ends" line of the deactivate preview: what, and what happens to it. */
export interface ImpactLine {
    what: string;
    outcome: string;
}

/** Where the Service accounts tab is, at one account (the preview's link). */
export const serviceAccountPath = (accountId?: string) =>
    `/settings/people?tab=service-accounts${accountId ? `&account=${encodeURIComponent(accountId)}` : ''}`;

export const personPath = (id: string) => `/settings/people/${encodeURIComponent(id)}`;

/** A browser's and a system's names, from a user agent: brand names, not copy. */
function deviceParts(userAgent: string) {
    const browser = /Edg\//.test(userAgent)
        ? 'Edge'
        : /Firefox\//.test(userAgent)
          ? 'Firefox'
          : /Chrome\/|CriOS\//.test(userAgent)
            ? 'Chrome'
            : /Safari\//.test(userAgent)
              ? 'Safari'
              : null;
    const system = /iPhone/.test(userAgent)
        ? 'iPhone'
        : /iPad/.test(userAgent)
          ? 'iPad'
          : /Android/.test(userAgent)
            ? 'Android'
            : /Mac OS X|Macintosh/.test(userAgent)
              ? 'macOS'
              : /Windows/.test(userAgent)
                ? 'Windows'
                : /Linux/.test(userAgent)
                  ? 'Linux'
                  : null;
    return [browser, system].filter(Boolean);
}

// ── Ownership transfer and permanent removal (CB-360) ─────────────────────

/** The non-empty kinds of a count by kind, in `ASSET_KINDS` order. */
export const ownedKinds = (owned: Partial<Record<AssetKind, number>>) =>
    ASSET_KINDS.filter((kind) => (owned[kind] ?? 0) > 0).map((kind) => ({ kind, count: owned[kind]! }));

/** What a transfer moved of one kind, in the server's words: "3 tasks, 1 job"; empty when none. */
export function movedParts(moved: Record<string, number>) {
    return Object.entries(moved)
        .filter(([, n]) => n > 0)
        .map(([what, n]) => `${n} ${what.replace(/_/g, ' ')}`)
        .join(', ');
}

/** 0 B, 12 KB, 3.4 MB: the removal's files and objects. */
export function byteSize(bytes: number) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${unit && value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** What a blocker means, in the admin's terms (`settings.person-dialogs:remove.help.<id>`). */
export type BlockerHelp = 'owned' | 'deactivate' | 'self' | 'lastAdmin' | 'owner' | 'listed' | 'unpurged' | 'protected';

/** What blocks a permanent removal, and what to do about it. */
export interface Blocker {
    /** The server's words. */
    text: string;
    /** What it means, when known. */
    help?: BlockerHelp;
    /** What to do first, when the page offers it. */
    action?: 'transfer' | 'deactivate';
}

/** Explains each of the purge dry run's refusals (`PersonPurgePlan.refusals`). */
export function blockerOf(text: string): Blocker {
    if (/still own/i.test(text)) {
        return { text, help: 'owned', action: 'transfer' };
    }
    if (/deactivate (them|the account) first/i.test(text)) {
        return { text, help: 'deactivate', action: 'deactivate' };
    }
    if (/remove yourself/i.test(text)) {
        return { text, help: 'self' };
    }
    if (/keep at least one admin/i.test(text)) {
        return { text, help: 'lastAdmin' };
    }
    if (/workspace owner/i.test(text)) {
        return { text, help: 'owner' };
    }
    if (/is under a listed/i.test(text)) {
        return { text, help: 'listed', action: 'transfer' };
    }
    if (/the purge doesn.t remove those/i.test(text)) {
        return { text, help: 'unpurged' };
    }
    if (/protected/i.test(text)) {
        return { text, help: 'protected' };
    }
    return { text };
}

/**
 * What the workspace owner's protection (CB-390) does to an account's
 * actions, as `me` (the signed-in app user id) sees them: `others`, it is
 * the owner's account and only the owner changes it (role, deactivation,
 * removal, sessions, devices, password links, transfers); `self`, it is my
 * own account as the owner, which stays an active admin until I make
 * another admin the owner. Undefined: nothing extra applies.
 */
export type OwnerLock = 'others' | 'self';
export function ownerLock(person: { owner?: boolean; userId: string }, me: string | undefined): OwnerLock | undefined {
    if (!person.owner) {
        return undefined;
    }
    return person.userId && person.userId === me ? 'self' : 'others';
}

const STATE_KEYS = {
    active: 'settings.people:state.active',
    invited: 'settings.people:state.invited',
    'invite-expired': 'settings.people:state.invite-expired',
    deactivated: 'settings.people:state.deactivated',
} as const satisfies Record<PersonState, string>;

const ROLE_KEYS = {
    admin: 'settings.people:roles.admin',
    member: 'settings.people:roles.member',
} as const satisfies Record<Role, string>;

const OWNER_LOCK_KEYS = {
    others: 'settings.people:ownerLock.others',
    self: 'settings.people:ownerLock.self',
} as const satisfies Record<OwnerLock, string>;

/**
 * The People wording (`settings.people`), as functions a component calls:
 * last active, dates, states, roles, sign-in methods, reach, devices and
 * the owner's lock.
 */
export function usePeopleFormat() {
    const { t } = useTranslation(['settings.people']);
    const providerName = useProviderLabel();
    /** "Oct 2" this year, "Oct 2, 2025" before. */
    const shortDate = (at: number | string, now = Date.now()) => {
        const ms = typeof at === 'number' ? at : Date.parse(at);
        return new Date(ms).getFullYear() === new Date(now).getFullYear()
            ? t('settings.people:lastActive.date', { at: new Date(ms) })
            : t('settings.people:lastActive.dateYear', { at: new Date(ms) });
    };
    /**
     * "Now", "25 min ago", "3 h ago", "Yesterday", "3 days ago", "2 weeks
     * ago", "Oct 2"; `inline` inside a sentence ("now", "yesterday").
     */
    const lastActive = (at: number, now = Date.now(), inline = false) => {
        const context = inline ? 'inline' : undefined;
        const ms = Math.max(0, now - at);
        if (ms < ACTIVE_NOW_MS) {
            return t('settings.people:lastActive.now', { context });
        }
        if (ms < 3_600_000) {
            return t('settings.people:lastActive.minutes', { count: Math.round(ms / 60_000) });
        }
        if (ms < 86_400_000) {
            return t('settings.people:lastActive.hours', { count: Math.round(ms / 3_600_000) });
        }
        const days = Math.floor(ms / 86_400_000);
        if (days === 1) {
            return t('settings.people:lastActive.yesterday', { context });
        }
        if (days < 14) {
            return t('settings.people:lastActive.days', { count: days });
        }
        if (days < 35) {
            return t('settings.people:lastActive.weeks', { count: Math.floor(days / 7) });
        }
        return shortDate(at, now);
    };
    /** A moment to the second, for a tooltip or a tile's note. */
    const exactTime = (at: number | string) => t('settings.people:lastActive.exact', { at: new Date(at) });
    const stateLabel = (state: PersonState) => t(STATE_KEYS[state]);
    const roleLabel = (role: Role) => t(ROLE_KEYS[normalizeRole(role)]);
    const ownerLockTitle = (lock: OwnerLock) => t(OWNER_LOCK_KEYS[lock]);
    /** The admin's "Send sign-in link", worded by the channel it goes by (CB-352). */
    const signInLinkWords = (via: RosterPerson['signInLinkVia']) => {
        if (via !== 'email' && via !== 'telegram') {
            return null;
        }
        return {
            action: t('settings.people:signInLink.action', { context: via }),
            sent: (name: string) => t('settings.people:signInLink.sent', { context: via, name }),
        };
    };
    /**
     * How they sign in, as chips: passkeys, password, providers and a linked
     * Telegram. A password and nothing else is a warning; none is said in
     * words.
     */
    const signInChips = (person: RosterPerson): SignInChip[] | string => {
        if (person.status === 'deactivated') {
            return t('settings.people:signIn.cantSignIn');
        }
        const telegram = person.signInLinkVia === 'telegram' || !!person.reach?.telegram;
        const chips: SignInChip[] = [];
        if (person.passkeys) {
            chips.push({ label: t('settings.people:signIn.passkey', { count: person.passkeys }) });
        }
        if (person.password) {
            const only = !person.passkeys && !person.providers.length && !telegram;
            chips.push(
                only
                    ? { label: t('settings.people:signIn.passwordOnly'), warn: true }
                    : { label: t('settings.people:signIn.password') },
            );
        }
        for (const provider of person.providers) {
            chips.push({ label: providerName(provider) });
        }
        if (telegram) {
            chips.push({ label: t('settings.people:signIn.telegram') });
        }
        return chips.length ? chips : t('settings.people:signIn.nothing');
    };
    /** "5 Spaces · 3 socios · 2 apps · code"; a deactivated person's apps only. */
    const reachSummary = (person: RosterPerson) => {
        const reach = person.reach;
        if (!reach) {
            return '—';
        }
        if (person.status === 'deactivated') {
            return reach.appsOwned
                ? t('settings.people:reach.ownsApps', { count: reach.appsOwned })
                : t('settings.people:reach.nothing');
        }
        const parts = [
            reach.spaces && t('settings.people:reach.spaces', { count: reach.spaces }),
            reach.socioGrants && t('settings.people:reach.socios', { count: reach.socioGrants }),
            reach.connectedAgents && t('settings.people:reach.agents', { count: reach.connectedAgents }),
            reach.appsOwned && t('settings.people:reach.apps', { count: reach.appsOwned }),
            reach.keysMade && t('settings.people:reach.keysMade', { count: reach.keysMade }),
            reach.codeAccess && t('settings.people:reach.code'),
        ].filter(Boolean);
        return parts.length ? parts.join(' · ') : t('settings.people:reach.nothingYet');
    };
    /** "3 devices". */
    const devices = (count: number) => t('settings.people:devices', { count });
    /**
     * A signed-in device in words, from its user agent (the person page's
     * Sign-in & devices tab): "Chrome · macOS", "Safari · iPhone".
     */
    const deviceLabel = (userAgent: string | null) => {
        if (!userAgent) {
            return t('settings.people:unknownDevice');
        }
        const parts = deviceParts(userAgent);
        return parts.length ? parts.join(' · ') : userAgent.slice(0, 40);
    };
    /** How a session signed in: `password`, `passkey`, `link` or `provider:<id>`. */
    const signInMethodLabel = (method: string | null) => {
        if (!method) {
            return null;
        }
        if (method.startsWith('provider:')) {
            return providerName(method.slice('provider:'.length));
        }
        return method === 'link'
            ? t('settings.people:signIn.method.link')
            : method === 'link:email'
              ? t('settings.people:signIn.method.linkEmail')
              : method === 'password'
                ? t('settings.people:signIn.method.password')
                : method === 'passkey'
                  ? t('settings.people:signIn.method.passkey')
                  : providerName(method);
    };
    return {
        shortDate,
        lastActive,
        exactTime,
        stateLabel,
        roleLabel,
        ownerLockTitle,
        signInLinkWords,
        signInChips,
        reachSummary,
        devices,
        deviceLabel,
        signInMethodLabel,
    };
}

/** The person page's words for what someone owns (`settings.person:assets`), and the deactivate preview's. */
export function useAssetWords() {
    const { t } = useTranslation(['settings.person']);
    const assetTitle = (kind: AssetKind) => t(`settings.person:assets.${kind}.title`);
    /** What moves of the kind. */
    const assetWhat = (kind: AssetKind) => t(`settings.person:assets.${kind}.what`);
    /** "3 schedules", "1 Space membership". */
    const assetCount = (kind: AssetKind, count: number) => t(`settings.person:assets.${kind}.count`, { count });
    /** The preview's "Also ends", non-zero lines only; `first` is their first name. */
    return { assetTitle, assetWhat, assetCount };
}

/** The deactivate preview's words for what else ends (`settings.person-dialogs`). */
export function useImpactWords() {
    const { t } = useTranslation(['settings.person-dialogs']);
    const alsoEnds = (impact: DeactivationImpact, first: string): ImpactLine[] => {
        const lines: (ImpactLine | false)[] = [
            impact.sessions > 0 && {
                what: t('settings.person-dialogs:deactivate.ends.sessions', { count: impact.sessions }),
                outcome: t('settings.person-dialogs:deactivate.outcomes.signedOut'),
            },
            impact.connectedAgents > 0 && {
                what: t('settings.person-dialogs:deactivate.ends.connectedAgents', { count: impact.connectedAgents }),
                outcome: t('settings.person-dialogs:deactivate.outcomes.disconnected'),
            },
            impact.socioGrants > 0 && {
                what: t('settings.person-dialogs:deactivate.ends.socioGrants', { count: impact.socioGrants }),
                outcome: t('settings.person-dialogs:deactivate.outcomes.revoked'),
            },
            impact.appSessions > 0 && {
                what: t('settings.person-dialogs:deactivate.ends.appSessions', { count: impact.appSessions }),
                outcome: t('settings.person-dialogs:deactivate.outcomes.ended'),
            },
            impact.pluginAccess > 0 && {
                what: t('settings.person-dialogs:deactivate.ends.pluginAccess', { count: impact.pluginAccess }),
                outcome: t('settings.person-dialogs:deactivate.outcomes.ended'),
            },
            impact.scheduledTasks > 0 && {
                what: t('settings.person-dialogs:deactivate.ends.scheduledTasks', { count: impact.scheduledTasks }),
                outcome: t('settings.person-dialogs:deactivate.outcomes.paused'),
            },
            impact.jobRuns > 0 && {
                what: t('settings.person-dialogs:deactivate.ends.jobRuns', { count: impact.jobRuns }),
                outcome: t('settings.person-dialogs:deactivate.outcomes.stopped'),
            },
            impact.subscriptionConnections > 0 && {
                what: t('settings.person-dialogs:deactivate.ends.subscriptionConnections', {
                    count: impact.subscriptionConnections,
                }),
                outcome: t('settings.person-dialogs:deactivate.outcomes.disconnected'),
            },
            impact.mcpConnections > 0 && {
                what: t('settings.person-dialogs:deactivate.ends.mcpConnections', { count: impact.mcpConnections }),
                outcome: t('settings.person-dialogs:deactivate.outcomes.disconnected'),
            },
            impact.rooms.handedOver > 0 && {
                what: t('settings.person-dialogs:deactivate.ends.roomsHandedOver', {
                    count: impact.rooms.handedOver,
                    first,
                }),
                outcome: t('settings.person-dialogs:deactivate.outcomes.handedOver'),
            },
            impact.rooms.archived > 0 && {
                what: t('settings.person-dialogs:deactivate.ends.roomsArchived', { count: impact.rooms.archived }),
                outcome: t('settings.person-dialogs:deactivate.outcomes.archived'),
            },
        ];
        return lines.filter((line): line is ImpactLine => !!line);
    };
    return { alsoEnds };
}
