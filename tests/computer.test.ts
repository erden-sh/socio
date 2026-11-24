import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { computerInputs } from '@socio/shared/computers/computer-types';

import {
    BROWSER_STUCK,
    ComputerService,
    CREDENTIAL_CHECK_MS,
    CREDENTIAL_REFRESH_MAX,
    CREDENTIAL_REFRESH_WINDOW_MS,
    STUCK_BROWSER_MS,
} from '../src/server/computers/computer-service.js';
import { computerTools } from '../src/server/computers/computer-tools.js';
import { DataTokens } from '../src/server/dataspace/tokens.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase, testDatabaseFile } from './helpers/test-database.js';

const stores: WorkspaceStore[] = [];
afterEach(() => {
    for (const store of stores.splice(0)) {
        store.close();
    }
});
async function fixture(deadline = 1000, browserRead = deadline) {
    const workspace = new WorkspaceStore(testDatabase());
    stores.push(workspace);
    const id = workspace.dots()[0].id;
    const calls: { url: string; init?: RequestInit }[] = [];
    let paused = false;
    let endpoint: string | undefined;
    let health: string | undefined;
    let isolationVersion: number | undefined = 1;
    let actionHandler: (url: string, init?: RequestInit) => Promise<Response> = async () =>
        Response.json({ text: 'result' });
    const transport: typeof fetch = async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith('/computers')) {
            return Response.json({
                computers: workspace.dots().map((dot) => ({
                    botId: dot.id,
                    container: `company-brain-computer-${dot.id}`,
                    status: 'running',
                    ...(endpoint ? { url: endpoint } : {}),
                    ...(health ? { health } : {}),
                })),
            });
        }
        if (url.endsWith('/ensure')) {
            return Response.json({
                botId: id,
                container: `company-brain-computer-${id}`,
                status: 'running',
                url: `http://company-brain-computer-${id}:4100`,
            });
        }
        if (url.endsWith('/control')) {
            return Response.json({
                holder: 'human',
                requested: false,
                transitioning: false,
                resumeSnapshotRequired: false,
                request: { id: 'request', status: 'taken' },
            });
        }
        const response = await actionHandler(url, init);
        if (url.endsWith('/health') && response.ok) {
            return Response.json({ ...(await response.json()), isolationVersion });
        }
        return response;
    };
    const config = {
        baseUrl: 'https://example.com',
        voiceName: 'voice',
        runtimeUrl: 'http://localhost',
        computerSupervisorUrl: 'http://127.0.0.1:4312',
        computerSupervisorToken: 'supervisor-secret',
        computerToken: 'master-secret',
    };
    const service = new ComputerService(workspace, config, () => paused, transport, deadline, {}, browserRead);
    await workspace.computers.patch(id, {
        enabled: true,
        browser: true,
        files: true,
        shell: true,
    });
    return {
        workspace,
        id,
        service,
        calls,
        config,
        transport,
        setPaused: (value: boolean) => {
            paused = value;
        },
        setEndpoint: (value: string) => {
            endpoint = value;
        },
        setIsolation: (value: number | undefined) => {
            isolationVersion = value;
        },
        setHealth: (value: string) => {
            health = value;
        },
        handle: (fn: typeof actionHandler) => {
            actionHandler = fn;
        },
    };
}
it('defaults every permission off and persists policy and metadata-only audit across restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'computers-'));
    const path = testDatabaseFile(join(dir, 'db'));
    let workspace = new WorkspaceStore(path);
    const id = workspace.dots()[0].id;
    expect(await workspace.computers.permissions(id)).toEqual({
        enabled: false,
        browser: false,
        files: false,
        shell: false,
    });
    await workspace.computers.patch(id, { enabled: true, files: true });
    const audit = workspace.computers.begin(id, 'files_write', 'agent');
    workspace.computers.finish(audit, 'succeeded');
    workspace.close();
    workspace = new WorkspaceStore(path);
    expect((await workspace.computers.permissions(id)).files).toBe(true);
    expect((await workspace.computers.audit(id))[0]).toMatchObject({
        action: 'files_write',
        outcome: 'succeeded',
    });
    workspace.close();
    rmSync(dir, { recursive: true });
});
it('status never provisions and actions use per-socio derived credentials with audit before dispatch', async () => {
    const f = await fixture();
    f.config.computerToken = '  master-secret  ';
    await f.service.status(f.id);
    expect(f.calls.every((call) => !call.url.endsWith('/ensure'))).toBe(true);
    f.handle(async () => {
        expect((await f.workspace.computers.audit(f.id))[0].outcome).toBe('pending');
        return Response.json({ text: f.config.computerToken.trim() });
    });
    expect(
        await f.service.action(f.id, 'files_read', { path: 'note.txt' }, 'agent', undefined, 'fixture-person'),
    ).toEqual({ text: '[redacted]' });
    const request = f.calls.find((call) => call.url.endsWith('/files/read'))!;
    expect(new Headers(request.init?.headers).get('authorization')).toBe(
        `Bearer ${createHmac('sha256', 'master-secret').update(`company-brain-computer:${f.id}`).digest('hex')}`,
    );
    expect(new Headers(request.init?.headers).get('x-openbot-bot-id')).toBe(f.id);
    expect(request.init?.redirect).toBe('error');
    f.handle(async () => Response.json({ text: 'result' }));
    const other = f.workspace.createDot(f.workspace.spaces()[0].id, 'Other', '', true, true);
    await f.workspace.computers.patch(other.id, { enabled: true, files: true });
    await f.service.action(other.id, 'files_read', { path: 'note.txt' }, 'owner', undefined, 'fixture-person');
    const last = f.calls.at(-1)!;
    expect(new Headers(last.init?.headers).get('authorization')).not.toBe(
        new Headers(request.init?.headers).get('authorization'),
    );
    expect(last.url).toContain(other.id);
});
it('rejects foreign targets, nonexistent socios, traversal, unexpected inputs and agent human controls', async () => {
    const f = await fixture();
    f.setEndpoint('http://attacker.test:4100');
    await expect(f.service.action(f.id, 'read', {})).rejects.toThrow('endpoint');
    expect(f.calls).toHaveLength(1);
    await expect(f.service.action('missing', 'read', {})).rejects.toThrow('Socio not found');
    for (const path of ['../secret', 'a/../../secret', '/etc/passwd', 'a\\secret', 'a\0b']) {
        expect(computerInputs.files_read.safeParse({ path }).success).toBe(false);
    }
    expect(computerInputs.exec.safeParse({ command: 'pwd', timeoutMs: 60001 }).success).toBe(false);
    expect(computerInputs.read.safeParse({ url: 'http://elsewhere' }).success).toBe(false);
    await expect(f.service.action(f.id, 'human_type', { text: 'secret' }, 'agent')).rejects.toThrow('owner-only');
});
it('checks current permissions and global pause and records failure without sensitive inputs', async () => {
    const f = await fixture();
    await f.workspace.computers.patch(f.id, { shell: false });
    await expect(f.service.action(f.id, 'exec', { command: 'sensitive command' }, 'agent')).rejects.toThrow(
        'permission',
    );
    f.setPaused(true);
    await expect(f.service.action(f.id, 'read', {}, 'agent')).rejects.toThrow('paused');
    expect(f.calls).toHaveLength(0);
    expect(JSON.stringify(await f.workspace.computers.audit(f.id))).not.toContain('sensitive');
    expect((await f.workspace.computers.audit(f.id)).every((a) => a.outcome === 'failed')).toBe(true);
});
it('cancels in-flight actions on revocation and bounds upstream deadlines', async () => {
    const f = await fixture(200);
    f.handle(
        async (_url, init) =>
            new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            }),
    );
    const run = f.service.action(f.id, 'exec', { command: 'wait' }, 'agent', undefined, 'fixture-person');
    setTimeout(() => void f.workspace.computers.patch(f.id, { shell: false }), 20);
    await expect(run).rejects.toThrow('canceled or timed out');
    await expect(f.service.action(f.id, 'files_list', {}, 'owner', undefined, 'fixture-person')).rejects.toThrow(
        'canceled or timed out',
    );
    expect((await f.workspace.computers.audit(f.id)).every((a) => a.outcome === 'failed')).toBe(true);
});
it('preserves recovery handback after permissions are revoked; upstream failures are sanitized', async () => {
    const f = await fixture();
    await f.workspace.computers.patch(f.id, { enabled: false, browser: false });
    await f.service.control(f.id, 'release');
    expect(f.calls.some((call) => call.url.endsWith('/control/release'))).toBe(true);
    await f.workspace.computers.patch(f.id, { enabled: true, browser: true });
    f.handle(async () => Response.json({ error: 'secret upstream detail' }, { status: 500 }));
    await expect(f.service.action(f.id, 'read', {})).rejects.toThrow('HTTP 500');
    f.handle(async () => new Response('x'.repeat(4_000_001)));
    await expect(f.service.action(f.id, 'read', {})).rejects.toThrow('size limit');
});
it('binds tools to the current socio without exposing human or policy controls', async () => {
    const f = await fixture();
    const check = vi.fn();
    const tools = computerTools(f.service, f.id, check, new AbortController().signal, 'fixture-person');
    expect(tools.some((t) => t.name.includes('human') || t.name.includes('permission'))).toBe(false);
    const read = tools.find((t) => t.name === 'computer_files_read')!;
    await read.execute?.({ path: 'notes.txt' });
    expect(check).toHaveBeenCalled();
    expect(f.calls.at(-1)?.url).toContain(f.id);
});
it('tells a command the data space file routes, and a company socio its shared paths (CB-361)', async () => {
    const f = await fixture();
    const exec = (shared: boolean) =>
        computerTools(f.service, f.id, vi.fn(), new AbortController().signal, 'fixture-person', undefined, shared).find(
            (t) => t.name === 'computer_exec',
        )!.description;
    for (const shared of [false, true]) {
        expect(exec(shared)).toContain('GET $CB_DATA_URL/files?prefix=');
        expect(exec(shared)).toContain('GET $CB_DATA_URL/files/raw?path=');
        expect(exec(shared)).toContain('PUT $CB_DATA_URL/files with JSON');
    }
    expect(exec(true)).toContain('a file files_copy put at shared/<name> is path <name> there');
    expect(exec(false)).not.toContain('files_copy put at shared/');
    // Only exec carries it.
    const read = computerTools(f.service, f.id, vi.fn(), new AbortController().signal).find(
        (t) => t.name === 'computer_files_read',
    )!;
    expect(read.description).not.toContain('$CB_DATA_URL');
});
it('bounds completed audit storage while preserving pending work', async () => {
    const f = await fixture();
    const pending = f.workspace.computers.begin(f.id, 'exec', 'agent');
    for (let i = 0; i < 1010; i++) {
        f.workspace.computers.finish(f.workspace.computers.begin(f.id, 'read', 'owner'), 'succeeded');
    }
    f.workspace.computers.finish(pending, 'failed');
    expect(await f.workspace.computers.audit(f.id)).toHaveLength(50);
});

