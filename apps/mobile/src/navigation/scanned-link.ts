// A link the QR scanner read (CB-566) opens as the same link from outside the app would:
// root-navigation.tsx sets the opener to its `openExternalUrl`, so a scanned Add a device, Get the
// app or invite link takes exactly the path a tap on it in another app takes, with no trip to the
// link domain. The scanner reaches it here without importing the navigation's root, which would be
// an import cycle (root-stack → screens → root-navigation), as in-app.ts does for links in messages.
// No React Native here.

type Opener = (url: string) => void;

let opener: Opener | null = null;

/** Set by the navigation's root. */
export function setScannedLinkOpener(next: Opener | null) {
    opener = next;
}

/** Opens a scanned link as one from outside the app; false when the navigation's root isn't up. */
export function openScannedLink(url: string): boolean {
    if (opener === null) {
        return false;
    }
    opener(url);
    return true;
}
