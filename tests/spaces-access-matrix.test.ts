import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, it, vi } from 'vitest';

import { ROOM_DISCLOSURE_VERSION } from '@socio/shared/rooms/rooms';
import type { Space, User, WorkspaceState } from '@socio/shared/types';

import { agentMcpServer } from '../src/server/agents/mcp-tools.js';
import type { AppRecord } from '../src/server/apps/contract.js';
import { spaceMemoryForTurn } from '../src/server/memory/space-memory.js';
import { pageAccess } from '../src/server/pages/page-tools.js';

import { PNG } from './fixtures/media.js';
import { roomsFixture, ROOM_PEOPLE } from './fixtures/rooms.js';
import { testWorkspaceViews } from './helpers/page-views.js';

// Spaces made private (CB-181): one Space access rule (`SpaceAccess.reads`)
// answers every read path of a Space and what is in it. Each path is
// checked for the whole matrix: someone outside the Space, its member, its
// editor and a workspace admin (an editor of every Space), and a socio
// that has the Space or not, on a Space open to the workspace and on a
// private one. Outside a private Space it is "not found", word for word as
// a Space or page that isn't there.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

/** The matrix: Nina is outside, Mo a member, Ada its editor, Alice an admin. */
const PEOPLE = ['nina', 'mo', 'ada', 'alice'] as const;
type Person = (typeof PEOPLE)[number];
const READERS: readonly Person[] = ['mo', 'ada', 'alice'];
const WORD = 'zebracorn';

async function fixture() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = await roomsFixture(cleanup);
    const json = async <T>(response: Promise<Response> | Response) => (await response).json() as Promise<T>;
    const open = f.company.spaceId;
    // A member makes a private Space for herself and Mo.
    const made = await f.as('ada')('/spaces', 'POST', {
        name: 'Deals',
        description: 'Not for everyone.',
        private: true,
        people: [{ userId: 'mo', role: 'member' }],
    });
    expect(made.status).toBe(201);
    const closed = (await made.json()) as Space;
    const page = await json<{ id: string; revision: number }>(
        f.as('ada')(`/spaces/${closed.id}/pages`, 'POST', {
            title: `The ${WORD} deal`,
            content: `Terms of the ${WORD} deal.`,
        }),
    );
    const openPage = await json<{ id: string }>(
        f.as('olive')(`/spaces/${open}/pages`, 'POST', {
            title: 'Team handbook',
            content: `Everyone reads this, ${WORD} too.`,
        }),
    );
    // The company socio has both Spaces; another company socio only the open one.
    f.workspace.updateDot(
        f.company.id,
        {
            name: f.company.name,
            researchAllowed: true,
            memoryAllowed: true,
            spaceIds: [open, closed.id],
        },
        'alice',
    );
    const other = f.workspace.createDot(
        open,
        'Other',
        'Helps.',
        true,
        true,
        [open],
        null,
        false,
        null,
        false,
        null,
        'alice',
    );
    return { ...f, json, open, closed, page, openPage, other };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The status of each request, for each person. */
async function statuses(f: Fixture, requests: Record<string, [path: string, method?: string, body?: unknown]>) {
    const out: Record<string, Record<string, number>> = {};
    for (const person of PEOPLE) {
        out[person] = {};
        for (const [name, [path, method, body]] of Object.entries(requests)) {
            out[person][name] = (await f.as(person)(path, method, body)).status;
        }
    }
    return out;
}

/** The same row for readers, another for everyone else. */
const byReader = (
    reader: Record<string, number>,
    outsider: Record<string, number>,
    readers: readonly Person[] = READERS,
) => Object.fromEntries(PEOPLE.map((person) => [person, readers.includes(person) ? reader : outsider]));

const spaceReads = (spaceId: string, pageId: string) => ({
    tree: [`/spaces/${spaceId}/page-tree`] as [string],
    pages: [`/spaces/${spaceId}/pages`] as [string],
    library: [`/spaces/${spaceId}/pages?bodies=false`] as [string],
    page: [`/spaces/${spaceId}/pages/${pageId}`] as [string],
    memory: [`/spaces/${spaceId}/memory`] as [string],
    people: [`/spaces/${spaceId}/people`] as [string],
    search: [`/spaces/search?q=deal&space=${spaceId}`] as [string],
    location: [`/pages/${pageId}/location`] as [string],
    ask: [`/ask/conversation?kind=page&id=${pageId}`] as [string],
});

