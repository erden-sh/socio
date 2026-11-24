import { DEACTIVATED_MESSAGE, type AuthSession } from '@socio/shared/auth';
import {
    LEAVE_WORKSPACE_PATH,
    type LeaveWorkspaceCheck,
    type LeaveWorkspaceRequest,
} from '@socio/shared/leave-workspace';

import { api } from '../lib/api';

import { importOrReload } from './chunk-reload';

/**
 * Better Auth's endpoints (`/api/auth/*`) as the sign-in screen and the
 * account dialog use them. The WebAuthn browser code loads only when a
 * passkey is used.
 */
export const authSession = () => api<AuthSession>('/auth/session');

export async function signInWithPasskey() {
    const { startAuthentication } = await importOrReload(() => import('@simplewebauthn/browser'));
    const options = await api<Parameters<typeof startAuthentication>[0]['optionsJSON']>(
        '/auth/passkey/generate-authenticate-options',
    );
    const response = await startAuthentication({ optionsJSON: options });
    await api('/auth/passkey/verify-authentication', 'POST', { response });
}

export async function addPasskey(name: string) {
    const { startRegistration } = await importOrReload(() => import('@simplewebauthn/browser'));
    const options = await api<Parameters<typeof startRegistration>[0]['optionsJSON']>(
        `/auth/passkey/generate-register-options?name=${encodeURIComponent(name)}`,
    );
    const response = await startRegistration({ optionsJSON: options });
    await api('/auth/passkey/verify-registration', 'POST', { response, name });
    passkeyCheck.set(null);
}

export interface Passkey {
    id: string;
    name?: string | null;
    createdAt?: string | null;
}
export const listPasskeys = () => api<Passkey[]>('/auth/passkey/list-user-passkeys');
export const deletePasskey = (id: string) => api('/auth/passkey/delete-passkey', 'POST', { id });

/** `sessionStorage` key: whether the sidebar should suggest a passkey. */
export const PASSKEY_CHECK_KEY = 'socio-passkey-check';
/**
 * The passkey suggestion, kept for this tab (CB-68): `pending` after a
 * sign-in without a passkey, then `show:<user id>` once the list came back
 * empty, so reloads neither ask again nor lose it. Nothing otherwise: an
 * ordinary page load doesn't ask for the list (Better Auth rate-limits it).
 */
export const passkeyCheck = {
    get(): string | null {
        try {
            return sessionStorage.getItem(PASSKEY_CHECK_KEY);
        } catch {
            return null;
        }
    },
    set(value: string | null) {
        try {
            if (value) {
                sessionStorage.setItem(PASSKEY_CHECK_KEY, value);
            } else {
                sessionStorage.removeItem(PASSKEY_CHECK_KEY);
            }
        } catch {
            // Storage is blocked: no suggestion.
        }
    },
};
const signedInWithoutPasskey = () => passkeyCheck.set('pending');

/** Your display name (Better Auth's own endpoint; role and links can't be set through it). */
export const updateName = (name: string) => api('/auth/update-user', 'POST', { name });

export const signInWithPassword = (email: string, password: string) =>
    api('/auth/sign-in/email', 'POST', { email, password }).then(signedInWithoutPasskey);
export const signUp = (name: string, email: string, password: string) =>
    api('/auth/sign-up/email', 'POST', { name, email, password }).then(signedInWithoutPasskey);

/**
 * Off to the provider; it comes back to `/` (or `/?error=…`), or to an
 * agent's request being connected (CB-90).
 */
export async function signInWithProvider(provider: string) {
    const here = globalThis.location;
    // Back to the page that asked: an agent's consent, or the app's sheet.
    const back = /^\/(connect|device\/continue)(\/|$)/.test(here.pathname) ? `${here.pathname}${here.search}` : '/';
    const { url } = await api<{ url: string }>('/auth/sign-in/social', 'POST', {
        provider,
        callbackURL: back,
        // A failure comes back to the same page, which says why.
        errorCallbackURL: back,
    });
    signedInWithoutPasskey();
    globalThis.location.assign(url);
}

/** "Send me a sign-in link": the answer is the same for every address. */
export const requestSignInLink = (email: string) => api('/auth/sign-in-link', 'POST', { email });
/**
 * Uses a one-time sign-in link: the server signs in and sends the browser
 * to `/` (or `/?error=…` when the link is used up or expired).
 */
export function completeSignInLink(token: string) {
    const query = new URLSearchParams({
        token,
        callbackURL: '/',
        errorCallbackURL: '/',
    });
    signedInWithoutPasskey();
    globalThis.location.assign(`/api/auth/magic-link/verify?${query}`);
}

/** Sets a password from a one-time link (an invite or a reset). */
export const setPasswordFromLink = (token: string, newPassword: string) =>
    api('/auth/reset-password', 'POST', { token, newPassword });
export const requestPasswordReset = (email: string) =>
    api('/auth/request-password-reset', 'POST', {
        email,
        redirectTo: '/reset-password',
    });
export const changePassword = (currentPassword: string, newPassword: string) =>
    api('/auth/change-password', 'POST', {
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
    });
/** Ends every session of this account, this one included. */
export const signOutEverywhere = () => api('/auth/revoke-sessions', 'POST', {});

/** Leaving the workspace (CB-383): whether one may, then leaving. `api` adds the `/api`. */
const LEAVE_PATH = LEAVE_WORKSPACE_PATH.replace(/^\/api/, '');
export const leaveWorkspaceCheck = () => api<LeaveWorkspaceCheck>(LEAVE_PATH);
export const leaveWorkspace = () =>
    api<{ ok: true }>(LEAVE_PATH, 'POST', { confirm: 'leave' } satisfies LeaveWorkspaceRequest);

/** Messages for the `?error=` codes an OAuth sign-in comes back with. */
export function signInError(code: string | null, description?: string | null) {
    if (!code) {
        return '';
    }
    if (code === 'not_invited') {
        return 'This account is not invited to this workspace. Ask an admin to add you.';
    }
    if (code === 'state_mismatch' || code === 'state_not_found') {
        return 'The sign-in expired or was started in another browser. Try again.';
    }
    if (code === 'INVALID_TOKEN' || code === 'new_user_signup_disabled') {
        return 'That sign-in link is used up or expired. Ask for a new one.';
    }
    if (code === 'BANNED_USER') {
        return DEACTIVATED_MESSAGE;
    }
    if (code === 'METHOD_OFF') {
        return 'That way of signing in is turned off here. Sign in another way, or ask an operator.';
    }
    if (code === 'account_not_linked') {
        return 'An account with this email exists, but the provider did not confirm the address. Sign in another way, or ask an admin.';
    }
    return description || 'Sign-in failed. Try again, or ask an admin.';
}
