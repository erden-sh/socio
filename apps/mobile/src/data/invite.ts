import { DEACTIVATED_MESSAGE } from '@socio/shared/auth';
import type { AppVariant, WorkspaceManifest } from '@socio/shared/device-sign-in';

import { deviceLinkAddress } from '../net/add-device';
import { AbortedError } from '../net/errors';
import {
    CANT_CHECK_INVITE,
    checkNewPassword,
    INVITE_PASSWORD_OFF,
    type InviteLink,
    passwordRuleLine,
    sameNameWarning,
    type SetPasswordResult,
    setPasswordLine,
} from '../net/invite';
import type { ProbeResult } from '../net/probe';
import { probeCopy } from '../net/probe-copy';
import { signInCopy, UNFINISHED } from '../net/sign-in-copy';

import type { SignInOutcome } from './sign-in-flow';
import type { Store } from './wipe';

// Invites when the app is installed first, under Node:
// src/platform/invite.ts binds it, the Invite screen draws its view.
//
// 1. An invite link (`readInviteLink`) names the workspace by host: it is checked as a typed address
//    is (`deviceLinkAddress`, `checkAddress`), then probed (the manifest, then the sign-in view).
//    Opening it spends nothing.
// 2. "Join Acme (acme.example.com)?" with the host where the probe ended, and a warning when a
//    workspace of that name is already on the device (another host: check the address).
// 3. The set-password form, the web's: the email the invite went to, the password and its repeat,
//    checked as the web checks them (at least MIN_PASSWORD_LENGTH characters, at most
//    MAX_PASSWORD_LENGTH, the same twice). Then `POST /api/auth/reset-password` with the token: a
//    refusal is worded (used or run out, the server's length rule, too many tries, no answer).
// 4. Once the password is set, the token is spent and dropped. The password sign-in goes through
//    `signInAndCommit` (the install id, the person check, BANNED_USER, the commit): the person's
//    copy commits, another person's asks the another-person question, and a sign-in that doesn't
//    take asks the email again with the password kept for it.
// The token and the password live in this closure's memory only: never stored, logged, thrown, put in
// a view or a problem. Both go when the screen does (`leave`); a kill loses them, and the invite link
// still works until it is used.

/** A workspace on the device, for the same-name warning. */
export interface KnownWorkspace {
    readonly name: string;
    readonly origin: string;
    readonly state: string;
}

