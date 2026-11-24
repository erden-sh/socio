/**
 * Updates for operators (CB-259): the releases a configured feed offers
 * beyond the running build, with their notes and Upgrading steps, and the
 * opt-in updater sidecar that applies one through the Portainer stack API
 * after a backup, checks the new version's health and rolls back when it
 * fails. Notify and guided apply; nothing is applied without an operator,
 * unless an operator turns automatic updates on.
 */
import { compareVersions, subsections } from './release-notes.js';

export { compareVersions };

/** Where releases are listed: GitHub releases (with notes) or GHCR tags. */
export type UpdateFeedKind = 'github' | 'ghcr';

export interface UpdateFeed {
    kind: UpdateFeedKind;
    /** `owner/repo` (GitHub) or `owner/image` (GHCR), lowercase-insensitive. */
    repository: string;
}

/** What the feed settings come to: the feed, how often, and auto-apply. */
export interface UpdateSettings {
    /** Null: no feed, no checks. */
    feed: UpdateFeed | null;
    /** Hours between checks; 0 checks only when an operator asks. */
    checkHours: number;
    /** Off unless turned on: applies releases without Upgrading steps. */
    autoApply: boolean;
    /**
     * Warn when the running release is more than this many days older than
     * the newest one (CB-323); 0 turns the staleness warning off.
     */
    staleDays: number;
}

/** As saved in Settings (operators', over UPDATES_*); never in `/api/state`. */
export interface SavedUpdateSettings extends Partial<UpdateSettings> {
    /** The newest version operators were told about, so it is told once. */
    notified?: string;
    /** The newest version operators were warned about as stale, so it is told once. */
    staleNotified?: string;
}

export const UPDATE_CHECK_DEFAULT_HOURS = 24;
export const UPDATE_CHECK_MAX_HOURS = 168;
export const UPDATE_STALE_DEFAULT_DAYS = 90;
export const UPDATE_STALE_MAX_DAYS = 3650;

/** `owner/name` or `owner/name/sub` (GHCR images may nest), no dots-only parts. */
const PART = '[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})';
export const UPDATE_REPOSITORY = new RegExp(`^${PART}(?:/${PART}){1,2}$`);

export const validRepository = (kind: UpdateFeedKind, repository: string) =>
    UPDATE_REPOSITORY.test(repository) &&
    !repository.split('/').some((part) => /^\.+$/.test(part)) &&
    (kind === 'ghcr' || repository.split('/').length === 2);

/** `github:owner/repo` or `ghcr:owner/image`: the feed's identity. */
export const feedId = (feed: UpdateFeed) => `${feed.kind}:${feed.repository}`;

/** Reads `github:owner/repo` or `ghcr:owner/image`; undefined when it isn't one. */
export function parseFeed(raw: string | undefined): UpdateFeed | undefined {
    const match = raw?.trim().match(/^(github|ghcr):(.+)$/);
    if (!match) {
        return undefined;
    }
    const kind = match[1] as UpdateFeedKind;
    const repository = match[2]!.trim();
    return validRepository(kind, repository) ? { kind, repository } : undefined;
}

export const validCheckHours = (hours: number) =>
    Number.isInteger(hours) && hours >= 0 && hours <= UPDATE_CHECK_MAX_HOURS;

export const validStaleDays = (days: number) => Number.isInteger(days) && days >= 0 && days <= UPDATE_STALE_MAX_DAYS;