it('reads an open Space as before and a private one by its people only: every HTTP read path, the whole matrix', async () => {
    const f = await fixture();
    const all = (requests: object, code: number) =>
        Object.fromEntries(Object.keys(requests).map((name) => [name, code]));

    // Open to the workspace: everyone, as before.
    const openReads = spaceReads(f.open, f.openPage.id);
    expect(await statuses(f, openReads)).toEqual(byReader(all(openReads, 200), all(openReads, 200)));

    // Private: its people and admins; anyone else, a 404 everywhere.
    const closedReads = spaceReads(f.closed.id, f.page.id);
    expect(await statuses(f, closedReads)).toEqual(byReader(all(closedReads, 200), all(closedReads, 404)));

    // Writes, too: a page they can't see they can't change or chat about.
    const write = (person: Person, revision: number) =>
        f.as(person)(`/spaces/${f.closed.id}/pages/${f.page.id}`, 'PATCH', {
            title: `The ${WORD} deal`,
            expectedRevision: revision,
        });
    expect((await write('nina', f.page.revision)).status).toBe(404);
    expect(
        (
            await f.as('nina')(`/spaces/${f.closed.id}/pages`, 'POST', {
                title: 'Mine now',
            })
        ).status,
    ).toBe(404);
    expect(
        (await f.as('nina')(`/spaces/${f.closed.id}/pages/${f.page.id}/conversation`, 'POST', { dotId: f.company.id }))
            .status,
    ).toBe(404);
    expect((await write('mo', f.page.revision)).status).toBe(200);
    // A search-result click counts for readers only, and answers the same.
    for (const person of PEOPLE) {
        expect((await f.as(person)(`/spaces/${f.closed.id}/pages/${f.page.id}/used`, 'POST')).status).toBe(204);
    }
});

it('lists a private Space, its pages and its socios’ grants to its people only: sidebar, palette, search, socios', async () => {
    const f = await fixture();
    for (const person of PEOPLE) {
        const reader = READERS.includes(person);
        const view = await f.json<WorkspaceState>(f.as(person)('/workspace'));
        const listed = view.spaces.find((space) => space.id === f.closed.id);
        expect(!!listed, `${person} sidebar`).toBe(reader);
        if (listed) {
            expect(listed.private).toBe(true);
        }
        expect(view.spaces.find((space) => space.id === f.open)?.private, person).toBe(false);
        // A socio's grants never name it, nor count it.
        const company = view.dots.find((dot) => dot.id === f.company.id)!;
        expect(company.spaceIds.includes(f.closed.id), `${person} grants`).toBe(reader);
        expect(company.spaceIds.length, person).toBe(reader ? 2 : 1);
        // The palette's titles and page search.
        const titles = await f.json<Array<{ id: string }>>(f.as(person)('/pages/titles'));
        expect(
            titles.some((title) => title.id === f.page.id),
            `${person} titles`,
        ).toBe(reader);
        const found = await f.json<{ results: Array<{ id: string }> }>(f.as(person)(`/spaces/search?q=${WORD}`));
        expect(found.results.map((hit) => hit.id).sort(), `${person} search`).toEqual(
            (reader ? [f.page.id, f.openPage.id] : [f.openPage.id]).sort(),
        );
    }
    // Admins' Space lists show every Space, private ones marked.
    const admin = await f.json<WorkspaceState>(f.as('alice')('/workspace'));
    expect(admin.spaces.map((space) => space.access)).toEqual(['editor', 'editor']);
});

it('answers a private Space or page outside it exactly as one that isn’t there', async () => {
    const f = await fixture();
    const nina = f.as('nina');
    const answer = async (path: string, method = 'GET', body?: unknown) => {
        const response = await nina(path, method, body);
        return { status: response.status, body: await response.text() };
    };
    const pairs: Array<[string, string, string?, unknown?]> = [];
    const hidden = spaceReads(f.closed.id, f.page.id);
    const missing = spaceReads('no-such-space', 'no-such-page');
    for (const name of Object.keys(hidden) as Array<keyof typeof hidden>) {
        pairs.push([hidden[name][0], missing[name][0]]);
    }
    // A real page id in a Space that isn't there: the page isn't named.
    pairs.push([`/spaces/${f.closed.id}/pages/no-such-page`, `/spaces/no-such-space/pages/${f.page.id}`]);
    for (const [seen, absent] of pairs) {
        expect(await answer(seen), seen).toEqual(await answer(absent));
    }
    for (const [method, suffix, body] of [
        ['PATCH', `/pages/${f.page.id}`, { title: 'x', expectedRevision: 1 }],
        ['DELETE', `/pages/${f.page.id}`, undefined],
        ['POST', `/pages/${f.page.id}/move`, { spaceId: f.open }],
        ['POST', '/pages', { title: 'x' }],
        ['PUT', '/access', { membersOnly: false }],
        ['POST', '/memory', { text: 'A fact.' }],
    ] as const) {
        expect(await answer(`/spaces/${f.closed.id}${suffix}`, method, body), `${method} ${suffix}`).toEqual(
            await answer(`/spaces/no-such-space${suffix.replace(f.page.id, 'no-such-page')}`, method, body),
        );
    }
    // The Space's id is no use either: a socio can't be given it.
    const dot = await f.json<{ id: string }>(
        nina('/dots', 'POST', {
            name: 'Mine',
            instructions: 'Helps.',
            researchAllowed: true,
            memoryAllowed: true,
            spaceId: f.open,
        }),
    );
    const grant = (spaceId: string) =>
        answer(`/dots/${dot.id}`, 'PUT', {
            name: 'Mine',
            researchAllowed: true,
            memoryAllowed: true,
            spaceId: f.open,
            spaceIds: [f.open, spaceId],
        });
    expect(await grant(f.closed.id)).toEqual(await grant('no-such-space'));
});

