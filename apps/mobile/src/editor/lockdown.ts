// The page editor's WebView, locked down. The editor's document is ours, one
// HTML string loaded at about:blank under a strict CSP, so the WebView needs no
// origin, no storage, no cookies and no network. These props go on tentap's
// RichText (screens/page-editor-webview.tsx); tests/editor/editor-screen.test.ts
// holds them. No React Native here.

/** The one document the WebView may show: ours, loaded as HTML at about:blank. */
export const EDITOR_DOCUMENT_URL = 'about:blank';

/** The WebView props that keep the page from storing, sharing or fetching anything. */
export const EDITOR_LOCKDOWN = {
    originWhitelist: [EDITOR_DOCUMENT_URL] as string[],
    // Nothing kept: a non-persistent data store on iOS, cleared cookies, cache,
    // history and form data on Android; with DOM storage off, the page's
    // localStorage and sessionStorage throw.
    incognito: true,
    domStorageEnabled: false,
    cacheEnabled: false,
    cacheMode: 'LOAD_NO_CACHE',
    thirdPartyCookiesEnabled: false,
    sharedCookiesEnabled: false,
    // No files, no windows, nothing the page could open by itself.
    allowFileAccess: false,
    allowFileAccessFromFileURLs: false,
    allowUniversalAccessFromFileURLs: false,
    javaScriptCanOpenWindowsAutomatically: false,
    setSupportMultipleWindows: false,
    mixedContentMode: 'never',
    geolocationEnabled: false,
    mediaPlaybackRequiresUserAction: true,
    allowsInlineMediaPlayback: false,
    allowsLinkPreview: false,
    allowsBackForwardNavigationGestures: false,
    fraudulentWebsiteWarningEnabled: true,
    saveFormDataDisabled: true,
    textInteractionEnabled: true,
    // Android's WebView scales text by the system font size on its own; the
    // page already takes it from `socio-appearance`'s `fontScale`, so
    // the WebView's own zoom stays at 100 % or the scale applies twice.
    textZoom: 100,
} as const;

/** What the WebView does with a navigation it is asked for. */
export type EditorRequest =
    /** Our document (its first load, and tentap's injected boot). */
    | { readonly kind: 'allow' }
    /** A web link the person tapped: refused here, opened by the app's own rules (`useOpenLink`). */
    | { readonly kind: 'open'; readonly url: string }
    /** Anything else: refused. */
    | { readonly kind: 'refuse' };

/**
 * `onShouldStartLoadWithRequest`'s rule: only our document loads; a web link
 * in the top frame goes out through the app (`useOpenLink`), never inside the
 * editor; every other request (another scheme, a frame, a file) is refused.
 */
export function editorRequest(request: { readonly url: string; readonly isTopFrame?: boolean }): EditorRequest {
    if (request.url === EDITOR_DOCUMENT_URL) {
        return { kind: 'allow' };
    }
    if (request.isTopFrame !== false && /^https?:\/\//i.test(request.url)) {
        return { kind: 'open', url: request.url };
    }
    return { kind: 'refuse' };
}
