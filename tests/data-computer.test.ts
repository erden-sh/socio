import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { computerInputs } from '@socio/shared/computers/computer-types';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { computersModule } from '../src/server/computers/computer-module.js';
import { COMPUTER_SECRET_PATH, ComputerService, computerSecretPath } from '../src/server/computers/computer-service.js';
import { computerTools } from '../src/server/computers/computer-tools.js';
import { SHARED_COMPUTER_READ_ONLY, sharedComputerNoDataset, sharedOwner } from '../src/server/dataspace/space.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture(apiUrl?: string) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-data-computer-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { app, workspace, platform, config, dispose } = await makeTestRuntime({
        config: {
            computerSupervisorUrl: 'http://127.0.0.1:4312',
            computerSupervisorToken: 'supervisor-secret',
            computerToken: 'master-secret',
            data: { userDataDir: dir, apiUrl },
            sessionSecret: 'secret-0123456789abcdef-xyz',
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    for (const user of DEFAULT_MOCK_USERS) {
        workspace.recordUser(user);
    }
    // A computer's command calling the data API with a token it holds.
    const api = (token: string, path: string, method = 'GET', body?: unknown) =>
        app.request(`http://company-brain-app:4310/api${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    const id = workspace.dots()[0].id;
    await workspace.computers.patch(id, {
        enabled: true,
        browser: true,
        files: true,
        shell: true,
    });
    const calls: Array<{ url: string; body?: unknown }> = [];
    // The computer's workspace: what the platform and the commands wrote.
    const files = new Map<string, string>();
    let running = true;
    let output = 'ok';
    let failExec = false;
    // What the command saw in its environment, and whether its token was live.
    const seen: Array<{ token?: string; live: boolean }> = [];
    // Runs while a command runs, with what the command holds: its token and
    // the run file as written (what another process could read meanwhile).
    let during: ((held: { token?: string; file?: string }) => Promise<unknown>) | undefined;
    const written = new Map<string, string>();
    const transport: typeof fetch = async (input, init) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, body });
        if (url.endsWith('/computers')) {
            return Response.json({
                computers: [
                    {
                        botId: id,
                        container: `company-brain-computer-${id}`,
                        status: running ? 'running' : 'stopped',
                        url: `http://company-brain-computer-${id}:4100`,
                    },
                ],
            });
        }
        if (url.endsWith('/health')) {
            return Response.json({ isolationVersion: 1 });
        }
        if (url.endsWith('/stop')) {
            return Response.json({ ok: true });
        }
        if (url.endsWith('/files/write')) {
            files.set(body.path, body.contents);
            written.set(body.path, body.contents);
            return Response.json({ ok: true });
        }
        if (url.endsWith('/files/read')) {
            return Response.json({ path: body.path, text: files.get(body.path) });
        }
        if (url.endsWith('/files/list')) {
            return Response.json({
                path: body.path,
                entries: [...files.keys()].map((path) => ({ path, kind: 'file' })),
                truncated: false,
            });
        }
        // Exec: the prefix sources its file, then deletes it and the old one.
        const command = String(body.command);
        const first = command.split('\n')[0];
        if (failExec && command.includes('\n')) {
            return new Response('down', { status: 502 });
        }
        const sourced = /\. \.\/(\S+);/.exec(first)?.[1];
        const token = sourced ? /CB_DATA_TOKEN='([^']+)'/.exec(files.get(sourced) ?? '')?.[1] : undefined;
        if (sourced) {
            seen.push({ token, live: !!platform.data.tokens.resolve(token) });
        }
        for (const match of first.matchAll(/rm -f ([^;\n]+)/g)) {
            for (const path of match[1].trim().split(/\s+/)) {
                for (const name of [...files.keys()]) {
                    if (
                        name === path ||
                        (path.includes('*') && name.startsWith(path.split('*')[0]) && name.endsWith(path.split('*')[1]))
                    ) {
                        files.delete(name);
                    }
                }
            }
        }
        if (sourced && during) {
            await during({ token, file: written.get(sourced) });
        }
        if (command.includes('find .socio/run')) {
            for (const path of [...files.keys()]) {
                if (path.startsWith('.socio/run/')) {
                    files.delete(path);
                }
            }
        }
        if (command.startsWith('cat ')) {
            return Response.json({
                stdout: files.get(command.slice(4).trim()) ?? '',
                exitCode: 0,
            });
        }
        return Response.json({
            stdout: output.replace('$TOKEN', token ?? ''),
            exitCode: 0,
            command: 'echoed',
        });
    };
    const service = new ComputerService(
        workspace,
        config,
        () => false,
        transport,
        5000,
        platform.dotExtensions.computer,
    );
    return {
        platform,
        workspace,
        api,
        id,
        service,
        calls,
        files,
        seen,
        setRunning: (value: boolean) => (running = value),
        setOutput: (value: string) => (output = value),
        setFailExec: (value: boolean) => (failExec = value),
        setDuring: (value: typeof during) => (during = value),
    };
}

