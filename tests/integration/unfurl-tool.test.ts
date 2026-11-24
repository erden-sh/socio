import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';

import type { DotTurn } from '@socio/foundation/turns/turn';
import { embedToken, type EmbedCard } from '@socio/shared/embed-card';

import { inspectMarkdown, markdownManager } from '../../packages/client/src/modules/pages/editor/markdown';
import { validateUrl } from '../../src/net/public-address.js';
import { MockAuthProvider } from '../../src/server/auth/mock.js';
import { webStoreOn } from '../../src/server/composition/integration-stores.js';
import { webConfigOf } from '../../src/server/composition/web.js';
import { WorkspacePageTools } from '../../src/server/pages/page-tools.js';
import { WorkspaceSettings } from '../../src/server/settings/contract.js';
import { unfurlTools } from '../../src/server/skills/unfurl-tool.js';
import { WebConfig } from '../../src/server/web/contract.js';
import { webModule } from '../../src/server/web/web-module.js';
import { WebReads, webSettingsFromEnv, type Resolver } from '../../src/server/web/web-reads.js';
import { PNG, pngOf } from '../fixtures/media.js';
import { articleHtml, fixTweetStatus, videoHtml, videoOembed } from '../fixtures/unfurl.js';
import { makeTestRuntime } from '../helpers/test-runtime.js';
import { takeEgressAttempts } from '../setup/egress-guard.js';

const SECRET = 'secret-0123456789abcdef-xyz';
const USERS = [
    { id: 'alice', name: 'Alice Moreno', role: 'admin' as const },
    { id: 'bob', name: 'Bob', role: 'member' as const },
];

// A local fake web: names under `.example` are pinned to the loopback
// fixture; every other name goes through the real public-address check,
// so loopback and private targets are refused for real.
const resolve: Resolver = async (url) =>
    url.hostname.endsWith('.example') ? { address: '127.0.0.1', family: 4 } : validateUrl(url.href);

interface Seen {
    host: string;
    url: string;
    headers: IncomingHttpHeaders;
}
let server: Server;
let port: number;
let seen: Seen[];
const routes = new Map<string, { type: string; body: string | Buffer; status?: number }>();
const origin = (host: string) => `http://${host}:${port}`;

beforeEach(async () => {
    seen = [];
    routes.clear();
    server = createServer((request, response) => {
        const host = (request.headers.host ?? '').split(':')[0];
        const url = request.url ?? '/';
        seen.push({ host, url, headers: request.headers });
        const route = routes.get(`${host}${url}`);
        if (!route) {
            response.writeHead(404, { 'Content-Type': 'text/plain' });
            response.end('not found');
            return;
        }
        response.writeHead(route.status ?? 200, { 'Content-Type': route.type });
        response.end(route.body);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    port = (server.address() as AddressInfo).port;
});

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    await new Promise((done) => server.close(done));
    takeEgressAttempts();
});

