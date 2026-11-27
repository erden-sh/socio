import { z } from 'zod';

/**
 * The access policy (CB-124): how people
 * sign in. The environment (`AUTH_*`) is the ceiling; operators can only
 * narrow it in the app: keep a subset of a list, turn a method off. What
 * is in force is the environment's value intersected with what they saved,
 * computed on every read. Who may run code was here too, as a narrowing of
 * `CODE_USERS`; since CB-376 it is a permission given by groups (People →
 * Groups), and a saved list is only read once, to seed the "Code" group.
 */

/** How a session began (`auth_session.signInMethod`). */
export type SignInMethodId =
    | 'password'
    | 'passkey'
    | 'link'
    | 'link:email'
    | `provider:${string}`
    /** The Socio app's native Google and Apple sign-in, through Socio's cloud services (CB-570). */
    | 'google'
    | 'apple';

/**
 * What operators saved. A missing key follows the environment; a boolean
 * can only be `false` (off), except an opt-in key, which is off unless
 * saved `true`; a list is the entries kept.
 */
export interface SavedAccessPolicy {
    password?: false;
    passkey?: false;
    /** Telegram sign-in links. */
    signInLink?: false;
    /**
     * Sign-in links and codes by email (CB-352): the first opt-in key. Off
     * unless saved `true`, and then only while an email channel delivers
     * sign-in links (the ceiling).
     */
    emailLinks?: true;
    openSignUp?: false;
    /** The Socio app's native Google sign-in (CB-570). */
    google?: false;
    /** The Socio app's native Sign in with Apple (CB-570). */
    apple?: false;
    /** OAuth provider ids kept on. */
    providers?: string[];
    allowedEmails?: string[];
    allowedDomains?: string[];
    adminEmails?: string[];
    /**
     * App user ids that could run code, before CB-376: read once by the
     * migration to a "Code" group; a save can't set it any more.
     */
    codeUsers?: string[];
}

const LIST_MAX = 500;
const item = z.string().trim().min(1).max(320);
const list = z.array(item).max(LIST_MAX);
/** The body's `policy`: unknown keys and `true` are refused. */
export const savedAccessPolicySchema = z
    .object({
        password: z.literal(false).optional(),
        passkey: z.literal(false).optional(),
        signInLink: z.literal(false).optional(),
        emailLinks: z.literal(true).optional(),
        openSignUp: z.literal(false).optional(),
        google: z.literal(false).optional(),
        apple: z.literal(false).optional(),
        providers: list.optional(),
        allowedEmails: list.optional(),
        allowedDomains: list.optional(),
        adminEmails: list.optional(),
        codeUsers: list.optional(),
    })
    .strict();

/** What the environment allows for sign-in (Better Auth only). */
export interface SignInCeiling {
    password: boolean;
    passkey: boolean;
    /** A channel (the Telegram bot) delivers sign-in links. */
    signInLink: boolean;
    /**
     * An email channel delivers sign-in links (it needs SMTP), so links and
     * codes could go by email (CB-352). SMTP alone isn't enough.
     */
    emailLinks: boolean;
    openSignUp: boolean;
    /**
     * The Socio app's native Google and Apple sign-in (CB-570): link-only,
     * verified by Socio's cloud services, so no setting gates them here.
     * They are offered only while the cloud connection can verify them.
     */
    google: boolean;
    apple: boolean;
    providers: { id: string; name: string }[];
    allowedEmails: string[];
    allowedDomains: string[];
    adminEmails: string[];
}

export interface SignInInForce {
    password: boolean;
    passkey: boolean;
    signInLink: boolean;
    /** Sign-in links and codes by email: saved on, with SMTP set up. */
    emailLinks: boolean;
    openSignUp: boolean;
    google: boolean;
    apple: boolean;
    providers: string[];
    allowedEmails: string[];
    allowedDomains: string[];
    adminEmails: string[];
}