const exec = (f: Awaited<ReturnType<typeof fixture>>, command: string, userId = 'alice') =>
    f.service.action(f.id, 'exec', { command }, 'agent', undefined, userId) as Promise<{ stdout: string }>;

it('hands exec its own data token through a file it deletes, never the command, and revokes it when the command returns', async () => {
    const f = await fixture('http://company-brain-app:4310');
    await exec(f, 'python3 track.py');
    const write = f.calls.find((call) => call.url.endsWith('/files/write'))!;
    const { path, contents } = write.body as { path: string; contents: string };
    expect(path).toMatch(/^\.socio\/run\/[0-9a-f-]{36}\.env$/);
    const token = /CB_DATA_TOKEN='([^']+)'/.exec(contents)![1];
    expect(contents).toContain("CB_DATA_URL='http://company-brain-app:4310/api/data'");
    const command = (
        f.calls.find((call) => call.url.endsWith('/exec'))!.body as {
            command: string;
        }
    ).command;
    expect(command.startsWith(`chmod 600 ${path} 2>/dev/null; set -a; [ -r ${path} ] && . ./${path}`)).toBe(true);
    expect(command.endsWith('\npython3 track.py')).toBe(true);
    expect(command).not.toContain(token);
    // The command had it, live; after it, the token and its file are gone.
    expect(f.seen).toEqual([{ token, live: true }]);
    expect(f.platform.data.tokens.resolve(token)).toBeUndefined();
    expect(f.platform.data.tokens.count()).toBe(0);
    expect([...f.files.values()].some((text) => text.includes(token))).toBe(false);
    // The next command gets another token; output that echoes it is redacted.
    f.setOutput('leak $TOKEN');
    expect((await exec(f, 'echo $CB_DATA_TOKEN')).stdout).toBe('leak [redacted]');
    expect(f.seen[1].token).toMatch(/^cbdt_/);
    expect(f.seen[1].token).not.toBe(token);
});