it('keeps datasets, apps and link-card images shared with a private Space to its people', async () => {
    const f = await fixture();
    // Ada's dataset, shared with the private Space; Olive's with the open one.
    const dataset = await f.json<{ id: string }>(f.as('ada')('/data/datasets', 'POST', { name: 'Pipeline' }));
    expect(
        (
            await f.as('ada')(`/data/datasets/${dataset.id}`, 'PATCH', {
                sharedSpaceId: f.closed.id,
            })
        ).status,
    ).toBe(200);
    // Nobody shares with a Space they can't read: it is not found.
    const nina = await f.json<{ id: string }>(f.as('nina')('/data/datasets', 'POST', { name: 'Nina’s' }));
    const ninaShare = await f.as('nina')(`/data/datasets/${nina.id}`, 'PATCH', {
        sharedSpaceId: f.closed.id,
    });
    expect(ninaShare.status).toBe(404);
    const view = (person: Person, spaceId: string, pageId: string) =>
        f.as(person)('/data/views/query', 'POST', {
            spaceId,
            pageId,
            datasetId: dataset.id,
            query: 'SELECT 1 AS one',
        });
    const embed = await f.platform.media.saveEmbedMedia('ada', {
        name: 'card.png',
        bytes: PNG,
        folder: 'unfurled/example.com',
        spaceId: f.closed.id,
        dotId: f.company.id,
        sourceUrl: 'https://example.com/',
    });
    const app = {
        id: 'app-1',
        ownerUserId: 'olive',
        sharedSpaceId: f.closed.id,
    } as AppRecord;
    for (const person of PEOPLE) {
        const reader = READERS.includes(person);
        const listed = await f.json<{ datasets: Array<{ id: string }> }>(f.as(person)('/data'));
        expect(
            listed.datasets.some((item) => item.id === dataset.id),
            `${person} data`,
        ).toBe(reader);
        expect((await f.as(person)(`/data/datasets/${dataset.id}`)).status, `${person} dataset`).toBe(
            reader ? 200 : 404,
        );
        // An embedded view: only on a page they may read.
        expect((await view(person, f.closed.id, f.page.id)).status, `${person} view`).toBe(reader ? 200 : 404);
        expect((await f.as(person)(`/media/embeds/${embed.id}/content`)).status, `${person} embed`).toBe(
            reader ? 200 : 404,
        );
        // Mini apps shared with the Space (no app runtime here: the rule).
        expect(f.platform.apps.access(person, app), `${person} app`).toBe(reader ? 'space' : undefined);
    }
    // The owner of an app shared with a private Space always opens it.
    expect(f.platform.apps.access('olive', app)).toBe('owner');
    // Shared with the open Space: everyone, as before.
    expect(f.platform.apps.access('nina', { ...app, sharedSpaceId: f.open })).toBe('space');
});

it('lets a connected agent read only the Spaces its person reads', async () => {
    const f = await fixture();
    const connect = async (person: Person) => {
        const user = ROOM_PEOPLE.find((one) => one.id === person) as User;
        const server = agentMcpServer({
            workspace: f.workspace,
            board: f.platform.board,
            actor: {
                grantId: `g-${person}`,
                clientId: 'https://agent.example/client',
                clientName: 'Agent',
                clientDomain: 'agent.example',
                label: 'Agent',
                userId: person,
                scopes: ['pages:read'],
            },
            person: user,
            origin: 'http://localhost',
        });
        const [client, transport] = InMemoryTransport.createLinkedPair();
        const mcp = new Client({ name: 'matrix', version: '0.1.0' });
        await Promise.all([server.connect(transport), mcp.connect(client)]);
        cleanup.push(() => mcp.close());
        return async (name: string, args: Record<string, unknown> = {}) => {
            const result = await mcp.callTool({ name, arguments: args });
            return {
                isError: !!result.isError,
                text: (result.content as Array<{ text: string }>)[0]!.text,
            };
        };
    };
    for (const person of PEOPLE) {
        const reader = READERS.includes(person);
        const call = await connect(person);
        const spaces = await call('list_spaces');
        expect(spaces.text.includes(f.closed.id), `${person} spaces`).toBe(reader);
        expect(spaces.text.includes('Deals'), `${person} names`).toBe(reader);
        const read = await call('read_page', {
            spaceId: f.closed.id,
            pageId: f.page.id,
        });
        expect(read.isError, `${person} read`).toBe(!reader);
        if (!reader) {
            expect(read.text).not.toContain(WORD);
        }
        const search = await call('search_pages', { query: WORD });
        expect(search.text.includes(f.page.id), `${person} search`).toBe(reader);
        expect((await call('list_pages', { spaceId: f.closed.id })).isError).toBe(!reader);
    }
});

