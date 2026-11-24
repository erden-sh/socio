// The page editor's WebView bundle: tentap's advanced setup with
// the web's document (extensions.ts). scripts/build-editor.mts builds it into
// one HTML document under a strict CSP; the native side passes that document
// as RichText's `source`, so tentap injects its boot config from outside the
// page and every script in it is under the policy.
//
// The bridge to native is page-bridge.ts, its messages src/editor/bridge.ts.
import './jitless';
import { boot } from '@10play/tentap-editor/src/web/runtime.ts';
import { useTenTap } from '@10play/tentap-editor/src/web/useTenTap.tsx';
import type { Editor } from '@tiptap/core';
import { EditorContent } from '@tiptap/react';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { BRIDGES } from './bridges';
import { pageEditorOptions } from './extensions';
import { attachPageSession, type PageSession } from './page-bridge';
import { PageImages } from './page-images';
import { PageTitle, SCROLL_CLASS, TITLE_ATTRIBUTES, TITLE_CLASS } from './page-title';

const images = new PageImages();
let session: PageSession | null = null;
let created: Editor | null = null;
// The title scrolls with the text, in the document's one scroll (CB-417). Return moves on to the text.
const title = new PageTitle(
    (message) => runtime.post(message),
    () => created?.commands.focus('start'),
);

function PageEditor() {
    const editor = useTenTap({
        bridges: BRIDGES,
        tiptapOptions: pageEditorOptions({
            images,
            onNotice: (notice) => session?.notice(notice),
            onPasteImage: (file) => session?.pasteImage(file),
            onCreate: (made) => {
                created = made;
                session = attachPageSession(made, runtime.post, images, { title });
            },
        }),
    });
    return createElement(
        'div',
        { className: SCROLL_CLASS },
        createElement('textarea', { ...TITLE_ATTRIBUTES, className: TITLE_CLASS, ref: title.attach }),
        createElement(EditorContent, { editor, className: 'tentap-root' }),
    );
}

// As tentap's own page does: the boot config may arrive after the bundle runs
// (injected before content loads, or again on load), so mount once it has.
const runtime = boot();
runtime.whenConfigured(() => {
    try {
        createRoot(document.getElementById('root')!).render(createElement(PageEditor));
    } catch (error) {
        runtime.reportBootError(error);
        throw error;
    }
});
