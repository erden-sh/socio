import type { ClientCompatState } from '../sync/client-compat';

// The Update Socio gate and banner's words (CB-553), under Node. A workspace
// whose server needs a newer app shows the gate in place of its screens; one
// that only recommends a newer app shows a banner the person can dismiss for
// that version. Both say what happens to the phone's copy: nothing. Drafts,
// the outbox and the cache wait and send after the update. The other
// workspaces on the phone keep working.
//
// Where to get the update: iOS testers get builds from TestFlight, whose app
// opens on its own scheme (`itms-beta://`, which shows the app's page and its
// Update button). Android's preview builds come from a download page the app
// doesn't know (and there is no store listing yet), so Android words where to
// look and has no button.

/** Where the update comes from, by platform: a link to open, or none (the words say where to look). */
export const UPDATE_LINKS: Readonly<Record<'ios' | 'android', string | null>> = {
    ios: 'itms-beta://',
    android: null,
};

export const UPDATE_TITLE = 'Update Socio';
export const UPDATE_OPEN_LABEL = 'Open TestFlight';
export const UPDATE_CHECK_LABEL = 'Check again';
export const UPDATE_KEPT = 'Everything on this phone is kept: what you wrote waits and sends once Socio is up to date.';
export const UPDATE_DISMISS_LABEL = 'Not now';

export interface UpdateGateCopy {
    readonly title: string;
    readonly body: string;
    /** Where the update is: the button's link, or null with `where` saying it. */
    readonly link: string | null;
    readonly where: string;
    readonly kept: string;
}

/** What the gate says for `workspace` on `platform`, in a build named `appName` ("Socio Preview"). */
export function updateGateCopy(
    state: Pick<ClientCompatState, 'minimum' | 'version'>,
    workspace: string,
    platform: 'ios' | 'android',
    appName: string,
): UpdateGateCopy {
    const needs = state.minimum === null ? 'a newer version of Socio' : `Socio ${state.minimum} or later`;
    const has = state.version === null ? '' : ` This phone has ${state.version}.`;
    const link = UPDATE_LINKS[platform];
    return {
        title: UPDATE_TITLE,
        body: `${workspace} needs ${needs}.${has}`,
        link,
        where:
            link === null
                ? `Install the latest ${appName} from the download page you got it from, then open it again.`
                : `Update ${appName} in TestFlight, then open it again.`,
        kept: UPDATE_KEPT,
    };
}

/** The banner's line while this version is between the server's minimum and the version it recommends. */
export function updateBannerCopy(recommended: string): string {
    return `Socio ${recommended} is ready. Update when you can.`;
}