it('lets a socio read a private Space only when it has it and everyone reading its chat may', async () => {
    const f = await fixture();
    // Each person's own chat with each socio.
    const socios = { granted: f.company.id, ungranted: f.other.id };
    const access = (person: Person, dotId: string) => {
        const threadId = `${person}-${dotId}`;
        if (!f.workspace.thread(threadId)) {
            f.workspace.bindThread(threadId, dotId, 'Chat', person);
        }
        return pageAccess(f.workspace, f.open, threadId, () => {});
    };
    for (const person of PEOPLE) {
        for (const [which, dotId] of Object.entries(socios)) {
            const may = which === 'granted' && READERS.includes(person);
            const pages = access(person, dotId);
            const label = `${person} with the ${which} socio`;
            expect(
                pages.spaces().some((space) => space.id === f.closed.id),
                label,
            ).toBe(may);
            // The open Space: as before, for every person with either socio.
            expect(
                pages.spaces().some((space) => space.id === f.open),
                label,
            ).toBe(true);
            if (may) {
                expect((await pages.read(f.page.id, f.closed.id)).title).toContain(WORD);
                expect(
                    pages.list(f.closed.id).map((page) => page.id),
                    label,
                ).toEqual([f.page.id]);
            } else {
                await expect(pages.read(f.page.id, f.closed.id), label).rejects.toThrow(
                    'Space access has been revoked or was not granted.',
                );
                expect(() => pages.list(f.closed.id), label).toThrow();
            }
            const hits = pages.search({ query: WORD }).results.map((hit) => hit.id);
            expect(hits.includes(f.page.id), label).toBe(may);
            expect(hits.includes(f.openPage.id), label).toBe(true);
            // Apps shared with the Space, reached for the person (CB-232's tools).
            expect(
                f.platform.apps.socioMayReach(
                    {
                        id: 'app-1',
                        ownerUserId: 'olive',
                        sharedSpaceId: f.closed.id,
                    } as AppRecord,
                    person,
                    `${person}-${dotId}`,
                    dotId,
                ),
                label,
            ).toBe(may);
        }
    }

    // The Ask panel's socio about a private page: one that has the Space.
    const ask = (person: Person, dotId: string) =>
        f.as(person)(`/ask/conversation?kind=page&id=${f.page.id}&dotId=${dotId}`);
    expect((await ask('mo', f.company.id)).status).toBe(200);
    expect((await ask('mo', f.other.id)).status).toBe(400);
    expect((await ask('nina', f.company.id)).status).toBe(404);

    // A room: only when every member, and everyone invited, may read it.
    const room = await f.json<{ id: string }>(
        f.as('ada')('/rooms', 'POST', { dotId: f.company.id, title: 'Deal room' }),
    );
    await f.as('ada')(`/rooms/${room.id}/invites`, 'POST', { userId: 'mo' });
    await f.as('mo')(`/rooms/${room.id}/accept`, 'POST', {
        disclosureVersion: ROOM_DISCLOSURE_VERSION,
    });
    const inRoom = () => pageAccess(f.workspace, f.open, room.id, () => {});
    expect(
        inRoom()
            .spaces()
            .map((space) => space.id),
    ).toContain(f.closed.id);
    // Nina invited: not yet joined, still she may soon read the room.
    await f.as('ada')(`/rooms/${room.id}/invites`, 'POST', { userId: 'nina' });
    expect(
        inRoom()
            .spaces()
            .map((space) => space.id),
    ).not.toContain(f.closed.id);
    await expect(inRoom().read(f.page.id, f.closed.id)).rejects.toThrow();
    // Space memory in a turn follows the same rule.
    await f.as('ada')(`/spaces/${f.closed.id}/memory`, 'POST', {
        text: `The ${WORD} deal closes Friday.`,
    });
    const recall = (threadId: string, userId: string) =>
        spaceMemoryForTurn(f.store, f.workspace, {
            dotId: f.company.id,
            threadId,
            userId,
            query: `When does the ${WORD} deal close?`,
        });
    expect(await recall(room.id, 'ada')).toEqual([]);
    expect((await recall(`mo-${f.company.id}`, 'mo')).map((hit) => hit.spaceId)).toEqual([f.closed.id]);
    expect(await recall(`nina-${f.company.id}`, 'nina')).toEqual([]);
});