it('keeps a person’s data token out of the file tools, listings and output of the next person’s turn on the same company socio', async () => {
    const f = await fixture('http://company-brain-app:4310');
    expect(f.workspace.dot(f.id)?.ownerId ?? null).toBeNull();
    // A computer from before CB-224 kept a shared token here; a mini app's
    // token file sits beside it.
    f.files.set('.socio/data.env', "CB_DATA_TOKEN='cbdt_left_by_an_old_release'\n");
    f.files.set('.socio/apps/board.env', "CB_DATA_TOKEN='cbdt_app_token'\n");
    f.files.set('notes.txt', 'hello');
    // Alice's turn runs a command.
    const alice = computerTools(f.service, f.id, () => undefined, new AbortController().signal, 'alice');
    const tool = (tools: typeof alice, name: string) => tools.find((t) => t.name === `computer_${name}`)!;
    await tool(alice, 'exec').execute?.({
        command: 'python3 track.py',
        timeoutMs: 30_000,
    });
    const aliceToken = f.seen[0].token!;
    expect(aliceToken).toMatch(/^cbdt_/);
    // Her command deleted its own file and the old shared one.
    expect([...f.files.keys()].sort()).toEqual(['.socio/apps/board.env', 'notes.txt']);
    expect(f.platform.data.tokens.resolve(aliceToken)).toBeUndefined();
    // Bob's turn on the same socio, then.
    const bob = computerTools(f.service, f.id, () => undefined, new AbortController().signal, 'bob');
    const answers: unknown[] = [];
    for (const path of [
        '.socio/data.env',
        './.socio//data.env',
        '.socio/run/anything.env',
        '.socio/apps/board.env',
        '.socio/jobs/j/r/job.env',
    ]) {
        await expect(tool(bob, 'files_read').execute?.({ path })).rejects.toThrow(COMPUTER_SECRET_PATH);
        await expect(tool(bob, 'files_write').execute?.({ path, contents: 'x' })).rejects.toThrow(COMPUTER_SECRET_PATH);
    }
    await expect(tool(bob, 'files_list').execute?.({ path: '.socio/run' })).rejects.toThrow(COMPUTER_SECRET_PATH);
    // The workspace's listing leaves the token files out.
    const listing = (await tool(bob, 'files_list').execute?.({ path: '' })) as {
        entries: Array<{ path: string }>;
    };
    expect(listing.entries.map((entry) => entry.path)).toEqual(['notes.txt']);
    answers.push(listing);
    // A file that reaches a token some other way (a link, a copy) and a
    // command's output come back redacted; and Alice's token is dead anyway.
    f.files.set('link.txt', `CB_DATA_TOKEN='${aliceToken}'`);
    answers.push(await tool(bob, 'files_read').execute?.({ path: 'link.txt' }));
    f.setOutput(`old ${aliceToken}`);
    answers.push(await tool(bob, 'exec').execute?.({ command: 'env', timeoutMs: 30_000 }));
    answers.push(
        await tool(bob, 'exec').execute?.({
            command: 'cat .socio/apps/board.env',
            timeoutMs: 30_000,
        }),
    );
    const text = JSON.stringify(answers);
    expect(text).not.toContain(aliceToken);
    expect(text).not.toMatch(/cbdt_/);
    expect(text).toContain('[redacted]');
    expect(f.platform.data.tokens.resolve(aliceToken)).toBeUndefined();
    // Bob's commands had their own tokens, never Alice's.
    expect(f.seen.slice(1).every((run) => run.token !== aliceToken)).toBe(true);
    // The person at the Computer panel is refused the same way.
    await expect(f.service.action(f.id, 'files_read', { path: '.socio/data.env' }, 'owner')).rejects.toThrow(
        COMPUTER_SECRET_PATH,
    );
});

it('ends the token and deletes its file when the command never ran', async () => {
    const f = await fixture('http://company-brain-app:4310');
    f.setFailExec(true);
    await expect(exec(f, 'python3 track.py')).rejects.toThrow(/HTTP 502/);
    expect(f.platform.data.tokens.count()).toBe(0);
    expect([...f.files.keys()]).toEqual([]);
    expect((f.calls.at(-1)!.body as { command: string }).command).toMatch(
        /^\[ ! -L \.socio \] && \[ ! -L \.socio\/run \] && rm -f \.socio\/run\/[0-9a-f-]{36}\.env; true$/,
    );
});

it('never dispatches a root legacy-token cleanup to a computer', async () => {
    const f = await fixture('http://company-brain-app:4310');
    f.files.set('.socio/data.env', 'expired lease from a previous process');
    const before = f.calls.length;
    expect(computersModule.start).toBeUndefined();
    expect(f.calls.length).toBe(before);
});

it('revokes the token when the computer is found stopped, and gives none without DATA_API_URL', async () => {
    const f = await fixture('http://company-brain-app:4310');
    await exec(f, 'true');
    expect(f.seen[0].live).toBe(true);
    expect(f.platform.data.tokens.count()).toBe(0);
    f.setRunning(false);
    await expect(exec(f, 'true')).rejects.toThrow(/Start this socio/);
    expect(f.platform.data.tokens.count()).toBe(0);
    const plain = await fixture();
    await exec(plain, 'true');
    expect(plain.calls.some((call) => call.url.endsWith('/files/write'))).toBe(false);
    expect(
        (
            plain.calls.find((call) => call.url.endsWith('/exec'))!.body as {
                command: string;
            }
        ).command,
    ).toBe('true');
});

