import type { ApprovalView } from '@socio/shared/approvals';
import { carryingOn, mustOpenFirst } from '@socio/shared/approvals-view';

import type { AuthedFetch } from '../net/authed-fetch';
import { readJson } from '../net/read-body';

import { APPROVALS } from './approvals';
import type { WriteHold } from './session';
import type { SnapshotCache } from './snapshot-cache';
import { type AppStateSource, isForeground, type NetworkSource, returnsFromBackground } from './triggers';

// Deciding approval requests, the scope's `approvals`. Decisions are online
// only: a late approval is dangerous, so none ever goes through the outbox.
// - **Refused before any request** (`blocked()`) while NetInfo says offline,
//   the server is away (the scheduler's "Reconnecting…") or writes wait
//   (`writeHold`: Expired, or the minimum-version gate closed for an update).
//   The screen says "Needs a connection" (the chat's approval card's words).
// - **The card's rules first** (shared's approvals-view.ts), with no request: Approve
//   waits until long details are opened (`mustOpenFirst`), a decided request
//   takes no decision, only a request with a review has details to open, and
//   only an automatic approval can be undone.
// - **Opening details** answers `{ full }`, not the request (service.ts's
//   `open`): the outcome carries that text, and the request as now opened
//   (the view held, marked opened, else read again), so Approve works.
// - **One request at a time per request** (`busy`).
// - **A request that breaks off** (no answer, or a 5xx, which a proxy may send
//   after the server took it) leaves the request `unconfirmed` ("Couldn't
//   confirm your decision"): it is read again once online, never sent again,
//   and takes no other action until that read answers.
// - **A 409 or 404** reads the request again and hands back what it says now.
//   The 409s carry no `code` and the app never reads their text (a stable
//   code is a separate server PR), so the status is all it goes by.
// - **Polling while shown** (`watch`, the web's useApproval rule): a request
//   waiting, or whose socio carries on, is read every 5 s, every 2 s once the
//   socio carries on with nothing else to wait for; never in the background,
//   offline or while the server is away.
// - **On resume** (a return after 10 s or more in the background), the
//   requests still waiting, and those due a read, are asked about directly,
//   four at a time with a 10 s timeout each, since no later event may
//   name them again (there is no push topic for approvals yet).
// Every answer that brings a request updates its row in the `approvals`
// collection (`cache.confirm`) when the collection holds it or it waits; any
// other is kept in memory for the card that asked (`view`).
//
// No React Native: tests/sync runs it under Node against a fake server and fake timers.

/** What a person can do to a request. */
export type ApprovalAction = 'approve' | 'deny' | 'open' | 'undo';

/** Why nothing can be sent now. */
export type ApprovalBlock = 'offline' | 'away' | 'sign-in' | 'update';

/** A rule of the card that refuses an action before any request. */
export type ApprovalRule = 'open-first' | 'decided' | 'no-details' | 'not-undoable';

/** One request's state on this device. */
export interface ApprovalRequestState {
    /** The action whose request is in flight, or null. */
    readonly busy: ApprovalAction | null;
    /** A request broke off: its outcome is read again once online, never sent again. */
    readonly unconfirmed: boolean;
}

/** What an action did. */
export type ApprovalOutcome =
    /** The server took it: the request as it now is. */
    | { readonly kind: 'done'; readonly view: ApprovalView }
    /**
     * The details opened: their full text, and the request as now opened
     * (undefined when it wasn't held and reading it failed).
     */
    | { readonly kind: 'opened'; readonly full: string; readonly view: ApprovalView | undefined }
    /** Nothing was sent (offline, away, a sign-in or an update). */
    | { readonly kind: 'blocked'; readonly reason: ApprovalBlock }
    /** Nothing was sent: the card's rules refuse it. */
    | { readonly kind: 'not-allowed'; readonly reason: ApprovalRule }
    /** Nothing was sent: a request for it is in flight. */
    | { readonly kind: 'busy' }
    /**
     * A 409 or 404: the request read again (null when it is gone, undefined
     * when that read failed too, and it is read again later).
     */
    | { readonly kind: 'refused'; readonly view: ApprovalView | null | undefined }
    /** It broke off, or this request's last one did: read again once online, never sent again. */
    | { readonly kind: 'unconfirmed' }
    /** Another refusal (400, 401, 403, 429): its status. */
    | { readonly kind: 'failed'; readonly status: number | null };