it('takes everything in a private Space from someone removed, at once, and gives it back when they return', async () => {
    const f = await fixture();
    // Mo's page chat and Ask chat about the private page.
    const chat = await f.platform.pages.conversation(f.closed.id, f.page.id, f.company.id, 'mo');
    const asked = await f.json<{ conversation: { id: string } }>(
        f.as('mo')('/ask/conversation', 'POST', {
            kind: 'page',
            id: f.page.id,
            dotId: f.company.id,
        }),
    );
    const chats = async () =>
        (await f.json<WorkspaceState>(f.as('mo')('/workspace'))).conversations.map((thread) => thread.id);
    expect(await chats()).toEqual(expect.arrayContaining([chat.id, asked.conversation.id]));
    // Every tab's poll of the shell sees the change (change counters).
    const mo = ROOM_PEOPLE.find((one) => one.id === 'mo')!;
    const before = await testWorkspaceViews(f.platform).workspaceVersion(mo);
    // Ada removes Mo.
    expect((await f.as('ada')(`/spaces/${f.closed.id}/people/mo`, 'DELETE')).status).toBe(200);
    expect(await testWorkspaceViews(f.platform).workspaceVersion(mo)).not.toBe(before);
    const view = await f.json<WorkspaceState>(f.as('mo')('/workspace'));
    expect(view.spaces.map((space) => space.id)).not.toContain(f.closed.id);
    expect(await chats()).not.toContain(chat.id);
    expect(await chats()).not.toContain(asked.conversation.id);
    for (const id of [chat.id, asked.conversation.id]) {
        expect((await f.as('mo')(`/conversations/${id}/transcript`)).status, id).toBe(404);
        expect((await f.as('mo')(`/conversations/${id}/page-context`)).status, id).toBe(404);
    }
    expect((await f.as('mo')(`/spaces/${f.closed.id}/pages/${f.page.id}`)).status).toBe(404);
    // Back in the Space: back in their lists.
    await f.as('ada')(`/spaces/${f.closed.id}/people/mo`, 'PUT', {
        role: 'member',
    });
    expect(await chats()).toEqual(expect.arrayContaining([chat.id, asked.conversation.id]));
});

it('lets anyone make a private Space, and only admins open one to the workspace', async () => {
    const f = await fixture();
    // A member asking for an open Space is refused; private is theirs.
    expect(
        (
            await f.as('nina')('/spaces', 'POST', {
                name: 'Open please',
                private: false,
            })
        ).status,
    ).toBe(403);
    const mine = await f.json<Space>(f.as('nina')('/spaces', 'POST', { name: 'Just me' }));
    const nina = await f.json<WorkspaceState>(f.as('nina')('/workspace'));
    expect(nina.spaces.find((space) => space.id === mine.id)).toMatchObject({
        private: true,
        access: 'editor',
    });
    // The rest of the workspace doesn't see it; admins do.
    for (const person of ['mo', 'olive']) {
        expect(
            (await f.json<WorkspaceState>(f.as(person)('/workspace'))).spaces.some((space) => space.id === mine.id),
        ).toBe(false);
    }
    expect(
        (await f.json<WorkspaceState>(f.as('alice')('/workspace'))).spaces.some((space) => space.id === mine.id),
    ).toBe(true);
    // Its editor can't open it to everyone; an admin can.
    expect(
        (
            await f.as('nina')(`/spaces/${mine.id}/access`, 'PUT', {
                membersOnly: false,
            })
        ).status,
    ).toBe(403);
    expect(
        (
            await f.as('alice')(`/spaces/${mine.id}/access`, 'PUT', {
                membersOnly: false,
            })
        ).status,
    ).toBe(200);
    expect(
        (await f.json<WorkspaceState>(f.as('mo')('/workspace'))).spaces.find((space) => space.id === mine.id),
    ).toMatchObject({ private: false, access: 'reader' });
    // An admin's Space is open by default; a private one is theirs to make.
    const admins = await f.json<Space>(f.as('alice')('/spaces', 'POST', { name: 'Everyone' }));
    expect(
        (await f.json<WorkspaceState>(f.as('mo')('/workspace'))).spaces.some((space) => space.id === admins.id),
    ).toBe(true);
    const hidden = await f.json<Space>(f.as('alice')('/spaces', 'POST', { name: 'Board', private: true }));
    expect(
        (await f.json<WorkspaceState>(f.as('mo')('/workspace'))).spaces.some((space) => space.id === hidden.id),
    ).toBe(false);
    // Making it private is audited by id.
    expect(f.workspace.auditOf('space_member', hidden.id)).toMatchObject([
        { actor: 'alice', action: 'create', detail: 'members only' },
    ]);
});