it('scopes a company socio’s command token to its shared area: a copy taken while it runs never reaches the person’s data', async () => {
    const f = await fixture('http://company-brain-app:4310');
    const dot = f.workspace.dot(f.id)!;
    expect(dot.ownerId ?? null).toBeNull();
    const data = f.platform.data;
    // Alice's own data with this socio: her scratch (as the chat fills it),
    // her per-person folder, a private grant and a folder grant.
    const person = data.tokens.forCommand('alice', f.id, 60_000, 'person');
    expect(
        (
            await f.api(person.token, '/data/datasets/scratch/tables', 'POST', {
                table: 'diary',
                columns: [{ name: 'a' }],
            })
        ).status,
    ).toBe(200);
    data.tokens.revokeSession(person.session);
    const aliceScratch = data.scratch('alice', f.id)!;
    const salaries = data.createDataset('alice', { name: 'Salaries' });
    const board = data.createDataset('alice', { name: 'Team board' });
    data.updateDataset('alice', board.id, { sharedSpaceId: dot.spaceId });
    for (const datasetId of [salaries.id, board.id]) {
        data.setGrant('alice', { dotId: f.id, datasetId, access: 'write' });
    }
    data.setGrant('alice', { dotId: f.id, folder: 'reports/', access: 'write' });
    const alice = { kind: 'user', userId: 'alice' } as const;
    await data.putFile(alice, 'reports/q3.txt', Buffer.from('private'));
    await data.putFile(alice, `dots/${f.id}/notes.txt`, Buffer.from('mine'));
    const checks: Record<string, { status: number; body: unknown }> = {};
    // While Alice's command runs, another process reads her token: from
    // the run file before the prefix deletes it, or from her environment.
    f.setDuring(async ({ token, file }) => {
        expect(file).toContain(`CB_DATA_TOKEN='${token}'`);
        const call = async (path: string, method = 'GET', body?: unknown) => {
            const response = await f.api(token!, path, method, body);
            return { status: response.status, body: await response.json() };
        };
        const query = (id: string) => call(`/data/datasets/${id}/query`, 'POST', { sql: 'SELECT 1' });
        checks.list = await call('/data/datasets');
        checks.usage = await call('/data/usage');
        checks.aliceScratch = await query(aliceScratch.id);
        checks.salaries = await query(salaries.id);
        checks.salariesByName = await query('Salaries');
        checks.missing = await query('no-such-dataset');
        checks.scratchDiary = await call('/data/datasets/scratch/query', 'POST', {
            sql: 'SELECT * FROM diary',
        });
        checks.board = await query(board.id);
        checks.boardWrite = await call(`/data/datasets/${board.id}/tables`, 'POST', {
            table: 't',
            columns: [{ name: 'a' }],
        });
        checks.boardRows = await call(`/data/datasets/${board.id}/tables/t/rows`, 'POST', { rows: [{ a: 1 }] });
        checks.shared = await call('/data/datasets/scratch/tables', 'POST', {
            table: 'notes',
            columns: [{ name: 'a' }],
        });
        for (const path of ['notes.txt', `dots/${f.id}/notes.txt`, 'reports/q3.txt', 'nothing.txt']) {
            checks[`file ${path}`] = await call(`/data/files/raw?path=${encodeURIComponent(path)}`);
        }
        checks.files = await call('/data/files');
        checks.put = await call('/data/files', 'PUT', {
            path: 'scan.txt',
            content: 'for everyone',
        });
        // Checked on every request: unsharing takes it out of reach at once.
        data.updateDataset('alice', board.id, { sharedSpaceId: null });
        checks.unshared = await query(board.id);
        // Shared with a Space that is then deleted (CB-277): no share while it is.
        const gone = f.workspace.createSpace('Gone', '');
        data.updateDataset('alice', board.id, { sharedSpaceId: gone.id });
        checks.reshared = await query(board.id);
        f.workspace.db.prepare("UPDATE spaces SET deletedAt=?, deletedBy='alice' WHERE id=?").run(Date.now(), gone.id);
        checks.spaceDeleted = await query(board.id);
    });
    await exec(f, 'python3 track.py');
    const token = f.seen[0].token!;
    expect(f.platform.data.tokens.resolve(token)).toBeUndefined();
    // Only the socio's shared dataset and, to read, the Space-shared one.
    expect(checks.list.status).toBe(200);
    expect(
        (checks.list.body as Array<{ name: string; access: string }>)
            .map((item) => `${item.name}: ${item.access}`)
            .sort(),
    ).toEqual([`${dot.name} shared: write`, 'Team board: read']);
    // The usage it writes against, with nobody's id.
    expect(checks.usage.status).toBe(200);
    expect(checks.usage.body).not.toHaveProperty('own.userId');
    // Out of reach and missing look the same: 404 with the same text.
    for (const [key, name] of [
        ['aliceScratch', aliceScratch.id],
        ['salaries', salaries.id],
        ['salariesByName', 'Salaries'],
        ['missing', 'no-such-dataset'],
        ['unshared', board.id],
        ['spaceDeleted', board.id],
    ]) {
        expect(checks[key], key).toEqual({
            status: 404,
            body: { error: sharedComputerNoDataset(name) },
        });
    }
    // "scratch" is the socio's shared dataset, not Alice's.
    expect(checks.scratchDiary.status).toBe(400);
    expect(checks.shared.status).toBe(200);
    expect(checks.board.status).toBe(200);
    expect(checks.reshared.status).toBe(200);
    // Space-shared data is read-only here, whatever Alice's approval policy.
    for (const key of ['boardWrite', 'boardRows']) {
        expect(checks[key], key).toEqual({
            status: 403,
            body: { error: SHARED_COMPUTER_READ_ONLY },
        });
    }
    expect(data.list({ kind: 'dot', userId: 'alice', dotId: f.id }).find((item) => item.id === board.id)?.tables).toBe(
        0,
    );
    // Alice's files are out of reach, like a file that doesn't exist.
    for (const path of ['notes.txt', `dots/${f.id}/notes.txt`, 'reports/q3.txt', 'nothing.txt']) {
        expect(checks[`file ${path}`].status, path).toBe(404);
    }
    expect(checks.files.body).toEqual([]);
    // What it wrote is in the socio's shared area, not Alice's.
    expect(checks.put.status).toBe(200);
    expect(data.fileAt(sharedOwner(f.id), `dots/${f.id}/scan.txt`)).toBeDefined();
    expect(data.fileAt('alice', `dots/${f.id}/scan.txt`)).toBeUndefined();
    expect(
        data.list({ kind: 'dot', userId: 'alice', dotId: f.id }).find((item) => item.kind === 'scratch')?.tables,
    ).toBe(1);
    // The audit says what it was.
    expect(
        data
            .auditFor('alice')
            .filter((entry) => entry.outcome === 'denied')
            .map((entry) => entry.detail),
    ).toEqual(
        expect.arrayContaining([
            "read of the user's own data from a shared computer",
            "the user's own folder from a shared computer",
            'write to a Space-shared dataset from a shared computer',
        ]),
    );
    // After the command, the copy is worth nothing.
    expect((await f.api(token, '/data/datasets')).status).toBe(401);
});