/** The workspaces on the device, settled ones only (not being added or wiped). */
export async function knownWorkspaces(store: Store): Promise<KnownWorkspace[]> {
    return (await store.registry.list())
        .filter((row) => row.state !== 'pending' && row.state !== 'wiping')
        .map(({ name, origin, state }) => ({ name, origin, state }));
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The warning for a workspace named `name` at `origin`, or null when none of that name is on the device. */
export function sameNameLine(name: string, origin: string, known: readonly KnownWorkspace[]): string | null {
    const matches = known.filter((row) => sameName(row.name, name));
    if (matches.length === 0) {
        return null;
    }
    const elsewhere = matches.find((row) => row.origin !== origin);
    return sameNameWarning(name, elsewhere === undefined ? null : new URL(elsewhere.origin).host);
}

export interface InviteDeps {
    readonly variant: AppVariant;
    /** `probeWorkspace` with this build's rules, never answering `known`: an invite may be for a workspace on the device. */
    readonly probe: (text: string, signal: AbortSignal) => Promise<ProbeResult>;
    readonly known: () => Promise<readonly KnownWorkspace[]>;
    /** `setPasswordFromInvite`. */
    readonly setPassword: (
        input: { readonly origin: string; readonly token: string; readonly password: string },
        signal: AbortSignal,
    ) => Promise<SetPasswordResult>;
    /** `signInAndCommit` with the email and password, then the gate. */
    readonly signIn: (input: {
        readonly origin: string;
        readonly email: string;
        readonly password: string;
        readonly manifest: WorkspaceManifest | null;
        readonly signal: AbortSignal;
    }) => Promise<SignInOutcome>;
}

/** What the Invite screen shows. No step holds the token or the password. */
export type InviteView =
    | { readonly step: 'idle' }
    | { readonly step: 'checking'; readonly host: string }
    /** The link can't be used: its host or the workspace refused. */
    | { readonly step: 'refused'; readonly host: string; readonly line: string; readonly detail: string | null }
    | { readonly step: 'join'; readonly host: string; readonly name: string; readonly warning: string | null }
    /** The set-password form; `line` says why the last try didn't work. */
    | {
          readonly step: 'password';
          readonly host: string;
          readonly name: string;
          readonly busy: boolean;
          readonly line: string | null;
          readonly detail: string | null;
      }
    | { readonly step: 'signing-in'; readonly host: string; readonly name: string }
    /** The password is set but signing in with it didn't take: the email again (the password is kept). */
    | {
          readonly step: 'sign-in';
          readonly host: string;
          readonly name: string;
          readonly email: string;
          readonly line: string;
          readonly detail: string | null;
      }
    | { readonly step: 'commit-question'; readonly host: string; readonly name: string; readonly unsent: number | null }
    | { readonly step: 'signed-in' }
    /** Nothing more this invite can do here. */
    | { readonly step: 'ended'; readonly host: string; readonly name: string; readonly line: string };

export interface NewPasswordInput {
    readonly email: string;
    readonly password: string;
    readonly repeat: string;
}

export interface Invite {
    view(): InviteView;
    subscribe(listener: () => void): () => void;
    /** An invite link (a new one replaces what shows, unless a sign-in is committing). */
    start(link: InviteLink): void;
    /** Join: the set-password form. */
    join(): void;
    /** Set password: checked here, set on the server, then the sign-in. */
    submit(input: NewPasswordInput): void;
    /** The password is set: sign in with it as `email`. */
    signIn(email: string): void;
    /** The commit's another-person question answered. */
    answerCommit(confirm: boolean): void;
    /** The screen goes (Cancel, Back, unmount): the token and the password are dropped. */
    leave(): void;
}

/** The email field: something with an `@` in it; the server says the rest. */
const EMAIL = /^[^\s@]+@[^\s@]+$/;
export const EMAIL_NEEDED = 'Type the email your invite was sent to.';
/** Signing in with the new password: an email that doesn't match. */
export const EMAIL_MISMATCH =
    "Your password is set, but that email doesn't match this invite. Type the email the invite was sent to.";
export const INVITE_COMMIT_FAILED = "Couldn't finish signing in on this device. Try again.";
/** The commit's another-person question was cancelled. */
export const INVITE_SWITCH_CANCELLED =
    'Nothing changed on this device. Your password is set: sign in from the workspace’s address when you’re ready.';

export function createInvite(deps: InviteDeps): Invite {
    const listeners = new Set<() => void>();
    let shown: InviteView = { step: 'idle' };
    /** Everything of the link in hand; replaced whole by each `start`, dropped by `leave`. */
    let run: {
        readonly scope: AbortController;
        /** The host to show: the link's, then where the probe ended. */
        host: string;
        origin: string | null;
        name: string;
        manifest: WorkspaceManifest | null;
        /** The invite's token, until the password is set (or the screen goes). */
        token: string | null;
        /** The new password, from the moment it is set until the sign-in commits (or the screen goes). */
        password: string | null;
        commitAnswer: ((confirm: boolean) => void) | null;
    } | null = null;

    const set = (view: InviteView) => {
        shown = view;
        for (const listener of listeners) {
            listener();
        }
    };
    const current = (scope: AbortController) => run !== null && run.scope === scope && !scope.signal.aborted;
    const report = (where: string, error: unknown) => {
        if (!(error instanceof AbortedError)) {
            console.warn(`[invite] ${where}`, error instanceof Error ? error.name : 'unknown');
        }
    };
    const end = (line: string) => {
        if (run === null) {
            return;
        }
        run.token = null;
        run.password = null;
        set({ step: 'ended', host: run.host, name: run.name, line });
    };

    async function check(scope: AbortController, link: InviteLink) {
        const address = deviceLinkAddress(link.host, deps.variant);
        if (!address.ok) {
            set({ step: 'refused', host: link.host, line: probeCopy(address.problem), detail: address.problem });
            return;
        }
        const result = await deps.probe(address.address.origin, scope.signal);
        if (!current(scope) || run === null) {
            return;
        }
        if (result.kind !== 'found') {
            const problem = result.kind === 'failed' ? result.problem : 'not-socio';
            set({ step: 'refused', host: link.host, line: probeCopy(problem), detail: problem });
            return;
        }
        const manifest = result.workspace.manifest;
        if (manifest !== null && manifest.methods.password === false) {
            set({ step: 'refused', host: result.address.host, line: INVITE_PASSWORD_OFF, detail: null });
            return;
        }
        const known = await deps.known().catch(() => []);
        if (!current(scope) || run === null) {
            return;
        }
        run.host = result.address.host;
        run.origin = result.address.origin;
        run.name = result.workspace.name;
        run.manifest = manifest;
        set({
            step: 'join',
            host: run.host,
            name: run.name,
            warning: sameNameLine(run.name, run.origin, known),
        });
    }

    async function setPassword(scope: AbortController, email: string, password: string) {
        if (run === null || run.origin === null || run.token === null) {
            return;
        }
        const { host, name, origin, token } = run;
        set({ step: 'password', host, name, busy: true, line: null, detail: null });
        const result = await deps.setPassword({ origin, token, password }, scope.signal);
        if (!current(scope) || run === null) {
            return;
        }
        if (!result.ok) {
            const { line, spent } = setPasswordLine(result.problem);
            if (spent) {
                end(line);
            } else {
                set({ step: 'password', host, name, busy: false, line, detail: result.problem.kind });
            }
            return;
        }
        // Spent on the server: the token goes, the password stays for the sign-in.
        run.token = null;
        run.password = password;
        await signIn(scope, email);
    }

    async function signIn(scope: AbortController, email: string) {
        if (run === null || run.origin === null || run.password === null) {
            return;
        }
        const { host, name, origin, manifest, password } = run;
        set({ step: 'signing-in', host, name });
        const outcome = await deps.signIn({ origin, email: email.trim(), password, manifest, signal: scope.signal });
        await settle(scope, outcome, email);
    }

    async function settle(scope: AbortController, outcome: SignInOutcome, email: string): Promise<void> {
        if (run === null || run.scope !== scope) {
            // Left while committing: a committed sign-in stays (the gate shows it); a question is cancelled.
            if (outcome.kind === 'other-person') {
                await outcome.cancel();
            }
            return;
        }
        const { host, name } = run;
        const again = (line: string, detail: string | null) =>
            set({ step: 'sign-in', host, name, email, line, detail });
        switch (outcome.kind) {
            case 'committed':
                run.password = null;
                set({ step: 'signed-in' });
                return;
            case 'problem': {
                const { problem } = outcome;
                switch (problem.kind) {
                    case 'wrong-credentials':
                    case 'invalid-email':
                        again(EMAIL_MISMATCH, problem.kind);
                        return;
                    case 'deactivated':
                        end(DEACTIVATED_MESSAGE);
                        return;
                    case 'method-off':
                    case 'password-disabled':
                        end(INVITE_PASSWORD_OFF);
                        return;
                    default:
                        again(signInCopy(problem).message, problem.kind);
                        return;
                }
            }
            case 'unfinished':
                end(UNFINISHED);
                return;
            case 'commit-failed':
                again(INVITE_COMMIT_FAILED, outcome.error.step);
                return;
            case 'other-person': {
                const answer = await new Promise<boolean>((resolve) => {
                    if (run !== null) {
                        run.commitAnswer = resolve;
                    }
                    set({ step: 'commit-question', host, name, unsent: outcome.unsent });
                });
                if (answer && current(scope)) {
                    set({ step: 'signing-in', host, name });
                    await settle(scope, await outcome.confirm(), email);
                } else {
                    await outcome.cancel();
                    if (current(scope)) {
                        end(INVITE_SWITCH_CANCELLED);
                    }
                }
            }
        }
    }

    const go = (scope: AbortController, work: () => Promise<void>, where: string, email: string) => {
        work().catch((error: unknown) => {
            report(where, error);
            if (current(scope) && !(error instanceof AbortedError) && run !== null) {
                if (run.password !== null) {
                    set({
                        step: 'sign-in',
                        host: run.host,
                        name: run.name,
                        email,
                        line: INVITE_COMMIT_FAILED,
                        detail: null,
                    });
                } else if (run.token !== null) {
                    set({
                        step: 'password',
                        host: run.host,
                        name: run.name,
                        busy: false,
                        line: INVITE_COMMIT_FAILED,
                        detail: null,
                    });
                } else {
                    end(INVITE_COMMIT_FAILED);
                }
            }
        });
    };

    return {
        view: () => shown,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        start(link) {
            if (shown.step === 'signing-in' || (shown.step === 'password' && shown.busy)) {
                return;
            }
            run?.scope.abort();
            run?.commitAnswer?.(false);
            const scope = new AbortController();
            run = {
                scope,
                host: link.host,
                origin: null,
                name: '',
                manifest: null,
                token: link.token,
                password: null,
                commitAnswer: null,
            };
            set({ step: 'checking', host: link.host });
            check(scope, link).catch((error: unknown) => {
                report('the workspace was not checked', error);
                if (current(scope)) {
                    set({ step: 'refused', host: link.host, line: CANT_CHECK_INVITE, detail: null });
                }
            });
        },
        join() {
            if (run === null || shown.step !== 'join') {
                return;
            }
            set({ step: 'password', host: run.host, name: run.name, busy: false, line: null, detail: null });
        },
        submit({ email, password, repeat }) {
            if (run === null || shown.step !== 'password' || shown.busy) {
                return;
            }
            const { host, name, scope } = run;
            if (!EMAIL.test(email.trim())) {
                set({ step: 'password', host, name, busy: false, line: EMAIL_NEEDED, detail: null });
                return;
            }
            const rule = checkNewPassword(password, repeat);
            if (rule !== null) {
                set({ step: 'password', host, name, busy: false, line: passwordRuleLine(rule), detail: rule });
                return;
            }
            go(scope, () => setPassword(scope, email, password), 'the password was not set', email);
        },
        signIn(email) {
            if (run === null || shown.step !== 'sign-in') {
                return;
            }
            const { host, name, scope } = run;
            if (!EMAIL.test(email.trim())) {
                set({ step: 'sign-in', host, name, email, line: EMAIL_NEEDED, detail: null });
                return;
            }
            go(scope, () => signIn(scope, email), 'the sign-in failed', email);
        },
        answerCommit(confirm) {
            const answer = run?.commitAnswer;
            if (run === null || answer == null) {
                return;
            }
            run.commitAnswer = null;
            answer(confirm);
        },
        leave() {
            const left = run;
            run = null;
            if (left !== null) {
                left.token = null;
                left.password = null;
                left.scope.abort();
                left.commitAnswer?.(false);
            }
            set({ step: 'idle' });
        },
    };
}