it('accepts an uppercase namespace while preserving exact container identity', async () => {
    const f = await fixture();
    const config = { ...f.config, computerNamespace: 'MyDots' };
    const transport: typeof fetch = async (input, init) => {
        if (String(input).endsWith('/computers')) {
            return Response.json({
                computers: [
                    {
                        botId: f.id,
                        container: `MyDots-computer-${f.id}`,
                        status: 'running',
                        url: `http://MyDots-computer-${f.id}:4100`,
                    },
                ],
            });
        }
        return f.transport(input, init);
    };
    const service = new ComputerService(f.workspace, config, () => false, transport);
    await expect(service.action(f.id, 'read', {})).resolves.toEqual({
        text: 'result',
    });
    expect(f.calls.at(-1)?.url).toBe(`http://mydots-computer-${f.id}:4100/read`);
});

it('gives agents a safe recovery instruction for stale browser or control conflicts', async () => {
    const f = await fixture();
    f.handle(async () => Response.json({ error: f.config.computerToken }, { status: 409 }));
    await expect(f.service.action(f.id, 'navigate', { url: 'https://example.com' }, 'agent')).rejects.toThrow(
        'computer_snapshot',
    );
    await expect(f.service.action(f.id, 'navigate', { url: 'https://example.com' }, 'agent')).rejects.not.toThrow(
        f.config.computerToken,
    );
    expect((await f.workspace.computers.audit(f.id))[0].outcome).toBe('failed');
});

