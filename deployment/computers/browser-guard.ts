/**
 * Time limits for the OpenBot computer's browser (CB-125). harden-computer.mjs
 * copies this file into the pinned agent-computer source next to profiles.ts.
 *
 * Upstream waits on a browser close with no time limit, and every later page()
 * waits on that close first. A Chromium that died without Playwright noticing
 * never answers the close, so every snapshot and screenshot hung until the
 * container restarted. Here a close gets a limit and then the browser's
 * processes are killed, and a page is checked before it is reused: a page
 * that is only busy is still reused, and only a browser that does not answer
 * is replaced.
 *
 * No Playwright import, so the app's tests load this file as it is.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** How long a browser close may take before its processes are killed. */
export const CLOSE_LIMIT_MS = 10_000;
/** How long page() waits on a close in progress before it stops waiting. */
export const CLOSING_WAIT_MS = 30_000;
/** How long a browser launch may take before Playwright gives up on it. */
export const LAUNCH_LIMIT_MS = 60_000;
/** How long a page in use may take to evaluate `1` before its browser is asked instead. */
export const PAGE_PROBE_MS = 1_000;
/** How long the browser process may take to answer before it counts as dead. */
export const PROBE_LIMIT_MS = 5_000;
/** A close pending longer than this is stuck: closes are cut off at the limit. */
export const STUCK_CLOSE_MS = 20_000;
/** A launch pending longer than this is stuck; a cold start takes seconds. */
export const STUCK_LAUNCH_MS = 45_000;

export type BrowserState = 'stopped' | 'starting' | 'running' | 'closing' | 'stuck';

/** Whether `work` settles, either way, within `ms`. */
export async function finishesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
    });
    try {
        return await Promise.race([
            work.then(
                () => true,
                () => true,
            ),
            deadline,
        ]);
    } finally {
        clearTimeout(timer);
    }
}

type ProcEntry = { ppid: number; state: string; start: string; args: string[] };

function readProc(proc: string, pid: number): ProcEntry | undefined {
    try {
        // `pid (comm) state ppid ...`; comm may contain spaces and parentheses.
        const stat = readFileSync(join(proc, String(pid), 'stat'), 'utf8');
        // Field 3 onwards; field 22 is when the process started, which a reused pid does not share.
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const [state, ppid] = fields;
        const args = readFileSync(join(proc, String(pid), 'cmdline'), 'utf8')
            .split('\0')
            .filter(Boolean);
        return { ppid: Number(ppid), state, start: fields[19] ?? '', args };
    } catch {
        return undefined;
    }
}

const profileArg = (dir: string) => `--user-data-dir=${dir}`;

/**
 * The Chromium this process launched on a profile directory: its own child
 * started with that `--user-data-dir`. Read right after the launch, because a
 * dead browser's command line is empty.
 */
export function browserPidFor(dir: string, parent = process.pid, proc = '/proc'): number | undefined {
    let names: string[];
    try {
        names = readdirSync(proc);
    } catch {
        return undefined;
    }
    for (const name of names) {
        if (!/^\d+$/.test(name)) continue;
        const entry = readProc(proc, Number(name));
        if (entry?.ppid === parent && entry.args.includes(profileArg(dir))) return Number(name);
    }
    return undefined;
}

/** When a process started (field 22 of its stat), to tell it from a later one given the same pid. */
export function startTimeOf(pid: number | undefined, proc = '/proc'): string | undefined {
    return pid ? readProc(proc, pid)?.start : undefined;
}

/**
 * Kill a browser and its process group (Playwright starts Chromium as a group
 * leader, so the group is its renderers and helpers). Refused when the pid
 * now belongs to some other program: one that started at another time than
 * `startedAt`, read at launch, or one without this profile's argument. A
 * zombie or a missing leader still has its group killed. Returns whether a
 * signal was sent.
 */
