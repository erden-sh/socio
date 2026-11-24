import type { SignInMethods } from '@socio/shared/auth';
import type { AppVariant, WorkspaceManifest } from '@socio/shared/device-sign-in';

import { deviceLinkAddress } from '../net/add-device';
import { AbortedError } from '../net/errors';
import type { WorkspaceLink } from '../net/first-screen';
import type { ProbeResult } from '../net/probe';
import { probeCopy } from '../net/probe-copy';

import type { StagedLogo } from './logo';

// Add workspace's ways to a workspace, under Node: a typed address (the address screen) and a
// Get the app link (the first screen) both end here. The address is probed (net/probe.ts); a
// workspace found has its logo staged and goes to Confirm, one already on the device opens, anything
// else gets its line from probe-copy.ts, never the server's text. A link's host is first checked as a
// typed address is (`deviceLinkAddress`: `checkAddress`, a development build's local server plain
// http), so a link can reach nothing a person couldn't type.

/** What Confirm takes: the workspace the probe found (ConfirmWorkspaceParams). */
export interface FoundWorkspace {
    readonly origin: string;
    readonly host: string;
    readonly name: string;
    readonly logo: StagedLogo;
    readonly methods: SignInMethods | null;
    readonly manifest: WorkspaceManifest | null;
}

export interface AddProblem {
    readonly line: string;
    /** Test builds only: the answer's status and origin, or the refusal's kind. */
    readonly detail: string | null;
}

export type AddOutcome =
    | { readonly kind: 'problem'; readonly problem: AddProblem }
    | { readonly kind: 'found'; readonly workspace: FoundWorkspace }
    | { readonly kind: 'opened' | 'failure' | 'aborted' };

export interface AddDeps {
    readonly probe: (text: string, signal: AbortSignal) => Promise<ProbeResult>;
    readonly stage: (logo: string | null, origin: string, signal: AbortSignal) => Promise<StagedLogo>;
    readonly openKnown: (origin: string) => Promise<void>;
    /** Development and preview: problems carry their detail. */
    readonly testBuild: boolean;
    readonly report?: (message: string, error: unknown) => void;
}

/** Probes `text`; stages the logo of a workspace found, or opens one already on the device. */
export async function addByAddress(text: string, signal: AbortSignal, deps: AddDeps): Promise<AddOutcome> {
    try {
        const result = await deps.probe(text, signal);
        if (result.kind === 'failed') {
            const detail = [result.status === null ? null : `HTTP ${result.status}`, result.origin]
                .filter((part) => part !== null)
                .join(' · ');
            return {
                kind: 'problem',
                problem: { line: probeCopy(result.problem), detail: deps.testBuild && detail !== '' ? detail : null },
            };
        }
        if (result.kind === 'known') {
            await deps.openKnown(result.address.origin);
            return { kind: 'opened' };
        }
        const logo = await deps.stage(result.workspace.logo, result.address.origin, signal);
        return {
            kind: 'found',
            workspace: {
                origin: result.address.origin,
                host: result.address.host,
                name: result.workspace.name,
                logo,
                methods: result.workspace.methods,
                manifest: result.workspace.manifest,
            },
        };
    } catch (error) {
        if (error instanceof AbortedError || signal.aborted) {
            return { kind: 'aborted' };
        }
        (deps.report ?? console.warn)('[add-workspace] could not add', error);
        return { kind: 'failure' };
    }
}

/** A Get the app link: its host checked as a typed address, then the same probe. */
export function addByLink(
    link: WorkspaceLink,
    variant: AppVariant,
    signal: AbortSignal,
    deps: AddDeps,
): Promise<AddOutcome> {
    const address = deviceLinkAddress(link.host, variant);
    if (!address.ok) {
        return Promise.resolve({
            kind: 'problem',
            problem: { line: probeCopy(address.problem), detail: deps.testBuild ? address.problem : null },
        });
    }
    return addByAddress(address.address.origin, signal, deps);
}
