import type { WorkspaceManifest } from '@socio/shared/device-sign-in';

import type { SheetResult } from '../net/auth-sheet';

import type { StagedLogo } from './logo';
import type { SheetFlow, SheetRefusal, TakenSheet } from './sheet-flow';
import type { SignInOutcome } from './sign-in-flow';

// Signing in through the system sign-in sheet, the part between the screens and the pending
// flow, under Node; src/platform/sheet-sign-in.ts binds it to auth-sheet.ts' sheet, the store and
// the redeem, so tests/sheet-sign-ins.test.ts runs it as the app does.
//
// - A callback comes two ways: the sheet's own answer (`start`), and a link from outside
//   (`onLink`, root-navigation.ts), which is how it comes after Android killed the app while the
//   sheet showed, or when Android's Custom Tab hands it back as a verified App Link. Whichever comes
//   first takes the flow; the other finds nothing, and `start` says so only when the link didn't
//   take that same state (`callback` with `taken: false`), else it is `refused` with why, which the
//   SignIn screen words ("didn't finish, try again").
// - A taken callback waits here, in memory, as a ticket for the SheetSignIn screen, which redeems
//   and commits it once (`finish(ticket)`). A screen that asks with another ticket, or none, gets
//   null: an outcome is never handed to a second screen (which would ask the other-person question
//   again). What the screens held for the flow started in this process (the staged logo, the
//   probe's manifest) goes with it; after a kill the mascot shows and the manifest is read again.
// - The person's Cancel deletes the flow on iOS. On Android it doesn't: the Custom Tab answers
//   `dismiss` as soon as the person is back in the app, which can come before the link's url event
//   that carries the callback. The state protects the flow there, and it expires or is replaced by
//   the next `begin`. Every other failure deletes it.

/** What opening the sheet ended in, for the SignIn screen. */
export type SheetStart =
    /** A callback came: `taken` when this answer took it (the screen opens SheetSignIn); false when the link took it. */
    | { readonly kind: 'callback'; readonly taken: boolean }
    /** A callback came and nothing took it: the flow had expired, or the callback wasn't its own. */
    | { readonly kind: 'refused'; readonly reason: SheetRefusal }
    | { readonly kind: 'cancelled' }
    /** This build has no sheet. */
    | { readonly kind: 'unavailable' }
    /** The sheet couldn't open or come back; `detail` is the platform's words for test builds, never a URL. */
    | { readonly kind: 'failed'; readonly reason: string; readonly detail: string | null };

export interface SheetInput {
    readonly origin: string;
    readonly name: string;
    readonly logo: StagedLogo;
    readonly manifest: WorkspaceManifest | null;
}

/** A taken callback's job, for the redeem. */
export interface SheetJob {
    readonly taken: TakenSheet;
    readonly logo: StagedLogo;
    readonly manifest: WorkspaceManifest | null;
}

export interface SheetSignInsDeps {
    /** The pending flow on the open store, or null in a build with no sheet (or before the store opens). */
    readonly flow: () => SheetFlow | null;
    /** src/platform/auth-sheet.ts' `openAuthSheet`. */
    readonly openSheet: (url: string) => Promise<SheetResult>;
    readonly os: 'ios' | 'android';
    /** Redeems and commits a job (`signInAndCommit` with the redeem as its stage, then the logo and the gate). */
    readonly redeem: (job: SheetJob) => Promise<SignInOutcome>;
    /** Opens the SheetSignIn screen over the gate, for a callback a link brought. */
    readonly show: () => void;
    /** Where a failure to read the flow is reported: its kind only. */
    readonly report?: (message: string) => void;
}

/** The workspace a taken callback is for, and the ticket its screen redeems it with. */
export interface ReadySheet {
    readonly ticket: number;
    readonly origin: string;
    readonly name: string;
}