// The "create Spaces" permission: everyone by default (CB-181); an admin
// may keep it to admins in Settings. The server refuses the rest and tells
// each person's shell, which shows Create Space from it.
it('lets members create Spaces only while the create-Spaces permission includes them, and tells their shell', async () => {
    const f = await fixture();
    const permissions = async (person: string) =>
        (await f.json<WorkspaceState>(f.as(person)('/workspace'))).permissions;
    const nina = f.workspace.users().find((user) => user.id === 'nina')!;
    expect(await permissions('nina')).toEqual({ createSpaces: true });
    expect(await permissions('alice')).toEqual({ createSpaces: true });
    const before = await testWorkspaceViews(f.platform).workspaceVersion(nina);
    // Only an admin chooses, from the values there are.
    expect((await f.as('nina')('/settings', 'PATCH', { spaceCreators: 'admins' })).status).toBe(403);
    expect((await f.as('alice')('/settings', 'PATCH', { spaceCreators: 'members' })).status).toBe(400);
    expect((await f.as('alice')('/settings', 'PATCH', { spaceCreators: 'admins' })).status).toBe(200);
    // Admins only: a member's shell hides the control and its tab refetches.
    expect(await testWorkspaceViews(f.platform).workspaceVersion(nina)).not.toBe(before);
    expect(await permissions('nina')).toEqual({ createSpaces: false });
    expect(await permissions('alice')).toEqual({ createSpaces: true });
    const refused = await f.as('nina')('/spaces', 'POST', { name: 'Not now', private: true });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'Only workspace admins can create Spaces in this workspace.' });
    expect(f.workspace.spaces().some((space) => space.name === 'Not now')).toBe(false);
    // Admins still make either kind.
    expect((await f.as('alice')('/spaces', 'POST', { name: 'Admins open' })).status).toBe(201);
    expect((await f.as('alice')('/spaces', 'POST', { name: 'Admins closed', private: true })).status).toBe(201);
    // Everyone again: members make their private Space as before.
    expect((await f.as('alice')('/settings', 'PATCH', { spaceCreators: 'everyone' })).status).toBe(200);
    expect(await permissions('nina')).toEqual({ createSpaces: true });
    expect((await f.as('nina')('/spaces', 'POST', { name: 'Now' })).status).toBe(201);
});

it('makes no Space private while a runtime that would still show it is alive', async () => {
    const f = await fixture();
    f.workspace.spaceAccess.usePrivacyContract(() => false);
    const refused = await f.as('alice')('/spaces', 'POST', {
        name: 'Later',
        private: true,
    });
    expect(refused.status).toBe(409);
    expect(
        (
            await f.as('alice')(`/spaces/${f.open}/access`, 'PUT', {
                membersOnly: true,
            })
        ).status,
    ).toBe(409);
    // Opening one, and Spaces for everyone, wait for nothing.
    expect(
        (
            await f.as('alice')(`/spaces/${f.closed.id}/access`, 'PUT', {
                membersOnly: false,
            })
        ).status,
    ).toBe(200);
    expect((await f.as('alice')('/spaces', 'POST', { name: 'Now' })).status).toBe(201);
});

// Deleted Spaces (CB-277): a deleted Space, and everything in it, reads as
// one that isn't there on every path above, for everyone, its editors and
// admins too; restored, each reads again as before.

/** Ada's dataset, a link card and an app, all shared with the private Space. */
async function shares(f: Fixture) {
    const dataset = await f.json<{ id: string }>(f.as('ada')('/data/datasets', 'POST', { name: 'Pipeline' }));
    await f.as('ada')(`/data/datasets/${dataset.id}`, 'PATCH', {
        sharedSpaceId: f.closed.id,
    });
    const embed = await f.platform.media.saveEmbedMedia('ada', {
        name: 'card.png',
        bytes: PNG,
        folder: 'unfurled/example.com',
        spaceId: f.closed.id,
        dotId: f.company.id,
        sourceUrl: 'https://example.com/',
    });
    await f.as('ada')(`/spaces/${f.closed.id}/memory`, 'POST', {
        text: `The ${WORD} deal closes Friday.`,
    });
    // Mo's page chat and Ask chat about the private page.
    const chat = await f.platform.pages.conversation(f.closed.id, f.page.id, f.company.id, 'mo');
    const asked = await f.json<{ conversation: { id: string } }>(
        f.as('mo')('/ask/conversation', 'POST', {
            kind: 'page',
            id: f.page.id,
            dotId: f.company.id,
        }),
    );
    return {
        dataset,
        embed,
        chats: [chat.id, asked.conversation.id],
        app: {
            id: 'app-1',
            ownerUserId: 'olive',
            sharedSpaceId: f.closed.id,
        } as AppRecord,
    };
}

