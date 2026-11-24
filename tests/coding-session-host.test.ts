import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

/**
 * The session-host entry point (CB-326 step 1): a Node process that bridges
 * Socio's app to the vendored provider-codex adapter over ndjson. This test
 * spawns the entry as a child, points it at a fake codex app-server peer (via
 * `SOCIO_HOST_CODEX_BIN` → tests/support/fake-codex-bin.sh → fake-codex-peer.ts),
 * feeds stdin commands, and asserts the stdout ndjson events — without a real
 * `codex` binary or a sandbox.
 */

interface HostProcess {
    child: ReturnType<typeof spawn>;
    stdout: Array<{ type: string; [k: string]: unknown }>;
    stderr: string;
}

/** Spawns the session-host entry against the fake codex peer. */
function startHost(sessionId: string, model = 'gpt-5'): HostProcess {
    const tokenDir = mkdtempSync(join(tmpdir(), 'socio-host-'));
    writeFileSync(join(tokenDir, 'token'), 'cbgw_test_token_0123456789');
    const child = spawn(
        'node',
        ['--import', 'tsx', 'src/server/coding/host/session-host.ts', sessionId, 'codex', model],
        {
            cwd: process.cwd(),
            env: {
                ...process.env,
                SOCIO_HOST_TOKEN_FILE: join(tokenDir, 'token'),
                SOCIO_HOST_CODEX_BIN: 'tests/support/fake-codex-bin.sh',
                SOCIO_HOST_CWD: tokenDir,
                SOCIO_HOST_STATE_DIR: join(tokenDir, 'state'),
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        },
    );
    const stdout: Array<{ type: string; [k: string]: unknown }> = [];
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
            if (!line.trim()) {
                continue;
            }
            try {
                stdout.push(JSON.parse(line) as { type: string; [k: string]: unknown });
            } catch {
                stderr += `unparseable stdout: ${line}\n`;
            }
        }
    });
    child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
    });
    return { child, stdout, stderr };
}

/** Waits for the host to emit an event matching a predicate, or times out. */
async function waitFor(
    host: HostProcess,
    predicate: (events: HostProcess['stdout']) => boolean,
    ms = 5_000,
): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (predicate(host.stdout)) {
            return;
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for event; stderr: ${host.stderr}`);
}

it('bridges a turn_start command to provider_turn.updated and turn.terminal events', async () => {
    const host = startHost('sess-1');
    const exit = new Promise<number>((resolve) => host.child.on('exit', (code) => resolve(code ?? 0)));
    const stdin = host.child.stdin;
    if (!stdin) {
        throw new Error('host child has no stdin');
    }

    // The host is ready once buildSession resolves and the stdin loop is wired.
    // Give it a moment to boot (spawn codex, initialize, open the session),
    // then drive a turn. The fake peer responds to initialize immediately.
    await new Promise((r) => setTimeout(r, 500));
    stdin.write(JSON.stringify({ op: 'turn_start', payload: { message: 'Fix the test.' } }) + '\n');
    // The fake peer maps turn/start → turn/started (provider_turn.updated) +
    // turn/completed (turn.terminal).
    await waitFor(host, (events) => events.some((e) => e.type === 'turn.terminal' && e.status === 'completed'), 8_000);

    const types = host.stdout.map((e) => e.type);
    expect(types).toContain('ack');
    expect(types).toContain('provider_turn.updated');
    expect(types).toContain('turn.terminal');

    stdin.write(JSON.stringify({ op: 'close' }) + '\n');
    expect(await exit).toBe(0);
}, 20_000);

it('bridges thread_snapshot, thread_rollback, and thread_fork to codex thread ops', async () => {
    const host = startHost('sess-2');
    const exit = new Promise<number>((resolve) => host.child.on('exit', (code) => resolve(code ?? 0)));
    const stdin = host.child.stdin;
    if (!stdin) {
        throw new Error('host child has no stdin');
    }

    // Ensure a native thread first (rollback/fork/snapshot operate on it).
    await new Promise((r) => setTimeout(r, 500));
    stdin.write(JSON.stringify({ op: 'turn_start', payload: { message: 'do it' } }) + '\n');
    await waitFor(host, (events) => events.some((e) => e.type === 'turn.terminal' && e.status === 'completed'), 8_000);

    // thread_snapshot → thread.snapshot with the codex turn list.
    stdin.write(JSON.stringify({ op: 'thread_snapshot' }) + '\n');
    await waitFor(host, (events) => events.some((e) => e.type === 'thread.snapshot'), 8_000);
    const snapshotEvent = host.stdout.find((e) => e.type === 'thread.snapshot') as {
        snapshot?: { providerTurns?: unknown[] };
    };
    expect(snapshotEvent?.snapshot?.providerTurns?.length).toBe(1);

    // thread_rollback → thread.rolledback (codex thread/revert) + the
    // thread/reverted notification maps to provider_thread.updated.
    stdin.write(
        JSON.stringify({
            op: 'thread_rollback',
            payload: { providerTurn: { id: 'turn-1', nativeTurnRef: { nativeId: 'turn-1' } }, providerThreadTurns: [] },
        }) + '\n',
    );
    await waitFor(host, (events) => events.some((e) => e.type === 'thread.rolledback'), 8_000);

    // thread_fork → thread.forked with a new providerThreadId distinct from the source.
    stdin.write(JSON.stringify({ op: 'thread_fork', payload: { providerTurnId: 'turn-1' } }) + '\n');
    await waitFor(host, (events) => events.some((e) => e.type === 'thread.forked'), 8_000);
    const forkEvent = host.stdout.find((e) => e.type === 'thread.forked') as {
        fork?: { providerThreadId?: string; forkedFrom?: { providerThreadId?: string } };
    };
    expect(forkEvent?.fork?.providerThreadId).not.toBe('thread-1');
    expect(forkEvent?.fork?.forkedFrom?.providerThreadId).toBe('thread-1');

    stdin.write(JSON.stringify({ op: 'close' }) + '\n');
    expect(await exit).toBe(0);
}, 25_000);
