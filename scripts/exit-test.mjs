#!/usr/bin/env node
// Release exit test.
//
//   node scripts/exit-test.mjs                      # local: starts dist/ itself
//   node scripts/exit-test.mjs --base https://brain.example.test [--insecure]
//     --admin-email E --member-email E --password-file F   (Better Auth)
//
// Local mode starts the built server (pnpm run build first) on a temporary
// database with the egress log, using .env for the model. Telegram is
// disabled so the run never competes with a live bot. It then:
//   1. runs ui-smoke.mjs --scenario users (two users chat, isolation, roles);
//   2. runs a scheduled task in its conversation and waits for completion;
//   3. starts a turn and stops it, expecting a prompt stop;
//   4. restarts the server on the same database and checks the conversation
//      replays (local mode only);
//   5. fails on any outbound connection outside the allowlist: the model
//      endpoint, search.parallel.ai and api.telegram.org (local mode only).
// Against --base it runs steps 1-3 on the deployed server.
//
// Local mode uses mock auth and signs in as its first admin and member. Against --base
// (Better Auth) it signs in with the email-and-password test accounts
// (--admin-email, --member-email, --password-file; see docs/SETUP.md).
// Either way it deletes the conversations it created, with their scheduled
// task, at the end.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertFinished, deleteConversations, parseArgs, signIn, testUsers, turn } from './lib/brain-client.mjs';