it('says why the computer refused, and retakes the snapshot for a person', async () => {
    const f = await fixture();
    let snapshotNeeded = true;
    f.handle(async (url) => {
        if (url.endsWith('/snapshot')) {
            snapshotNeeded = false;
            return Response.json({ snapshotId: 1, text: 'page' });
        }
        return snapshotNeeded
            ? Response.json({ error: 'snapshot first', stale: true, snapshotRequired: true }, { status: 409 })
            : Response.json({ ok: true });
    });
    // An agent is told to take the snapshot itself.
    await expect(f.service.action(f.id, 'navigate', { url: 'https://example.com' }, 'agent')).rejects.toThrow(
        'the page changed or the computer restarted',
    );
    // A person's navigate takes it and retries once.
    await expect(f.service.action(f.id, 'navigate', { url: 'https://example.com' }, 'owner')).resolves.toEqual({
        ok: true,
    });
    expect(f.calls.slice(-3).map((c) => new URL(c.url).pathname)).toEqual(['/navigate', '/snapshot', '/navigate']);

    f.handle(async () => Response.json({ error: 'held', humanHasControl: true }, { status: 409 }));
    await expect(f.service.action(f.id, 'navigate', { url: 'https://example.com' }, 'owner')).rejects.toThrow(
        'a person has control of this computer',
    );
});

