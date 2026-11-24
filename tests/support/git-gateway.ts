// The Git proxy's world for tests (CB-239, CB-267): a Platform with the
// flags on, GitHub as the loopback fake (git http-backend over bare
// repositories), coding-git on loopback, and a stand-in for the model gateway's
// listener that hands every request to the Git routes with a fixed stamped
// sandbox. No network beyond 127.0.0.1.
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import type { ActorScope } from '@socio/shared/actor-scopes';

import { createCodingGitServer } from '../../src/coding-git/server.js';
import { CodingGit } from '../../src/coding-git/service.js';
import { gatewaySourcesOf } from '../../src/server/gateway/adopted.js';
import { CodingGitClient } from '../../src/server/gateway/coding-git-client.js';
import { gitGateway, gitRoutes } from '../../src/server/gateway/git.js';
import { GitHubApp } from '../../src/server/github/api.js';
import { fakeGitHub } from '../github-fake.js';
import { makeTestRuntime } from '../helpers/test-runtime.js';

import { PERSON, tempDir, workRepo } from './git-repos.js';

export const SANDBOX = 'sbx-1';
export const SESSION_BRANCH = 'socio/rulo/ab12cd34';
const SECRET = 'coding-git-secret-0123456789abcdef';

async function listen(server: Server) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function gitWorld(
    cleanup: Array<() => unknown>,
    options: { flags?: Record<string, boolean>; codingGit?: boolean } = {},
) {
    const root = tempDir('cb-git-gateway-', cleanup);
    const github = await fakeGitHub(join(root, 'github'), cleanup, {
        organizations: ['acme'],
    });
    const converted = await GitHubApp.convertManifest(github.createApp('acme'), {
        hosts: github.hosts,
    });
    github.install(Number(converted.id), ['app', 'other'], 'acme');
    // The repository on GitHub: main with a base commit by a person.
    const seed = workRepo(join(root, 'seed'));
    seed.write('README.md', '# app\n');
    seed.write('src/index.ts', 'export const answer = 42;\n');
    seed.write('docs/guide.md', '# Guide\n');
    seed.commit('base', PERSON);
    github.repository('acme', 'app', seed.dir);
    github.repository('acme', 'other', seed.dir);

    const { platform, edge, workspace, dispose } = await makeTestRuntime({
        config: {
            apiKey: '',
            model: '',
            sessionSecret: 'git-gateway-secret-0123456789abcdef',
            appOrigin: 'https://socio.example',
            // Its flags are in development: only an internal deployment has them (CB-503).
            deploymentKind: 'internal',
            featureFlags: options.flags ?? {
                'socio-actor-access': true,
                'coding-sessions': true,
                'repo-extraction': true,
            },
            github: {
                app: { id: converted.id, privateKey: converted.privateKey },
            },
            githubAccess: { hosts: github.hosts },
            data: { userDataDir: join(root, 'userdata') },
        },
        // Who may run code (CB-376): the people the `code:run` permission covers.
        codeRunners: ['alice', 'bob'],
    });
    // These tests drive the gateways with stand-in prompt runs (no
    // `coding_runs` rows), so instead of the coding sessions' check their
    // runs are live while their credential row exists.
    platform.actors.credentials.holders.override('prompt-run', () => true);
    cleanup.push(dispose);
    for (const user of [
        { id: 'alice', name: 'Alice', role: 'member' as const },
        { id: 'bob', name: 'Bob', role: 'member' as const },
        { id: 'olga', name: 'Olga', role: 'admin' as const },
    ]) {
        workspace.recordUser(user);
    }
    const socio = workspace.dots()[0]!;
    const chat = workspace.bindThread('chat-1', socio.id, 'Work', 'alice');
    const gateway = gitGateway(platform);

    // coding-git on loopback, as its own service would run.
    let codingGit: CodingGit | undefined;
    if (options.codingGit !== false) {
        codingGit = new CodingGit({ dir: join(root, 'coding-git') });
        const server = createCodingGitServer(codingGit, SECRET);
        const url = await listen(server);
        cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
        gateway.context.codingGit = new CodingGitClient({ url, secret: SECRET });
    }

    // The gateway listener, standing in: every request is from SANDBOX, stamped.
    const routes = gitRoutes(gatewaySourcesOf(platform));
    let sandboxId = SANDBOX;
    const listener = createServer((request, response) => {
        void (async () => {
            const path = (request.url ?? '/').split('?')[0];
            const route = routes.find((entry) => entry.method === request.method && entry.match(path));
            if (!route) {
                request.resume();
                response.writeHead(404).end();
                return;
            }
            const controller = new AbortController();
            response.on('close', () => controller.abort());
            const headers = new Headers();
            for (const [key, value] of Object.entries(request.headers)) {
                if (typeof value === 'string') {
                    headers.set(key, value);
                }
            }
            const answer = await route.handle(
                new Request(`http://gateway.socio.internal${request.url}`, {
                    method: request.method,
                    headers,
                    body:
                        request.method === 'GET' ? undefined : (Readable.toWeb(request) as ReadableStream<Uint8Array>),
                    duplex: 'half',
                } as RequestInit),
                { sandboxId, correlationId: randomUUID(), signal: controller.signal },
            );
            response.writeHead(answer.status, Object.fromEntries(answer.headers));
            if (answer.body) {
                for await (const chunk of answer.body as unknown as AsyncIterable<Uint8Array>) {
                    response.write(chunk);
                }
            }
            response.end();
        })().catch(() => response.destroy());
    });
    const gatewayUrl = await listen(listener);
    cleanup.push(() => new Promise<void>((resolve) => listener.close(() => resolve())));

    await gateway.repos.save('acme/app', { push: true, pushChecklistConfirmed: true, extraction: true }, 'olga');

    const grant = (
        scopes: ActorScope[] = ['git:read', 'git:push', 'git:pr'],
        resources: Record<string, unknown> = {
            repository: 'acme/app',
            branch: SESSION_BRANCH,
            base: 'main',
        },
        personId = 'alice',
    ) =>
        platform.actors.grants.create({
            personId,
            socioId: socio.id,
            audiences: ['gateway:git'],
            scopes,
            resources,
            conversationId: chat.id,
            conversationKind: 'private',
            task: 'Fix the bug',
            approvedBy: personId,
            correlationId: 'test',
        });
    const credential = async (granted: Awaited<ReturnType<typeof grant>>, contextId = SANDBOX) =>
        (
            await platform.actors.credentials.issue({
                grant: granted,
                kind: 'cbgw',
                audiences: ['gateway:git'],
                contextId,
                holder: { kind: 'prompt-run', id: `run-${randomUUID()}` },
                correlationId: 'test',
            })
        ).token;

    return {
        root,
        github,
        platform,
        edge,
        workspace,
        socio,
        chat,
        gateway,
        gatewayUrl,
        codingGit,
        seed,
        grant,
        credential,
        /** The sandbox the listener's stamps name from now on. */
        stampAs(id: string) {
            sandboxId = id;
        },
    };
}

/** Git, as the sandbox's agent runs it, with `token` as the credential. */
export function sandboxGit(dir: string, token: string | undefined) {
    const auth = token ? Buffer.from(`:${token}`).toString('base64') : '';
    return [
        '-c',
        'credential.helper=',
        '-c',
        'protocol.version=0',
        ...(token ? ['-c', `http.extraHeader=Authorization: Basic ${auth}`] : []),
        '-C',
        dir,
    ];
}
