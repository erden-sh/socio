import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EDITOR_DOCUMENT_URL, EDITOR_LOCKDOWN, editorRequest } from '../../src/editor/lockdown';
import { parseImports } from '../../vendor/t3code/dependency-graph';

// The page editor's screen: its WebView's lockdown and the lazy load: tentap,
// react-native-webview and the editor's 850 KB document load only with
// screens/page-editor-webview.tsx, which only the route's screen requires,
// inside a function, when the rich editor shows.

const src = join(import.meta.dirname, '../../src');
const WEBVIEW_FILE = 'screens/page-editor-webview.tsx';
/** The round trip's WebView, development and preview builds only, loaded the same lazy way. */
const CORPUS_FILE = 'screens/editor-corpus-run.tsx';
const HEAVY = [/^@10play\/tentap-editor($|\/)/, /^react-native-webview($|\/)/, /generated\/editor-html$/];

const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => file.split(sep).join('/'));

describe("the page editor's WebView", () => {
    it('is locked down: only our document, nothing kept, no cookies, files or windows', () => {
        expect(EDITOR_LOCKDOWN).toMatchObject({
            originWhitelist: ['about:blank'],
            incognito: true,
            domStorageEnabled: false,
            cacheEnabled: false,
            cacheMode: 'LOAD_NO_CACHE',
            thirdPartyCookiesEnabled: false,
            sharedCookiesEnabled: false,
            allowFileAccess: false,
            allowFileAccessFromFileURLs: false,
            allowUniversalAccessFromFileURLs: false,
            javaScriptCanOpenWindowsAutomatically: false,
            setSupportMultipleWindows: false,
            mixedContentMode: 'never',
            geolocationEnabled: false,
        });
    });

    it("keeps Android's text zoom at 100 %: the font scale comes once, through socio-appearance", () => {
        expect(EDITOR_LOCKDOWN.textZoom).toBe(100);
    });

    it('loads only our document; a tapped web link goes to the app, everything else is refused', () => {
        expect(editorRequest({ url: EDITOR_DOCUMENT_URL, isTopFrame: true })).toEqual({ kind: 'allow' });
        expect(editorRequest({ url: 'https://example.com/a', isTopFrame: true })).toEqual({
            kind: 'open',
            url: 'https://example.com/a',
        });
        expect(editorRequest({ url: 'https://example.com/frame', isTopFrame: false })).toEqual({ kind: 'refuse' });
        for (const url of [
            'file:///etc/hosts',
            'javascript:alert(1)',
            'data:text/html,x',
            'intent://x',
            'about:srcdoc',
        ]) {
            expect(editorRequest({ url, isTopFrame: true })).toEqual({ kind: 'refuse' });
        }
    });

    it('passes every lockdown prop and the request rule to RichText, our document as its source', () => {
        const text = readFileSync(join(src, WEBVIEW_FILE), 'utf8');
        expect(text).toContain('{...EDITOR_LOCKDOWN}');
        expect(text).toContain('source={{ html: EDITOR_HTML }}');
        expect(text).not.toContain('customSource');
        expect(text).toMatch(
            /onShouldStartLoadWithRequest=\{\(request\) => \{\s+const decision = editorRequest\(request\)/,
        );
        expect(text).toContain('onRenderProcessGone={() => session.lost()}');
        expect(text).toContain('onContentProcessDidTerminate={() => session.lost()}');
    });
});

describe("the page editor's lazy load", () => {
    it('imports tentap, the WebView and the document only in the WebView file', () => {
        const importers = files.filter((file) =>
            parseImports(readFileSync(join(src, file), 'utf8'), join(src, file)).some(({ specifier }) =>
                HEAVY.some((pattern) => pattern.test(specifier)),
            ),
        );
        expect(importers.sort()).toEqual([CORPUS_FILE, WEBVIEW_FILE]);
    });

    it('reaches the round trip’s WebView only through a require inside a function of its route’s screen', () => {
        const importers = files.filter((file) =>
            parseImports(readFileSync(join(src, file), 'utf8'), join(src, file)).some(({ specifier }) =>
                specifier.endsWith('editor-corpus-run'),
            ),
        );
        expect(importers).toEqual(['screens/editor-corpus.tsx']);
        const screen = readFileSync(join(src, 'screens/editor-corpus.tsx'), 'utf8');
        expect(screen.match(/^import .*editor-corpus-run.*$/gm)).toEqual([
            "import type { EditorCorpusRun as EditorCorpusRunType } from './editor-corpus-run';",
        ]);
        expect(screen).toMatch(/function editorCorpusRun\(\)[^{]*\{[^}]*require\('\.\/editor-corpus-run'\)/);
    });

    it('reaches the WebView file only through a require inside a function of the route’s screen', () => {
        const importers = files.filter((file) =>
            parseImports(readFileSync(join(src, file), 'utf8'), join(src, file)).some(({ specifier }) =>
                specifier.endsWith('page-editor-webview'),
            ),
        );
        expect(importers).toEqual(['screens/page-editor.tsx']);
        const screen = readFileSync(join(src, 'screens/page-editor.tsx'), 'utf8');
        // A type-only import loads nothing; the value comes from the require in `editorWebView()`.
        expect(screen.match(/^import .*page-editor-webview.*$/gm)).toEqual([
            "import type { EditorWebView as EditorWebViewType } from './page-editor-webview';",
        ]);
        expect(screen).toMatch(/function editorWebView\(\)[^{]*\{[^}]*require\('\.\/page-editor-webview'\)/);
    });
});

// A save goes out from the open editor, so its merge mostly lands while the
// editor is on top: the editor shows the merge toast with "See what
// changed", and the reader underneath shows its toasts only while focused, so
// a hidden toast neither plays out unseen nor is said twice.
describe("the page editor's merge toast", () => {
    it('renders PageToasts for its page over the editor, inside the keyboard view, above the toolbar', () => {
        const text = readFileSync(join(src, 'screens/page-editor.tsx'), 'utf8');
        expect(text).toContain("import { PageToasts } from './page-conflict';");
        expect(text).toMatch(
            // A page's editor only: a review's draft has no page to merge.
            /\{pageId === null \? null : <PageToasts pageId=\{pageId\} notice=\{null\} onHide=\{noToast\} \/>\}\s+<\/KeyboardAvoidingView>/,
        );
    });

    it("renders the reader's toasts only while the reader is focused", () => {
        const text = readFileSync(join(src, 'screens/page.tsx'), 'utf8');
        expect(text).toContain('const focused = useIsFocused();');
        expect(text).toContain('{focused ? <PageToasts pageId={pageId} notice={notice} onHide={hideNotice} /> : null}');
        expect(text.match(/<PageToasts /g)).toHaveLength(1);
    });
});

// CB-417 (the owner's report, 2026-11-18): the editor as Apple Notes has it.
// The system's bar holds the save line and, once scrolled, the title; the
// title is the document's own; the toolbar is the keyboard's accessory bar,
// shown only with the keyboard; the body fills the rest.
describe("the page editor's native layout", () => {
    const screen = readFileSync(join(src, 'screens/page-editor.tsx'), 'utf8');
    const toolbar = readFileSync(join(src, 'screens/page-editor-toolbar.tsx'), 'utf8');

    it('fills the system’s bar instead of drawing the app’s header or a save line of its own', () => {
        expect(screen).not.toContain('HeaderBar');
        expect(screen).toMatch(
            /navigation\.setOptions\(\{\s+title: screenTitle,\s+headerTitle: \(\) => \(\s+<EditorBarTitle /,
        );
        expect(screen).toContain('headerRight: () => (');
        // The save line is the bar's status now; no line of its own above the page.
        expect(screen.match(/testID="page-editor-saved"/g)).toBeNull();
        const bar = readFileSync(join(src, 'screens/page-editor-bar.tsx'), 'utf8');
        expect(bar).toContain('testID="page-editor-saved"');
        expect(bar).toContain('testID="page-editor-save-line"');
    });

    it('keeps the title in the document in the rich editor, and a native field only in source mode', () => {
        expect(screen).toMatch(
            /\{source \? \(\s+<View className="flex-1 gap-3 p-4" style=\{\{ paddingTop: barInset \+ 16 \}\}>\s+<TextInput\s+value=\{view\.text\.title\}/,
        );
        // The document pads by the bar it scrolls under.
        expect(screen).toContain('editorAppearance(scheme, fontScale, { top: barInset, bottom: bottomInset })');
    });

    it('shows the toolbar only with the keyboard, flush on it, full width, with no glass capsule', () => {
        expect(screen).toContain('{source || !keyboardUp ? null : (');
        expect(toolbar).toContain('<KeyboardStickyView offset={{ closed: 0, opened: 0 }}>');
        expect(toolbar).not.toContain('GlassSurface');
        expect(toolbar).toContain('border-t border-border bg-muted');
    });
});