/** A decision's haptic: success, or an error. */
export type ApprovalFeedback = (kind: 'success' | 'error') => void;

export interface ApprovalActionsOptions {
    readonly fetch: AuthedFetch;
    readonly cache: Pick<SnapshotCache, 'rows' | 'confirm'>;
    readonly appState: AppStateSource;
    readonly network: NetworkSource;
    /** Whether the server is away (the scheduler's status). */
    readonly away: () => boolean;
    /** Why writes wait (session.ts's `writeHold`). */
    readonly hold: () => WriteHold;
    /** A decision's haptic (the platform's, which reads the phone's setting). */
    readonly feedback?: ApprovalFeedback;
    readonly onError?: (error: unknown) => void;
    /** The device clock, for a return from the background. */
    readonly now?: () => number;
}

export interface ApprovalActions {
    /** Why nothing can be sent now, or null. */
    blocked(): ApprovalBlock | null;
    /** The newest copy of a request this device has: its row, else the last answer about it. */
    view(id: string): ApprovalView | undefined;
    /** Whether the server's last answer about the request was that it isn't there (a 404). */
    gone(id: string): boolean;
    /** A request's state on this device: the same object until it changes. */
    state(id: string): ApprovalRequestState;
    /**
     * Calls `listener` after each change of a state, of a view kept in memory
     * or of the connection NetInfo reports (`blocked()`). Returns the unsubscribe.
     */
    subscribe(listener: () => void): () => void;
    /** Approve or Deny (`POST …/decision`), with a haptic. */
    decide(id: string, decision: 'approve' | 'deny'): Promise<ApprovalOutcome>;
    /** Opens long details (`POST …/open`), which lets Approve work. */
    openDetails(id: string): Promise<ApprovalOutcome>;
    /** Undoes an automatic approval (`POST …/undo`). */
    undo(id: string): Promise<ApprovalOutcome>;
    /** A screen shows the request: polled while it waits or its socio carries on. Returns the leave. */
    watch(id: string): () => void;
    /** Reads the requests still waiting and those due a read (`resume`'s work, also for tests). */
    reconcile(): Promise<void>;
    /** Stops every timer and listener; nothing more is sent. */
    dispose(): void;
}

/** How often a shown request is read: while it waits, or its socio waits for other requests. */
export const APPROVAL_POLL_MS = 5_000;
/** …and once its socio carries on with nothing else to wait for. */
export const APPROVAL_CARRYING_POLL_MS = 2_000;
/** Requests asked about at once on resume. */
export const RECONCILE_CONCURRENCY = 4;
/** Each read's timeout on resume. */
export const RECONCILE_TIMEOUT_MS = 10_000;

const IDLE: ApprovalRequestState = { busy: null, unconfirmed: false };

const requestPath = (id: string) => `/api/approvals/${encodeURIComponent(id)}`;

const isView = (value: unknown): value is ApprovalView =>
    !!value &&
    typeof value === 'object' &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { status?: unknown }).status === 'string';

/** The card's rule that refuses `action` on `view`, or null (an unknown request goes to the server). */
export function approvalRule(view: ApprovalView | undefined, action: ApprovalAction): ApprovalRule | null {
    if (action === 'undo') {
        const auto = view?.auto;
        return view?.status === 'approved' && view.decidedVia === 'auto' && auto?.undoable && !auto.undoneAt
            ? null
            : 'not-undoable';
    }
    if (view === undefined) {
        return null;
    }
    if (action === 'open') {
        // The server opens a decided request's details too; only one without a review has none.
        return view.review ? null : 'no-details';
    }
    if (view.status !== 'pending') {
        return 'decided';
    }
    return action === 'approve' && mustOpenFirst(view) ? 'open-first' : null;
}

