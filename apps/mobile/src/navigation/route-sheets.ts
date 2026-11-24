// The pickers' sheets (CB-421): a screen's in-place picker
// (the Board's Filters, an issue's fields, Move, the batch bar's choices, a
// Space to save in, a memory's form, a diff) is shown in a real native sheet,
// the `Sheet` or `TallSheet` route (presets.ts `sheet()`: the system's grabber,
// detents and swipe down), never in a React Native `Modal`. The screen keeps
// its state and draws the sheet's content as before; this store hands that
// content to the route, which draws it in its place (screens/route-sheet.tsx).
// A swipe down tells the screen through `onDismiss`, as its Done or Cancel
// would; the screen closing it (Done, a choice) pops the route. No React
// Native here: tests/navigation runs it under Node.

/** The two sheet routes: a short picker opens at the medium detent alone, a long one at medium, then large. */
export const SHEET_ROUTES = { short: 'Sheet', tall: 'TallSheet' } as const;

export type SheetRoute = (typeof SHEET_ROUTES)[keyof typeof SHEET_ROUTES];

/** The route a sheet opens in: `tall` for a list that can be long (facets, Spaces, people, a diff). */
export const sheetRoute = (tall: boolean): SheetRoute => (tall ? SHEET_ROUTES.tall : SHEET_ROUTES.short);

interface Entry<T> {
    content: T;
    readonly onDismiss: () => void;
}

export interface RouteSheets<T> {
    /** Shows `content` under `id` (a new id each time a sheet opens). */
    present(id: string, content: T, onDismiss: () => void): void;
    /** The screen drew it again: the route draws the new content. */
    update(id: string, content: T): void;
    /** The screen closed it (Done, a choice): the route pops itself, and `onDismiss` isn't called. */
    close(id: string): void;
    /** The route went (a swipe down, Back): the screen hears it once, unless it closed it first. */
    dismissed(id: string): void;
    /** What the route draws: its content while open, null once closed or unknown. */
    get(id: string): T | null;
    subscribe(listener: () => void): () => void;
}

export function createRouteSheets<T>(): RouteSheets<T> {
    const entries = new Map<string, Entry<T>>();
    const listeners = new Set<() => void>();
    const tell = () => {
        for (const listener of listeners) {
            listener();
        }
    };
    return {
        present(id, content, onDismiss) {
            entries.set(id, { content, onDismiss });
            tell();
        },
        update(id, content) {
            const entry = entries.get(id);
            if (entry === undefined || entry.content === content) {
                return;
            }
            entry.content = content;
            tell();
        },
        close(id) {
            if (entries.delete(id)) {
                tell();
            }
        },
        dismissed(id) {
            const entry = entries.get(id);
            if (entry === undefined) {
                return;
            }
            entries.delete(id);
            tell();
            entry.onDismiss();
        },
        get(id) {
            return entries.get(id)?.content ?? null;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

let next = 0;
/** A fresh id for each sheet shown. */
export const newSheetId = () => {
    next += 1;
    return `sheet-${next}`;
};
