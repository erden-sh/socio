import { native, type NativeTap, type PushKeys, type PushState, type PushStorage } from './native';

// The typed wrapper over SocioPush (README.md). Every id is checked here,
// before the native side makes a keychain account or a file name of it.

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** A workspace's name is the subtitle of a notification, never more. */
export const NAME_MAX = 200;

function checkId(kind: string, id: string): string {
    if (!ID.test(id)) {
        throw new TypeError(`socio-push: a ${kind} id is 1 to 128 letters, digits, "-" or "_".`);
    }
    return id;
}

/** Where this build keeps the push items: the shared keychain group or the app's own, and whether it has the inbox. */
export async function pushStorage(): Promise<PushStorage> {
    return native().storage();
}

/**
 * Makes a new P-256 key pair and auth secret for the workspace, natively, and
 * keeps them in the keychain, replacing any it had. Returns only the public
 * half and the auth secret, for the subscription.
 */
export async function createKeys(workspaceId: string): Promise<PushKeys> {
    return native().createKeys(checkId('workspace', workspaceId));
}

/** The workspace's subscription keys, or null when it has none. */
export async function getKeys(workspaceId: string): Promise<PushKeys | null> {
    return native().getKeys(checkId('workspace', workspaceId));
}

/** Deletes the workspace's keys, its flags and lease deadline, and every registration that points at it. */
export async function deleteKeys(workspaceId: string): Promise<void> {
    return native().deleteKeys(checkId('workspace', workspaceId));
}

/**
 * Indexes a relay registration (the push's `s`) by the workspace it belongs
 * to, with the workspace's name for the subtitle when several are signed in.
 */
export async function setRegistration(registrationId: string, workspaceId: string, name: string): Promise<void> {
    checkId('registration', registrationId);
    checkId('workspace', workspaceId);
    return native().setRegistration(registrationId, workspaceId, name.slice(0, NAME_MAX));
}

export async function deleteRegistration(registrationId: string): Promise<void> {
    return native().deleteRegistration(checkId('registration', registrationId));
}

/** The workspace's flags as the extension reads them, with the device's show-text setting. */
export async function getState(workspaceId: string): Promise<PushState> {
    return native().getState(checkId('workspace', workspaceId));
}

/** The workspace's copy is locked (Ended, or the lease): its notifications show generic text. */
export async function setLocked(workspaceId: string, locked: boolean): Promise<void> {
    return native().setLocked(checkId('workspace', workspaceId), locked);
}

/**
 * When the workspace's lease locks the copy (`leaseLockAt` in src/data/lease.ts,
 * ms since the epoch), or null. Past it, by the device clock, notifications
 * show generic text, though the app hasn't run to lock it.
 */
export async function setLeaseLockAt(workspaceId: string, at: number | null): Promise<void> {
    if (at !== null && !Number.isFinite(at)) {
        throw new TypeError('socio-push: leaseLockAt is a time in ms, or null.');
    }
    return native().setLeaseLockAt(checkId('workspace', workspaceId), at);
}

/** The device's "Show message text in notifications" (on until set). */
export async function setShowText(showText: boolean): Promise<void> {
    return native().setShowText(showText);
}

/**
 * Decrypts an aes128gcm body (base64url) with the workspace's keys, one record
 * only, and returns its text. Rejects on anything RFC 8291 refuses, or when the
 * workspace has no keys.
 */
export async function decrypt(workspaceId: string, body: string): Promise<string> {
    if (!BASE64URL.test(body)) {
        throw new TypeError('socio-push: the body is base64url without padding.');
    }
    return native().decrypt(checkId('workspace', workspaceId), body);
}

/** One push the extension or the service recorded: where it points, never what it said. */
export interface InboxEntry {
    /** The file's id (a UUID), for `deleteInbox`. */
    id: string;
    workspaceId: string;
    /** The payload's `link`, a web path. */
    link: string;
    /** The payload's `tag` (a conversation), or null. */
    tag: string | null;
    /** When the push came, in ms since the epoch. */
    receivedAt: number;
}

export interface Inbox {
    /** Oldest first. */
    entries: InboxEntry[];
    /** Files that don't parse as an entry: delete them, they point at nothing. */
    unreadable: string[];
}

/** One inbox file's JSON as an entry, or null when it isn't one. */
export function parseInboxEntry(id: string, json: string): InboxEntry | null {
    let value: unknown;
    try {
        value = JSON.parse(json);
    } catch {
        return null;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
    }
    const { workspaceId, link, tag, receivedAt } = value as Record<string, unknown>;
    if (
        typeof workspaceId !== 'string' ||
        !ID.test(workspaceId) ||
        typeof link !== 'string' ||
        !link.startsWith('/') ||
        (tag !== undefined && tag !== null && typeof tag !== 'string') ||
        typeof receivedAt !== 'number' ||
        !Number.isFinite(receivedAt)
    ) {
        return null;
    }
    return { id, workspaceId, link, tag: tag ?? null, receivedAt };
}

/** The inbox files the extension wrote, parsed. Empty where the build has no app group. */
export async function readInbox(): Promise<Inbox> {
    const entries: InboxEntry[] = [];
    const unreadable: string[] = [];
    for (const file of await native().listInbox()) {
        if (!UUID.test(file.id)) {
            continue;
        }
        const entry = parseInboxEntry(file.id, file.json);
        if (entry) {
            entries.push(entry);
        } else {
            unreadable.push(file.id);
        }
    }
    return { entries, unreadable };
}

/** Deletes the inbox files with these ids; one already gone is fine. */
export async function deleteInbox(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
        if (!UUID.test(id)) {
            throw new TypeError(`socio-push: "${id}" isn't an inbox file's id.`);
        }
    }
    if (ids.length > 0) {
        await native().deleteInbox([...ids]);
    }
}

/** Where a tapped notification points (Android): the workspace beside the path, never a URL. */
export interface PushTap {
    workspaceId: string;
    /** A web path. */
    link: string;
    tag: string | null;
}

/** A tap as the native side handed it, or null when it isn't one. */
export function parseTap(value: unknown): PushTap | null {
    if (typeof value !== 'object' || value === null) {
        return null;
    }
    const { workspaceId, link, tag } = value as Partial<NativeTap>;
    if (
        typeof workspaceId !== 'string' ||
        !ID.test(workspaceId) ||
        typeof link !== 'string' ||
        !link.startsWith('/') ||
        link.startsWith('//') ||
        (tag !== undefined && tag !== null && typeof tag !== 'string')
    ) {
        return null;
    }
    return { workspaceId, link, tag: tag ?? null };
}

/**
 * Tells Android's messaging service which chat is on screen (the workspace and the web path), or
 * null: a push for it isn't shown while the app is in front. A no-op on iOS, whose foreground
 * handler decides (src/push/taps.ts).
 */
export function setScreen(workspaceId: string | null, path: string | null): void {
    const module = native();
    if (!module.setScreen) {
        return;
    }
    module.setScreen(workspaceId === null ? null : checkId('workspace', workspaceId), path);
}

/** The notification tap that started the app, once (Android); null on iOS or without one. */
export async function takeLaunchTap(): Promise<PushTap | null> {
    const module = native();
    return module.takeLaunchTap ? parseTap(await module.takeLaunchTap()) : null;
}

/** Calls `listener` for each notification tap while the app runs (Android). On iOS it never calls. */
export function addTapListener(listener: (tap: PushTap) => void): { remove(): void } {
    const module = native();
    if (!module.addListener) {
        return { remove() {} };
    }
    return module.addListener('onTap', (value) => {
        const tap = parseTap(value);
        if (tap) {
            listener(tap);
        }
    });
}