/** How long until a shown request is read again, or null when it needn't be (the web's useApproval). */
export function approvalPollMs(view: ApprovalView): number | null {
    const carrying = carryingOn(view);
    if (view.status !== 'pending' && !carrying) {
        return null;
    }
    return carrying && !view.continuation?.waitingFor ? APPROVAL_CARRYING_POLL_MS : APPROVAL_POLL_MS;
}

export function createApprovalActions(options: ApprovalActionsOptions): ApprovalActions {
    const { fetch, cache, appState, network, away, hold, feedback, onError = () => {}, now = Date.now } = options;
    const states = new Map<string, ApprovalRequestState>();
    /** Answers about requests the collection doesn't hold. */
    const known = new Map<string, ApprovalView>();
    /** Requests the server last answered as not there (404). */
    const missing = new Set<string>();
    /** Requests due a read: unconfirmed, or a refusal whose read failed. */
    const due = new Set<string>();
    const reading = new Map<string, Promise<ApprovalView | null | undefined>>();
    const watchers = new Map<string, number>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const listeners = new Set<() => void>();
    const aborts = new Set<AbortController>();
    let connected: boolean | null = null;
    let backgroundedAt: number | null = isForeground(appState.current()) ? null : now();
    let disposed = false;

    const tell = () => {
        for (const listener of [...listeners]) {
            listener();
        }
    };
    const setState = (id: string, next: ApprovalRequestState) => {
        const before = states.get(id) ?? IDLE;
        if (before.busy === next.busy && before.unconfirmed === next.unconfirmed) {
            return;
        }
        if (next.busy === null && !next.unconfirmed) {
            states.delete(id);
        } else {
            states.set(id, next);
        }
        tell();
    };
    const row = (id: string): ApprovalView | undefined => {
        const held = cache.rows(APPROVALS).get(id);
        return held === undefined ? undefined : (JSON.parse(held.json) as ApprovalView);
    };
    const view = (id: string) => row(id) ?? known.get(id);

    /** Keeps an answer: in the collection when it holds the request or it waits, else in memory. */
    const keep = (id: string, next: ApprovalView | null) => {
        const held = cache.rows(APPROVALS).has(id);
        if (next === null) {
            missing.add(id);
        } else {
            missing.delete(id);
        }
        if (next === null) {
            known.delete(id);
            if (held) {
                cache.confirm({ collection: APPROVALS, scope: '', key: id, deleted: true }).catch(onError);
            }
        } else if (held || next.status === 'pending') {
            known.delete(id);
            cache.confirm({ collection: APPROVALS, scope: '', key: id, value: next }).catch(onError);
        } else {
            known.set(id, next);
        }
        tell();
        // What it says now sets the next read (a decision makes the socio carry on).
        stopTimer(id);
        follow(id);
    };

    const blocked = (): ApprovalBlock | null => {
        if (connected === false) {
            return 'offline';
        }
        if (away()) {
            return 'away';
        }
        return hold();
    };

    /** A request with its own timeout, also stopped on dispose. */
    const withTimeout = async <T>(ms: number | null, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        const controller = new AbortController();
        aborts.add(controller);
        const timer = ms === null ? null : setTimeout(() => controller.abort(), ms);
        try {
            return await run(controller.signal);
        } finally {
            if (timer !== null) {
                clearTimeout(timer);
            }
            aborts.delete(controller);
        }
    };

    /**
     * Reads a request (`GET /api/approvals/:id`), one read at a time per
     * request: the view, null when it is gone (404), undefined when it failed
     * (it stays due if it was).
     */
    const read = (id: string, timeoutMs: number | null = RECONCILE_TIMEOUT_MS) => {
        const inFlight = reading.get(id);
        if (inFlight !== undefined) {
            return inFlight;
        }
        const run = (async (): Promise<ApprovalView | null | undefined> => {
            try {
                const answer = await withTimeout(timeoutMs, async (signal) => {
                    const response = await fetch(requestPath(id), { signal });
                    if (response.status === 404) {
                        return null;
                    }
                    if (!response.ok) {
                        return undefined;
                    }
                    const body = await readJson(response, signal);
                    return isView(body) ? body : undefined;
                });
                if (disposed || answer === undefined) {
                    return undefined;
                }
                due.delete(id);
                setState(id, { busy: states.get(id)?.busy ?? null, unconfirmed: false });
                keep(id, answer);
                return answer;
            } catch {
                // Offline, the server away or a timeout: it stays as it was, and due if it was.
                return undefined;
            } finally {
                reading.delete(id);
            }
        })();
        reading.set(id, run);
        return run;
    };

    /** Reads every request due a read, while online. */
    const readDue = () => {
        if (connected !== false && !disposed) {
            for (const id of [...due]) {
                void read(id);
            }
        }
    };

    // ----- Polling while shown -----

    function stopTimer(id: string) {
        const timer = timers.get(id);
        if (timer !== undefined) {
            clearTimeout(timer);
            timers.delete(id);
        }
    }
    /** Sets a shown request's next read by what it says now, unless one is set or in flight. */
    function follow(id: string) {
        // A request the server says isn't there is read again only when a screen shows it anew.
        if (disposed || !watchers.has(id) || timers.has(id) || reading.has(id) || missing.has(id)) {
            return;
        }
        const current = view(id);
        const ms = current === undefined ? APPROVAL_POLL_MS : approvalPollMs(current);
        if (ms === null) {
            return;
        }
        timers.set(
            id,
            setTimeout(() => {
                timers.delete(id);
                const quiet = !isForeground(appState.current()) || connected === false || away();
                if (quiet) {
                    follow(id);
                    return;
                }
                void read(id).then(() => follow(id));
            }, ms),
        );
    }

    // ----- Actions -----

    const act = async (id: string, action: ApprovalAction, path: string, json?: unknown): Promise<ApprovalOutcome> => {
        if (disposed) {
            return { kind: 'failed', status: null };
        }
        const reason = blocked();
        if (reason !== null) {
            return { kind: 'blocked', reason };
        }
        const state = states.get(id) ?? IDLE;
        if (state.busy !== null) {
            return { kind: 'busy' };
        }
        if (state.unconfirmed) {
            void read(id);
            return { kind: 'unconfirmed' };
        }
        const rule = approvalRule(view(id), action);
        if (rule !== null) {
            return { kind: 'not-allowed', reason: rule };
        }
        setState(id, { busy: action, unconfirmed: false });
        const brokeOff = (): ApprovalOutcome => {
            due.add(id);
            setState(id, { busy: null, unconfirmed: true });
            readDue();
            return { kind: 'unconfirmed' };
        };
        let response: Response;
        try {
            response = await withTimeout(null, (signal) =>
                fetch(`${requestPath(id)}/${path}`, {
                    method: 'POST',
                    signal,
                    ...(json === undefined ? {} : { json }),
                }),
            );
        } catch {
            return disposed ? { kind: 'failed', status: null } : brokeOff();
        }
        if (response.ok) {
            let body: unknown;
            try {
                body = await readJson(response);
            } catch {
                return brokeOff();
            }
            setState(id, IDLE);
            if (action === 'open') {
                return opened(id, body, response.status);
            }
            if (!isView(body)) {
                void read(id);
                return { kind: 'failed', status: response.status };
            }
            keep(id, body);
            return { kind: 'done', view: body };
        }
        if (response.status >= 500) {
            return brokeOff();
        }
        setState(id, IDLE);
        if (response.status === 409 || response.status === 404) {
            const current = await read(id);
            if (current === undefined) {
                due.add(id);
            }
            return { kind: 'refused', view: current };
        }
        return { kind: 'failed', status: response.status };
    };

    /** A 2xx to `…/open`: `{ full }`, and the request marked opened (the view held, else read again). */
    const opened = async (id: string, body: unknown, status: number): Promise<ApprovalOutcome> => {
        const full = body && typeof body === 'object' ? (body as { full?: unknown }).full : undefined;
        if (typeof full !== 'string') {
            void read(id);
            return { kind: 'failed', status };
        }
        const held = view(id);
        if (held === undefined) {
            return { kind: 'opened', full, view: (await read(id)) ?? undefined };
        }
        const next: ApprovalView = { ...held, review: { mustOpen: held.review?.mustOpen ?? false, opened: true } };
        keep(id, next);
        return { kind: 'opened', full, view: next };
    };

    const decide = async (id: string, decision: 'approve' | 'deny') => {
        const outcome = await act(id, decision, 'decision', { decision });
        if (outcome.kind === 'done') {
            feedback?.('success');
        } else if (outcome.kind === 'refused' || outcome.kind === 'unconfirmed' || outcome.kind === 'failed') {
            feedback?.('error');
        }
        return outcome;
    };

    // ----- Resume -----

    const reconcile = async () => {
        if (disposed || connected === false) {
            return;
        }
        const ids = new Set(due);
        for (const held of cache.rows(APPROVALS).values()) {
            if ((JSON.parse(held.json) as ApprovalView).status === 'pending') {
                ids.add(held.key);
            }
        }
        for (const [id, item] of known) {
            if (item.status === 'pending') {
                ids.add(id);
            }
        }
        const queue = [...ids];
        const worker = async () => {
            for (let id = queue.shift(); id !== undefined && !disposed; id = queue.shift()) {
                await read(id, RECONCILE_TIMEOUT_MS);
            }
        };
        await Promise.all(Array.from({ length: Math.min(RECONCILE_CONCURRENCY, queue.length) }, worker));
    };

    const unsubscribes = [
        appState.subscribe((next) => {
            if (!isForeground(next)) {
                backgroundedAt ??= now();
                return;
            }
            const returned = returnsFromBackground(backgroundedAt, now());
            backgroundedAt = null;
            if (returned) {
                reconcile().catch(onError);
            }
        }),
        network.subscribe((next) => {
            if (next.connected === null) {
                return;
            }
            const back = connected === false && next.connected;
            const changed = connected !== next.connected;
            connected = next.connected;
            if (changed) {
                // `blocked()` changed: the card and the bar say so.
                tell();
            }
            if (back) {
                readDue();
            }
        }),
    ];
    network
        .current()
        .then((next) => {
            // A report that came first wins.
            if (connected === null && next.connected !== null && !disposed) {
                connected = next.connected;
                tell();
            }
        })
        .catch(() => {});

    return {
        blocked,
        view,
        gone: (id) => missing.has(id),
        state: (id) => states.get(id) ?? IDLE,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        decide,
        openDetails: (id) => act(id, 'open', 'open'),
        undo: (id) => act(id, 'undo', 'undo'),
        watch(id) {
            watchers.set(id, (watchers.get(id) ?? 0) + 1);
            if (view(id) === undefined && connected !== false && !away()) {
                void read(id).then(() => follow(id));
            } else {
                follow(id);
            }
            let left = false;
            return () => {
                if (left) {
                    return;
                }
                left = true;
                const count = (watchers.get(id) ?? 1) - 1;
                if (count > 0) {
                    watchers.set(id, count);
                } else {
                    watchers.delete(id);
                    stopTimer(id);
                }
            };
        },
        reconcile,
        dispose() {
            disposed = true;
            for (const unsubscribe of unsubscribes.splice(0)) {
                unsubscribe();
            }
            for (const id of [...timers.keys()]) {
                stopTimer(id);
            }
            for (const controller of [...aborts]) {
                controller.abort();
            }
            listeners.clear();
        },
    };
}