export function killBrowser(pid: number | undefined, dir: string, startedAt?: string, proc = '/proc'): boolean {
    if (!pid) return false;
    const leader = readProc(proc, pid);
    if (leader && startedAt !== undefined && leader.start !== startedAt) return false;
    if (leader && leader.state !== 'Z' && leader.args.length > 0 && !leader.args.includes(profileArg(dir)))
        return false;
    try {
        process.kill(-pid, 'SIGKILL');
        return true;
    } catch {
        try {
            process.kill(pid, 'SIGKILL');
            return true;
        } catch {
            return false;
        }
    }
}

/**
 * Wait for a close up to `limitMs`, then kill. Returns `killed` when the close
 * did not finish in time.
 */
export async function closeOrKill(
    closing: Promise<unknown>,
    kill: () => unknown,
    limitMs = CLOSE_LIMIT_MS,
): Promise<'closed' | 'killed'> {
    if (await finishesWithin(closing, limitMs)) return 'closed';
    kill();
    return 'killed';
}

type ProbedPage = {
    evaluate(expression: string): Promise<unknown>;
    isClosed(): boolean;
};
type ProbedBrowser = {
    newBrowserCDPSession(): Promise<{
        send(method: 'Browser.getVersion'): Promise<unknown>;
        detach(): Promise<void>;
    }>;
};

/**
 * Whether a page answers a cheap evaluate within `limitMs`: `answered`,
 * `gone` (closed or crashed), or `busy` (no answer yet). An evaluate that
 * fails because a navigation replaced the document still got an answer.
 */
export async function pageAnswers(page: ProbedPage, limitMs = PAGE_PROBE_MS): Promise<'answered' | 'gone' | 'busy'> {
    let failure: unknown;
    const settled = await finishesWithin(
        page.evaluate('1').catch((error: unknown) => {
            failure = error ?? new Error('failed');
        }),
        limitMs,
    );
    if (!settled) return 'busy';
    if (failure === undefined) return 'answered';
    return !page.isClosed() && !/crash|closed|disconnected/i.test(String(failure)) ? 'answered' : 'gone';
}

/**
 * Whether the browser process itself answers over CDP within `limitMs`. It
 * does while one of its pages is blocked running a script; a Chromium that
 * died or froze without Playwright noticing does not.
 */
export async function browserAnswers(
    browser: ProbedBrowser | null | undefined,
    limitMs = PROBE_LIMIT_MS,
): Promise<boolean> {
    if (!browser) return false;
    let failed = false;
    const settled = await finishesWithin(
        (async () => {
            const session = await browser.newBrowserCDPSession();
            try {
                await session.send('Browser.getVersion');
            } finally {
                void session.detach().catch(() => undefined);
            }
        })().catch(() => {
            failed = true;
        }),
        limitMs,
    );
    return settled && !failed;
}

/**
 * Whether a page's browser is alive. The page is asked first; a page that is
 * only busy (its script holds the main thread) is alive as long as its browser
 * answers, so a slow page is never mistaken for a dead browser and killed with
 * its tabs and unsaved state.
 */
export async function answers(
    page: ProbedPage,
    browser: ProbedBrowser | null | undefined,
    pageMs = PAGE_PROBE_MS,
    browserMs = PROBE_LIMIT_MS,
): Promise<boolean> {
    const verdict = await pageAnswers(page, pageMs);
    if (verdict !== 'busy') return verdict === 'answered';
    return browserAnswers(browser, browserMs);
}

/** What a Bot's browser is doing, as `/health` reports it. */
export function browserStateOf(
    browser: { running: boolean; closingSince?: number; startingSince?: number },
    now = Date.now(),
): BrowserState {
    if (browser.closingSince !== undefined) return now - browser.closingSince > STUCK_CLOSE_MS ? 'stuck' : 'closing';
    if (browser.startingSince !== undefined)
        return now - browser.startingSince > STUCK_LAUNCH_MS ? 'stuck' : 'starting';
    return browser.running ? 'running' : 'stopped';
}