/** Every read of the private Space and what's in it, for `person`: true = sees it. */
async function sees(f: Fixture, shared: Awaited<ReturnType<typeof shares>>, person: Person) {
    const as = f.as(person);
    const view = await f.json<WorkspaceState>(as('/workspace'));
    const company = view.dots.find((dot) => dot.id === f.company.id)!;
    const titles = await f.json<Array<{ id: string }>>(as('/pages/titles'));
    const found = await f.json<{ results: Array<{ id: string }> }>(as(`/spaces/search?q=${WORD}`));
    const data = await f.json<{ datasets: Array<{ id: string }> }>(as('/data'));
    const thread = `${person}-${f.company.id}`;
    if (!f.workspace.thread(thread)) {
        f.workspace.bindThread(thread, f.company.id, 'Chat', person);
    }
    const pages = pageAccess(f.workspace, f.open, thread, () => {});
    const recall = await spaceMemoryForTurn(f.store, f.workspace, {
        dotId: f.company.id,
        threadId: thread,
        userId: person,
        query: `When does the ${WORD} deal close?`,
    });
    const status = async (path: string, method = 'GET', body?: unknown) => (await as(path, method, body)).status;
    const http = Object.fromEntries(
        await Promise.all(
            Object.entries(spaceReads(f.closed.id, f.page.id)).map(async ([name, [path]]) => [
                name,
                (await status(path)) === 200,
            ]),
        ),
    );
    return {
        ...http,
        sidebar: view.spaces.some((space) => space.id === f.closed.id),
        grant: company.spaceIds.includes(f.closed.id),
        palette: titles.some((title) => title.id === f.page.id),
        searched: found.results.some((hit) => hit.id === f.page.id),
        chats: view.conversations.some((thread) => shared.chats.includes(thread.id)),
        transcripts: (await status(`/conversations/${shared.chats[0]}/transcript`)) === 200,
        dataset:
            data.datasets.some((item) => item.id === shared.dataset.id) &&
            (await status(`/data/datasets/${shared.dataset.id}`)) === 200,
        view:
            (await status('/data/views/query', 'POST', {
                spaceId: f.closed.id,
                pageId: f.page.id,
                datasetId: shared.dataset.id,
                query: 'SELECT 1 AS one',
            })) === 200,
        embed: (await status(`/media/embeds/${shared.embed.id}/content`)) === 200,
        app: f.platform.apps.access(person, shared.app) !== undefined,
        socioSpaces: pages.spaces().some((space) => space.id === f.closed.id),
        socioRead: await pages.read(f.page.id, f.closed.id).then(
            () => true,
            () => false,
        ),
        socioSearch: pages.search({ query: WORD }).results.some((hit) => hit.id === f.page.id),
        socioApp: f.platform.apps.socioMayReach(shared.app, person, thread, f.company.id),
        recall: recall.some((hit) => hit.spaceId === f.closed.id),
    };
}

const everything = (value: boolean, person: Person) => ({
    tree: value,
    pages: value,
    library: value,
    page: value,
    memory: value,
    people: value,
    search: value,
    location: value,
    ask: value,
    sidebar: value,
    grant: value,
    palette: value,
    searched: value,
    // Mo's chats about its page; the others have none.
    chats: value && person === 'mo',
    transcripts: value && person === 'mo',
    // Ada's own dataset and link card stay hers; a share reads only with it.
    dataset: value || person === 'ada',
    view: value,
    embed: value || person === 'ada',
    app: value,
    socioSpaces: value,
    socioRead: value,
    socioSearch: value,
    socioApp: value,
    recall: value,
});

