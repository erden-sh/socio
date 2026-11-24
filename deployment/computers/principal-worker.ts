// CB-227: the unprivileged worker principal-runtime.ts starts for each
// request. It runs only inside the computer image: computer.Dockerfile copies
// it into OpenBot's /app/src, where `./shell` and `./workspace` are OpenBot's
// own modules (agent-computer/src at the pinned revision). They don't exist in
// this repository; tsconfig.json here maps them to openbot/*.d.ts for the editor.
import { readFileSync } from 'node:fs';

import { createShell } from './shell';
/** Executed after setpriv, with no root capability or supplementary group. */
import { createWorkspace } from './workspace';

const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.umask(0o077);
try {
    if (
        process.getuid?.() === 0 ||
        process.getgid?.() !== 20000 ||
        process.getgroups?.().some((group) => group !== 20000)
    )
        throw new Error('The computer worker was not isolated.');
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const { payload, home, sharedRoot, operation } = input;
    let value: unknown;
    if (operation === 'exec') {
        if (typeof payload.command !== 'string' || !payload.command.trim()) throw new Error('Missing command.');
        const variables = payload.variables ?? {};
        if (
            !variables ||
            typeof variables !== 'object' ||
            Array.isArray(variables) ||
            Object.entries(variables).some(
                ([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string',
            )
        )
            throw new Error('Invalid environment.');
        const shell = createShell(home, {
            ...process.env,
            ...variables,
            COMPUTER_SHELL_ENV: Object.keys(variables).join(','),
        });
        value = await shell.run({
            command: payload.command,
            timeoutMs: payload.timeoutMs,
            signal: controller.signal,
        });
    } else {
        const path = typeof payload.path === 'string' ? payload.path : '';
        if (path.startsWith('/') || path.split('/').includes('..') || path.includes('\\') || path.includes('\0'))
            throw new Error('Invalid workspace path.');
        const shared = path === 'shared' || path.startsWith('shared/');
        const requested = shared ? path.slice('shared'.length).replace(/^\//, '') : path;
        const workspace = createWorkspace(shared ? sharedRoot : home);
        if (shared && operation === 'files_write') process.umask(0o007);
        if (operation === 'files_read') value = await workspace.read(requested);
        else if (operation === 'files_write')
            value = await workspace.write(requested, payload.contents, {
                append: payload.append,
            });
        else if (operation === 'files_list') {
            const result = await workspace.list(requested);
            value = {
                ...result,
                entries: [
                    ...(!shared && (!path || path === '.') ? [{ path: 'shared', kind: 'folder' as const }] : []),
                    ...result.entries.map((entry) => ({
                        ...entry,
                        path: shared ? `shared/${entry.path}` : entry.path,
                    })),
                ],
            };
        } else throw new Error('Unknown operation.');
        if (value && typeof value === 'object' && 'path' in value) (value as { path: string }).path = path;
    }
    process.stdout.write(JSON.stringify({ ok: true, value }));
} catch {
    process.stdout.write(JSON.stringify({ ok: false }));
    process.exitCode = 1;
}
