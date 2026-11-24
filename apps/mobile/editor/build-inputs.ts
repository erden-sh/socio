// What scripts/build-editor.mts reads besides the bundle, loaded through
// Vite (tentap's source and the web's are TypeScript): the page's stylesheet,
// the stylesheet tentap's native side injects, and the editor's schema. The
// script sets jsdom's globals first.
import { Editor, getSchema } from '@tiptap/core';

import { bridgeExtensions } from './bridges';
import { editorExtensions } from './extensions';
import { PAGE_CSS } from './styles';

// tentap's native side adds this <style> on every load, whatever `dynamicHeight`
// says; its hash goes in the CSP, so a tentap bump that changes it changes the page.
export { DYNAMIC_HEIGHT_CSS } from '@10play/tentap-editor/src/shared/dynamicHeightStyle.ts';

/** The page's one stylesheet: TipTap's own (what `injectCSS` would add), then ours. */
export function pageCss() {
    const editor = new Editor({ extensions: editorExtensions() });
    const tiptap = document.querySelector('style[data-tiptap-style]')?.textContent ?? '';
    editor.destroy();
    if (!tiptap) {
        throw new Error('TipTap added no stylesheet.');
    }
    return `${tiptap}\n${PAGE_CSS}`;
}

/** The node and mark names of the bundle's schema: the editor's extensions and the bridges'. */
export function schemaNames() {
    const schema = getSchema([...bridgeExtensions(), ...editorExtensions()]);
    return { nodes: Object.keys(schema.nodes).sort(), marks: Object.keys(schema.marks).sort() };
}
