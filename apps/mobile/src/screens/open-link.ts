import { useNavigation } from '@react-navigation/native';
import * as WebBrowser from 'expo-web-browser';
import { Alert, Linking, Platform } from 'react-native';

import {
    appPathOf,
    CANCEL,
    linkTarget,
    OPEN,
    OPENS_IN_BROWSER,
    WEB_SIGN_IN_TOLD_KEY,
    webSignInLine,
} from '../chat/markdown-links';
import { useLiveQuery, useViewState, useWorkspaceScope, useCollections } from '../live';
import { openInApp } from '../navigation/in-app';
import { issueAction } from '../navigation/tabs';
import { workspaceName } from '../shell/account';
import { issueOfParam } from '../shell/last-screen';
import { shellQuery, shellRows } from '../shell/queries';

// Opens a link from a socio's reply by markdown-links.ts's rules: a page of
// the workspace in expo-web-browser (on iOS the app's
// own browser view), after the sign-in line the first time on this
// workspace; another site or a mailto through the system; anything else not
// at all. The chat's cards open the web through it too. An issue's link (a
// chip) opens its screen, and an issue's attachment the viewer, unless `web`
// asks for the browser (a file the app doesn't show). CB-413: a link in a
// message (`app`) to a page the app has a screen for (a Space, a page, a chat
// or room, a schedule, an approval…) opens that screen, as the web's AppLink
// does; buttons that say "Open in your browser" leave `app` off.

/** An issue's attachment named by a link alone: the viewer says this over it. */
const ATTACHMENT_NAME = 'Attachment';

export interface OpenHow {
    /** The browser, even for an issue or a picture the app shows. */
    readonly web?: boolean;
    /** A link in text (Markdown): a page of the workspace opens its screen in the app when it has one. */
    readonly app?: boolean;
}

export function useOpenLink(): (href: string, how?: OpenHow) => void {
    const { workspace } = useWorkspaceScope();
    const navigation = useNavigation();
    const viewState = useViewState();
    const collections = useCollections();
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const name = workspaceName(shellRows(shell).state, workspace);
    return (href: string, how: OpenHow = {}) => {
        const target = linkTarget(href, workspace.origin);
        if (target === null) {
            return;
        }
        const issue = target.kind === 'issue' && how.web !== true ? issueOfParam(target.key) : null;
        if (issue !== null) {
            navigation.dispatch(issueAction(issue));
            return;
        }
        if (target.kind === 'issue-attachment' && how.web !== true) {
            navigation.navigate('AttachmentViewer', {
                images: [{ id: target.id, name: ATTACHMENT_NAME, local: null, kind: 'issue' }],
                index: 0,
            });
            return;
        }
        const path = how.app === true && how.web !== true ? appPathOf(target) : null;
        if (path !== null && openInApp(path)) {
            return;
        }
        if (target.kind === 'external') {
            Linking.openURL(target.url).catch((error: unknown) => console.warn('[chat] link not opened', error));
            return;
        }
        const open = () => {
            viewState.set(WEB_SIGN_IN_TOLD_KEY, '1');
            WebBrowser.openBrowserAsync(target.url).catch((error: unknown) =>
                console.warn('[chat] browser not opened', error),
            );
        };
        if (viewState.get(WEB_SIGN_IN_TOLD_KEY) !== null) {
            open();
            return;
        }
        Alert.alert(OPENS_IN_BROWSER, webSignInLine(name, Platform.OS === 'ios'), [
            { text: CANCEL, style: 'cancel' },
            { text: OPEN, onPress: open },
        ]);
    };
}
