import {
    LEAVE_REFUSAL_MESSAGES,
    LEAVE_WORKSPACE_PATH,
    leaveWorkspaceCheckSchema,
    leaveWorkspaceRefusalSchema,
    type LeaveWorkspaceRequest,
} from '@socio/shared/leave-workspace';

import type { AuthedFetch } from '../net/authed-fetch';
import { readJson } from '../net/read-body';

// Leaving a workspace (CB-383; shared's leave-workspace.ts, the server's),
// under Node. The account sheet asks `readLeaveCheck`
// as it opens: allowed, refused with the server's sentence, unsupported (an
// older server answers 404, and the row hides), or unknown (no answer, or
// one it can't read). Leaving posts `{ "confirm": "leave" }` through the
// workspace's authedFetch; only a 200 runs `wipe`, the same wipe as signing
// out (src/platform/sign-out.ts), since the server has already ended every
// session and device of the person's. A 409 keeps everything and says the
// server's reason; no answer, or any other, keeps everything too.

/** What the server says about leaving, as the account sheet shows it. */
export type LeaveCheck =
    | { readonly kind: 'allowed' }
    | { readonly kind: 'refused'; readonly message: string }
    /** An older server, without the endpoint: the row isn't shown. */
    | { readonly kind: 'unsupported' }
    /** No answer, or one that can't be read: the row is shown off, with `LEAVE_CHECK_FAILED`. */
    | { readonly kind: 'unknown' };

/** Leaving's outcome. */
export type LeaveOutcome =
    | { readonly kind: 'left' }
    | { readonly kind: 'refused'; readonly message: string }
    | { readonly kind: 'failed'; readonly message: string };

/** Under the row when the check got no answer it could read. */
export const LEAVE_CHECK_FAILED = 'Couldn’t check whether you can leave. Try again when you’re online.';
/** No answer to the leave: nothing on the phone changed. */
export const LEAVE_NO_ANSWER = 'Couldn’t reach the workspace. Check your connection and try again.';
/** Any other answer (a 400, 403 or 5xx). */
export const LEAVE_FAILED = 'Couldn’t leave the workspace. Try again later.';

/** `GET /api/account/leave`: whether the signed-in person may leave. Changes nothing; never rejects. */
export async function readLeaveCheck(fetch: AuthedFetch, signal?: AbortSignal): Promise<LeaveCheck> {
    try {
        const response = await fetch(LEAVE_WORKSPACE_PATH, { signal });
        if (response.status === 404) {
            return { kind: 'unsupported' };
        }
        if (!response.ok) {
            return { kind: 'unknown' };
        }
        const check = leaveWorkspaceCheckSchema.safeParse(await readJson(response, signal));
        if (!check.success) {
            return { kind: 'unknown' };
        }
        if (check.data.allowed) {
            return { kind: 'allowed' };
        }
        return {
            kind: 'refused',
            message: check.data.refusal?.message ?? LEAVE_REFUSAL_MESSAGES.already_left,
        };
    } catch {
        return { kind: 'unknown' };
    }
}

export interface LeaveDeps {
    /** The workspace's authedFetch (its scope's). */
    readonly fetch: AuthedFetch;
    /** Erases the workspace's copy, once the server says the person left (the sign-out's wipe). */
    readonly wipe: () => Promise<void>;
}

/**
 * `POST /api/account/leave` with the confirmation, then, on a 200 alone, the
 * wipe. Resolves 'left' once the wipe has run; never rejects for the request.
 */
export async function leaveWorkspace(deps: LeaveDeps): Promise<LeaveOutcome> {
    let response: Response;
    try {
        response = await deps.fetch(LEAVE_WORKSPACE_PATH, {
            method: 'POST',
            json: { confirm: 'leave' } satisfies LeaveWorkspaceRequest,
        });
    } catch {
        return { kind: 'failed', message: LEAVE_NO_ANSWER };
    }
    if (response.status === 200) {
        await deps.wipe();
        return { kind: 'left' };
    }
    if (response.status === 409) {
        const refusal = leaveWorkspaceRefusalSchema.safeParse(await readJson(response).catch(() => null));
        return {
            kind: 'refused',
            message: refusal.success ? refusal.data.error || LEAVE_REFUSAL_MESSAGES[refusal.data.code] : LEAVE_FAILED,
        };
    }
    return { kind: 'failed', message: LEAVE_FAILED };
}