const LIST_KEYS = ['providers', 'allowedEmails', 'allowedDomains', 'adminEmails', 'codeUsers'] as const;
const FLAG_KEYS = ['password', 'passkey', 'signInLink', 'openSignUp', 'google', 'apple'] as const;
/** Emails and domains compare lowercased; ids as they are. */
const LOWERCASE = new Set(['allowedEmails', 'allowedDomains', 'adminEmails']);

const lower = (value: string) => value.toLowerCase();
const sorted = (values: Iterable<string>) => [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * The canonical form: lists deduplicated and sorted (emails and domains
 * lowercased, a domain's leading @ dropped), absent keys left out. Two
 * policies that mean the same have the same form (and step-up digest).
 */
export function normalizePolicy(saved: SavedAccessPolicy): SavedAccessPolicy {
    const out: SavedAccessPolicy = {};
    for (const key of FLAG_KEYS) {
        if (saved[key] === false) {
            out[key] = false;
        }
    }
    if (saved.emailLinks === true) {
        out.emailLinks = true;
    }
    for (const key of LIST_KEYS) {
        const values = saved[key];
        if (!values) {
            continue;
        }
        out[key] = sorted(
            values
                .map((value) => value.trim())
                .map((value) => (LOWERCASE.has(key) ? lower(value) : value))
                .map((value) => (key === 'allowedDomains' ? value.replace(/^@/, '') : value))
                .filter(Boolean),
        );
    }
    return out;
}

/** The environment's list, kept to the saved entries when there are some. */
const narrowed = (ceiling: readonly string[], kept: string[] | undefined) =>
    kept ? ceiling.filter((entry) => kept.includes(entry)) : [...ceiling];

/** Sign-in as it is in force: the environment's, narrowed by the saved. */
export function signInInForce(ceiling: SignInCeiling, saved: SavedAccessPolicy): SignInInForce {
    return {
        password: ceiling.password && saved.password !== false,
        passkey: ceiling.passkey && saved.passkey !== false,
        signInLink: ceiling.signInLink && saved.signInLink !== false,
        emailLinks: ceiling.emailLinks && saved.emailLinks === true,
        openSignUp: ceiling.openSignUp && saved.openSignUp !== false,
        google: ceiling.google && saved.google !== false,
        apple: ceiling.apple && saved.apple !== false,
        providers: narrowed(
            ceiling.providers.map(({ id }) => id),
            saved.providers,
        ),
        allowedEmails: narrowed(ceiling.allowedEmails, saved.allowedEmails),
        allowedDomains: narrowed(ceiling.allowedDomains, saved.allowedDomains),
        adminEmails: narrowed(ceiling.adminEmails, saved.adminEmails),
    };
}

/** Who could run code before CB-376: `CODE_USERS`, narrowed (the "Code" group's seed). */
export function codeUsersInForce(ceiling: readonly string[], saved: SavedAccessPolicy): string[] {
    return narrowed(ceiling, saved.codeUsers);
}

/**
 * Whether a session that began this way may go on under what operators
 * saved: only the policy ends sessions. A method the environment leaves
 * off (a deploy's choice, or the Telegram bot not running this time)
 * makes no new ones, but doesn't sign out those it made. False when no
 * method is recorded, or one this doesn't know: every way in records its
 * own, so such a session is from before CB-124 (auth migration 7 ends
 * those) or from a way in nobody mapped, and nothing says the policy
 * allows it (fails closed).
 */
export function sessionAllowed(method: string | null | undefined, saved: SavedAccessPolicy) {
    if (method === 'password') {
        return saved.password !== false;
    }
    if (method === 'passkey') {
        return saved.passkey !== false;
    }
    if (method === 'link') {
        return saved.signInLink !== false;
    }
    // Opt-in: an email link's session lasts only while email links are on.
    if (method === 'link:email') {
        return saved.emailLinks === true;
    }
    if (method === 'google') {
        return saved.google !== false;
    }
    if (method === 'apple') {
        return saved.apple !== false;
    }
    if (method?.startsWith('provider:') && method.length > 'provider:'.length) {
        return !saved.providers || saved.providers.includes(method.slice('provider:'.length));
    }
    return false;
}

/**
 * Any way to sign in at all is left. The app's Google and Apple sign-in
 * don't count: they only sign in accounts already linked, and only while
 * the cloud connection can verify them.
 */
export const anyMethod = (inForce: SignInInForce) =>
    inForce.password || inForce.passkey || inForce.signInLink || inForce.emailLinks || inForce.providers.length > 0;

const LABELS: Record<(typeof LIST_KEYS)[number], [string, string]> = {
    providers: ['Sign-in provider', 'AUTH_OAUTH_PROVIDERS'],
    allowedEmails: ['Allowed email', 'AUTH_ALLOWED_EMAILS'],
    allowedDomains: ['Allowed domain', 'AUTH_ALLOWED_DOMAINS'],
    adminEmails: ['Admin email', 'AUTH_ADMIN_EMAILS'],
    codeUsers: ['Code user', 'CODE_USERS'],
};
/** Why a save can't carry `codeUsers` any more (CB-376). */
export const CODE_USERS_MOVED =
    'Who may run code is now a permission under Settings → People → Groups: it can’t be set in the access policy.';
const FLAG_LABELS: Record<(typeof FLAG_KEYS)[number], [string, string]> = {
    password: ['Email and password', 'AUTH_PASSWORD'],
    passkey: ['Passkeys', 'AUTH_PASSKEY'],
    signInLink: ['Sign-in links by Telegram', 'the Telegram bot'],
    openSignUp: ['Open sign-up', 'AUTH_OPEN_SIGNUP'],
    google: ['Google in the Socio app', 'the cloud connection'],
    apple: ['Sign in with Apple in the Socio app', 'the cloud connection'],
};
/** The opt-in key's words (CB-352). */
export const EMAIL_LINKS_LABEL = 'Sign-in links by email';

/**
 * Why a saved policy goes beyond the environment, if it does: an entry
 * the variable doesn't list, a method it leaves off. Sign-in keys are
 * refused outright without a sign-in ceiling (mock auth).
 */
export function ceilingViolations(saved: SavedAccessPolicy, ceiling: { signIn: SignInCeiling | null }): string[] {
    const problems: string[] = [];
    const { signIn } = ceiling;
    for (const key of FLAG_KEYS) {
        if (saved[key] === undefined) {
            continue;
        }
        if (!signIn) {
            problems.push(`${FLAG_LABELS[key][0]}: this server has no sign-in policy (mock auth).`);
        }
    }
    if (saved.emailLinks !== undefined) {
        if (!signIn) {
            problems.push(`${EMAIL_LINKS_LABEL}: this server has no sign-in policy (mock auth).`);
        } else if (!signIn.emailLinks) {
            problems.push(
                `${EMAIL_LINKS_LABEL}: no email channel delivers sign-in links on this server (it needs SMTP_URL), so it can't be turned on.`,
            );
        }
    }
    for (const key of LIST_KEYS) {
        const values = saved[key];
        if (!values) {
            continue;
        }
        if (key === 'codeUsers') {
            problems.push(CODE_USERS_MOVED);
            continue;
        }
        if (!signIn) {
            problems.push(`${LABELS[key][0]}s: this server has no sign-in policy (mock auth).`);
            continue;
        }
        const allowed = key === 'providers' ? signIn.providers.map(({ id }) => id) : signIn[key];
        for (const value of values) {
            if (!allowed.includes(value)) {
                problems.push(
                    `${LABELS[key][0]} "${value}" is not in ${LABELS[key][1]}: the environment is the ceiling, so it can't be added here.`,
                );
            }
        }
    }
    return problems;
}

/**
 * What a change does, in words, for the audit and the preview. `counts`
 * gives numbers instead of the entries, for notices that may leave the
 * server (a person's Telegram or push channels) and the log: emails and
 * user ids stay in the app's own history.
 */
export function policyChanges(
    before: { signIn: SignInInForce | null },
    after: { signIn: SignInInForce | null },
    { counts = false } = {},
): string[] {
    const lines: string[] = [];
    const diff = (label: string, from: string[], to: string[]) => {
        const removed = from.filter((entry) => !to.includes(entry));
        const added = to.filter((entry) => !from.includes(entry));
        const say = (entries: string[]) => (counts ? String(entries.length) : entries.join(', '));
        if (removed.length) {
            lines.push(`${label}: removed ${say(removed)}`);
        }
        if (added.length) {
            lines.push(`${label}: added back ${say(added)}`);
        }
    };
    if (before.signIn && after.signIn) {
        for (const key of FLAG_KEYS) {
            if (before.signIn[key] !== after.signIn[key]) {
                lines.push(`${FLAG_LABELS[key][0]}: ${after.signIn[key] ? 'on' : 'off'}`);
            }
        }
        if (before.signIn.emailLinks !== after.signIn.emailLinks) {
            lines.push(`${EMAIL_LINKS_LABEL}: ${after.signIn.emailLinks ? 'on' : 'off'}`);
        }
        for (const key of ['providers', 'allowedEmails', 'allowedDomains', 'adminEmails'] as const) {
            diff(`${LABELS[key][0]}s`, before.signIn[key], after.signIn[key]);
        }
    }
    return lines;
}

/** How an operator confirms a change (CB-124 step-up). */
export type StepUpMethod = 'password' | 'passkey' | 'confirm';

/** `POST /api/access-policy/step-up`: a one-time challenge for one change. */
export interface StepUpChallenge {
    id: string;
    /** The proofs this operator can give now; empty: none (see `reason`). */
    methods: StepUpMethod[];
    /** WebAuthn request options when `methods` has `passkey`. */
    passkey?: Record<string, unknown>;
    expiresAt: string;
    reason?: string;
}

/** The proof in `PUT /api/access-policy`. */
export const stepUpProofSchema = z.union([
    z
        .object({
            id: z.string().min(1).max(100),
            password: z.string().min(1).max(128),
        })
        .strict(),
    z
        .object({
            id: z.string().min(1).max(100),
            passkey: z.record(z.string(), z.unknown()),
        })
        .strict(),
    z.object({ id: z.string().min(1).max(100), confirm: z.literal(true) }).strict(),
]);
export type StepUpProof = z.infer<typeof stepUpProofSchema>;

/** What saving a policy would do (`POST /api/access-policy/preview`). */
export interface AccessPolicyImpact {
    /** In words; empty when nothing in force changes. */
    changes: string[];
    /** Why it can't be saved (a lockout or the ceiling), if it can't. */
    refusal: string | null;
    sessionsEnded: number;
    /** People left without a set-up way to sign in. */
    withoutWayIn: { name: string; email: string }[];
    /** The operator's own session would end. */
    signsYouOut: boolean;
    /** Queued and running code runs that would stop. */
    codeRunsStopped: number;
}

export type AccessPolicyAuditAction = 'change' | 'reset' | 'step_up_failed' | 'step_up_locked';

export interface AccessPolicyAuditEntry {
    id: number;
    at: number;
    actor: string;
    actorName: string;
    action: AccessPolicyAuditAction;
    /** The step-up used (`password`, `passkey`, `confirm`, `cli`). */
    stepUp: string | null;
    detail: string;
    sessionsEnded: number;
    codeRunsStopped: number;
}

/** `GET /api/access-policy` (operators). */
export interface AccessPolicyView {
    version: number;
    updatedAt: number | null;
    updatedBy: string | null;
    /** The stored row didn't parse: the environment applies. */
    unreadable: boolean;
    saved: SavedAccessPolicy;
    /** Null with mock auth: there are no sign-in methods to narrow. */
    signIn: { ceiling: SignInCeiling; inForce: SignInInForce } | null;
    audit: AccessPolicyAuditEntry[];
}

/** `PUT /api/access-policy`'s answer. */
export interface AccessPolicySaved {
    view: AccessPolicyView;
    impact: AccessPolicyImpact;
}