/** A computer that never answers a request until it is aborted. */
const never = (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
        }),
    );
const pathOf = (call: { url: string }) => new URL(call.url).pathname;

it('gives snapshots and screenshots a shorter limit than other browser actions', async () => {
    const f = await fixture(2000, 100);
    f.handle(async (url, init) => {
        if (url.endsWith('/health')) {
            return Response.json({ browser: true, browserState: 'running' });
        }
        if (url.endsWith('/navigate')) {
            await new Promise((resolve) => setTimeout(resolve, 300));
            return Response.json({ ok: true });
        }
        return never(url, init);
    });
    for (const action of ['snapshot', 'screenshot'] as const) {
        const started = Date.now();
        await expect(f.service.action(f.id, action, {}, 'agent')).rejects.toThrow('canceled or timed out');
        expect(Date.now() - started).toBeLessThan(1000);
    }
    // Longer than the snapshot limit, inside the usual one.
    await expect(f.service.action(f.id, 'navigate', { url: 'https://example.com' }, 'agent')).resolves.toEqual({
        ok: true,
    });
    // The browser answered its health: no breaker, the next call is made.
    await expect(f.service.action(f.id, 'snapshot', {}, 'agent')).rejects.toThrow('canceled or timed out');
    expect(f.calls.filter((c) => pathOf(c) === '/snapshot')).toHaveLength(2);
});

it('says the browser is stuck after a timeout, and fails browser calls fast until a restart', async () => {
    const f = await fixture(1000, 100);
    f.handle(async (url, init) => {
        if (url.endsWith('/health')) {
            return Response.json({ browser: false, browserState: 'stuck' });
        }
        if (url.endsWith('/files/read')) {
            return Response.json({ text: 'notes' });
        }
        if (url.endsWith('/exec')) {
            return Response.json({ exitCode: 0 });
        }
        if (url.endsWith('/stop')) {
            return Response.json({ stopped: true });
        }
        return never(url, init);
    });
    await expect(f.service.action(f.id, 'snapshot', {}, 'agent')).rejects.toThrow(BROWSER_STUCK);
    expect(f.calls.map(pathOf).slice(-2)).toEqual(['/snapshot', '/health']);
    const before = f.calls.length;
    // The breaker rejects both turns without dispatching a browser request.
    await expect(f.service.action(f.id, 'navigate', { url: 'https://example.com' }, 'agent')).rejects.toThrow(
        BROWSER_STUCK,
    );
    const nextTurn = new ComputerService(f.workspace, f.config, () => false, f.transport, 1000);
    await expect(nextTurn.action(f.id, 'screenshot', {}, 'agent')).rejects.toThrow(BROWSER_STUCK);
    expect(f.calls.slice(before).map(pathOf)).toEqual(['/computers', '/computers']);
    // Shell and files are not affected.
    await expect(
        f.service.action(f.id, 'files_read', { path: 'notes.txt' }, 'agent', undefined, 'fixture-person'),
    ).resolves.toEqual({ text: 'notes' });
    await expect(
        f.service.action(f.id, 'exec', { command: 'pwd' }, 'agent', undefined, 'fixture-person'),
    ).resolves.toEqual({ exitCode: 0 });
    // Stop (then Start) clears it: the next browser call reaches the computer.
    await f.service.stop(f.id);
    await expect(f.service.action(f.id, 'snapshot', {}, 'agent')).rejects.toThrow(BROWSER_STUCK);
    expect(f.calls.filter((c) => pathOf(c) === '/snapshot')).toHaveLength(2);
    // And so does time: after the window, the browser is tried again.
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + STUCK_BROWSER_MS);
    try {
        await expect(f.service.action(f.id, 'snapshot', {}, 'agent')).rejects.toThrow();
    } finally {
        clock.mockRestore();
    }
    expect(f.calls.filter((c) => pathOf(c) === '/snapshot')).toHaveLength(3);
    expect(
        (await f.workspace.computers.audit(f.id))
            .filter((a) => ['snapshot', 'screenshot', 'navigate'].includes(a.action))
            .every((a) => a.outcome === 'failed'),
    ).toBe(true);
});

