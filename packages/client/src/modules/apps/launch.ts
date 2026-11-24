import { api } from '../../lib/api';

/** A one-time sign-in link for the app's own origin (valid for a minute). */
export const launchUrl = (id: string, next = '/') =>
    api<{ url: string }>(`/apps/${encodeURIComponent(id)}/launch`, 'POST', {
        next,
    }).then((result) => result.url);

/**
 * Opens an app in a new tab: the tab opens at once (so it isn't blocked),
 * loses its opener, then goes to the launch link; or this tab goes there.
 */
export async function openApp(id: string) {
    const tab = window.open('about:blank', '_blank');
    if (tab) {
        tab.opener = null;
    }
    try {
        const url = await launchUrl(id);
        if (tab) {
            tab.location.href = url;
        } else {
            window.location.assign(url);
        }
    } catch (error) {
        tab?.close();
        throw error;
    }
}