/** A release tag the updater accepts: `v` and three numbers, nothing else. */
export const UPDATE_TAG = /^v(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/** "v0.7.0" → "0.7.0"; undefined unless a release tag. */
export const versionOfTag = (tag: string) => (UPDATE_TAG.test(tag) ? tag.slice(1) : undefined);

/** One release a feed offers. Its text is untrusted: shown, never followed. */
export interface FeedRelease {
    /** "0.22.0". */
    version: string;
    /** "v0.22.0": the image tag the updater sets. */
    tag: string;
    /** YYYY-MM-DD, when the feed says. */
    date?: string;
    /** The release's title, when the feed has one. */
    title?: string;
    /** Its notes (GitHub releases); undefined for a tag-only feed. */
    notesMarkdown?: string;
    /**
     * The bullets of its `### Upgrading` section: [] when it has none, null
     * when the feed can't say (no notes): treated as steps to read.
     */
    upgrading: string[] | null;
    /** The release's page (https://github.com/…), when there is one. */
    url?: string;
    /** Its summary says `(security)` (`securityRelease`): warn right away (CB-323). */
    security?: true;
}

/** The marker a release's summary carries when it fixes a security issue. */
export const SECURITY_MARKER = /\(security\)/i;

/**
 * Whether a release is marked security (CB-323): `(security)` in its
 * summary or highlights, the text before its first `### ` section (what
 * docs/RELEASE-NOTES.md gives every release), or in its title. That text
 * is free, so the release tooling needs no new section for it.
 */
export function securityRelease(markdown: string | undefined, title?: string): boolean {
    const text = markdown?.replace(/\r\n?/g, '\n') ?? '';
    const at = text.search(/^### /m);
    const summary = at < 0 ? text : text.slice(0, at);
    return SECURITY_MARKER.test(summary) || (!!title && SECURITY_MARKER.test(title));
}

/** Why the Updates card warns that this server is behind (CB-323). */
export interface UpdateStaleness {
    /** `security`: a newer release is marked security; `age`: the window passed. */
    reason: 'security' | 'age';
    /** The newest release's tag. */
    newest: string;
    /** The newest release's date minus the running one's, when both are known. */
    behindDays?: number;
    /** The window in force (`UPDATES_STALE_DAYS`). */
    staleDays: number;
    /** The newer releases marked security, newest first. */
    security: string[];
}

const DAY = 86_400_000;

/** Whole days from one YYYY-MM-DD to another; undefined when either isn't a date. */
export function daysBetween(from: string | undefined, to: string | undefined): number | undefined {
    const start = from ? Date.parse(`${from.slice(0, 10)}T00:00:00Z`) : NaN;
    const end = to ? Date.parse(`${to.slice(0, 10)}T00:00:00Z`) : NaN;
    return Number.isNaN(start) || Number.isNaN(end) ? undefined : Math.round((end - start) / DAY);
}

/**
 * Whether this server is stale (CB-323): a newer release is marked
 * security, or the newest release came out more than `staleDays` days
 * after the running one (by the dates the feed and the release notes
 * carry; no dates, no age warning). `staleDays` 0 turns it all off. Only
 * a warning: nothing is applied because of it.
 */
export function updateStaleness(input: {
    /** Newer than the running build, newest first (`newerReleases`). */
    available: readonly FeedRelease[];
    /** The running release's date (YYYY-MM-DD), when known. */
    runningDate?: string;
    staleDays: number;
}): UpdateStaleness | undefined {
    const { available, runningDate, staleDays } = input;
    const newest = available[0];
    if (!staleDays || !newest) {
        return undefined;
    }
    const security = available.filter((release) => release.security).map((release) => release.tag);
    const behindDays = daysBetween(runningDate, newest.date);
    const old = behindDays !== undefined && behindDays > staleDays;
    if (!security.length && !old) {
        return undefined;
    }
    return {
        reason: security.length ? 'security' : 'age',
        newest: newest.tag,
        ...(behindDays !== undefined ? { behindDays } : {}),
        staleDays,
        security,
    };
}

/**
 * The bullets of a release's `### Upgrading` section. Null when the notes
 * are empty or have no `### ` sections at all, so a release written in
 * another format never reads as "nothing to do".
 */
export function upgradingSteps(markdown: string | undefined): string[] | null {
    const text = markdown?.replace(/\r\n?/g, '\n').trim();
    if (!text) {
        return null;
    }
    // The intro (summary, highlights) may come first; `subsections` skips it.
    const sections = subsections(text);
    if (!sections.length) {
        return null;
    }
    const upgrading = sections.find((section) => section.title.toLowerCase() === 'upgrading');
    if (!upgrading) {
        return [];
    }
    const items: string[] = [];
    for (const line of upgrading.body.split('\n')) {
        const item = line.match(/^[-*] (.+)$/);
        if (item) {
            items.push(item[1]!.trim());
        } else if (line.trim() && items.length) {
            items[items.length - 1] += ` ${line.trim()}`;
        }
    }
    // Text without bullets is a step too.
    if (!items.length && upgrading.body.trim()) {
        items.push(upgrading.body.trim());
    }
    return items;
}

/** The releases newer than `current`, newest first, one per version. */
export function newerReleases(releases: readonly FeedRelease[], current: string): FeedRelease[] {
    const seen = new Set<string>();
    return releases
        .filter((release) => compareVersions(release.version, current) > 0)
        .sort((a, b) => compareVersions(b.version, a.version))
        .filter((release) => (seen.has(release.version) ? false : (seen.add(release.version), true)));
}

/**
 * Every release from just after `current` up to `target` (oldest first):
 * the Upgrading steps an update to `target` must account for.
 */
export function releasesThrough(releases: readonly FeedRelease[], current: string, target: string): FeedRelease[] {
    return newerReleases(releases, current)
        .filter((release) => compareVersions(release.version, target) <= 0)
        .reverse();
}

/** Whether an update to `target` needs an operator to confirm steps. */
export const needsConfirmation = (releases: readonly FeedRelease[], current: string, target: string) =>
    releasesThrough(releases, current, target).some(
        (release) => release.upgrading === null || release.upgrading.length > 0,
    );

/**
 * What automatic updates may apply: the newest release reachable from
 * `current` through releases that all have notes and no Upgrading steps;
 * undefined when the next one has steps (or unknown ones), or there is none.
 */
export function autoApplyTarget(releases: readonly FeedRelease[], current: string): FeedRelease | undefined {
    let target: FeedRelease | undefined;
    for (const release of newerReleases(releases, current).reverse()) {
        if (release.upgrading === null || release.upgrading.length) {
            break;
        }
        target = release;
    }
    return target;
}

/** Where an update is, in the app and then the updater. */
export type UpdatePhase =
    /** The app: the mandatory backup before anything changes. */
    | 'backing_up'
    /** The updater: reading the stack, planning, checking the images. */
    | 'checking'
    /** The updater: the stack's image tags changed through Portainer. */
    | 'applying'
    /** The updater: waiting for the new version to be healthy. */
    | 'verifying'
    /** The updater: the previous stack file and env sent back. */
    | 'rolling_back'
    | 'succeeded'
    /** It failed, and the previous version is healthy again. */
    | 'rolled_back'
    /** Refused or failed before anything changed. */
    | 'failed'
    /** It failed, and so did the rollback: an operator must act. */
    | 'rollback_failed';

export const FINISHED_PHASES: readonly UpdatePhase[] = ['succeeded', 'rolled_back', 'failed', 'rollback_failed'];

/** The pre-update backup the app took, by file names only. */
export interface UpdateBackup {
    /** `company-brain-YYYYMMDD-HHMMSS.sqlite`. */
    database: string;
    /** `userdata-YYYYMMDD-HHMMSS`. */
    userdata: string;
    /** Whether the off-site copy took it too. */
    offsite: boolean;
    at: number;
}

/** One update, as the updater reports it (no env values, no secrets). */
export interface UpdaterJob {
    id: string;
    /** "v0.22.0". */
    target: string;
    /** The version it updates from ("0.21.0"). */
    from: string;
    /** The operator's user id, or `auto`. */
    requestedBy: string;
    phase: UpdatePhase;
    startedAt: number;
    updatedAt: number;
    finishedAt?: number;
    /** Why it failed or rolled back; no secrets, no env values. */
    error?: string;
    backup: UpdateBackup;
    /** What happened, oldest first. */
    steps: { at: number; line: string }[];
}

/** `GET /v1/status` on the updater. */
export interface UpdaterStatus {
    /** The Portainer stack it updates. */
    stack: string;
    /** The stack env keys it changes, and nothing else. */
    tagKeys: string[];
    /** The update in progress, or the last one. */
    job: UpdaterJob | null;
    /** Earlier updates, newest first (a few). */
    history: UpdaterJob[];
}

/** `POST /v1/apply` on the updater. */
export interface UpdaterApplyRequest {
    target: string;
    from: string;
    requestedBy: string;
    backup: UpdateBackup;
}

/** `GET /api/updates` (operators). */
export interface UpdatesView {
    current: { version: string; commit: string | null };
    /** The settings in force; `source` says whether an operator saved them. */
    settings: UpdateSettings & { source: 'settings' | 'environment' };
    /** The environment's, for "reset". */
    defaults: UpdateSettings;
    /** Where the feed's read token comes from; never the token. */
    token: 'settings' | 'environment' | 'none' | 'unreadable';
    check: {
        running: boolean;
        at?: number;
        ok?: boolean;
        error?: string;
        /** When the next scheduled check is due. */
        nextAt?: number;
    };
    /** Newer than the running build, newest first. */
    available: FeedRelease[];
    /** Set when this server is behind enough to warn (CB-323). */
    stale?: UpdateStaleness;
    /** What automatic updates would apply now, when they are on. */
    autoTarget?: string;
    updater: {
        configured: boolean;
        reachable?: boolean;
        error?: string;
        status?: UpdaterStatus;
    };
    /** The app's part of an update: the backup, then the hand-off. */
    preparing?: {
        target: string;
        requestedBy: string;
        phase: 'backing_up' | 'failed';
        startedAt: number;
        error?: string;
    };
    backups: { running: boolean; offsite: boolean };
}