export interface SheetSignIns {
    /** Starts a flow, opens the sheet on the workspace's device start page, and takes its callback. */
    start(input: SheetInput): Promise<SheetStart>;
    /** A link from outside that may be the sheet's callback: taken, then SheetSignIn opens. Resolves whether it was. */
    onLink(url: string): Promise<boolean>;
    /** The callback waiting for a screen, if any. */
    ready(): ReadySheet | null;
    /** Redeems and commits the callback with `ticket`, once however often it is asked; null for another ticket. */
    finish(ticket: number): Promise<SignInOutcome | null>;
}

const MASCOT: StagedLogo = { kind: 'mascot' };

export function createSheetSignIns(deps: SheetSignInsDeps): SheetSignIns {
    const report = deps.report ?? ((message: string) => console.warn(message));
    /** What the screens hold for the flow started in this process. */
    let held: {
        readonly state: string;
        readonly logo: StagedLogo;
        readonly manifest: WorkspaceManifest | null;
    } | null = null;
    let tickets = 0;
    /** The last callback taken: its ticket and job, then its run once started. */
    let current: {
        readonly ticket: number;
        readonly state: string;
        readonly job: SheetJob;
        run: Promise<SignInOutcome> | null;
    } | null = null;

    const deliver = async (url: string): Promise<{ readonly taken: boolean; readonly refused?: SheetRefusal }> => {
        const flow = deps.flow();
        if (flow === null) {
            return { taken: false, refused: 'no-flow' };
        }
        let take: Awaited<ReturnType<SheetFlow['take']>>;
        try {
            take = await flow.take(url);
        } catch (error) {
            report(`[sheet] the pending sign-in could not be read: ${error instanceof Error ? error.name : 'unknown'}`);
            return { taken: false, refused: 'no-flow' };
        }
        if ('refused' in take) {
            return { taken: false, refused: take.refused };
        }
        const { taken } = take;
        const mine = held !== null && held.state === taken.state ? held : null;
        if (mine !== null) {
            held = null;
        }
        tickets += 1;
        current = {
            ticket: tickets,
            state: taken.state,
            job: { taken, logo: mine?.logo ?? MASCOT, manifest: mine?.manifest ?? null },
            run: null,
        };
        return { taken: true };
    };

    return {
        async start(input) {
            const flow = deps.flow();
            if (flow === null) {
                return { kind: 'unavailable' };
            }
            const { url, state } = await flow.begin({ origin: input.origin, name: input.name });
            held = { state, logo: input.logo, manifest: input.manifest };
            const result = await deps.openSheet(url);
            if (result.type === 'callback') {
                const delivered = await deliver(result.url);
                if (delivered.taken || current?.state === state) {
                    // Taken here, or the link took this flow's callback first and opened SheetSignIn.
                    return { kind: 'callback', taken: delivered.taken };
                }
                return { kind: 'refused', reason: delivered.refused ?? 'no-flow' };
            }
            if (result.type === 'cancelled' && deps.os === 'android') {
                // The link may still bring the callback: the flow and what the screens held stay.
                return { kind: 'cancelled' };
            }
            if (held?.state === state) {
                held = null;
            }
            await flow.cancel(state).catch(() => undefined);
            switch (result.type) {
                case 'cancelled':
                    return { kind: 'cancelled' };
                case 'unavailable':
                    return { kind: 'unavailable' };
                case 'failed':
                    return { kind: 'failed', reason: result.reason, detail: result.detail ?? null };
            }
        },
        async onLink(url) {
            const delivered = await deliver(url);
            if (delivered.taken) {
                deps.show();
            }
            return delivered.taken;
        },
        ready() {
            return current === null || current.run !== null
                ? null
                : { ticket: current.ticket, origin: current.job.taken.origin, name: current.job.taken.name };
        },
        finish(ticket) {
            if (current === null || current.ticket !== ticket) {
                return Promise.resolve(null);
            }
            current.run ??= deps.redeem(current.job);
            return current.run;
        },
    };
}
