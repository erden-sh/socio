// The inbox files, under Node. The iOS extension and Android's messaging
// service write one file per decrypted push
// (`{workspaceId, link, tag, receivedAt}`, never a title or body: socio-push's
// `readInbox`). The app reads them at launch, on each return to the
// foreground, as a workspace's scope opens and as a notification comes while
// it is in front:
//
// - the open workspace's are handled, then deleted: a `tag` pulls that
//   conversation's history and steering, and the shell (the chat list's unread);
//   a link of `/` pulls the shell's notices and the room invites (an invite has
//   no tag); any other link pulls the shell;
// - `approval:` topics are dropped until approvals are pushed (they aren't yet);
// - another workspace's wait until it opens, only the newest per conversation
//   (or per kind of link without one) and none older than `INBOX_MAX_AGE_MS`:
//   the older ones pull nothing more, so a workspace that stays on the phone
//   but never opens doesn't pile them up;
// - a workspace no longer on the phone, and a file that doesn't parse, are
//   deleted.

/** One inbox file, as socio-push's `readInbox` parses it. */
export interface InboxFile {
    readonly id: string;
    readonly workspaceId: string;
    readonly link: string;
    readonly tag: string | null;
    readonly receivedAt: number;
}

/** What the open workspace pulls for the files it handled. */
export interface InboxPulls {
    /** Conversations whose history and steering are pulled, each once. */
    readonly conversations: readonly string[];
    /** The shell's snapshots (the chat list, the notices). */
    readonly shell: boolean;
    /** The room invites (a link of `/`). */
    readonly invites: boolean;
}

/** Tags of approvals' topics: dropped until approvals are pushed. */
export const APPROVAL_TOPIC = 'approval:';

/** How long another workspace's file waits for it to open: past this its scope's own sync covers it. */
export const INBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** What a file pulls, as `inboxPulls` reads it: two files with one key pull the same. */
function pullKey({ link, tag }: Pick<InboxFile, 'link' | 'tag'>): string {
    if (tag !== null) {
        return `tag:${tag}`;
    }
    return link.split(/[?#]/)[0] === '/' ? 'invites' : 'shell';
}

/** What the files ask the open workspace to pull. */
export function inboxPulls(files: readonly Pick<InboxFile, 'link' | 'tag'>[]): InboxPulls {
    const conversations = new Set<string>();
    let shell = false;
    let invites = false;
    for (const { link, tag } of files) {
        if (tag !== null && tag.startsWith(APPROVAL_TOPIC)) {
            continue;
        }
        shell = true;
        if (tag !== null) {
            conversations.add(tag);
        } else if (link.split(/[?#]/)[0] === '/') {
            invites = true;
        }
    }
    return { conversations: [...conversations], shell, invites };
}

export interface InboxDeps {
    /** socio-push's `readInbox`: the files oldest first, and the ids of those that don't parse. */
    readonly read: () => Promise<{ entries: readonly InboxFile[]; unreadable: readonly string[] }>;
    /** socio-push's `deleteInbox`. */
    readonly remove: (ids: readonly string[]) => Promise<void>;
    /** The workspace whose scope is open, or null. */
    readonly open: () => string | null;
    /** Whether a workspace is on this phone (any state but gone). */
    readonly known: (workspaceId: string) => Promise<boolean>;
    /** Pulls for the open workspace (`workspaceId`, still open when called). */
    readonly pull: (workspaceId: string, pulls: InboxPulls) => void;
    /** The time now, in ms since the epoch. */
    readonly now?: () => number;
    readonly onError?: (error: unknown) => void;
}

export interface InboxDrain {
    /** Reads and handles the files once; a call while one runs runs it once more after. Never rejects. */
    drain(): Promise<void>;
}

export function createInboxDrain(deps: InboxDeps): InboxDrain {
    const { onError = () => {}, now = Date.now } = deps;
    let running: Promise<void> | null = null;
    let again = false;

    const once = async () => {
        const { entries, unreadable } = await deps.read();
        const open = deps.open();
        const done = [...unreadable];
        const mine: InboxFile[] = [];
        const known = new Map<string, boolean>();
        const oldest = now() - INBOX_MAX_AGE_MS;
        /** Another workspace's file kept per workspace and pull key: the newest. */
        const kept = new Map<string, InboxFile>();
        for (const entry of entries) {
            if (entry.workspaceId === open) {
                mine.push(entry);
                done.push(entry.id);
                continue;
            }
            let here = known.get(entry.workspaceId);
            if (here === undefined) {
                here = await deps.known(entry.workspaceId);
                known.set(entry.workspaceId, here);
            }
            if (!here || entry.receivedAt < oldest) {
                done.push(entry.id);
                continue;
            }
            const key = `${entry.workspaceId}\n${pullKey(entry)}`;
            const before = kept.get(key);
            if (before === undefined || entry.receivedAt >= before.receivedAt) {
                kept.set(key, entry);
                if (before !== undefined) {
                    done.push(before.id);
                }
            } else {
                done.push(entry.id);
            }
        }
        if (open !== null && mine.length > 0 && deps.open() === open) {
            const pulls = inboxPulls(mine);
            if (pulls.shell) {
                deps.pull(open, pulls);
            }
        }
        if (done.length > 0) {
            await deps.remove(done);
        }
    };

    const run = (): Promise<void> =>
        once()
            .catch(onError)
            .then(() => {
                if (again) {
                    again = false;
                    return run();
                }
                return undefined;
            });

    return {
        drain() {
            if (running !== null) {
                again = true;
                return running;
            }
            running = run().finally(() => {
                running = null;
            });
            return running;
        },
    };
}

/** The slice of a workspace scope the pulls use. */
export interface PullScope {
    readonly histories: {
        held(): string[];
        history(threadId: string): { pull(): Promise<unknown> };
        preload(threadId: string): Promise<{ pull(): Promise<unknown> }>;
    };
    readonly steering: { held(): string[]; steering(threadId: string): { refresh(): unknown } };
    readonly scheduler: { poke(sources?: readonly string[]): void };
}

/**
 * Pulls what the files ask on the open scope: each conversation's history
 * (read from disk first when memory doesn't hold it, so the pull lands on the
 * phone's copy) and its steering while a screen holds it, the shell, and the
 * invites (`invitesSource`, the room-invites kind's id).
 */
export function applyInboxPulls(
    scope: PullScope,
    pulls: InboxPulls,
    invitesSource: string,
    onError: (error: unknown) => void = () => {},
): void {
    for (const id of pulls.conversations) {
        const chat = scope.histories.held().includes(id)
            ? Promise.resolve(scope.histories.history(id))
            : scope.histories.preload(id);
        chat.then((held) => held.pull()).catch(onError);
        if (scope.steering.held().includes(id)) {
            Promise.resolve(scope.steering.steering(id).refresh()).catch(onError);
        }
    }
    if (pulls.shell) {
        scope.scheduler.poke();
    }
    if (pulls.invites) {
        scope.scheduler.poke([invitesSource]);
    }
}
