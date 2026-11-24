import BridgeExtension from '@10play/tentap-editor/src/bridges/base.ts';
import { CoreBridge } from '@10play/tentap-editor/src/bridges/core.ts';
// The tentap bridges the bundle runs (tentap's advanced setup). Always from
// tentap's source (`@10play/tentap-editor/src/…`), never
// `@10play/tentap-editor/web`: that prebuilt file carries a TipTap and a
// ProseMirror of its own, a second copy beside the web's.
import type { AnyExtension } from '@tiptap/core';

import { receiveForEditor } from './page-bridge';

/**
 * tentap's core bridge (focus, content, undo through the native side)
 * without its Document, Paragraph and Text: StarterKit has them, and two
 * would warn and break the schema. The native side keeps the stock CoreBridge.
 * No bridge here sets `extendCSS`: each one's <style> would need its hash in
 * the page's CSP (scripts/build-editor.mts).
 */
export const Core = new BridgeExtension({
    ...CoreBridge,
    forceName: CoreBridge.name,
    tiptapExtension: undefined,
    tiptapExtensionDeps: undefined,
});

/**
 * The page bridge (src/editor/bridge.ts): native's `socio-` messages
 * reach the editor's session. No TipTap extension, so tentap always runs it.
 */
export const Page = new BridgeExtension({
    forceName: 'socioPage',
    onBridgeMessage: (editor, message) => receiveForEditor(editor, message),
});

export const BRIDGES: BridgeExtension[] = [Core, Page];

/** The TipTap extensions the bridges add to the editor: none, so the schema is the web's. */
export const bridgeExtensions = (): AnyExtension[] =>
    BRIDGES.flatMap((bridge) => [bridge.tiptapExtension, ...(bridge.tiptapExtensionDeps ?? [])]).filter(
        (extension): extension is AnyExtension => extension !== undefined,
    );
