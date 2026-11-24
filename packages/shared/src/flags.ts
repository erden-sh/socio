import type { Role } from './types.js';

/**
 * Feature flags (CB-169, CB-182, CB-503): features that ship dark, are
 * tried early by a workspace or some of its people, or are part of some
 * plans only. Every flag is declared here, in code, with a safe default;
 * the server evaluates them per request (src/server/flags) and the client
 * only shows what the server decided (`WorkspaceState.flags`). No outside
 * flag service and no telemetry: rules live in the workspace database, set
 * in Settings.
 *
 * Only this server's configuration (FEATURE_FLAGS, a stored server rule,
 * which may be locked, and plans) and the workspace's admins (a workspace
 * rule) decide who has a flag: on, off, or for some roles and people. A
 * person never turns a flag on or off for themselves (CB-503). Settings
 * shows the server's part read-only and offers no operator controls.
 *
 * Stages:
 * - `dev`: unfinished, for the team that builds Socio. Only an internal
 *   deployment (`SOCIO_DEPLOYMENT_KIND=internal`) has it: listed on
 *   Settings → In development, where admins switch it like any other. In a
 *   customer deployment (the default) it is never listed nor on, whatever
 *   FEATURE_FLAGS, a stored rule or a plan says.
 * - `early-access`: ready to try, still experimental. Admins decide it on
 *   Settings → Early access; it carries an "Early access" badge.
 * - `ga`: released. A flag that stays is an optional feature, on Settings
 *   → Optional features: a switch an admin or this server's configuration
 *   (a plan included) may turn off.
 */
export const FLAG_STAGES = ['dev', 'early-access', 'ga'] as const;
export type FlagStage = (typeof FLAG_STAGES)[number];

export const FLAG_STAGE_LABELS: Record<FlagStage, string> = {
    dev: 'In development',
    'early-access': 'Early access',
    ga: 'Released',
};

export interface FlagDefinition {
    /** Lowercase letters, digits and dashes; never changes once shipped. */
    key: string;
    /** A short name, as Settings and badges show it. */
    title: string;
    /** What turning it on changes, for people. */
    description: string;
    stage: FlagStage;
    /** Its value where no rule applies. Safe: off for anything unfinished. */
    default: boolean;
    /** The area that owns it and removes it (an issue area, not a person). */
    owner: string;
    /** YYYY-MM-DD: by when the flag is removed from the code. */
    removeBy: string;
    /** Its board item: What's new marks highlights with this key. */
    issue?: string;
    /** Socio tools that exist only while the flag is on for the person. */
    tools?: readonly string[];
}

/**
 * Every flag. Add one here, check it on the server with
 * `FlagService.enabled` (or `requireFlag` on a route), list its socio
 * tools, and remove it by `removeBy`.
 */
export const FLAGS = [
    {
        key: 'web-reads',
        title: 'Socios read web pages',
        description:
            'Socios may read a public URL or JSON API directly (http_get, http_json), under the research permission.',
        stage: 'ga',
        default: true,
        owner: 'server',
        removeBy: '2027-06-30',
        issue: 'CB-169',
        tools: ['http_get', 'http_json'],
    },
    {
        // CB-232: off for everyone until its review phase passes. Turning it
        // off for a person ends their socios' grants.
        key: 'socio-actor-access',
        title: 'Socios use apps for you',
        description:
            'Socios may ask to use mini apps and plugins for the person they act for, with that person’s approval, and only through the platform’s own delegated sessions.',
        stage: 'dev',
        default: false,
        owner: 'server',
        removeBy: '2027-06-30',
        issue: 'CB-232',
        tools: [
            'request_app_access',
            'end_app_access',
            'app_open',
            'app_snapshot',
            'app_click',
            'app_type',
            'app_screenshot',
            'app_close',
        ],
    },
    {
        // CB-239: needs socio-actor-access on as well.
        key: 'coding-sessions',
        title: 'Coding sessions',
        description:
            'Socios may run a coding agent on a listed repository for the person they act for, in a sandbox of its own, with models and Git reached only through Socio.',
        stage: 'dev',
        default: false,
        owner: 'server',
        removeBy: '2027-06-30',
        issue: 'CB-239',
        tools: ['coding_start', 'coding_prompt', 'coding_status', 'coding_diff', 'coding_open_pr', 'coding_stop'],
    },
    {
        // CB-267: needs socio-actor-access on as well.
        key: 'repo-extraction',
        title: 'Repository extraction for apps',
        description:
            'Socios may ask to give a workspace app a read-only copy of part of a listed repository, once per approval.',
        stage: 'dev',
        default: false,
        owner: 'server',
        removeBy: '2027-06-30',
        issue: 'CB-267',
        tools: ['repo_extract'],
    },
    {
        // Hides Learning's "Analyze now", which has never worked, until it is
        // fixed. Off: no button, and the route answers 404. The daily and
        // evidence-count analyses are not affected.
        key: 'learning-analyze-now',
        title: 'Learning: Analyze now',
        description:
            'Admins may start a Learning analysis by hand with Analyze now. Not working yet: it stays off until it is fixed.',
        stage: 'early-access',
        default: false,
        owner: 'server',
        removeBy: '2027-06-30',
    },
    {
        // CB-451: the web sidebar's dataset items and Private
        // group, and placing datasets from a Space. The API is always on.
        key: 'datasets-in-spaces',
        title: 'Datasets in Spaces',
        description:
            'Datasets show in their Space beside its pages, and your own datasets in no Space show under Private at the top of your Spaces.',
        stage: 'early-access',
        default: false,
        owner: 'web',
        removeBy: '2027-06-30',
        issue: 'CB-451',
    },
] as const satisfies readonly FlagDefinition[];