it('answers a deleted Space and everything in it as one that isn’t there, for everyone, and gives it all back on restore', async () => {
    const f = await fixture();
    const shared = await shares(f);
    for (const person of PEOPLE) {
        expect(await sees(f, shared, person), person).toEqual(everything(READERS.includes(person), person));
    }
    const mo = ROOM_PEOPLE.find((one) => one.id === 'mo')!;
    const before = await testWorkspaceViews(f.platform).workspaceVersion(mo);
    const closed = vi.spyOn(f.platform.apps, 'closeSpaceSockets');

    // Its editor deletes it: gone for everyone at once, admins included.
    expect((await f.as('ada')(`/spaces/${f.closed.id}`, 'DELETE')).status).toBe(200);
    expect(closed).toHaveBeenCalledWith(f.closed.id);
    expect(await testWorkspaceViews(f.platform).workspaceVersion(mo)).not.toBe(before);
    for (const person of PEOPLE) {
        expect(await sees(f, shared, person), `${person} deleted`).toEqual(everything(false, person));
    }

    // Word for word as a Space that isn't there, for its editor and an admin.
    for (const person of ['ada', 'alice'] as const) {
        const answer = async (path: string, method = 'GET', body?: unknown) => {
            const response = await f.as(person)(path, method, body);
            return { status: response.status, body: await response.text() };
        };
        const hidden = spaceReads(f.closed.id, f.page.id);
        const missing = spaceReads('no-such-space', 'no-such-page');
        for (const name of Object.keys(hidden) as Array<keyof typeof hidden>) {
            expect(await answer(hidden[name][0]), `${person} ${name}`).toEqual(await answer(missing[name][0]));
        }
        for (const [method, suffix, body] of [
            ['PATCH', `/pages/${f.page.id}`, { title: 'x', expectedRevision: 1 }],
            ['DELETE', `/pages/${f.page.id}`, undefined],
            ['POST', `/pages/${f.page.id}/move`, { spaceId: f.open }],
            ['POST', '/pages', { title: 'x' }],
            ['PUT', '/access', { membersOnly: false }],
            ['PUT', '/people/nina', { role: 'member' }],
            ['POST', '/memory', { text: 'A fact.' }],
            ['DELETE', '', undefined],
        ] as const) {
            expect(
                await answer(`/spaces/${f.closed.id}${suffix}`, method, body),
                `${person} ${method} ${suffix}`,
            ).toEqual(await answer(`/spaces/no-such-space${suffix.replace(f.page.id, 'no-such-page')}`, method, body));
        }
        // A page in another Space can't be moved into it, nor a socio given it.
        expect(
            (await f.as(person)(`/spaces/${f.open}/pages/${f.openPage.id}/move`, 'POST', { spaceId: f.closed.id }))
                .status,
        ).toBe(404);
    }
    const ask = await f.as('mo')(`/ask/conversation?kind=page&id=${f.page.id}&dotId=${f.company.id}`);
    expect(ask.status).toBe(404);

    // Its socio grant is kept, unused: editing the socio keeps it.
    expect(f.workspace.canAccessSpace(f.company.id, f.closed.id)).toBe(true);
    expect(
        (
            await f.as('alice')(`/dots/${f.company.id}`, 'PUT', {
                name: f.company.name,
                researchAllowed: true,
                memoryAllowed: true,
                spaceId: f.open,
                spaceIds: [f.open],
            })
        ).status,
    ).toBe(200);
    expect(f.workspace.canAccessSpace(f.company.id, f.closed.id)).toBe(true);

    // A connected agent sees nothing of it either.
    const server = agentMcpServer({
        workspace: f.workspace,
        board: f.platform.board,
        actor: {
            grantId: 'g-alice',
            clientId: 'https://agent.example/client',
            clientName: 'Agent',
            clientDomain: 'agent.example',
            label: 'Agent',
            userId: 'alice',
            scopes: ['pages:read'],
        },
        person: ROOM_PEOPLE.find((one) => one.id === 'alice')!,
        origin: 'http://localhost',
    });
    const [client, transport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'matrix', version: '0.1.0' });
    await Promise.all([server.connect(transport), mcp.connect(client)]);
    cleanup.push(() => mcp.close());
    const call = async (name: string, args: Record<string, unknown> = {}) => {
        const result = await mcp.callTool({ name, arguments: args });
        return {
            isError: !!result.isError,
            text: (result.content as Array<{ text: string }>)[0]!.text,
        };
    };
    expect((await call('list_spaces')).text).not.toContain(f.closed.id);
    const read = await call('read_page', {
        spaceId: f.closed.id,
        pageId: f.page.id,
    });
    expect(read.isError).toBe(true);
    expect(read.text).not.toContain(WORD);
    expect((await call('search_pages', { query: WORD })).text).not.toContain(f.page.id);
    expect((await call('list_pages', { spaceId: f.closed.id })).isError).toBe(true);

    // Kept: the row, its page, its people and its memory are all there.
    expect(f.workspace.withDeletedSpace(f.closed.id)).toMatchObject({
        deletedBy: 'ada',
    });
    expect(f.workspace.pages.withDeleted(f.page.id)?.deletedAt).toBeNull();

    // An admin restores it: everything back, for the people who could read it.
    expect((await f.as('alice')(`/admin/spaces/${f.closed.id}/restore`, 'POST')).status).toBe(200);
    for (const person of PEOPLE) {
        expect(await sees(f, shared, person), `${person} restored`).toEqual(
            everything(READERS.includes(person), person),
        );
    }
    expect(f.workspace.auditOf('space', f.closed.id)).toMatchObject([
        { actor: 'ada', action: 'delete', detail: 'private; 1 page' },
        { actor: 'alice', action: 'restore', detail: 'deleted by ada' },
    ]);
});
