import type { WorkspaceManifest } from '@socio/shared/device-sign-in';

import { workspaceLayout } from '../data/layout';
import type { StagedLogo } from '../data/logo';
import { type SignInOutcome, signInAndCommit } from '../data/sign-in-flow';
import { rootState } from '../navigation/root-gate';

import { commitStaged } from './add-workspace';
import { randomBytes, sha256Hex } from './crypto';
import { launchedStore } from './device-store';
import { appFetch } from './fetch';
import { APP_USER_AGENT } from './user-agent';

// What the SignIn screen needs from the phone: the sign-in, person
// check and commit (data/sign-in-flow.ts) on the launched store, through the
// app's one fetch and User-Agent. Once a new workspace commits, its staged
// logo moves into its directory; then the root gate reads the registry again,
// which shows the shell.

function store() {
    const launched = launchedStore();
    if (launched === null) {
        throw new Error('The store is not open.');
    }
    return launched.opened.store;
}

export interface SignInInput {
    readonly origin: string;
    readonly email: string;
    readonly password: string;
    readonly logo: StagedLogo;
    /** The probe's manifest; null when signing in again, or on a server with none. */
    readonly manifest: WorkspaceManifest | null;
    readonly signal: AbortSignal;
}

/** Signs in and commits; a committed outcome has moved the logo and refreshed the gate. */
export async function signIn(input: SignInInput): Promise<SignInOutcome> {
    const outcome = await signInAndCommit(
        {
            origin: input.origin,
            email: input.email,
            password: input.password,
            logo: input.logo.kind === 'file' ? `logo.${input.logo.extension}` : null,
            manifest: input.manifest,
            signal: input.signal,
        },
        { store: store(), hash: sha256Hex, fetch: appFetch, userAgent: APP_USER_AGENT, randomBytes },
    );
    return finish(outcome, input.logo);
}

/** After any sign-in: a new workspace's logo moves in, then the gate shows it. */
export async function finish(outcome: SignInOutcome, logo: StagedLogo): Promise<SignInOutcome> {
    if (outcome.kind === 'other-person') {
        return { ...outcome, confirm: async () => finish(await outcome.confirm(), logo) };
    }
    if (outcome.kind !== 'committed') {
        return outcome;
    }
    if (outcome.committed === 'new' && logo.kind === 'file') {
        try {
            await commitStaged(logo, workspaceLayout(store().root, outcome.id).directory);
        } catch (error) {
            // The workspace is signed in; its logo shows as the mascot until it is fetched again.
            console.warn('[sign-in] logo not moved', error);
        }
    }
    // Adding another workspace ends with its sign-in, in the same change as the switch to it.
    await rootState.refresh({ adding: false });
    return outcome;
}