export type FlagKey = (typeof FLAGS)[number]['key'];

export const FLAG_KEY = /^[a-z][a-z0-9-]{0,47}$/;
/** Keys `/api/flags/<key>` can't have: its own routes' names. */
export const RESERVED_FLAG_KEYS = ['tier', 'tiers', 'early-access'];

/**
 * Who a rule turns a flag on for: everyone (`enabled`), or only the
 * listed roles and people. Off for everyone else.
 */
export interface FlagTargets {
    enabled: boolean;
    roles: Role[];
    /** User ids. */
    people: string[];
}

/** A rule as an operator (instance) or admin (workspace) saves it. */
export interface FlagRuleInput extends FlagTargets {
    /** Instance rules only: the workspace's admins can't change it. */
    locked?: boolean;
}
export interface FlagRule extends FlagRuleInput {
    updatedBy: string;
    updatedAt: number;
}

/** Most people a rule names. */
export const MAX_FLAG_PEOPLE = 200;

/**
 * Which layer decided a flag for a person, from the most general:
 * a customer deployment, where a `dev` flag is always off (`deployment`),
 * the code's default, the instance's env, the operator's instance rule,
 * the workspace's plan (tier), the admin's workspace rule. There is no
 * person's layer (CB-503).
 */
export type FlagSource = 'deployment' | 'default' | 'env' | 'instance' | 'tier' | 'workspace';

export interface FlagEvaluation {
    enabled: boolean;
    source: FlagSource;
}

/**
 * What the shell gets in `WorkspaceState.flags`: the flags on for this
 * person. For showing only; the server checks every flag itself.
 */
export interface ClientFlags {
    on: string[];
    /** An internal deployment (CB-503): Settings lists flags in development. */
    internal?: boolean;
}

/** A plan (CB-182): flags it includes (true) or leaves out (false). */
export interface FlagTier {
    id: string;
    name: string;
    description: string;
    flags: Record<string, boolean>;
    updatedBy: string;
    updatedAt: number;
}
export const FLAG_TIER_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const MAX_TIER_NAME = 40;
export const MAX_TIER_DESCRIPTION = 200;

/**
 * The workspace's Settings pages for flags (CB-503), each with its stage,
 * for admins: Optional features (`ga`), Early access (`early-access`) and,
 * in an internal deployment only, In development (`dev`).
 */
export const FLAG_PAGE_STAGE = {
    features: 'ga',
    'early-access': 'early-access',
    'features-dev': 'dev',
} as const satisfies Record<string, FlagStage>;
export type FlagPage = keyof typeof FLAG_PAGE_STAGE;

/** One flag as Settings → Optional features, Early access or In development shows it (admins). */
export interface FlagAdminView {
    key: string;
    title: string;
    description: string;
    stage: FlagStage;
    default: boolean;
    owner: string;
    removeBy: string;
    issue?: string;
    tools: string[];
    /** `FEATURE_FLAGS`'s value, when it names the flag. */
    env?: boolean;
    instance?: FlagRule;
    /** The workspace's plan's entry for it. */
    tier?: boolean;
    workspace?: FlagRule;
    /** Its value for the person looking. */
    you: FlagEvaluation;
    /** Its value for the workspace when no role or person rule applies. */
    everyone: FlagEvaluation;
    /** Why an admin can't change it, or null when they can. */
    workspaceBlocked: string | null;
}

/** A line of the flags' audit, newest first. */
export interface FlagAuditLine {
    actor: string;
    actorName: string;
    action: string;
    targetKind: 'feature_flag' | 'flag_tier';
    targetId: string;
    detail: string;
    createdAt: number;
}

/** `GET /api/flags` (admins): every flag this deployment has (`dev` ones only if internal). */
export interface FlagsAdminState {
    tenantId: string;
    flags: FlagAdminView[];
    tiers: FlagTier[];
    /** The workspace's plan, or null. */
    tierId: string | null;
    people: Array<{ id: string; name: string; role: Role }>;
    audit: FlagAuditLine[];
}

export const flagDefinition = (key: string, registry: readonly FlagDefinition[] = FLAGS) =>
    registry.find((flag) => flag.key === key);

/** Early-access flags that name this board item (What's new badges). */
export const earlyAccessForIssue = (issue: string, registry: readonly FlagDefinition[] = FLAGS) =>
    registry.filter((flag) => flag.stage === 'early-access' && flag.issue === issue);
