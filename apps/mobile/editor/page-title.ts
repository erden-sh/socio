// The page's title at the top of the editor's document (CB-417), as Apple
// Notes and Files keep theirs: it scrolls with the text, in the WebView's one
// scroll, and once it has gone under the native bar the bar shows it on one
// line. A plain <textarea> outside ProseMirror, so the document's schema and
// the Markdown it writes stay the web's: the title travels on its own
// messages (src/editor/bridge.ts), never in `socio-change`.
//
// - `socio-title` sets it (after each load, and when a merge changed it); a
//   set is never an edit, so nothing goes back.
// - Each input goes to native as `socio-title-change`, line breaks folded to
//   spaces (a title is one line, wrapped); Return moves to the text instead.
// - `socio-title-shown` says when it scrolls under the bar or back: its
//   bottom against the top inset native gives (`socio-appearance`'s `insets`).
import { PAGE_TITLE_MAX } from '@socio/shared/pages/page-draft';

import { type ToNativeMessage, TITLE_LABEL, TITLE_PLACEHOLDER } from '../src/editor/bridge';

type Post = (message: ToNativeMessage) => void;

/** The scroll container that holds the title and the editor (the document's one scroll). */
export const SCROLL_CLASS = 'socio-scroll';
export const TITLE_CLASS = 'socio-title';

/** The title's attributes on its <textarea>. */
export const TITLE_ATTRIBUTES = {
    'aria-label': TITLE_LABEL,
    placeholder: TITLE_PLACEHOLDER,
    maxLength: PAGE_TITLE_MAX,
    rows: 1,
    enterKeyHint: 'next',
    autoCapitalize: 'sentences',
    spellCheck: true,
} as const;

/** A title is one line: pasted or typed line breaks become one space. */
export const oneLine = (text: string) => text.replace(/\s*[\r\n]+\s*/g, ' ');

export class PageTitle {
    private field: HTMLTextAreaElement | null = null;
    private scroller: HTMLElement | null = null;
    private shown = true;
    private insetTop = 0;
    private title = '';
    private readonly cleanup: (() => void)[] = [];

    constructor(
        private readonly post: Post,
        /** Return in the title: on to the text. */
        private readonly onEnter: () => void,
    ) {}

    /** The <textarea> as it mounts (a React ref), null as it unmounts. */
    readonly attach = (field: HTMLTextAreaElement | null) => {
        this.cleanup.splice(0).forEach((stop) => stop());
        this.field = field;
        this.scroller = field?.closest<HTMLElement>(`.${SCROLL_CLASS}`) ?? null;
        if (field === null) {
            return;
        }
        field.value = this.title;
        const onInput = () => {
            const value = oneLine(field.value);
            if (value !== field.value) {
                const at = field.selectionStart;
                field.value = value;
                field.setSelectionRange(Math.min(at, value.length), Math.min(at, value.length));
            }
            this.fit();
            if (value !== this.title) {
                this.title = value;
                this.post({ type: 'socio-title-change', payload: { title: value } });
            }
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Enter' && !event.isComposing) {
                event.preventDefault();
                this.onEnter();
            }
        };
        const onScroll = () => this.check();
        const onResize = () => {
            this.fit();
            this.check();
        };
        field.addEventListener('input', onInput);
        field.addEventListener('keydown', onKeyDown);
        this.scroller?.addEventListener('scroll', onScroll, { passive: true });
        const view = field.ownerDocument.defaultView;
        view?.addEventListener('resize', onResize);
        this.cleanup.push(
            () => field.removeEventListener('input', onInput),
            () => field.removeEventListener('keydown', onKeyDown),
            () => this.scroller?.removeEventListener('scroll', onScroll),
            () => view?.removeEventListener('resize', onResize),
        );
        this.fit();
    };

    /** The title from native: shown as it is, never sent back. */
    set(title: string) {
        this.title = title;
        const field = this.field;
        if (field === null || field.value === title) {
            return;
        }
        const focused = field.ownerDocument.activeElement === field;
        const at = field.selectionStart;
        field.value = title;
        if (focused) {
            field.setSelectionRange(Math.min(at, title.length), Math.min(at, title.length));
        }
        this.fit();
        this.check();
    }

    /** The bar's room over the document: the title counts as gone once it is under it. */
    setInsetTop(top: number) {
        this.insetTop = top;
        // The type size may have changed with it.
        this.fit();
        this.check();
    }

    /** Grows the field to its text: it wraps, and the document scrolls, never the field. */
    private fit() {
        const field = this.field;
        if (field === null) {
            return;
        }
        field.style.height = 'auto';
        field.style.height = `${field.scrollHeight}px`;
    }

    /** Posts whether the title shows below the bar, when that changes. */
    check() {
        const field = this.field;
        const scroller = this.scroller;
        if (field === null || scroller === null) {
            return;
        }
        const shown = field.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top + this.insetTop;
        if (shown !== this.shown) {
            this.shown = shown;
            this.post({ type: 'socio-title-shown', payload: { shown } });
        }
    }
}
