import { isAdmin } from '@socio/shared/roles';

import type { PushRefresh, PushStatus } from '../push/subscription';
import type { UnsentWrite } from '../sync/outbox';
import type { PendingWrite } from '../sync/pending';
import type { ShellWorkspace } from '../sync/shell';
import type { SnapshotCache, SnapshotDefinition } from '../sync/snapshot-cache';
import type { ServerVersionState } from '../sync/versions';

// Technical details: what Advanced
// mode adds for software engineers, opened from Settings while it is on. The
// versions (this build's, the server's and its gate, user.db's), each
// snapshot source's last pull, cursor and ETag with the rows it feeds, each
// outbox lane's rows, attempts and last error (with what the server refused
// there), and links to the engineering features that open the web, coding
// sessions and computers. Raw values, as the app holds them: this is
// the one place plain words give way. Nothing here is a secret: no
// cookie, key or payload, only ids, codes and counts. No React Native, so
// tests/shell runs it under Node.

/** One label and its value; `copy` when the value is worth copying (an ETag, a cursor, an error). */
export interface DetailRow {
    readonly label: string;
    readonly value: string;
    readonly copy: boolean;
    readonly testID: string;
}

/** A titled group of rows: a snapshot source, a lane. */
export interface DetailGroup {
    readonly title: string;
    readonly rows: readonly DetailRow[];
    readonly testID: string;
}

/** A page of the workspace's web that Advanced mode links to. */
export interface WebLink {
    readonly title: string;
    readonly subtitle: string;
    /** Root-relative, on the workspace's origin. */
    readonly path: string;
    readonly testID: string;
}

/** What a value shows when there is none. */
export const NONE = '—';
/** A source the server hasn't answered yet. */
export const NEVER = 'Never';
/** What the outbox section says with no row and nothing refused. */
export const NO_LANES = 'Nothing waiting to send.';
/** What the screen says when Advanced mode is off (it was turned off while it showed). */
export const ADVANCED_OFF = 'Turn on Advanced mode in Settings to see technical details.';

/** Settings' row to this screen, under Advanced mode while it is on. */
export const TECHNICAL_DETAILS_ROW = {
    title: 'Technical details',
    subtitle: 'Versions, sync and the outbox, with links to coding sessions and computers on the web.',
    testID: 'settings-technical-details',
} as const;

const row = (label: string, value: string | number | null, testID: string, copy = false): DetailRow => ({
    label,
    value: value === null || value === '' ? NONE : String(value),
    copy: copy && value !== null && value !== '',
    testID,
});