it('reads a stuck browser from an older computer, a silent one and the supervisor', async () => {
    // An older computer reports only `browser: false`.
    const older = await fixture(1000, 100);
    older.handle(async (url, init) =>
        url.endsWith('/health') ? Response.json({ status: 'ok', browser: false }) : never(url, init),
    );
    await expect(older.service.action(older.id, 'screenshot', {}, 'agent')).rejects.toThrow(BROWSER_STUCK);
    // A computer whose health does not answer either.
    const silent = await fixture(1000, 100);
    silent.handle(never);
    await expect(silent.service.action(silent.id, 'snapshot', {}, 'agent')).rejects.toThrow(BROWSER_STUCK);
    // The supervisor reports the container unhealthy: no wait at all.
    const unhealthy = await fixture();
    unhealthy.setHealth('unhealthy');
    unhealthy.handle(async () => Response.json({ text: 'result' }));
    await expect(unhealthy.service.action(unhealthy.id, 'read', {}, 'agent')).rejects.toThrow(BROWSER_STUCK);
    await expect(
        unhealthy.service.action(unhealthy.id, 'files_list', {}, 'agent', undefined, 'fixture-person'),
    ).resolves.toEqual({ text: 'result' });
    expect(unhealthy.calls.map(pathOf)).not.toContain('/read');
});

it('ignores a stuck browser read from before a stop or start, and a job run clears the breaker', async () => {
    const f = await fixture(1000, 100);
    let answerHealth: (() => void) | undefined;
    f.handle(async (url, init) => {
        if (url.endsWith('/health')) {
            await new Promise<void>((resolve) => (answerHealth = resolve));
            return Response.json({ browser: false, browserState: 'stuck' });
        }
        if (url.endsWith('/stop')) {
            return Response.json({ stopped: true });
        }
        return never(url, init);
    });
    const snapshots = () => f.calls.filter((c) => pathOf(c) === '/snapshot').length;
    // The health read began before Stop and Start, and answers after them.
    const before = f.service.action(f.id, 'snapshot', {}, 'agent');
    await vi.waitFor(() => expect(answerHealth).toBeDefined());
    await f.service.stop(f.id);
    await f.service.start(f.id);
    answerHealth!();
    await expect(before).rejects.toThrow('canceled or timed out');
    // So the next call still reaches the computer, and this time it is stuck.
    answerHealth = undefined;
    const after = f.service.action(f.id, 'snapshot', {}, 'agent');
    await vi.waitFor(() => expect(answerHealth).toBeDefined());
    answerHealth!();
    await expect(after).rejects.toThrow(BROWSER_STUCK);
    expect(snapshots()).toBe(2);
    // A job run that starts the stopped computer clears it too.
    const stopped: typeof fetch = async (input, init) =>
        String(input).endsWith('/computers')
            ? Response.json({
                  computers: [
                      {
                          botId: f.id,
                          container: `company-brain-computer-${f.id}`,
                          status: 'exited',
                      },
                  ],
              })
            : f.transport(input, init);
    await new ComputerService(f.workspace, f.config, () => false, stopped, 1000).ensureRunning(f.id, { waitMs: 1000 });
    answerHealth = undefined;
    const job = f.service.action(f.id, 'snapshot', {}, 'agent');
    await vi.waitFor(() => expect(answerHealth).toBeDefined());
    answerHealth!();
    await expect(job).rejects.toThrow(BROWSER_STUCK);
    expect(snapshots()).toBe(3);
});

