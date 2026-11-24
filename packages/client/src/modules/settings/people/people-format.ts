import { ASSET_KINDS, type AssetKind, type DeactivationImpact, type RosterPerson } from '@socio/shared/auth';
import { APP_LOCALE, compareText, lowerText } from '@socio/shared/locale';
import type { Role } from '@socio/shared/types';

/**
 * The words People shows for each person (CB-360), from the roster
 * (`GET /api/accounts/roster`).
 */

/** What the status badge says: an invite past its link's expiry is its own. */
/** The admin's "Send sign-in link", worded by the channel it goes by (CB-352). */
export function signInLinkWords(via: RosterPerson['signInLinkVia']) {
    if (via === 'email') {
        return { action: 'Send sign-in link by email', sent: 'by email' };
    }
    if (via === 'telegram') {
        return { action: 'Send sign-in link via Telegram', sent: 'on Telegram' };
    }
    return null;
}

export type PersonState = 'active' | 'invited' | 'invite-expired' | 'deactivated';

export const STATE_LABELS: Record<PersonState, string> = {
    active: 'Active',
    invited: 'Invited',
    'invite-expired': 'Invite expired',
    deactivated: 'Deactivated',
};

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

const dayFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const yearFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** "Now", "25 min ago", "3 h ago", "Yesterday", "3 days ago", "2 weeks ago", "Oct 2". */
export function lastActive(at: number, now = Date.now()) {
    const ms = Math.max(0, now - at);
    if (ms < ACTIVE_NOW_MS) {
        return 'Now';
    }
    if (ms < 3_600_000) {
        return `${Math.round(ms / 60_000)} min ago`;
    }
    if (ms < 86_400_000) {
        return `${Math.round(ms / 3_600_000)} h ago`;
    }
    const days = Math.floor(ms / 86_400_000);
    if (days === 1) {
        return 'Yesterday';
    }
    if (days < 14) {
        return `${days} days ago`;
    }
    if (days < 35) {
        return `${Math.floor(days / 7)} weeks ago`;
    }
    return (new Date(at).getFullYear() === new Date(now).getFullYear() ? dayFormat : yearFormat).format(at);
}

/** One sign-in method chip; `warn` for "Password only". */
export interface SignInChip {
    label: string;
    warn?: boolean;
}

const providerLabel = (id: string) => (id ? id[0]!.toLocaleUpperCase(APP_LOCALE) + id.slice(1) : id);

/**
 * How they sign in, as chips: passkeys, password, providers and a linked
 * Telegram. A password and nothing else is a warning; none is said in
 * words.
 */
