import { BridgeExtension, CoreBridge, RichText, useBridgeState, useEditorBridge } from '@10play/tentap-editor';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { EDITOR_HTML } from '../editor/generated/editor-html';
import { EDITOR_LOCKDOWN, editorRequest } from '../editor/lockdown';
import type { EditorSession } from '../editor/session';

// The page editor's WebView: tentap's RichText with our document
// (the editor's bundle, passed as `source` so tentap's boot is injected from outside the
// page's CSP), locked down (src/editor/lockdown.ts), its messages handed to
// the editor's session (src/editor/session.ts). The route's screen
// (page-editor.tsx) requires this file only when it shows the rich editor:
// tentap, react-native-webview and the 850 KB document load with it, never at
// launch (tests/editor/editor-screen.test.ts holds that).
//
// A dead content process (iOS's WebContent, Android's renderer): tentap
// mounts a new WebView (its renderer recovery); the session hears `lost()`
// from the crash and from tentap's ready going false, ignores the old page,
// and `load`s the draft into the new one once it is ready.

type Send = (message: unknown) => void;

export function EditorWebView(props: {
    session: EditorSession;
    /** A web link tapped in the page, opened by the app's rules (`useOpenLink`). */
    onOpenLink: (url: string) => void;
    testID?: string;
}) {
    const { session, onOpenLink } = props;
    const [bridge] = useState(
        () =>
            new BridgeExtension<object, { socioSend: Send }, unknown>({
                forceName: 'socioPage',
                onEditorMessage: (message) => session.receive(message),
                extendEditorInstance: (send) => ({ socioSend: send as Send }),
            }),
    );
    const editor = useEditorBridge({
        bridgeExtensions: [CoreBridge, bridge],
        // tentap's own keyboard handling stays off: the screen's keyboard-controller view lifts it.
        avoidIosKeyboard: false,
    });
    const { isReady } = useBridgeState(editor);

    useEffect(() => {
        const send = (editor as unknown as { socioSend: Send }).socioSend;
        session.connect(send);
        return () => session.connect(null);
    }, [editor, session]);
    useEffect(() => {
        if (isReady) {
            session.ready();
        } else {
            session.lost();
        }
    }, [isReady, session]);

    return (
        <View className="flex-1" testID={props.testID}>
            <RichText
                editor={editor}
                source={{ html: EDITOR_HTML }}
                exclusivelyUseCustomOnMessage={false}
                {...EDITOR_LOCKDOWN}
                style={{ backgroundColor: 'transparent' }}
                onShouldStartLoadWithRequest={(request) => {
                    const decision = editorRequest(request);
                    if (decision.kind === 'open') {
                        onOpenLink(decision.url);
                    }
                    return decision.kind === 'allow';
                }}
                onRenderProcessGone={() => session.lost()}
                onContentProcessDidTerminate={() => session.lost()}
            />
        </View>
    );
}