it('requires a trusted person and ignores forged principals in action input', async () => {
    const f = await fixture();
    await expect(f.service.action(f.id, 'exec', { command: 'id' })).rejects.toThrow('signed-in execution principal');
    expect(f.calls).toHaveLength(0);
    await expect(
        f.service.action(
            f.id,
            'exec',
            { command: 'id', principal: { kind: 'person', id: 'victim' } },
            'owner',
            undefined,
            'authenticated-person',
        ),
    ).rejects.toThrow();
    await f.service.action(f.id, 'exec', { command: 'id' }, 'owner', undefined, 'authenticated-person');
    const body = JSON.parse(String(f.calls.at(-1)?.init?.body));
    expect(body.principal).toEqual({
        kind: 'person',
        id: 'authenticated-person',
    });
});

it('refuses old computer images before writing credentials or running a command', async () => {
    const f = await fixture();
    f.setIsolation(undefined);
    await expect(f.service.action(f.id, 'exec', { command: 'id' }, 'owner', undefined, 'person')).rejects.toThrow(
        'isolated runtime image',
    );
    expect(f.calls.some((call) => call.url.endsWith('/exec') || call.url.endsWith('/files/write'))).toBe(false);
    await expect(
        f.service.writeFile(f.id, '.socio/apps/app.env', 'synthetic-secret', {
            kind: 'app',
            id: 'app',
        }),
    ).rejects.toThrow('isolated runtime image');
    expect(f.calls.some((call) => call.url.endsWith('/files/write'))).toBe(false);
});

it.each([
    ['start', 'before'],
    ['start', 'during'],
    ['ensureRunning', 'before'],
    ['ensureRunning', 'during'],
    ['telemetry-start', 'before'],
    ['telemetry-start', 'during'],
    ['telemetry-ensureRunning', 'before'],
    ['telemetry-ensureRunning', 'during'],
] as const)(
    'keeps fresh leases when a stopped listing from %s %s startup resolves late (CB-226)',
    async (operation, timing) => {
        const f = await fixture();
        const tokens = new DataTokens();
        const stopped = vi.fn((dotId: string) => tokens.revokeDot(dotId));
        let running = false;
        let holdListing = false;
        let answerListing: (() => void) | undefined;
        let answerEnsure: (() => void) | undefined;
        const state = () => ({
            botId: f.id,
            container: `company-brain-computer-${f.id}`,
            status: 'running',
            url: `http://company-brain-computer-${f.id}:4100`,
        });
        const transport: typeof fetch = async (input, init) => {
            const url = String(input);
            if (url.endsWith('/computers')) {
                if (holdListing) {
                    holdListing = false;
                    // The server took this snapshot while the computer was stopped;
                    // the response reaches the client after a successful start.
                    return new Promise<Response>((resolve) => {
                        answerListing = () => resolve(Response.json({ computers: [] }));
                    });
                }
                return Response.json({ computers: running ? [state()] : [] });
            }
            if (url.endsWith('/ensure')) {
                return new Promise<Response>((resolve) => {
                    answerEnsure = () => {
                        running = true;
                        resolve(Response.json(state()));
                    };
                });
            }
            return f.transport(input, init);
        };
        // A separate service represents another tab/turn on the same workspace.
        const observer = new ComputerService(f.workspace, f.config, () => false, transport, 2000, { stopped });
        const starter = new ComputerService(f.workspace, f.config, () => false, transport, 2000, { stopped });
        const telemetry = operation.startsWith('telemetry-');
        let observation: Promise<unknown> | undefined;
        const observeStoppedSnapshot = async () => {
            holdListing = true;
            observation = telemetry ? observer.resourceReadings() : observer.status(f.id);
            await vi.waitFor(() => expect(answerListing).toBeDefined());
        };
        if (timing === 'before') {
            await observeStoppedSnapshot();
        }
        const starting =
            operation === 'start' || operation === 'telemetry-start'
                ? starter.start(f.id, 'fixture-person')
                : starter.ensureRunning(f.id, {
                      userId: 'fixture-person',
                      waitMs: 2000,
                  });
        // Attach a handler immediately while the test controls the transport.
        starting.catch(() => {});
        await vi.waitFor(() => expect(answerEnsure).toBeDefined());
        if (timing === 'during') {
            await observeStoppedSnapshot();
        }
        answerEnsure!();
        await starting;
        const fresh = tokens.issue({
            userId: 'fixture-person',
            dotId: f.id,
            purpose: 'job',
            session: 'fresh-after-start',
        });
        const revocations = stopped.mock.calls.length;
        answerListing!();
        expect(await observation!).toEqual(telemetry ? [] : expect.objectContaining({ state: 'stopped' }));
        expect(stopped).toHaveBeenCalledTimes(revocations);
        expect(tokens.resolve(fresh)).toBeDefined();
    },
);