it('copies a file to a company socio’s shared folder only when asked to, for its computer', async () => {
    const f = await fixture('http://company-brain-app:4310');
    const data = f.platform.data;
    const chat = { kind: 'dot', userId: 'alice', dotId: f.id } as const;
    await data.putFile({ kind: 'user', userId: 'alice' }, `dots/${f.id}/scan.pdf`, Buffer.from('pdf'));
    await data.copyFile(chat, 'scan.pdf', 'copy.pdf');
    await data.copyFile(chat, 'scan.pdf', 'shared/scan.pdf');
    expect(data.fileAt('alice', `dots/${f.id}/copy.pdf`)).toBeDefined();
    expect(data.fileAt('alice', `dots/${f.id}/scan.pdf`)).toBeDefined();
    expect(data.fileAt(sharedOwner(f.id), `dots/${f.id}/scan.pdf`)).toBeDefined();
    expect(data.fileAt(sharedOwner(f.id), `dots/${f.id}/copy.pdf`)).toBeUndefined();
    // Bob's command on the same socio reads the shared copy, not Alice's.
    const bob = data.tokens.forCommand('bob', f.id, 60_000, 'socio');
    expect((await f.api(bob.token, '/data/files/raw?path=scan.pdf')).status).toBe(200);
    expect((await f.api(bob.token, '/data/files/raw?path=copy.pdf')).status).toBe(404);
    // files_copy's shared/<name> is <name> for the token: a miss says so (CB-361).
    const prefixed = await f.api(bob.token, '/data/files/raw?path=shared/scan.pdf');
    expect(prefixed.status).toBe(404);
    expect(((await prefixed.json()) as { error: string }).error).toContain(
        'A file files_copy put at shared/scan.pdf is path scan.pdf here, without shared/.',
    );
    const missing = await f.api(bob.token, '/data/files/raw?path=nothing.pdf');
    expect(((await missing.json()) as { error: string }).error).not.toContain('files_copy');
    // Another socio's folder is a 403, as for any socio.
    expect((await f.api(bob.token, '/data/files/raw?path=dots/other/x.txt')).status).toBe(403);
});

