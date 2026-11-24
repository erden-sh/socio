import type { RosterPerson } from './auth.js';
import type { PersonGroup } from './groups.js';

/**
 * One person as admins' person page shows them (CB-360,
 * `GET /api/accounts/:id`). Ids, names and dates only: never a session
 * token, a key's hash or any other secret.
 */
export interface PersonDetail {
    /** The roster's fields for this one person (`GET /api/accounts/roster`). */
    person: RosterPerson;
    signIn: PersonSignIn;
    /** Null without an app user, or with no source wired (the auth CLI). */
    access: PersonAccess | null;
    /** The groups they are in (CB-376), oldest first. */
    groups: PersonGroup[];
}

/** How a person signs in, and where they are signed in now. */
export interface PersonSignIn {
    /** Sessions not yet expired, one per signed-in browser or device, newest renewal first. */
    sessions: PersonSession[];
    passkeys: PersonPasskey[];
    /** A password is set. */
    password: boolean;
    /** Linked sign-in providers by id (`google`, an OIDC provider's id). */
    providers: string[];
}

/** One signed-in device (`auth_session`). Dates are ISO text. */
export interface PersonSession {
    /** The id `DELETE /api/accounts/:id/sessions/:sessionId` takes. */
    id: string;
    createdAt: string;
    /** When it was last renewed (sliding sessions): roughly its last use. */
    renewedAt: string;
    expiresAt: string;
    userAgent: string | null;
    /** How it signed in (`password`, `passkey`, `link` or `provider:<id>`), when recorded. */
    signInMethod: string | null;
    ip: string | null;
}

export interface PersonPasskey {
    id: string;
    name: string | null;
    /** ISO text; null when not recorded. */
    createdAt: string | null;
}

/** What a person can reach now. Dates are epoch milliseconds. */
export interface PersonAccess {
    spaces: PersonSpace[];
    socioGrants: PersonSocioGrant[];
    connectedAgents: PersonAgent[];
    appsOwned: PersonApp[];
    /** Every service key they made, revoked and expired ones too, newest first. */
    keysMade: PersonKey[];
    /** May run code: an admin, or in a group with "Run code" (CB-376). */
    codeAccess: boolean;
    telegram: PersonTelegram | null;
}

/**
 * A Space they can read: `editor` (an editor row, or a workspace admin),
 * `member` (a member row) or `everyone` (an open Space, no row).
 */
export interface PersonSpace {
    id: string;
    name: string;
    level: 'editor' | 'member' | 'everyone';
    membersOnly: boolean;
}

/** A socio's delegated access for them (CB-232), not revoked. */
export interface PersonSocioGrant {
    id: string;
    socioId: string;
    /** Null when the socio is gone. */
    socioName: string | null;
    /** `app:<id>`, `plugin:<id>`, `gateway:model` or `gateway:git`. */
    audiences: string[];
    scopes: string[];
    createdAt: number;
    expiresAt: number;
    lastUsedAt: number;
}

/** A connected agent (CB-90), live. */
export interface PersonAgent {
    grantId: string;
    clientName: string;
    clientDomain: string | null;
    label: string;
    scopes: string[];
    createdAt: number;
    lastUsedAt: number | null;
    expiresAt: number | null;
}

export interface PersonApp {
    id: string;
    name: string;
}

/** A service key they made, as the Service accounts tab lists it. */
export interface PersonKey {
    keyId: string;
    name: string;
    /** The first characters after `cbk_`, as the key list shows them. */
    hint: string;
    accountId: string;
    account: string;
    createdAt: number;
    expiresAt: number;
    lastUsedAt: number | null;
    revokedAt: number | null;
}

export interface PersonTelegram {
    username: string | null;
    linkedAt: number;
}

/** Where a line of a person's trail comes from. */
export type PersonTrailSource = 'workspace' | 'access_policy' | 'socio_access' | 'room';

/** One line of a person's audit trail (`GET /api/accounts/:id/audit`). */
export interface PersonTrailLine {
    /** Unique in the trail: `<source>:<row id>`. */
    id: string;
    /** Epoch milliseconds. */
    at: number;
    source: PersonTrailSource;
    /** A user id, `system`, `cli` or `dot:<id>`. */
    actorId: string;
    actorName: string;
    /** The source's own action code (`deactivate`, `revoke`, `join`, ...). */
    action: string;
    /** What happened, in words. */
    detail: string;
}

/** A page of a person's trail, newest first; `next` is the `before` of the next page, null at the end. */
export interface PersonTrail {
    lines: PersonTrailLine[];
    next: string | null;
}