async function fixture(env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-unfurl-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { workspace, platform, app, dispose } = await makeTestRuntime({
        config: {
            sessionSecret: SECRET,
            data: { userDataDir: dir },
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(USERS, SECRET),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    for (const user of USERS) {
        workspace.recordUser(user);
    }
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        return (path: string) => app.request(`/api${path}`, { headers: { cookie } });
    };
    const dot = workspace.dots()[0];
    const space = workspace.spaces()[0];
    workspace.bindThread('thread', dot.id, 'Links', 'alice');
    const turn = {
        dot,
        userId: 'alice',
        threadId: 'thread',
        channel: false,
        purpose: 'chat',
        check: () => {},
        signal: new AbortController().signal,
        toolNames: () => [],
    } as unknown as DotTurn;
    const reads = new WebReads(
        webStoreOn(workspace.db),
        webSettingsFromEnv({ APP_ORIGIN: 'https://socio.example', ...env }),
        {
            resolve,
        },
    );
    const [tool] = unfurlTools({
        reads,
        media: platform.media,
        pages: new WorkspacePageTools(workspace),
        turn,
        fixTweetBase: origin('api.fxtwitter.example'),
        now: () => Date.parse('2026-10-27T12:00:00Z'),
    });
    const run = (args: Record<string, unknown>) =>
        tool.execute!((tool.parameters as z.ZodType).parse(args) as never) as Promise<Unfurled>;
    return { workspace, platform, space, dot, run, as };
}

/** What unfurl_link answers, loosely: a page, or an error. */
interface Unfurled {
    error?: string;
    reason?: string;
    page: { id: string; title: string; revision: number };
    media: { copied: number; files?: string[]; notCopied?: string[] };
    [key: string]: unknown;
}

/** The page's card, from its first ```embed fence. */
const cardOf = (content: string): EmbedCard | undefined => {
    const match = /```embed\n([\s\S]*?)\n```/.exec(content);
    return match ? embedToken({ lang: 'embed', text: match[1] }) : undefined;
};

/** Nothing about the person in any request the fake web saw. */
const expectAnonymous = () => {
    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
        const sent = `${request.url}\n${JSON.stringify(request.headers)}`;
        expect(sent).not.toMatch(/alice|moreno|bob|thread|cookie/i);
        expect(request.headers).not.toHaveProperty('authorization');
        expect(request.headers).not.toHaveProperty('from');
        expect(request.headers).not.toHaveProperty('referer');
        expect(request.headers['user-agent']).toBe(
            'SocioAgent/1.0 (user-directed agent; +https://socio.example/agents)',
        );
    }
};

it('imports an X post through FixTweet into a new page: card, full text, media copied into Files', async () => {
    const f = await fixture();
    const media = origin('pbs.twimg.example');
    routes.set(`api.fxtwitter.example/2/status/2113278666507485349`, {
        type: 'application/json',
        body: JSON.stringify(fixTweetStatus(media)),
    });
    routes.set('pbs.twimg.example/media/photo.png', {
        type: 'image/png',
        body: PNG,
    });
    routes.set('pbs.twimg.example/media/poster.png', {
        type: 'image/png',
        body: pngOf(64),
    });
    const result = await f.run({
        url: 'https://x.com/rivera/status/2113278666507485349?s=46',
    });
    expect(result).toMatchObject({
        page: {
            spaceId: f.space.id,
            title: 'Dana Rivera on X: The good news: you can *mid-train* yourself to the frontier!',
            created: true,
        },
        card: { kind: 'post', provider: 'X', author: 'Dana Rivera' },
        text: { complete: true },
        media: { copied: 2 },
        links: 1,
    });
    // x.com itself is never fetched: only the API and the media.
    expect(seen.map((request) => `${request.host}${request.url}`)).toEqual([
        'api.fxtwitter.example/2/status/2113278666507485349',
        'pbs.twimg.example/media/photo.png',
        'pbs.twimg.example/media/poster.png',
    ]);
    expectAnonymous();
    expect(seen[0].headers.accept).toBe('application/json');

    const page = f.workspace.pages.get(f.space.id, result.page.id);
    // The page opens in the rich editor: card, byline, the post, the rest.
    expect(inspectMarkdown(page.content)).toEqual({ supported: true });
    const doc = markdownManager.parse(page.content);
    expect(doc.content![0].type).toBe('embedCard');
    expect(page.content).toContain('you can \\*mid-train\\* yourself');
    expect(page.content).toContain('Carbon-X is out today.');
    expect(page.content).toContain('[https://example.org/carbon-x\\_paper](https://example.org/carbon-x_paper)');
    expect(page.content).toMatch(/Source: \[https:\/\/x\.com\/rivera/);
    const card = cardOf(page.content)!;
    expect(card).toMatchObject({
        url: 'https://x.com/rivera/status/2113278666507485349?s=46',
        kind: 'post',
        provider: 'X',
        author: 'Dana Rivera',
        handle: '@rivera',
        publishedAt: '2026-10-22T17:04:05.000Z',
        fetchedAt: '2026-10-27T12:00:00.000Z',
        media: [
            { kind: 'image', alt: 'A loss curve', width: 1200, height: 800 },
            { kind: 'video', width: 1280, height: 720 },
        ],
    });
    // No remote URL on the card: only the copies' ids.
    expect(JSON.stringify(card)).not.toContain('twimg');

    // The copies are in Alice's Files, under unfurled/x.com/.
    expect(result.media.files).toEqual([
        'unfurled/x.com/x-2113278666507485349-1.png',
        'unfurled/x.com/x-2113278666507485349-2.png',
    ]);
    const alice = await f.as('alice');
    const listing = await (await alice('/media?folder=unfurled/x.com/')).json();
    expect(listing.items).toHaveLength(2);

    // Any member reading the page sees the card's images, served safely.
    const bob = await f.as('bob');
    const image = await bob(`/media/embeds/${card.media![0].id}/content`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('x-content-type-options')).toBe('nosniff');
    expect(image.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);
    // Only recorded copies, by their own id: not a file id, not a guess.
    const item = listing.items[0] as { id: string };
    expect((await bob(`/media/embeds/${item.id}/content`)).status).toBe(404);
    expect((await bob('/media/embeds/nope/content')).status).toBe(404);
    // Alice deletes the copy: the card shows its note instead.
    const own = listing.items.find((entry: { path: string }) => entry.path.endsWith('-1.png')) as { id: string };
    await f.platform.media.deleteItem('alice', own.id);
    expect((await bob(`/media/embeds/${card.media![0].id}/content`)).status).toBe(404);
});

it('falls back to the older FixTweet API, and saves nothing when the post can’t be read', async () => {
    const f = await fixture();
    routes.set(`api.fxtwitter.example/status/5`, {
        type: 'application/json',
        body: JSON.stringify({
            code: 200,
            tweet: { text: 'Hello', author: { name: 'A', screen_name: 'a' } },
        }),
    });
    const ok = await f.run({ url: 'https://twitter.com/a/status/5' });
    expect(ok.page.title).toBe('A on X: Hello');
    expect(seen.map((request) => request.url)).toEqual(['/2/status/5', '/status/5']);
    const before = f.workspace.pages.list(f.space.id).length;
    const missing = await f.run({ url: 'https://x.com/a/status/6' });
    expect(missing.error).toMatch(/Couldn't read this post/);
    expect(f.workspace.pages.list(f.space.id)).toHaveLength(before);
});

it('adds an article to an existing page, keeping what was there', async () => {
    const f = await fixture();
    const news = origin('news.example');
    routes.set('news.example/2026/carbon-x', {
        type: 'text/html; charset=utf-8',
        body: articleHtml(news),
    });
    routes.set('news.example/media/lead.png', { type: 'image/png', body: PNG });
    // Not an image, whatever its name says: skipped, never stored.
    routes.set('news.example/media/figure.png', {
        type: 'text/html',
        body: '<script>alert(1)</script>',
    });
    const page = await f.workspace.pages.create(f.space.id, {
        title: 'Reading list',
        content: '# Reading list\n\nMy notes.',
    });
    const result = await f.run({
        url: `${news}/2026/carbon-x`,
        pageId: page.id,
    });
    expect(result).toMatchObject({
        page: { id: page.id, revision: page.revision + 1, added: 'at the end' },
        card: {
            kind: 'article',
            provider: 'Example News',
            title: 'Carbon-X explained',
            author: 'Sam Lee',
        },
        media: {
            copied: 1,
            notCopied: [`${news}/media/figure.png: not an image (text/html)`],
        },
    });
    expectAnonymous();
    const saved = f.workspace.pages.get(f.space.id, page.id);
    expect(saved.content.startsWith('# Reading list\n\nMy notes.\n\n```embed\n')).toBe(true);
    expect(inspectMarkdown(saved.content)).toEqual({ supported: true });
    expect(saved.content).toContain('## Carbon-X explained');
    expect(saved.content).not.toMatch(/alert|tracked|Copyright/);
    expect(saved.content).toContain(`- [${news}/papers/1](${news}/papers/1)`);
    expect(cardOf(saved.content)).toMatchObject({
        kind: 'article',
        text: 'What mid-training is & why it matters.',
        publishedAt: '2026-10-20T08:30:00.000Z',
        media: [{ kind: 'image', alt: 'The lead image' }],
    });
});

it('uses a page’s advertised oEmbed for a video’s card, never its player', async () => {
    const f = await fixture();
    const video = origin('video.example');
    routes.set('video.example/watch', {
        type: 'text/html',
        body: videoHtml(video),
    });
    routes.set('video.example/oembed?url=watch', {
        type: 'application/json',
        body: JSON.stringify(videoOembed(video)),
    });
    routes.set('video.example/media/talk.png', { type: 'image/png', body: PNG });
    const result = await f.run({ url: `${video}/watch`, title: 'The talk' });
    expect(result).toMatchObject({
        page: { title: 'The talk' },
        card: {
            kind: 'video',
            provider: 'ExampleTube',
            title: 'Carbon-X: the talk',
            author: 'Example Channel',
        },
        media: { copied: 1 },
    });
    const content = f.workspace.pages.get(f.space.id, result.page.id).content;
    expect(content).not.toMatch(/iframe|<script|x\.js/);
    expect(cardOf(content)?.media).toEqual([{ id: expect.any(String), kind: 'video', width: 480, height: 360 }]);
    // The player's host was never asked for anything.
    expect(seen.map((request) => request.url)).toEqual(['/watch', '/oembed?url=watch', '/media/talk.png']);
});

it('keeps the web reads’ network rules: no loopback or private addresses, size caps', async () => {
    const f = await fixture({ WEB_MAX_BYTES: '2048' });
    const before = f.workspace.pages.list(f.space.id).length;
    // A loopback link is refused before any connection.
    for (const url of [`http://127.0.0.1:${port}/`, 'http://10.0.0.5/', 'http://localhost/']) {
        const refused = await f.run({ url });
        expect(refused).toMatchObject({ reason: 'blocked' });
    }
    expect(seen).toEqual([]);
    expect(f.workspace.pages.list(f.space.id)).toHaveLength(before);
    // Media on a private address, or over the size cap, aren't copied.
    const site = origin('site.example');
    routes.set('site.example/a', {
        type: 'text/html',
        body: `<html><head><title>A</title><meta property="og:image" content="http://192.168.1.10/x.png"></head><body><article><p>Text</p><img src="/big.png"></article></body></html>`,
    });
    routes.set('site.example/big.png', { type: 'image/png', body: pngOf(5000) });
    const result = await f.run({ url: `${site}/a` });
    expect(result.media.copied).toBe(0);
    expect(result.media.notCopied).toEqual([
        expect.stringMatching(/^http:\/\/192\.168\.1\.10\/x\.png: /),
        `${site}/big.png: larger than the web read size cap`,
    ]);
    expect(seen.map((request) => request.url)).toEqual(['/a', '/big.png']);
});

it('refuses links that aren’t pages, and the Spaces the socio may not use', async () => {
    const f = await fixture();
    routes.set('files.example/a.zip', {
        type: 'application/zip',
        body: Buffer.from('PK'),
    });
    expect(await f.run({ url: `${origin('files.example')}/a.zip` })).toEqual({
        error: 'This link is a application/zip, not a page, post or video: there is nothing to unfurl. Nothing was saved.',
    });
    const other = f.workspace.createSpace('Elsewhere', '');
    await expect(f.run({ url: `${origin('files.example')}/a.zip`, spaceId: other.id })).rejects.toThrow(/Space access/);
});

it('gives socios unfurl_link only where they may read the web', async () => {
    const f = await fixture();
    const tools = (allowed: boolean) =>
        webModule.dotTools!(
            {
                db: f.workspace.db,
                platform: f.platform,
                services: {
                    ...f.platform.context.services,
                    get: (tag: unknown) =>
                        tag === WorkspaceSettings
                            ? { settings: () => ({ researchAllowed: true }) }
                            : tag === WebConfig
                              ? webConfigOf({ web: undefined })
                              : f.platform.context.services.get(tag as never),
                },
            } as never,
            {
                dot: { ...f.dot, researchAllowed: allowed },
                userId: 'alice',
                threadId: 'thread',
                check: () => {},
                signal: new AbortController().signal,
            } as never,
        ).map((tool) => tool.name);
    expect(tools(true)).toContain('unfurl_link');
    expect(tools(false)).not.toContain('unfurl_link');
});

it('saves a video page’s description, not its player’s text, and a bare image as a photo', async () => {
    const f = await fixture();
    const video = origin('video.example');
    routes.set('video.example/v', {
        type: 'text/html',
        body: `<html><head><meta property="og:type" content="video.other"><meta property="og:title" content="Talk"><meta property="og:description" content="Line one.\nLine two."></head><body><div>Subscribe Like Share About Press</div></body></html>`,
    });
    const result = await f.run({ url: `${video}/v` });
    const content = f.workspace.pages.get(f.space.id, result.page.id).content;
    expect(content).toContain('Line one.');
    expect(content).not.toContain('Subscribe');
    expect(cardOf(content)).toMatchObject({ kind: 'video', title: 'Talk' });
    // A link straight to an image: read once, copied, shown on a photo card.
    routes.set('video.example/pics/a%ZZb.png', { type: 'image/png', body: PNG });
    const photo = await f.run({ url: `${video}/pics/a%ZZb.png` });
    expect(photo).toMatchObject({
        page: { title: 'a%ZZb.png' },
        card: { kind: 'photo' },
        media: { copied: 1 },
    });
    expect(seen.filter((request) => request.url === '/pics/a%ZZb.png')).toHaveLength(1);
});