it('gives a personal socio’s command its person’s reach', async () => {
    const f = await fixture('http://company-brain-app:4310');
    const company = f.workspace.dot(f.id)!;
    const own = f.workspace.createDot(
        company.spaceId,
        'Alice’s helper',
        '',
        false,
        false,
        [company.spaceId],
        null,
        false,
        null,
        false,
        'alice',
    );
    const data = f.platform.data;
    const salaries = data.createDataset('alice', { name: 'Salaries' });
    data.setGrant('alice', {
        dotId: own.id,
        datasetId: salaries.id,
        access: 'read',
    });
    const env = data.computerEnv(own.id, 'alice', 'http://app:4310', 60_000)!;
    const token = /CB_DATA_TOKEN='([^']+)'/.exec(env.file.contents)![1];
    expect(data.tokens.resolve(token)?.reach).toBeUndefined();
    expect(
        (
            await f.api(token, `/data/datasets/${salaries.id}/query`, 'POST', {
                sql: 'SELECT 1',
            })
        ).status,
    ).toBe(200);
    env.release!();
    expect(data.tokens.resolve(token)).toBeUndefined();
});

it('opens nothing with a socio’s command token once its person is deactivated, and still redacts it (CB-528)', async () => {
    const f = await fixture('http://company-brain-app:4310');
    const company = f.workspace.dot(f.id)!;
    const own = f.workspace.createDot(
        company.spaceId,
        'Alice’s helper',
        '',
        false,
        false,
        [company.spaceId],
        null,
        false,
        null,
        false,
        'alice',
    );
    const data = f.platform.data;
    const salaries = data.createDataset('alice', { name: 'Salaries' });
    data.setGrant('alice', { dotId: own.id, datasetId: salaries.id, access: 'read' });
    const deactivated = new Set<string>();
    f.workspace.useDeactivated(() => [...deactivated]);
    const env = data.computerEnv(own.id, 'alice', 'http://app:4310', 60_000)!;
    const token = /CB_DATA_TOKEN='([^']+)'/.exec(env.file.contents)![1]!;
    const query = () => f.api(token, `/data/datasets/${salaries.id}/query`, 'POST', { sql: 'SELECT 1' });
    expect((await query()).status).toBe(200);
    // Deactivated while the command runs: its token opens nothing from its next request.
    deactivated.add('alice');
    expect(data.tokens.resolve(token)).toBeUndefined();
    expect((await query()).status).toBe(401);
    // The command still holds it, so its output still has it redacted.
    expect(data.tokens.commandTokens(own.id)).toContain(token);
    env.release!();
});

it('refuses paths with outer spaces or control characters, and the old folder’s token files', async () => {
    for (const path of [
        ' .socio/data.env',
        '.socio/apps/x.env\n',
        '\t.socio/run/x.env',
        '.socio/data.env ',
        'notes\u0007.txt',
        'a\u0085b',
        ' .socio/data.env',
    ]) {
        expect(computerInputs.files_read.safeParse({ path }).success, path).toBe(false);
        expect(computerInputs.files_write.safeParse({ path, contents: 'x' }).success, path).toBe(false);
        expect(computerInputs.files_list.safeParse({ path }).success, path).toBe(false);
    }
    expect(computerInputs.files_read.safeParse({ path: 'reports/q3 notes.txt' }).success).toBe(true);
    // What the check itself sees, trimmed and normalized as the computer would.
    for (const path of [
        ' .socio/data.env',
        '.socio/apps/x.env\n',
        '\t.socio/run/x.env',
        './.socio//./data.env',
        '.socio/run',
        '.company-brain/data.env',
        '.company-brain/apps/board.env',
    ]) {
        expect(computerSecretPath(path), JSON.stringify(path)).toBe(true);
    }
    for (const path of [
        '.socio',
        '.socio/jobs/j/r/run.sh',
        '.socio/apps/board.log',
        'notes.env',
        'reports/.socio/data.txt',
    ]) {
        expect(computerSecretPath(path), path).toBe(false);
    }
    // The service refuses them before reaching the computer.
    const f = await fixture('http://company-brain-app:4310');
    const before = f.calls.length;
    await expect(f.service.action(f.id, 'files_read', { path: ' .socio/data.env' }, 'agent')).rejects.toThrow(
        /spaces or control characters/,
    );
    await expect(
        f.service.action(f.id, 'files_write', { path: '.company-brain/apps/board.env', contents: 'x' }, 'agent'),
    ).rejects.toThrow(COMPUTER_SECRET_PATH);
    expect(f.calls.length).toBe(before);
});

