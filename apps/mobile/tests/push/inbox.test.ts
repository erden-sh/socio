import { describe, expect, it, vi } from 'vitest';

import {
    applyInboxPulls,
    createInboxDrain,
    INBOX_MAX_AGE_MS,
    type InboxFile,
    type InboxPulls,
    inboxPulls,
} from '../../src/push';

// The inbox files: the open workspace's are handled and
// deleted, another workspace's wait until it opens, a workspace gone and a
// file that doesn't parse are deleted, and `approval:` topics are dropped.

const ACME = 'ws-acme';
const BETA = 'ws-beta';

let ids = 0;
/** The fake clock: files are received a millisecond apart from here. */
const START = Date.UTC(2026, 10, 10);
const file = (workspaceId: string, link: string, tag: string | null = null, receivedAt?: number): InboxFile => {
    ids += 1;
    return {
        id: `00000000-0000-4000-8000-${String(ids).padStart(12, '0')}`,
        workspaceId,
        link,
        tag,
        receivedAt: receivedAt ?? START + ids,
    };
};

function inbox(
    files: InboxFile[],
    unreadable: string[] = [],
    { open = ACME as string | null, on = [ACME, BETA] } = {},
) {
    const state = { files: [...files], unreadable: [...unreadable], open, now: START + 1_000_000 };
    const pulled: { workspaceId: string; pulls: InboxPulls }[] = [];
    const removed: string[][] = [];
    const drain = createInboxDrain({
        read: async () => ({ entries: [...state.files], unreadable: [...state.unreadable] }),
        remove: async (gone) => {
            removed.push([...gone]);
            state.files = state.files.filter((entry) => !gone.includes(entry.id));
            state.unreadable = state.unreadable.filter((id) => !gone.includes(id));
        },
        open: () => state.open,
        known: async (id) => on.includes(id),
        pull: (workspaceId, pulls) => pulled.push({ workspaceId, pulls }),
        now: () => state.now,
    });
    return { state, pulled, removed, drain };
}

describe('what the inbox files pull', () => {
    it("a tag pulls that conversation's history and steering, and the shell", () => {
        expect(
            inboxPulls([
                { link: '/chats/a', tag: 'a' },
                { link: '/chats/a#m-2', tag: 'a' },
                { link: '/chats/b', tag: 'b' },
            ]),
        ).toEqual({
            conversations: ['a', 'b'],
            shell: true,
            invites: false,
        });
    });

    it('a link of / pulls the shell and the invites (an invite has no tag)', () => {
        expect(inboxPulls([{ link: '/', tag: null }])).toEqual({ conversations: [], shell: true, invites: true });
    });

    it('any other link (the test notification) pulls the shell', () => {
        expect(inboxPulls([{ link: '/settings/notifications', tag: null }])).toEqual({
            conversations: [],
            shell: true,
            invites: false,
        });
    });

    it('drops approval: topics until approvals are pushed', () => {
        expect(inboxPulls([{ link: '/approvals/x', tag: 'approval:x' }])).toEqual({
            conversations: [],
            shell: false,
            invites: false,
        });
    });
});

