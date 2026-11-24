import { z } from 'zod';

/**
 * Leaving a workspace (CB-383): a person ends their own membership, from
 * Settings → Account → Profile → Leave workspace on the web, or from the
 * Socio app. Pure data and zod, so the app can bundle it (Hermes).
 *
 * Leaving is a deactivation the person asks for themselves: they can no
 * longer sign in, every session and device of theirs ends (the app's copy
 * is erased), and what they made stays with the company, where admins can
 * hand it to someone else (Settings → People). An admin can reactivate them.
 *
 * - `GET  LEAVE_WORKSPACE_PATH`: whether the signed-in person may leave
 *   (`leaveWorkspaceCheckSchema`); changes nothing.
 * - `POST LEAVE_WORKSPACE_PATH` with `{ "confirm": "leave" }`: leaves.
 *   200 `{ ok: true }`; 409 `{ error, code }` with a `LeaveRefusalCode`
 *   when they can't; 400 without the confirmation; 403 for anything but a
 *   person's own session (service keys, data tokens, plugins).
 *
 * After a 200 the caller's session is gone: the web signs out, the app
 * erases its copy of the workspace (its next request would answer 401
 * `deactivated` anyway). Every change here is additive.
 */
export const LEAVE_WORKSPACE_PATH = '/api/account/leave';

/**
 * Why a person can't leave on their own. `owner`: the workspace owner hands
 * ownership to another admin first (CB-390). `last_operator` is never sent
 * since the operator role was retired (CB-390); kept so an app still reads
 * an older server's answer.
 */
export const LEAVE_REFUSAL_CODES = ['last_operator', 'last_admin', 'owner', 'already_left'] as const;
export type LeaveRefusalCode = (typeof LEAVE_REFUSAL_CODES)[number];

/** The body `POST` needs: the person confirmed it. */
export const leaveWorkspaceRequestSchema = z.object({ confirm: z.literal('leave') });
export type LeaveWorkspaceRequest = z.infer<typeof leaveWorkspaceRequestSchema>;

/** `GET`'s answer: may they leave, and if not, why (a sentence to show). */
export const leaveWorkspaceCheckSchema = z.object({
    allowed: z.boolean(),
    refusal: z.object({ code: z.enum(LEAVE_REFUSAL_CODES), message: z.string() }).nullable(),
});
export type LeaveWorkspaceCheck = z.infer<typeof leaveWorkspaceCheckSchema>;

/** `POST`'s refusal (409). */
export const leaveWorkspaceRefusalSchema = z.object({ error: z.string(), code: z.enum(LEAVE_REFUSAL_CODES) });
export type LeaveWorkspaceRefusal = z.infer<typeof leaveWorkspaceRefusalSchema>;

/** What each refusal says to the person. */
export const LEAVE_REFUSAL_MESSAGES: Readonly<Record<LeaveRefusalCode, string>> = {
    last_operator:
        'You are the last person who can manage this workspace. Make someone else an admin before you leave.',
    last_admin:
        'You are this workspace’s only admin. Make someone else an admin before you leave, so someone can still manage it.',
    owner: 'You own this workspace. Make another admin its owner (Settings → People) before you leave.',
    already_left: 'You have already left this workspace.',
};
