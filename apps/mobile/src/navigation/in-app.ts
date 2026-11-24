// Opening an app path from inside the app (CB-413): a link in a message that
// names one of the app's screens (`/spaces/s1/pages/p1`, `/chats/abc`) opens
// it, as the web's AppLink opens its own routes. root-navigation.tsx sets the
// opener (links.ts's `openNow` over the root stack's path config); screens
// reach it here without importing the navigation's root, which would be an
// import cycle (root-stack → screens → open-link). No React Native here.

type Opener = (path: string) => boolean;

let opener: Opener | null = null;

/** Set by the navigation's root once its container exists. */
export function setInAppOpener(next: Opener | null) {
    opener = next;
}

/** Opens `path` on its screen now; false when no screen of the app's opens it now. */
export function openInApp(path: string): boolean {
    return opener?.(path) ?? false;
}