describe('draining the inbox', () => {
    it("handles and deletes the open workspace's, keeps another's until it opens", async () => {
        const mine = file(ACME, '/chats/a', 'a');
        const theirs = file(BETA, '/chats/b', 'b');
        const { drain, pulled, state } = inbox([mine, theirs]);

        await drain.drain();
        expect(pulled).toEqual([{ workspaceId: ACME, pulls: { conversations: ['a'], shell: true, invites: false } }]);
        expect(state.files).toEqual([theirs]);

        state.open = BETA;
        await drain.drain();
        expect(pulled.at(-1)).toEqual({
            workspaceId: BETA,
            pulls: { conversations: ['b'], shell: true, invites: false },
        });
        expect(state.files).toEqual([]);
    });

    it("deletes a workspace that's no longer on the phone, and files that don't parse", async () => {
        const gone = file('ws-gone', '/chats/x', 'x');
        const { drain, pulled, state } = inbox([gone], ['bad-1']);
        await drain.drain();
        expect(pulled).toEqual([]);
        expect(state.files).toEqual([]);
        expect(state.unreadable).toEqual([]);
    });

    it("keeps only the newest of another workspace's files per conversation and kind of link", async () => {
        const a1 = file(BETA, '/chats/a', 'a');
        const invite1 = file(BETA, '/');
        const a2 = file(BETA, '/chats/a#m-2', 'a');
        const b = file(BETA, '/chats/b', 'b');
        const invite2 = file(BETA, '/');
        const test1 = file(BETA, '/settings/notifications');
        const test2 = file(BETA, '/settings/notifications');
        const { drain, state, pulled } = inbox([a1, invite1, a2, b, invite2, test1, test2]);
        await drain.drain();
        expect(state.files).toEqual([a2, b, invite2, test2]);
        // A second drain finds nothing more to delete.
        await drain.drain();
        expect(state.files).toEqual([a2, b, invite2, test2]);

        state.open = BETA;
        await drain.drain();
        expect(pulled).toEqual([
            { workspaceId: BETA, pulls: { conversations: ['a', 'b'], shell: true, invites: true } },
        ]);
    });

    it("deletes another workspace's files past the age limit", async () => {
        const old = file(BETA, '/chats/a', 'a', START);
        const recent = file(BETA, '/chats/b', 'b', START + INBOX_MAX_AGE_MS);
        const { drain, state } = inbox([old, recent]);
        state.now = START + INBOX_MAX_AGE_MS + 1;
        await drain.drain();
        expect(state.files).toEqual([recent]);
    });

    it('keeps everything while no workspace is open (the lock screen)', async () => {
        const { drain, pulled, state, removed } = inbox([file(ACME, '/'), file(BETA, '/')], [], { open: null });
        await drain.drain();
        expect(pulled).toEqual([]);
        expect(state.files).toHaveLength(2);
        expect(removed).toEqual([]);
    });

    it('deletes approval topics without pulling', async () => {
        const { drain, pulled, state } = inbox([file(ACME, '/approvals/x', 'approval:x')]);
        await drain.drain();
        expect(pulled).toEqual([]);
        expect(state.files).toEqual([]);
    });

    it('runs once more after a drain asked while one runs, never two at once', async () => {
        const { drain, state, pulled } = inbox([file(ACME, '/chats/a', 'a')]);
        const first = drain.drain();
        state.files.push(file(ACME, '/chats/b', 'b'));
        const second = drain.drain();
        await Promise.all([first, second]);
        expect(pulled.flatMap(({ pulls }) => pulls.conversations)).toEqual(['a', 'b']);
        expect(state.files).toEqual([]);
    });

    it('never rejects: a read that fails is reported', async () => {
        const onError = vi.fn();
        const drain = createInboxDrain({
            read: () => Promise.reject(new Error('no group')),
            remove: async () => {},
            open: () => ACME,
            known: async () => true,
            pull: () => {},
            onError,
        });
        await expect(drain.drain()).resolves.toBeUndefined();
        expect(onError).toHaveBeenCalledOnce();
    });
});

describe('pulling on the open scope', () => {
    it('pulls each history (from disk first when not held), held steering, the shell and the invites', async () => {
        const pulls: string[] = [];
        const scope = {
            histories: {
                held: () => ['held'],
                history: (id: string) => ({ pull: async () => pulls.push(`history ${id}`) }),
                preload: async (id: string) => {
                    pulls.push(`preload ${id}`);
                    return { pull: async () => pulls.push(`history ${id}`) };
                },
            },
            steering: {
                held: () => ['held'],
                steering: (id: string) => ({ refresh: () => pulls.push(`steering ${id}`) }),
            },
            scheduler: { poke: (sources?: readonly string[]) => pulls.push(`poke ${sources?.join(',') ?? 'all'}`) },
        };
        applyInboxPulls(scope, { conversations: ['held', 'cold'], shell: true, invites: true }, 'room-invites');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(pulls.sort()).toEqual(
            ['history held', 'steering held', 'preload cold', 'history cold', 'poke all', 'poke room-invites'].sort(),
        );
    });
});