it.each([
    ['status', 'transport'],
    ['status', 'http'],
    ['status', 'invalid-listing'],
    ['status', 'timeout'],
    ['appTarget', 'transport'],
    ['appTarget', 'http'],
    ['appTarget', 'invalid-listing'],
    ['appTarget', 'timeout'],
    ['telemetry', 'transport'],
    ['telemetry', 'http'],
    ['telemetry', 'invalid-listing'],
] as const)('does not revoke leases when %s has an unknown %s failure (CB-226)', async (operation, failure) => {
    const f = await fixture();
    const tokens = new DataTokens();
    const live = tokens.issue({
        userId: 'fixture-person',
        dotId: f.id,
        purpose: 'job',
        session: 'still-running',
    });
    const stopped = vi.fn((dotId: string) => tokens.revokeDot(dotId));
    const transport: typeof fetch = async (input, init) => {
        if (String(input).endsWith('/computers')) {
            if (failure === 'transport') {
                throw new Error('Fixture transport unavailable');
            }
            if (failure === 'http') {
                return new Response('Fixture unavailable', { status: 503 });
            }
            if (failure === 'invalid-listing') {
                return Response.json({ computers: 'not a listing' });
            }
            return never(String(input), init);
        }
        return f.transport(input, init);
    };
    const service = new ComputerService(f.workspace, f.config, () => false, transport, 30, { stopped });
    const state =
        operation === 'telemetry'
            ? await service.resourceReadings()
            : operation === 'status'
              ? await service.status(f.id)
              : await service.appTarget(f.id, 3000);
    if (Array.isArray(state)) {
        expect(state).toEqual([]);
    } else {
        expect(state.state).toBe('unavailable');
    }
    expect(stopped).not.toHaveBeenCalled();
    expect(tokens.resolve(live)).toBeDefined();
});