export function signInChips(person: RosterPerson): SignInChip[] | string {
    if (person.status === 'deactivated') {
        return 'Can’t sign in';
    }
    const telegram = person.signInLinkVia === 'telegram' || !!person.reach?.telegram;
    const chips: SignInChip[] = [];
    if (person.passkeys) {
        chips.push({ label: person.passkeys > 1 ? `Passkey ×${person.passkeys}` : 'Passkey' });
    }
    if (person.password) {
        const only = !person.passkeys && !person.providers.length && !telegram;
        chips.push(only ? { label: 'Password only', warn: true } : { label: 'Password' });
    }
    for (const provider of person.providers) {
        chips.push({ label: providerLabel(provider) });
    }
    if (telegram) {
        chips.push({ label: 'Telegram' });
    }
    return chips.length ? chips : 'Nothing set up yet';
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "5 Spaces · 3 socios · 2 apps · code"; a deactivated person's apps only. */
export function reachSummary(person: RosterPerson) {
    const reach = person.reach;
    if (!reach) {
        return '—';
    }
    if (person.status === 'deactivated') {
        return reach.appsOwned ? `Owns ${count(reach.appsOwned, 'app')}` : 'Nothing';
    }
    const parts = [
        reach.spaces && count(reach.spaces, 'Space'),
        reach.socioGrants && count(reach.socioGrants, 'socio'),
        reach.connectedAgents && count(reach.connectedAgents, 'agent'),
        reach.appsOwned && count(reach.appsOwned, 'app'),
        reach.keysMade && `${count(reach.keysMade, 'key')} made`,
        reach.codeAccess && 'code',
    ].filter(Boolean);
    return parts.length ? parts.join(' · ') : 'Nothing yet';
}

/** Taking something away: admin to member. */
const RANK: Record<Role, number> = { admin: 1, member: 0 };
export const isDemotion = (from: Role, to: Role) => RANK[to] < RANK[from];

/** What a demotion ends, for its confirmation. */
export function demotionEnds(_from: Role, to: Role) {
    const ends: string[] = [];
    if (to === 'member') {
        ends.push(
            'the admin pages (People, Features, Secrets and the rest of the workspace’s settings) and what only admins may do',
            'their plugin sessions, which end now',
        );
    }
    return ends;
}

/** One "Also ends" line of the deactivate preview: what, and what happens to it. */
export interface ImpactLine {
    what: string;
    outcome: string;
}

/** The preview's "Also ends", non-zero lines only. */
export function alsoEnds(impact: DeactivationImpact, first: string): ImpactLine[] {
    const lines: (ImpactLine | false)[] = [
        impact.sessions > 0 && {
            what: `Sessions on ${count(impact.sessions, 'device')}`,
            outcome: 'signed out now',
        },
        impact.connectedAgents > 0 && {
            what: count(impact.connectedAgents, 'connected agent'),
            outcome: 'disconnected',
        },
        impact.socioGrants > 0 && {
            what: count(impact.socioGrants, 'socio access grant'),
            outcome: 'revoked',
        },
        impact.appSessions > 0 && {
            what: count(impact.appSessions, 'mini app session'),
            outcome: 'ended',
        },
        impact.pluginAccess > 0 && {
            what: `${count(impact.pluginAccess, 'plugin session')} and launch codes`,
            outcome: 'ended',
        },
        impact.scheduledTasks > 0 && {
            what: count(impact.scheduledTasks, 'scheduled task'),
            outcome: 'paused, kept',
        },
        impact.jobRuns > 0 && {
            what: count(impact.jobRuns, 'job run'),
            outcome: 'stopped now',
        },
        impact.subscriptionConnections > 0 && {
            what: count(impact.subscriptionConnections, 'model subscription connection'),
            outcome: 'disconnected',
        },
        impact.mcpConnections > 0 && {
            what: count(impact.mcpConnections, 'MCP connection'),
            outcome: 'disconnected',
        },
        impact.rooms.handedOver > 0 && {
            what: `${count(impact.rooms.handedOver, 'room')} where ${first} is the last admin`,
            outcome: 'handed to its earliest member',
        },
        impact.rooms.archived > 0 && {
            what: `${count(impact.rooms.archived, 'room')} with nobody left to run it`,
            outcome: 'stays archived',
        },
    ];
    return lines.filter((line): line is ImpactLine => !!line);
}

/** How long ago a key was used, for the preview: "used 2 h ago", "never used". */
export function keyUse(at: number | null, now = Date.now()) {
    if (at === null) {
        return 'never used';
    }
    const ago = lastActive(at, now);
    return `used ${ago === 'Now' ? 'just now' : ago === 'Yesterday' ? 'yesterday' : ago}`;
}

/** Where the Service accounts tab is, at one account (the preview's link). */
export const serviceAccountPath = (accountId?: string) =>
    `/settings/people?tab=service-accounts${accountId ? `&account=${encodeURIComponent(accountId)}` : ''}`;

export const personPath = (id: string) => `/settings/people/${encodeURIComponent(id)}`;

export { count as plural };

/**
 * A signed-in device in words, from its user agent (the person page's
 * Sign-in & devices tab): "Chrome · macOS", "Safari · iPhone".
 */
export function deviceLabel(userAgent: string | null) {
    if (!userAgent) {
        return 'Unknown device';
    }
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
    const parts = [browser, system].filter(Boolean);
    return parts.length ? parts.join(' · ') : userAgent.slice(0, 40);
}

/** How a session signed in: `password`, `passkey`, `link` or `provider:<id>`. */
export function signInMethodLabel(method: string | null) {
    if (!method) {
        return null;
    }
    if (method.startsWith('provider:')) {
        return providerLabel(method.slice('provider:'.length));
    }
    return method === 'link'
        ? 'Sign-in link'
        : method === 'link:email'
          ? 'Emailed sign-in link'
          : providerLabel(method);
}

export { providerLabel };

/** "Oct 2" this year, "Oct 2, 2025" before: the person page's dates. */
export const shortDate = (at: number | string, now = Date.now()) => {
    const ms = typeof at === 'number' ? at : Date.parse(at);
    return (new Date(ms).getFullYear() === new Date(now).getFullYear() ? dayFormat : yearFormat).format(ms);
};

// ── Ownership transfer and permanent removal (CB-360) ─────────────────────

/** Each kind a person can own, in words: its title, its unit, and what moves. */
export const ASSET_INFO: Record<AssetKind, { title: string; one: string; many: string; what: string }> = {
    apps: {
        title: 'Apps',
        one: 'app',
        many: 'apps',
        what: 'Mini apps they own. Their data space moves with them: an app’s bundles and datasets are its owner’s.',
    },
    schedules: {
        title: 'Schedules',
        one: 'schedule',
        many: 'schedules',
        what: 'Scheduled tasks, saved jobs and goals, with the conversations they run in.',
    },
    socios: { title: 'Personal socios', one: 'socio', many: 'socios', what: 'Socios they made for themselves.' },
    spaces: {
        title: 'Spaces',
        one: 'Space membership',
        many: 'Space memberships',
        what: 'Their place in each Space, as member or editor.',
    },
    data: {
        title: 'Data space',
        one: 'item',
        many: 'items',
        what: 'Datasets (private scratch areas too), files and media, folders, embeds and the grants they gave.',
    },
    conversations: {
        title: 'Conversations',
        one: 'conversation',
        many: 'conversations',
        what: 'Their own chats (not rooms).',
    },
    memories: {
        title: 'Memories',
        one: 'memory',
        many: 'memories',
        what: 'What socios remember about their work: the new owner gets them as proposals to keep or discard.',
    },
};

/** "3 schedules", "1 Space membership". */
export const assetCount = (kind: AssetKind, n: number) => count(n, ASSET_INFO[kind].one, ASSET_INFO[kind].many);

/** The non-empty kinds of a count by kind, in `ASSET_KINDS` order. */
export const ownedKinds = (owned: Partial<Record<AssetKind, number>>) =>
    ASSET_KINDS.filter((kind) => (owned[kind] ?? 0) > 0).map((kind) => ({ kind, count: owned[kind]! }));

/** What a transfer moved of one kind, in words: "3 tasks, 1 job"; "nothing" when none. */
export function movedWords(moved: Record<string, number>) {
    const parts = Object.entries(moved)
        .filter(([, n]) => n > 0)
        .map(([what, n]) => `${n} ${what.replace(/_/g, ' ')}`);
    return parts.join(', ') || 'nothing';
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

/** What blocks a permanent removal, and what to do about it. */
export interface Blocker {
    /** The server's words. */
    text: string;
    /** What it means, in the admin's terms, when known. */
    help?: string;
    /** What to do first, when the page offers it. */
    action?: 'transfer' | 'deactivate';
}

/** Explains each of the purge dry run's refusals (`PersonPurgePlan.refusals`). */
export function blockerOf(text: string): Blocker {
    if (/still own/i.test(text)) {
        return {
            text,
            help: 'Removal deletes what they own. The company keeps it: hand it to someone first.',
            action: 'transfer',
        };
    }
    if (/deactivate (them|the account) first/i.test(text)) {
        return {
            text,
            help: 'Only a deactivated person can be removed, so their sessions and keys have ended first.',
            action: 'deactivate',
        };
    }
    if (/remove yourself/i.test(text)) {
        return { text, help: 'Another admin has to remove your account.' };
    }
    if (/keep at least one admin/i.test(text)) {
        return {
            text,
            help: 'Someone must keep managing the workspace: make another person an admin first.',
        };
    }
    if (/workspace owner/i.test(text)) {
        return {
            text,
            help: 'The workspace owner stays an active admin. The owner can make another admin the owner first.',
        };
    }
    if (/is under a listed/i.test(text)) {
        return {
            text,
            help: 'They own it, and removal never takes what they own with them: transfer it first.',
            action: 'transfer',
        };
    }
    if (/the purge doesn.t remove those/i.test(text)) {
        return {
            text,
            help: 'Records that removal doesn’t delete still point at them: transfer what they own, or end these in the app first.',
        };
    }
    if (/protected/i.test(text)) {
        return { text, help: 'Part of what would go is protected (built in), so nothing is removed.' };
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
/** Why a control is off for `ownerLock`'s reasons, as its tooltip. */
export const OWNER_LOCK_TITLES: Readonly<Record<OwnerLock, string>> = {
    others: 'The workspace owner’s account: only the owner can change it',
    self: 'You own this workspace: make another admin the owner first',
};
