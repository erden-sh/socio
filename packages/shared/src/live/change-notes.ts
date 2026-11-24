/*
 * What changed, by topic and id, never content (CB-74): the notes a
 * successful write makes and the topics a view shows that each note is for.
 * Shared by the web's tab channel and the app; pure, without the
 * channel or the hook.
 */

/** What a note can be about. */
export const NOTE_TOPICS = [
    'conversation',
    'task',
    'memory',
    'call',
    'space',
    'dot',
    'settings',
    'setup',
    'apps',
    'page',
    'issue',
    'approval',
    'capture',
    'schedule',
    'run',
    'learning',
    'domains',
    'telegram-link',
    'media',
    'data',
    'access',
] as const;
export type NoteTopic = (typeof NOTE_TOPICS)[number];

/** A change: ids only (`spaceId` for pages), never content. */
export interface ChangeNote {
    topic: NoteTopic;
    id?: string;
    spaceId?: string;
}

// Ids as they appear in the app's paths: UUIDs, numbers, slugs, thread ids.
const ID = /^[\w.:-]{1,128}$/;
const KEYS = new Set(['topic', 'id', 'spaceId']);

/** Whether `value` is a note, and nothing more. */
export function isChangeNote(value: unknown): value is ChangeNote {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const note = value as Record<string, unknown>;
    return (
        Object.keys(note).every((key) => KEYS.has(key)) &&
        (NOTE_TOPICS as readonly unknown[]).includes(note.topic) &&
        (note.id === undefined || (typeof note.id === 'string' && ID.test(note.id))) &&
        (note.spaceId === undefined || (typeof note.spaceId === 'string' && ID.test(note.spaceId)))
    );
}

const withId = (key: 'id' | 'spaceId', value: string | undefined) =>
    value !== undefined && ID.test(value) ? { [key]: value } : {};
const note = (topic: NoteTopic, id?: string, spaceId?: string): ChangeNote => ({
    topic,
    ...withId('id', id),
    ...withId('spaceId', spaceId),
});
/** A note with only the ids that are ids: what may go on a channel. */
export const changeNote = note;

const decoded = (segment: string) => {
    try {
        return decodeURIComponent(segment);
    } catch {
        return '';
    }
};

/**
 * The notes a successful write to `path` (an `/api` path, without the
 * prefix) makes. Ids come from the path itself, never from the body or
 * the query, so a note can't carry what was written. Writes nobody else
 * shows (a sign-in, a query, a screenshot, a recorded use) make none.
 */
export function notesForWrite(path: string): ChangeNote[] {
    const parts = (path.split(/[?#]/)[0] ?? '').split('/').filter(Boolean).map(decoded);
    const [head, a, b, c, d] = parts;
    switch (head) {
        case 'rooms':
            // A room is a conversation (CB-212): its list, its view, its
            // transcript. `/rooms` itself (a new room) and the invite inbox
            // change the shell's lists only.
            return a && !['invites', 'socio-requests', 'readiness'].includes(a)
                ? [note('conversation', a)]
                : [note('conversation')];
        case 'conversations':
            return b === 'page' ? [note('conversation', a), note('page')] : [note('conversation', a)];
        case 'spaces':
            if (b !== 'pages') {
                return [note('space', a)];
            }
            if (d === 'used') {
                return [];
            }
            return d === 'conversation' ? [note('page', c, a), note('conversation')] : [note('page', c, a)];
        case 'dots':
            if (b === 'computer') {
                return c === 'permissions' ? [note('dot', a)] : [];
            }
            return [note('dot', a)];
        case 'settings':
            return [note('settings')];
        case 'memories':
            return [note('memory', a)];
        case 'tasks':
            return b === 'schedule' ? [note('task', a), note('schedule')] : [note('task', a)];
        case 'voice':
            return a === 'calls' ? [note('call', b)] : [];
        case 'issues':
            return [note('issue', a && /^\d+$/.test(a) ? a : undefined)];
        case 'issue-attachments':
        case 'dot-requests':
            return [note('issue')];
        case 'approvals':
            return a === 'policies' || a === 'guidance' ? [note('approval')] : [note('approval', a)];
        case 'schedules':
            return [note('schedule'), note('task')];
        case 'learning':
            return [note('learning', a === 'containers' ? b : undefined)];
        case 'domains':
            return [note('domains')];
        case 'telegram':
            return [note('telegram-link'), note('setup')];
        case 'apps':
            return b === 'launch' ? [] : [note('apps')];
        case 'media':
            return [note('media')];
        case 'data':
            // Reads by POST (queries, spec checks) change nothing.
            return parts.at(-1) === 'query' || a === 'specs' ? [] : [note('data')];
        case 'accounts':
        case 'service-accounts':
        case 'inference':
        case 'operator':
        case 'me':
            return [note('setup')];
        default:
            // `auth` (auth-channel.ts says it), and anything new: no note.
            return [];
    }
}

/**
 * The topics a tab shows that a note is for. A note without its id is for
 * every item of that kind (`issue:*`).
 * `*` is everything (an `access` note, or the tab coming back into view).
 */
export function liveTopicsOf({ topic, id, spaceId }: ChangeNote): string[] {
    const item = (prefix: string, value = id) => `${prefix}:${value ?? '*'}`;
    switch (topic) {
        case 'conversation':
            return ['shell', item('conversation')];
        case 'capture':
            return [item('conversation')];
        case 'call':
            return ['shell', item('call')];
        case 'memory':
            // The Memories page reads its own (CB-106).
            return ['shell', 'memories'];
        case 'task':
        case 'space':
        case 'dot':
        case 'settings':
        case 'apps':
            return ['shell'];
        case 'setup':
            // The operator's Platform page too (backends, BYO kinds).
            return ['shell', 'setup'];
        case 'page':
            return [item('space', spaceId)];
        case 'issue':
            return ['issues', item('issue')];
        case 'approval':
            return ['approvals', item('approval')];
        case 'learning':
            return ['learning', item('learning')];
        case 'schedule':
            return ['schedules'];
        case 'run':
            return ['runs'];
        case 'access':
            return ['*'];
        default:
            return [topic];
    }
}

/** Whether a tab showing `shown` refetches for `target` (a note's topic). */
export function topicMatches(shown: string, target: string) {
    if (target === '*' || target === shown) {
        return true;
    }
    return target.endsWith(':*') && shown.startsWith(target.slice(0, -1));
}
