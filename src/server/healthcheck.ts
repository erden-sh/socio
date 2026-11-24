/**
 * The app container's healthcheck (CB-318): `/healthz` within the timeout,
 * or a failure. A timeout (the server is listening but doesn't answer in
 * time) also captures what the main thread is doing, so a stall that fails
 * the check (and gets the task replaced) names its function. Only timeouts:
 * a refused or failed connection means nothing is listening (booting or
 * exiting), and attaching the debugger to a booting app caused a 2.6 s
 * stall of its own (a v0.37.0 upgrade, 2026-11-11).
 *
 *
 * - The check starts a detached helper and exits at once (Docker's check
 *   has a 5 s timeout of its own).
 * - The helper sends PID 1 SIGUSR1, which opens Node's inspector on the
 *   container's own loopback at INSPECT_PORT (the image's NODE_OPTIONS
 *   `--inspect-port`). The inspector answers even while JavaScript runs.
 * - It pauses, writes the call stack to REPORT_DIR/stall-<time>.json,
 *   resumes, and closes the inspector again.
 *
 * Node's own `--report-on-signal` can't do this: it writes the report only
 * once the loop is free again, with an empty JavaScript stack.
 *
 * At most one capture per `CAPTURE_EVERY_MS`, and the newest `KEEP` files,
 * so a long outage can't fill the volume. Nothing leaves the container.
 *
 *   node dist/server/server/healthcheck.js
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const port = process.env.PORT || '4310';
const dir = process.env.REPORT_DIR || '/data/reports';
export const CAPTURE_EVERY_MS = 10 * 60_000;
export const KEEP = 5;

/** Stall captures, newest first. */
export function captures(directory: string) {
    try {
        return readdirSync(directory)
            .filter((name) => name.startsWith('stall-') && name.endsWith('.json'))
            .map((name) => {
                const path = join(directory, name);
                return { path, mtime: statSync(path).mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime);
    } catch {
        return [];
    }
}

/** Whether to capture now, and which old captures to delete. */
export function capturePlan(existing: { path: string; mtime: number }[], now: number) {
    const fresh = existing.some((file) => now - file.mtime < CAPTURE_EVERY_MS);
    return {
        capture: !fresh,
        // Room for the one about to be written.
        remove: existing.slice(fresh ? KEEP : KEEP - 1),
    };
}

/**
 * The inspector port PID 1 was started with (`--inspect-port`, in its
 * arguments or NODE_OPTIONS), or undefined: without it, SIGUSR1 would open
 * the default port, which the check doesn't assume.
 */
export function inspectPort(read: (path: string) => string = (path) => readFileSync(path, 'utf8')): number | undefined {
    try {
        const flags = `${read('/proc/1/cmdline')}\0${read('/proc/1/environ')}`;
        const match = flags.match(/--inspect-port=(?:127\.0\.0\.1:)?(\d{2,5})\b/);
        return match ? Number(match[1]) : undefined;
    } catch {
        return undefined;
    }
}

/** Connection-level timeouts: the server accepted the connection, then hung. */
const HUNG_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

/**
 * Whether a failed `/healthz` fetch is a stall worth capturing: only a
 * timeout. A refused or reset connection (nothing listening yet, or any
 * more) is a plain failure.
 */
export function shouldCapture(error: unknown): boolean {
    const name = (error as { name?: unknown } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
        return true;
    }
    const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    return typeof code === 'string' && HUNG_CODES.has(code);
}

interface Frame {
    function: string;
    url: string;
    line: number;
    column: number;
}

/** Pauses PID 1 through its inspector, reads the stack, resumes, closes. */
export async function captureStack(inspector: number): Promise<Frame[]> {
    process.kill(1, 'SIGUSR1');
    let list: { webSocketDebuggerUrl: string }[] | undefined;
    for (let attempt = 0; attempt < 20 && !list; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        list = await fetch(`http://127.0.0.1:${inspector}/json/list`)
            .then((response) => response.json() as Promise<typeof list>)
            .catch(() => undefined);
    }
    if (!list?.[0]) {
        throw new Error('The inspector did not open.');
    }
    const socket = new WebSocket(list[0].webSocketDebuggerUrl);
    let id = 0;
    const send = (method: string, params: object = {}) => socket.send(JSON.stringify({ id: ++id, method, params }));
    try {
        return await new Promise<Frame[]>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('No pause within 10 s.')), 10_000);
            socket.onerror = () => reject(new Error('Inspector socket failed.'));
            socket.onopen = () => {
                send('Debugger.enable');
                send('Debugger.pause');
            };
            // Debugger.enable announces every script: frames carry only its id.
            const scripts = new Map<string, string>();
            socket.onmessage = (message) => {
                const data = JSON.parse(String(message.data)) as {
                    method?: string;
                    params?: {
                        scriptId?: string;
                        url?: string;
                        callFrames?: {
                            functionName: string;
                            url: string;
                            location: {
                                scriptId: string;
                                lineNumber: number;
                                columnNumber: number;
                            };
                        }[];
                    };
                };
                if (data.method === 'Debugger.scriptParsed' && data.params?.scriptId) {
                    scripts.set(data.params.scriptId, data.params.url ?? '');
                }
                if (data.method !== 'Debugger.paused' || !data.params?.callFrames) {
                    return;
                }
                clearTimeout(timer);
                resolve(
                    data.params.callFrames.slice(0, 40).map((frame) => ({
                        function: frame.functionName || '(anonymous)',
                        url: frame.url || scripts.get(frame.location.scriptId) || '',
                        line: frame.location.lineNumber + 1,
                        column: frame.location.columnNumber + 1,
                    })),
                );
            };
        });
    } finally {
        if (socket.readyState === WebSocket.OPEN) {
            send('Debugger.resume');
            send('Debugger.disable');
            // Closes the inspector port again (the command line API's require).
            send('Runtime.evaluate', {
                expression: "require('node:inspector').close()",
                includeCommandLineAPI: true,
            });
            await new Promise((resolve) => setTimeout(resolve, 300));
            socket.close();
        }
    }
}