it('redacts anything shaped like a Socio credential from what a computer returns (CB-232)', async () => {
    const f = await fixture();
    const echoed = [`cbsa_${'A'.repeat(43)}`, `cbgw_${'B'.repeat(43)}`, `cbob_v1.${'C'.repeat(60)}`];
    f.handle(async () => Response.json({ text: `env: ${echoed.join(' ')}` }));
    expect(
        await f.service.action(f.id, 'files_read', { path: 'note.txt' }, 'agent', undefined, 'fixture-person'),
    ).toEqual({ text: 'env: [redacted] [redacted] [redacted]' });
});
it('restarts a running computer that refuses its credential with the current one, then retries once (CB-331)', async () => {
    const f = await fixture();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
        const ensures = () => f.calls.filter((call) => call.url.endsWith('/ensure')).length;
        // Started under an older key: it refuses until the supervisor replaces it.
        f.handle(async (url) =>
            url.endsWith('/files/read') && ensures() === 0
                ? new Response('', { status: 401 })
                : Response.json({ text: 'ok' }),
        );
        expect(
            await f.service.action(f.id, 'files_read', { path: 'note.txt' }, 'agent', undefined, 'fixture-person'),
        ).toEqual({ text: 'ok' });
        expect(ensures()).toBe(1);
        // Ensure, never reset or stop: the volumes stay.
        expect(f.calls.some((call) => /\/(reset|stop)$/.test(call.url))).toBe(false);
        expect((await f.workspace.computers.audit(f.id)).map((entry) => entry.action)).toContain('refresh_credential');
        expect(warn.mock.calls.some(([line]) => String(line).includes('refused its credential'))).toBe(true);
    } finally {
        warn.mockRestore();
    }
});
it('a 401 a fresh credential does not cure restarts the computer once per window and never loops', async () => {
    const f = await fixture();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
        const ensures = () => f.calls.filter((call) => call.url.endsWith('/ensure')).length;
        f.handle(async (url) =>
            url.endsWith('/files/read') ? new Response('', { status: 401 }) : Response.json({ text: 'ok' }),
        );
        const read = () =>
            f.service.action(f.id, 'files_read', { path: 'note.txt' }, 'agent', undefined, 'fixture-person').then(
                () => 'ok',
                (error: Error) => error.message,
            );
        // Concurrent refusals share one restart; each call retries once, then reports the 401.
        expect(await Promise.all([read(), read()])).toEqual([
            'Computer service returned HTTP 401.',
            'Computer service returned HTTP 401.',
        ]);
        expect(ensures()).toBe(1);
        expect(await read()).toBe('Computer service returned HTTP 401.');
        expect(ensures()).toBe(1);
        // A new window allows another try, up to the limit, then none until the app restarts.
        for (let window = 0; window < CREDENTIAL_REFRESH_MAX + 2; window++) {
            vi.setSystemTime(Date.now() + CREDENTIAL_REFRESH_WINDOW_MS + 1);
            await read();
        }
        expect(ensures()).toBe(CREDENTIAL_REFRESH_MAX);
        expect(warn.mock.calls.some(([line]) => String(line).includes('not trying again'))).toBe(true);
    } finally {
        vi.useRealTimers();
        warn.mockRestore();
    }
});
it('a supervisor 401 never restarts a computer', async () => {
    const f = await fixture();
    const transport: typeof fetch = async (input, init) =>
        String(input).endsWith('/computers') ? new Response('', { status: 401 }) : f.transport(input, init);
    const service = new ComputerService(f.workspace, f.config, () => false, transport, 1000);
    expect((await service.status(f.id)).state).not.toBe('running');
    expect(f.calls.some((call) => call.url.endsWith('/ensure'))).toBe(false);
});
it('the background check finds a running computer on an older key and restarts it', async () => {
    const f = await fixture();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
        const ensures = () => f.calls.filter((call) => call.url.endsWith('/ensure')).length;
        f.handle(async (url) =>
            url.endsWith('/stats') ? Response.json({ error: 'none' }, { status: 404 }) : Response.json({ text: 'ok' }),
        );
        const transport: typeof fetch = async (input, init) =>
            String(input).endsWith('/control') && ensures() === 0
                ? (f.calls.push({ url: String(input), init }), new Response('', { status: 401 }))
                : f.transport(input, init);
        const service = new ComputerService(f.workspace, f.config, () => false, transport, 1000);
        await service.resourceReadings();
        const controls = () => f.calls.filter((call) => call.url.endsWith('/control')).length;
        // The refused read, the restart, and the one retry that now succeeds.
        await vi.waitFor(() => expect([ensures(), controls()]).toEqual([1, 2]));
        // Checked again only after CREDENTIAL_CHECK_MS.
        await service.resourceReadings();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(controls()).toBe(2);
        expect(CREDENTIAL_CHECK_MS).toBeGreaterThan(60_000);
    } finally {
        warn.mockRestore();
    }
});
it('a stop wins over a credential restart for a 401 that arrives after it', async () => {
    const f = await fixture();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        let stopped = false;
        f.handle(async (url) => {
            if (url.endsWith('/files/read')) {
                await held;
                return new Response('', { status: 401 });
            }
            if (url.endsWith('/stop')) {
                stopped = true;
            }
            return Response.json({ text: 'ok' });
        });
        const read = f.service
            .action(f.id, 'files_read', { path: 'note.txt' }, 'agent', undefined, 'fixture-person')
            .catch((error: Error) => error.message);
        await vi.waitFor(() => expect(f.calls.some((call) => call.url.endsWith('/files/read'))).toBe(true));
        await f.service.stop(f.id, 'fixture-person');
        expect(stopped).toBe(true);
        release();
        expect(await read).toBe('Computer service returned HTTP 401.');
        expect(f.calls.some((call) => call.url.endsWith('/ensure'))).toBe(false);
    } finally {
        warn.mockRestore();
    }
});