/** How long ago `at` was, in whole units, on the device clock: "Just now", "12 s ago", "3 min ago", "2 h ago", "4 d ago". */
export function ago(at: number, now: number): string {
    const seconds = Math.max(0, Math.floor((now - at) / 1000));
    if (seconds < 1) {
        return 'Just now';
    }
    if (seconds < 60) {
        return `${seconds} s ago`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes} min ago`;
    }
    const hours = Math.floor(minutes / 60);
    return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

/** A source's last pull: how long ago, then the exact time (UTC), or "Never". */
export function pulledLine(syncedAt: number | null, now: number): string {
    return syncedAt === null ? NEVER : `${ago(syncedAt, now)} · ${new Date(syncedAt).toISOString()}`;
}

/** What this build and phone are, from the platform. */
export interface BuildInfo {
    readonly appVersion: string;
    readonly variant: string;
    readonly platform: string;
    readonly osVersion: string;
}

/**
 * The versions: this build's, the server's as the version rules hold them
 * (the highest seen, the last reported, a rollback candidate) and the
 * minimum-version gate, then user.db's schema.
 */
export function versionRows(
    build: BuildInfo,
    server: ServerVersionState,
    minimum: string,
    userDb: { readonly version: number; readonly writable: boolean },
): DetailRow[] {
    return [
        row('App', `${build.appVersion} (${build.variant})`, 'tech-app-version', true),
        row('Phone', `${build.platform} ${build.osVersion}`, 'tech-os-version'),
        row('Server', server.serverVersion, 'tech-server-version', true),
        row('Last reported', server.lastVersion, 'tech-server-last'),
        ...(server.lowerVersion === null
            ? []
            : [row('Lower since', `${server.lowerVersion} · ${lowerSince(server.lowerSince)}`, 'tech-server-lower')]),
        row('Minimum server', minimum, 'tech-server-minimum'),
        row('Version gate', server.versionGate ?? 'undecided', 'tech-version-gate'),
        row('user.db', `v${userDb.version}${userDb.writable ? '' : ' (read-only)'}`, 'tech-user-db'),
    ];
}

const lowerSince = (at: number | null) => (at === null ? NONE : new Date(at).toISOString());

/** Each snapshot source as the cache holds it: its pull, cursor and ETag, and the rows of each collection it feeds. */
export function syncGroups(
    cache: Pick<SnapshotCache, 'meta' | 'cursor' | 'rows'>,
    definitions: readonly SnapshotDefinition[],
    now: number,
): DetailGroup[] {
    return definitions.map((definition) => {
        const meta = cache.meta(definition);
        const id = `tech-sync-${definition.id}`;
        return {
            title: definition.path,
            testID: id,
            rows: [
                row('Last pull', pulledLine(meta?.syncedAt ?? null, now), `${id}-pulled`),
                row('Cursor', cache.cursor(definition), `${id}-cursor`, true),
                row('ETag', meta?.etag ?? null, `${id}-etag`, true),
                row('Pulled under', meta?.serverVersion ?? null, `${id}-server`),
                row(
                    'Format',
                    meta === null || meta.schemaVersion === definition.format
                        ? definition.format
                        : `${meta.schemaVersion} (this build ${definition.format})`,
                    `${id}-format`,
                ),
                ...definition.feeds.map((feed) =>
                    row(`${feed.collection} rows`, cache.rows(feed.collection).size, `${id}-rows-${feed.collection}`),
                ),
            ],
        };
    });
}

/** "2 queued, 1 inflight": a lane's rows by state, in the order states first appear. */
function statesLine(rows: readonly PendingWrite[]): string {
    const counts = new Map<string, number>();
    for (const write of rows) {
        counts.set(write.state, (counts.get(write.state) ?? 0) + 1);
    }
    return [...counts].map(([state, count]) => `${count} ${state}`).join(', ');
}

/** The last error of the newest row that has one. */
function newestError(rows: readonly PendingWrite[]): string | null {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        const error = rows[index]!.lastError;
        if (error !== null) {
            return error;
        }
    }
    return null;
}

/**
 * Each outbox lane, by name: its rows (oldest first, by state), the head's
 * kind and attempts, every row's attempts together, and the last error, the
 * head's when it has one (what holds the lane), else the newest row's that
 * has one. What the server refused there follows, by its codes.
 */
export function laneGroups(rows: readonly PendingWrite[], unsent: readonly UnsentWrite[]): DetailGroup[] {
    const lanes = new Map<string, { rows: PendingWrite[]; unsent: UnsentWrite[] }>();
    const lane = (name: string) => {
        let entry = lanes.get(name);
        if (entry === undefined) {
            entry = { rows: [], unsent: [] };
            lanes.set(name, entry);
        }
        return entry;
    };
    const ordered = [...rows].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const write of ordered) {
        lane(write.lane).rows.push(write);
    }
    for (const write of unsent) {
        lane(write.lane).unsent.push(write);
    }
    return [...lanes.keys()].sort().map((name) => {
        const entry = lanes.get(name)!;
        const head = entry.rows[0];
        const lastError = head?.lastError ?? newestError(entry.rows);
        const id = `tech-lane-${name}`;
        return {
            title: name,
            testID: id,
            rows: [
                row(
                    'Rows',
                    entry.rows.length === 0 ? '0' : `${entry.rows.length} (${statesLine(entry.rows)})`,
                    `${id}-rows`,
                ),
                row('Head', head === undefined ? null : `${head.kind} · ${head.attempts} attempts`, `${id}-head`),
                row(
                    'Attempts',
                    entry.rows.reduce((sum, write) => sum + write.attempts, 0),
                    `${id}-attempts`,
                ),
                row('Last error', lastError, `${id}-error`, true),
                row(
                    'Unsent',
                    entry.unsent.length === 0
                        ? '0'
                        : `${entry.unsent.length} (${[...new Set(entry.unsent.map((write) => write.reason))].join(', ')})`,
                    `${id}-unsent`,
                ),
            ],
        };
    });
}

/** The web's coding settings (CB-239): admins, while the `coding-sessions` flag is on for them, as the web's nav lists it. */
export const CODING_PATH = '/settings/coding';
/** The web's Operations health page, which lists the socios' computers: admins, as the web's module gate. */
export const COMPUTERS_PATH = '/operations/health';

/**
 * The engineering features that open the web until they're ported,
 * each only where the web lists it for this person, so no link lands on a
 * page the web would send them away from.
 */
export function webLinks(workspace: Pick<ShellWorkspace, 'user' | 'flags'> | null): WebLink[] {
    if (workspace === null || !isAdmin(workspace.user)) {
        return [];
    }
    const links: WebLink[] = [];
    if (workspace.flags?.on.includes('coding-sessions') === true) {
        links.push({
            title: 'Coding sessions',
            subtitle: 'Models, repositories and limits',
            path: CODING_PATH,
            testID: 'tech-link-coding',
        });
    }
    links.push({
        title: 'Computers',
        subtitle: 'The socios’ computers and their resources',
        path: COMPUTERS_PATH,
        testID: 'tech-link-computers',
    });
    return links;
}

/** Where the open workspace's push stands, in a few words; the codes are raw. */
export function pushStatusLine(status: PushStatus): string {
    switch (status.kind) {
        case 'unknown':
            return 'Not checked yet';
        case 'build':
            return 'Off: this build can’t get notifications (Personal Team)';
        case 'no-relay':
            return 'Off: this build has no push relay';
        case 'no-permission':
            return 'Off: notifications aren’t allowed';
        case 'no-token':
            return 'Off: the phone gave no push token';
        case 'subscribed':
            return 'Subscribed';
        case 'host-not-allowed':
            return 'Refused: the server’s push hosts don’t include the relay (400)';
        case 'failed':
            return `Failed at ${status.step}: ${status.status}`;
    }
}

/** The workspace's push registration as the registry keeps it, as the Push section reads it. */
export interface PushRegistrationLike {
    readonly registrationId: string | null;
    readonly pushKey: string | null;
}

/** How many of the server's push key's characters show: enough to tell keys apart, never the whole key. */
export const PUSH_KEY_SHOWN = 12;

/** A keepalive's answer in a few words; the codes are raw. */
export function refreshLine(refresh: PushRefresh | null, now: number): string {
    if (refresh === null) {
        return 'None since the app started';
    }
    const answer =
        typeof refresh.answer === 'number'
            ? `Refused (${refresh.answer})`
            : { done: 'OK', gone: 'Gone (410)', forbidden: 'Not ours (403)', offline: 'No answer' }[refresh.answer];
    return `${ago(refresh.at, now)} · ${answer}`;
}

/**
 * The Push section's rows: the status and, once subscribed, the
 * server's subscription id; the relay registration's state; the last keepalive
 * and its answer; the server's push key's first characters.
 */
export function pushRows(
    status: PushStatus,
    registration: PushRegistrationLike | null = null,
    refresh: PushRefresh | null = null,
    now = 0,
): DetailRow[] {
    const key = registration?.pushKey ?? null;
    return [
        row('Push', pushStatusLine(status), 'tech-push-status'),
        ...(status.kind === 'subscribed'
            ? [row('Subscription', status.subscriptionId, 'tech-push-subscription', true)]
            : []),
        row(
            'Relay registration',
            registration?.registrationId == null ? 'Not registered' : 'Registered',
            'tech-push-registration',
        ),
        row('Last keepalive', refreshLine(refresh, now), 'tech-push-keepalive'),
        row(
            'Push key',
            key === null ? null : key.length > PUSH_KEY_SHOWN ? `${key.slice(0, PUSH_KEY_SHOWN)}…` : key,
            'tech-push-key',
        ),
    ];
}
