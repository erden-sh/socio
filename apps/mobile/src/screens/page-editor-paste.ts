import { useEffect, useSyncExternalStore } from 'react';

import {
    addPastedImage,
    PASTE_ADDING,
    PASTE_FAILED,
    PASTE_NEEDS_CONNECTION,
    PASTE_NOTHING,
    type PastedImage,
} from '../editor/paste-image';
import type { EditorSession } from '../editor/session';
import { useSyncStatus, useWorkspaceScope } from '../live';
import type { AuthedFetch } from '../net/authed-fetch';
import { appState } from '../platform/app-state';
import {
    clipboardHasImage,
    measureImage,
    onClipboardChange,
    readClipboardImage,
    writePastedImage,
} from '../platform/pasted-image';
import { clearPickerCache } from '../platform/pickers';
import type { FileUploads } from '../sync/upload-file';

// Pasting a picture into a page's editor (CB-358): the WebView's own
// paste (the session's `onPasteImage`) and the toolbar's Paste image both end
// in `addPastedImage` (the upload to Files, then the Space's image) and the
// block at the cursor. One paste at a time, online only; the banner says
// "Adding the image…", then why not, or "Saved to your Files" the first time.
// Paste image is on while the clipboard holds an image: asked as the editor
// shows, on each return to the app and on each clipboard change, never on a
// timer; the clipboard itself is read only on the tap.

/** What a paste needs of the open editor, the page and the scope. */
interface PasteTarget {
    readonly session: EditorSession;
    readonly spaceId: string;
    readonly online: boolean;
    readonly uploads: FileUploads;
    readonly fetch: AuthedFetch;
}

export interface PagePaste {
    /** For the session's `onPasteImage`: a picture the WebView's paste handed over. */
    readonly fromWebView: (image: PastedImage) => void;
    /** Paste image's tap. */
    readonly fromClipboard: () => void;
    /** The editor and page it pastes into, as they change; null as the editor goes. */
    connect(target: PasteTarget | null): void;
    /** What the clipboard holds, from `hasImageAsync`. */
    setClipboardImage(has: boolean): void;
    /** Paste image is on: the clipboard holds an image and no paste is going. */
    canPaste(): boolean;
    subscribe(listener: () => void): () => void;
}

/** One editor's paste, made once with the screen (before its session, which takes `fromWebView`). */
export function createPagePaste(): PagePaste {
    let target: PasteTarget | null = null;
    let going = false;
    let hasImage = false;
    const listeners = new Set<() => void>();
    const emit = () => listeners.forEach((listener) => listener());

    const paste = async (take: () => Promise<PastedImage | null>) => {
        const at = target;
        if (at === null || going) {
            return;
        }
        const { session } = at;
        if (!at.online) {
            session.showNotice(PASTE_NEEDS_CONNECTION);
            return;
        }
        going = true;
        emit();
        try {
            const pasted = await take();
            if (pasted === null) {
                session.showNotice(PASTE_NOTHING);
                return;
            }
            session.showNotice(PASTE_ADDING);
            const result = await addPastedImage(
                {
                    spaceId: at.spaceId,
                    connected: () => target?.online ?? false,
                    uploads: at.uploads,
                    fetch: at.fetch,
                    writeTemporary: writePastedImage,
                    measure: measureImage,
                    onError: (error) => console.warn('[editor] the pasted image', error),
                },
                pasted,
            );
            if (result.kind === 'refused') {
                session.showNotice(result.text);
            } else if (!session.insertImage(result.image, pasted.dataUri)) {
                session.showNotice(PASTE_FAILED);
            } else {
                const note = at.uploads.takeSavedNote();
                if (note === null) {
                    session.dismissNotice();
                } else {
                    session.showNotice(note);
                }
            }
        } catch (error) {
            console.warn('[editor] the image was not pasted', error);
            session.showNotice(PASTE_FAILED);
        } finally {
            going = false;
            emit();
            // expo-image-manipulator's renderings (the profile's, the measure's).
            clearPickerCache();
        }
    };

    return {
        fromWebView: (image) => void paste(async () => image),
        fromClipboard: () => void paste(readClipboardImage),
        connect(next) {
            target = next;
        },
        setClipboardImage(has) {
            if (has !== hasImage) {
                hasImage = has;
                emit();
            }
        },
        canPaste: () => hasImage && !going,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

/** Binds a page's paste to the open editor and the clipboard; whether Paste image is on. */
export function usePagePaste(paste: PagePaste, spaceId: string | null, session: EditorSession): boolean {
    const scope = useWorkspaceScope();
    const { reconnecting } = useSyncStatus();
    const { uploads, fetch } = scope;

    useEffect(() => {
        paste.connect(spaceId === null ? null : { session, spaceId, online: !reconnecting, uploads, fetch });
        return () => paste.connect(null);
    }, [paste, session, spaceId, reconnecting, uploads, fetch]);

    useEffect(() => {
        if (spaceId === null) {
            return;
        }
        let live = true;
        const check = () => {
            clipboardHasImage()
                .then((has) => {
                    if (live) {
                        paste.setClipboardImage(has);
                    }
                })
                .catch((error: unknown) => console.warn('[editor] the clipboard was not checked', error));
        };
        check();
        const stopClipboard = onClipboardChange(check);
        const stopAppState = appState.subscribe((next) => {
            if (next === 'active') {
                check();
            }
        });
        return () => {
            live = false;
            stopClipboard();
            stopAppState();
        };
    }, [paste, spaceId]);

    return useSyncExternalStore(paste.subscribe, paste.canPaste);
}
