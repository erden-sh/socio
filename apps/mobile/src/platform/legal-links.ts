import * as WebBrowser from 'expo-web-browser';

import { openLegalLink } from '../net/legal-links';

// socio.sh's legal pages (src/net/legal-links.ts) in expo-web-browser, as a
// workspace's pages open (screens/open-link.ts): SFSafariViewController on
// iOS, a Custom Tab on Android. No workspace, cookie or sign-in line: they
// are public, and open signed out too.

export function openLegalPage(href: string): void {
    openLegalLink(href, (url) => WebBrowser.openBrowserAsync(url));
}