async function capture() {
    const inspector = inspectPort();
    if (!inspector) {
        return;
    }
    const at = new Date();
    for (const file of captures(dir)) {
        if (file.path.endsWith('-pending.json')) {
            unlinkSync(file.path);
        }
    }
    let result: object;
    try {
        result = { at: at.toISOString(), stack: await captureStack(inspector) };
    } catch (error) {
        result = { at: at.toISOString(), error: String(error) };
    }
    writeFileSync(
        join(dir, `stall-${at.toISOString().replace(/[:.]/g, '-')}.json`),
        `${JSON.stringify(result, null, 2)}\n`,
    );
}

async function check() {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
            signal: AbortSignal.timeout(4000),
        });
        process.exit(response.ok ? 0 : 1);
    } catch (error) {
        if (!shouldCapture(error)) {
            process.exit(1);
        }
        try {
            mkdirSync(dir, { recursive: true });
            const plan = capturePlan(captures(dir), Date.now());
            for (const file of plan.remove) {
                unlinkSync(file.path);
            }
            if (plan.capture && inspectPort()) {
                // A placeholder now, so the next failed check doesn't start another.
                writeFileSync(
                    join(dir, `stall-${new Date().toISOString().replace(/[:.]/g, '-')}-pending.json`),
                    '{}\n',
                );
                spawn(process.execPath, [process.argv[1]!, '--capture'], {
                    detached: true,
                    stdio: 'ignore',
                }).unref();
            }
        } catch {
            // The capture is a bonus; the check's answer is the failure.
        }
        process.exit(1);
    }
}

if (process.argv[1]?.endsWith('healthcheck.js')) {
    void (process.argv.includes('--capture') ? capture() : check());
}
