import Constants from 'expo-constants';

import { rootState } from '../navigation/root-gate';
import { createWorkspaceLinkHold } from '../navigation/workspace-link';
import { deviceLinkConfig } from '../net/add-device';
import { readWorkspaceLink, type WorkspaceLink } from '../net/first-screen';

import { BUILD_VARIANT } from './variant';

// Get the app links, bound: this build's link host and variant from its embedded config,
// the gate, and how the first screen opens (root-navigation.ts hands links.ts's `openRoute` over).

const LINKS = deviceLinkConfig(Constants.expoConfig?.extra, BUILD_VARIANT);

let openScreen: () => void = () => undefined;

/** root-navigation.ts hands over how Add workspace's first screen opens. */
export function setWorkspaceScreenOpener(open: () => void): void {
    openScreen = open;
}

export const workspaceLinks = createWorkspaceLinkHold<WorkspaceLink>({
    read: (url) => (LINKS === null ? null : readWorkspaceLink(url, LINKS)),
    open: () => openScreen(),
    overGate: () => {
        if (rootState.get().active !== null) {
            rootState.setAdding(true);
        }
    },
});
