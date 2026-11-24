import type { ActorScope, AppAccessLevel } from './actor-scopes.js';
import type { CodingRuntimeCard, CodingSessionCard } from './coding/coding-sessions.js';

/**
 * Delegated app access as people see it (CB-232): the approval
 * capabilities a socio's requests use, the consent cards they show, and
 * a person's grants. Shared by the server, the chat card, Account → Socio
 * access and Operations → Socio access.
 */

/**
 * The approval capabilities. Only read access may skip the card, by the
 * person's own opt-in for that socio; write, `act` and every
 * consequential action are the person's click.
 */
export const SOCIO_ACCESS_CAPABILITIES = {
    read: 'app_access_read',
    write: 'app_access_write',
    act: 'app_access_act',
    action: 'app_action',
} as const;
export type SocioAccessCapability = (typeof SOCIO_ACCESS_CAPABILITIES)[keyof typeof SOCIO_ACCESS_CAPABILITIES];

/** The access capability for each level `request_app_access` takes. */
export const ACCESS_CAPABILITY: Record<AppAccessLevel, SocioAccessCapability> = {
    read: SOCIO_ACCESS_CAPABILITIES.read,
    write: SOCIO_ACCESS_CAPABILITIES.write,
    act: SOCIO_ACCESS_CAPABILITIES.act,
};

/** Pending access and action requests expire after 15 minutes. */
export const SOCIO_ACCESS_APPROVAL_TTL_MS = 15 * 60_000;

/**
 * Caps on pending requests: a socio has at most 5 access requests
 * waiting, a grant at most 3 action approvals. Counted inside the
 * transaction that inserts the request.
 */
export const SOCIO_ACCESS_PENDING = { perSocio: 5, perGrant: 3 } as const;

/**
 * An action's parameters on its card: the first 2 KB
 * inline, and past that Allow stays off until the person opens them all.
 * Over 64 KB nobody reviews them: refused before a card is made.
 */
export const ACTION_PARAMS = { inlineBytes: 2048, maxBytes: 65536 } as const;

/** Card text caps. */
export const CARD_TEXT = {
    task: 500,
    label: 80,
    action: 100,
    displayFields: 20,
    displayValue: 300,
} as const;

/** What the card says an access level never allows. */
export const ACCESS_NEVER = 'It can’t change the app’s settings or sharing, and can’t act as you anywhere else.';

/** Platform facts about an app, never the app's own words. */
export interface CardAppFacts {
    /** Its label, made inert: an app may name itself anything. */
    label: string;
    /** Its own origin, which no label can fake. */
    origin: string;
    /** Who owns it, by name. */
    owner: string;
    /**
     * A development app on the person's own socio: the
     * socio's shell can rewrite it, so the scopes are advisory.
     */
    development: boolean;
}

/** `request_app_access`'s card. */
export interface AppAccessCard {
    kind: 'app_access';
    socioName: string;
    access: AppAccessLevel;
    minutes: number;
    app: CardAppFacts;
    /** What the access allows, one line per scope, platform words. */
    allows: string[];
    never: string;
    /**
     * The room's name when the conversation is shared: the socio's answers
     * there are visible to everyone in it.
     */
    visibleTo: string | null;
    /** The socio's words, inert, quoted as theirs. */
    task: string;
    /** Approving ends the narrower grant this widens. */
    widens: boolean;
    /** The app forces this card, whatever the person's policy. */
    alwaysAsk: boolean;
}

/** One array in an action's parameters, counted by the platform. */
export interface ParamCount {
    /** Where it is, as a JSON-ish path (`recipients`, `batch[0].to`). */
    path: string;
    count: number;
}

/** A consequential action's card. */
export interface AppActionCard {
    kind: 'app_action';
    socioName: string;
    app: CardAppFacts;
    /** The action's manifest name, inert. */
    action: string;
    tier: 'consequential';
    /**
     * A data operation of Socio's data API (`data:<op>`, CB-232): the
     * operation and what it does, in Socio's words, not the app's.
     */
    operation?: { op: string; words: string };
    params: {
        /** Canonical JSON (RFC 8785), inert; the first 2 KB of it. */
        preview: string;
        /** The canonical JSON's size in bytes. */
        bytes: number;
        /** Whether `preview` is all of it. */
        complete: boolean;
        counts: ParamCount[];
    };
    /** The app's own description of it, inert: shown last, as the app's. */
    display: Array<{ label: string; value: string }>;
}

/** CB-239: a coding session's start card (`coding-sessions.ts`). */
export type SocioAccessCard = AppAccessCard | AppActionCard | CodingSessionCard | CodingRuntimeCard;

/** Where a grant stands for its person. */
export type GrantState = 'live' | 'ended';

/** A delegation grant as its person (or an admin) sees it. */
export interface SocioGrantView {
    id: string;
    socioId: string;
    socioName: string;
    /** Admins' view only: whose grant it is. */
    personId?: string;
    personName?: string;
    audience: string;
    /** The app, when it still exists. */
    app: { label: string; origin: string | null } | null;
    access: AppAccessLevel | 'other';
    scopes: ActorScope[];
    /** The socio's words when it asked, inert. */
    task: string;
    conversation: {
        kind: 'private' | 'room' | 'schedule';
        title: string | null;
    };
    createdAt: number;
    expiresAt: number;
    lastUsedAt: number;
    idleMinutes: number;
    state: GrantState;
    /** When and why it ended; who ended it, in words. */
    ended: { at: number; reason: string; by: string } | null;
}

/** What `GET /api/actors/grants` answers. */
export interface SocioGrantsState {
    grants: SocioGrantView[];
}

/** The level a grant's scopes make, for its list entry. */
export function grantAccess(scopes: readonly string[]): AppAccessLevel | 'other' {
    if (scopes.includes('app:act')) {
        return 'act';
    }
    if (scopes.includes('app:write')) {
        return 'write';
    }
    if (scopes.includes('app:read')) {
        return 'read';
    }
    return 'other';
}

/** What the card says a level lets the socio do with the app. */
export const ACCESS_VERB: Record<AppAccessLevel, string> = {
    read: 'read',
    write: 'read and change',
    act: 'read, change and ask to act in',
};

/** "1 hour", "90 minutes", "8 hours". */
export function minutesText(minutes: number) {
    if (minutes % 60 === 0) {
        const hours = minutes / 60;
        return `${hours} hour${hours === 1 ? '' : 's'}`;
    }
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** Why a grant ended, in words (`ACTOR_REVOKE_REASONS`). */
export const GRANT_END_WORDS: Record<string, string> = {
    person_revoked: 'You ended it',
    admin_revoked: 'An admin ended it',
    task_ended: 'The socio finished the task',
    replaced: 'Replaced by a wider grant',
    expired: 'Its time ran out',
    idle: 'Unused for too long',
    person_deactivated: 'The account was deactivated',
    access_changed: 'The person can no longer open the app',
    socio_unavailable: 'The socio is no longer available',
    audience_unavailable: 'The app is no longer available to socios',
    policy_stale: 'The app changed what it does',
    feature_off: 'Socio access was turned off',
    conversation_gone: 'The conversation was archived or deleted',
    conversation_changed: 'The conversation became a room',
    conversation_shared: 'The conversation is shared',
    // CB-239.
    session_ended: 'The coding session ended',
};
