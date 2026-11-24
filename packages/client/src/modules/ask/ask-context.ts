import type { Params } from 'react-router';

import type { AskContextRef } from '@socio/shared/ask';
import type { Dot } from '@socio/shared/types';

import type { UiHints } from '../../shell/ui-hints';

/** The screen's item, from the deepest route's params; none: `general`. */
export function askContextOf(params: Params): AskContextRef & {
    /** A page's Space: only socios with access to it may answer. */
    spaceId?: string;
} {
    if (params.spaceId && params.pageId) {
        return { kind: 'page', id: params.pageId, spaceId: params.spaceId };
    }
    if (params.issueKey) {
        return { kind: 'issue', id: params.issueKey };
    }
    if (params.datasetId) {
        return { kind: 'dataset', id: params.datasetId };
    }
    if (params.scheduleId) {
        return { kind: 'schedule', id: params.scheduleId };
    }
    return { kind: 'general', id: '' };
}

/**
 * The socios the panel offers: the person's own and the company's in use
 * (the workspace lists no one else's personal socios), and for a page,
 * those with access to its Space. The server checks the same again.
 */
export const askableSocios = (dots: readonly Dot[], spaceId?: string) =>
    dots.filter((dot) => !dot.archivedAt && (!spaceId || dot.spaceIds.includes(spaceId)));

/**
 * Opens the panel from anywhere in this tab (the palette's command): once
 * the dialog it was run from has closed and given focus back (at most a
 * second), so the panel keeps the focus it takes.
 */
export const OPEN_ASK = 'socio:open-ask';
export function openAsk() {
    const start = performance.now();
    const open = () => {
        if (
            document.querySelector('[role="dialog"]:not([data-slot="sheet-content"])') &&
            performance.now() - start < 1000
        ) {
            requestAnimationFrame(open);
        } else {
            window.dispatchEvent(new CustomEvent(OPEN_ASK));
        }
    };
    requestAnimationFrame(open);
}

/**
 * Whether a key press toggles the panel: ⌘J / Ctrl+J, which no browser
 * field or the page editor uses; not while an IME is composing.
 */
export function isAskShortcut(event: KeyboardEvent) {
    return (
        !event.defaultPrevented &&
        !event.isComposing &&
        event.key.toLowerCase() === 'j' &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey
    );
}

/** The panel's shortcut as shown: "⌘J" on Apple platforms, else "Ctrl J". */
export const askShortcut = ({ mac }: UiHints) => (mac ? '⌘J' : 'Ctrl J');
