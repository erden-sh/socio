// The listeners and hooks a build registers, in order: the order is
// behavior (which run-finished listener runs first, which approval notice
// goes out first, ...). app-graph.test.ts compares two builds with
// it; graph-registrations.test.ts pins the graph's.
import { fileURLToPath } from 'node:url';

import { vi } from 'vitest';

import { ApprovalService } from '../../src/server/approvals/service.js';

import { LocalAgentRunner } from './runners.js';
import { WorkspaceStore } from './stores.js';

/** Where listeners and hooks are registered: methods, by the prototype that has them. */
const REGISTRATIONS = [
    { target: LocalAgentRunner.prototype, methods: ['onRunFinished', 'setCycleGate'] },
    { target: WorkspaceStore.prototype, methods: ['onAccessChange', 'onSpaceAccessChange', 'useRooms'] },
    // The approvals' listeners: the Telegram notices (`onPending`), the
    // continuations and the work cycles (`onSettled`).
    { target: ApprovalService.prototype, methods: ['onPending', 'onSettled'] },
] as const;

/** The checkout, with a trailing slash. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The code that registered, from the stack inside the spy: the first
 * caller outside the composition (`composition/`, `platform.ts`, `main.ts`),
 * which only wires, else the first caller. Its function and file, without
 * line numbers, so an edit elsewhere in the file doesn't change it.
 */
function site(stack: string) {
    // The spy's own frame is in node_modules: the first one left is the caller.
    const frames = stack
        .split('\n')
        .slice(1)
        .map((line) => /^\s*at (?:(.+?) \()?(?:file:\/\/)?([^()]+?):\d+:\d+\)?$/.exec(line))
        .filter((match): match is RegExpExecArray => !!match)
        .filter(([, , file]) => file!.startsWith(`${ROOT}src/`))
        .map(([, fn, file]) => ({ fn, file: file!.slice(ROOT.length) }));
    const wiring = (file: string) => /^src\/server\/(composition\/|platform\.ts$|main\.ts$)/.test(file);
    const found = frames.find(({ file }) => !wiring(file)) ?? frames[0];
    if (!found) {
        return 'unknown';
    }
    const fn = found.fn && !/^(Generator\.next|Object\.|IteratorImpl)/.test(found.fn) ? `${found.fn} ` : '';
    return `${fn}(${found.file})`;
}

/**
 * Records each registration from now on (until `vi.restoreAllMocks()`); the
 * originals still run. By `source` (the default): `<method>: <arguments>`,
 * a function argument as its source, anything else as an empty string. By
 * `site`: `<method> <- <caller> (<file>)`, which stays the same when a
 * listener's code is only moved or reformatted.
 */
export function recordRegistrations({ by = 'source' }: { by?: 'source' | 'site' } = {}) {
    const calls: string[] = [];
    for (const { target, methods } of REGISTRATIONS) {
        for (const method of methods) {
            const holder = target as unknown as Record<string, (...args: unknown[]) => unknown>;
            const original = holder[method]!;
            vi.spyOn(holder, method).mockImplementation(function (this: unknown, ...args: unknown[]) {
                calls.push(
                    by === 'site'
                        ? `${method} <- ${site(new Error().stack ?? '')}`
                        : `${method}: ${args.map((arg) => (typeof arg === 'function' ? String(arg) : '')).join()}`,
                );
                return original.apply(this, args);
            });
        }
    }
    return calls;
}