it('runs the prefix in a real shell: the command gets the variables and both token files are gone', async () => {
    const f = await fixture('http://company-brain-app:4310');
    const env = f.platform.data.computerEnv(f.id, 'alice', 'http://app:4310', 60_000)!;
    const token = /CB_DATA_TOKEN='([^']+)'/.exec(env.file.contents)![1];
    const workspace = mkdtempSync(join(tmpdir(), 'cb-prefix-'));
    cleanup.push(() => rmSync(workspace, { recursive: true, force: true }));
    mkdirSync(join(workspace, '.socio/run'), { recursive: true });
    writeFileSync(join(workspace, env.file.path), env.file.contents);
    writeFileSync(join(workspace, '.socio/data.env'), "CB_DATA_TOKEN='old'\n");
    const run = spawnSync(
        'bash',
        [
            '-c',
            `${env.prefix}printf '%s|%s|' "$CB_DATA_TOKEN" "$CB_DATA_URL"; bash -c 'printf "%s|" "$CB_DATA_TOKEN"'; echo; ls -A .socio/run; ls -A .socio`,
        ],
        { cwd: workspace, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
    );
    expect(run.status).toBe(0);
    expect(String(run.stdout).split('\n')[0]).toBe(`${token}|http://app:4310/api/data|${token}|`);
    // Nothing left: the run folder is empty and the old file is gone.
    expect(String(run.stdout).trim().split('\n').slice(1)).toEqual(['run']);
    // With .socio replaced by a link, the run file still goes; the old
    // file behind the link is left alone.
    const linked = mkdtempSync(join(tmpdir(), 'cb-prefix-link-'));
    cleanup.push(() => rmSync(linked, { recursive: true, force: true }));
    mkdirSync(join(linked, 'elsewhere/run'), { recursive: true });
    symlinkSync('elsewhere', join(linked, '.socio'));
    writeFileSync(join(linked, env.file.path), env.file.contents);
    writeFileSync(join(linked, 'elsewhere/data.env'), "CB_DATA_TOKEN='old'\n");
    const through = spawnSync(
        'bash',
        ['-c', `${env.prefix}printf '%s' "$CB_DATA_TOKEN"; echo; ls -A elsewhere/run; ls -A elsewhere`],
        { cwd: linked, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
    );
    expect(String(through.stdout).trim().split('\n')).toEqual([token, 'data.env', 'run']);
    env.release!();
});

it('records the platform’s own clean-up commands in the computer’s activity', async () => {
    const f = await fixture('http://company-brain-app:4310');
    f.setFailExec(true);
    await expect(exec(f, 'true')).rejects.toThrow(/HTTP 502/);
    f.setFailExec(false);
    const audit = await f.workspace.computers.audit(f.id);
    const platform = audit.filter((entry) => entry.actor === 'platform');
    expect(platform).toHaveLength(1);
    expect(platform.every((entry) => entry.action === 'exec')).toBe(true);
    expect(platform.every((entry) => entry.userId === null)).toBe(true);
    // Both clean-ups leave a folder replaced by a link alone.
    const cleanups = f.calls
        .filter((call) => call.url.endsWith('/exec'))
        .map((call) => (call.body as { command: string }).command)
        .filter((command) => !command.includes('\n'));
    expect(cleanups).toHaveLength(1);
    for (const command of cleanups) {
        expect(command).toContain('[ ! -L .socio ] && [ ! -L .socio/run ]');
    }
});