const args = parseArgs(process.argv.slice(2));
const remote = args.base;
const port = Number(args.port ?? 4399);
const base = remote ?? `http://127.0.0.1:${port}`;
// --insecure: accept a self-signed proxy certificate (homelab TLS only).
const insecure = args.insecure === 'true';
if (insecure) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
const step = (text) => console.log(`[exit-test] ${text}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const env = Object.fromEntries(
    readFileSync('.env', 'utf8')
        .split('\n')
        .filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
);
const modelHost = (() => {
    const url = new URL(env.OPENAI_BASE_URL ?? 'http://invalid');
    return `${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`;
})();
const ALLOWED = new Set([modelHost, 'search.parallel.ai:443', 'api.telegram.org:443']);
const loopback = (target) => /^(127\.0\.0\.1|localhost|::1|\[::1\]):\d+$/.test(target);

let server;
let log = '';
const dir = remote ? undefined : mkdtempSync(join(tmpdir(), 'brain-exit-'));
async function startServer() {
    const mark = log.length;
    server = spawn(
        process.execPath,
        ['--env-file=.env', '--import', './scripts/egress-log.mjs', 'dist/server/server/index.js'],
        {
            env: {
                ...process.env,
                HOST: '127.0.0.1',
                PORT: String(port),
                DATABASE_PATH: join(dir, 'brain.sqlite'),
                // A fresh database has no accounts to sign in with. Mock auth runs
                // on loopback only, so no APP_ORIGIN of a deployment.
                AUTH_PROVIDER: 'mock',
                APP_ORIGIN: '',
                // A fixed secret keeps sign-ins valid across the restart step.
                SESSION_SECRET: 'exit-test-session-secret-0123456789',
                TELEGRAM_BOT_TOKEN: '',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    server.stdout.on('data', (chunk) => (log += chunk));
    server.stderr.on('data', (chunk) => (log += chunk));
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        if (log.slice(mark).includes('listening on')) {
            return;
        }
        if (server.exitCode !== null) {
            break;
        }
        await sleep(100);
    }
    throw new Error('The server did not start.');
}
async function stopServer() {
    if (!server || server.exitCode !== null) {
        return;
    }
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
}

let failed = false;
let admin;
const created = [];
try {
    if (!remote) {
        await startServer();
        step(`server started on ${base}`);
    }
    const users = await testUsers(base, args);
    step(`test users: ${users.admin.id} (admin), ${users.member.id} (member)`);

    // 1. Two users in the browser.
    const smoke = spawnSync(
        process.execPath,
        [
            'scripts/ui-smoke.mjs',
            '--base',
            base,
            '--scenario',
            'users',
            ...(users.admin.email
                ? [
                      '--admin-email',
                      users.admin.email,
                      '--member-email',
                      users.member.email,
                      '--password-file',
                      args['password-file'],
                  ]
                : ['--admin-user', users.admin.id, '--member-user', users.member.id]),
            ...(insecure ? ['--insecure'] : []),
        ],
        { stdio: 'inherit' },
    );
    if (smoke.status !== 0) {
        throw new Error('ui-smoke users failed');
    }
    step('two-user browser check passed');

    admin = await signIn(base, users.admin);
    const { dots } = await admin('/workspace');
    const dot = dots[0];

    // 2. A scheduled task runs on the server, in its conversation.
    const thread = await admin('/conversations', 'POST', {
        dotId: dot.id,
        title: 'Exit test schedule',
    });
    created.push(thread.id);
    const task = await admin('/tasks', 'POST', {
        prompt: 'Reply with exactly the word: osprey',
        threadId: thread.id,
    });
    let detail;
    const taskDeadline = Date.now() + 180_000;
    do {
        await sleep(2000);
        detail = await admin(`/tasks/${task.id}`);
    } while (['queued', 'running'].includes(detail.task.status) && Date.now() < taskDeadline);
    if (detail.task.status !== 'completed') {
        throw new Error(`Scheduled task ended ${detail.task.status}`);
    }
    const scheduled = await admin(`/conversations/${thread.id}/transcript`);
    if (!scheduled.messages.some((m) => /osprey/i.test(m.content))) {
        throw new Error('The scheduled turn is missing from its conversation.');
    }
    step('scheduled turn completed in its conversation');

    // 3. Stop a running turn.
    const long = await admin('/conversations', 'POST', {
        dotId: dot.id,
        title: 'Exit test stop',
    });
    created.push(long.id);
    let started = false;
    const running = turn(
        admin,
        dot.id,
        long.id,
        [],
        'Write a 1500-word essay on the history of lighthouses.',
        (event) => {
            if (event.type === 'TEXT_MESSAGE_CONTENT' || event.type === 'RUN_STARTED') {
                started = true;
            }
        },
    );
    const startDeadline = Date.now() + 60_000;
    while (!started && Date.now() < startDeadline) {
        await sleep(200);
    }
    const stopAt = Date.now();
    await admin(`/copilotkit/agent/${dot.id}/stop/${long.id}`, 'POST', {});
    const events = await running.done;
    const stopMs = Date.now() - stopAt;
    if (stopMs > 15_000) {
        throw new Error(`Stop took ${stopMs} ms`);
    }
    if (!events.some((e) => e.type === 'RUN_FINISHED' || e.type === 'RUN_ERROR')) {
        throw new Error('The stopped run did not close.');
    }
    step(`stopped a running turn in ${stopMs} ms`);

    // 4. Restart and replay (local only).
    if (!remote) {
        const before = (await admin(`/conversations/${thread.id}/transcript`)).messages.length;
        await stopServer();
        await startServer();
        const again = await signIn(base, users.admin);
        const after = await again(`/conversations/${thread.id}/transcript`);
        if (after.messages.length !== before) {
            throw new Error(`Replay lost messages: ${before} → ${after.messages.length}`);
        }
        const followUp = await again('/conversations', 'POST', {
            dotId: dot.id,
            title: 'After restart',
        });
        created.push(followUp.id);
        assertFinished(await turn(again, dot.id, followUp.id, [], 'Reply with exactly: heron').done);
        step('restarted; history replayed and a new turn ran');
    }
} catch (error) {
    failed = true;
    step(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
} finally {
    // Delete what this run created (the browser check cleans up
    // its own conversations).
    if (admin && created.length) {
        const left = await deleteConversations(admin, created).catch((error) => [String(error)]);
        if (left.length) {
            failed = true;
            step(`FAILED: could not delete: ${left.join(', ')}`);
        } else {
            step(`cleanup: deleted ${created.length} conversations`);
        }
    }
    await stopServer();
    if (dir) {
        rmSync(dir, { recursive: true, force: true });
    }
}

// 5. Egress audit (local only).
if (!remote) {
    const targets = [...new Set([...log.matchAll(/\[egress\] (\S+)/g)].map((m) => m[1]))];
    const outside = targets.filter((t) => !loopback(t) && !ALLOWED.has(t));
    step(`egress: ${JSON.stringify(targets.filter((t) => !loopback(t)))}`);
    if (outside.length) {
        failed = true;
        step(`FAILED: egress outside the allowlist: ${outside.join(', ')}`);
    }
} else {
    step('egress: not audited for a remote server');
}
step(`result: ${failed ? 'FAIL' : 'PASS'}`);
process.exit(failed ? 1 : 0);
