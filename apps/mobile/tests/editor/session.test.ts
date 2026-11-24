import { rmSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AUTOSAVE_DEBOUNCE_MS } from '@socio/shared/pages/page-draft';

import type { UserDb } from '../../src/data';
import type { ToNativeMessage, ToWebMessage } from '../../src/editor/bridge';
import { createEditorSession, FLUSH_WAIT_MS, MERGE_CLASHED, PASTE_IMAGE_LATER } from '../../src/editor/session';
import { openDrafts } from '../../src/sync/chat-drafts';
import { openOutbox } from '../../src/sync/outbox';
import { createPageDrafts, type EditorDraft, type EditorText, type PageEditorDraft } from '../../src/sync/page-drafts';
import { createPageSaves, decodeSave, PAGE_SAVE_KIND } from '../../src/sync/page-save';
import { userDb } from '../sync/outbox-fakes';

// The page editor's native session (src/editor/session.ts): the bridge's
// messages to the editor's draft, the merges to the bridge's `replace`, a
// dead WebView's reload from the draft, source mode, and leaving. Every message goes through the bridge's zod checks.

const START: EditorDraft = { spaceId: 's1', revision: 3, title: 'Roadmap', content: 'One\n\nTwo' };
const APPEARANCE = { fontScale: 1, tokens: { foreground: '#000000' } };

/** A draft that records its changes, and lets a test land a merge (the conflict's `landed`). */
function fakeDraft(start: EditorDraft = START) {
    let latest = start;
    const changes: EditorText[] = [];
    const listeners = new Set<(text: EditorText) => void>();
    let flushes = 0;
    let closed = false;
    const draft: PageEditorDraft = {
        read: () => latest,
        error: () => undefined,
        change(text) {
            latest = { ...latest, ...text };
            changes.push(text);
        },
        flush: async () => {
            flushes += 1;
        },
        close: async () => {
            closed = true;
        },
        onReplace(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
    const land = (text: EditorText, revision = latest.revision + 1) => {
        latest = { ...latest, ...text, revision };
        for (const listener of listeners) {
            listener(text);
        }
    };
    return {
        draft,
        changes,
        land,
        flushes: () => flushes,
        closed: () => closed,
        listening: () => listeners.size,
    };
}

function setup(start?: EditorDraft) {
    vi.useFakeTimers();
    const fake = fakeDraft(start);
    const sent: ToWebMessage[] = [];
    const errors: unknown[] = [];
    const session = createEditorSession({
        draft: fake.draft,
        appearance: APPEARANCE,
        onError: (error) => errors.push(error),
    });
    session.connect((message) => sent.push(JSON.parse(JSON.stringify(message)) as ToWebMessage));
    /** The WebView's answer, through JSON as it travels. */
    const web = (message: ToNativeMessage) => session.receive(JSON.parse(JSON.stringify(message)));
    const of = <T extends ToWebMessage['type']>(type: T) =>
        sent.filter((message): message is Extract<ToWebMessage, { type: T }> => message.type === type);
    const loaded = (markdown: string, version = 1, supported = true, reason: string | null = null) =>
        web({ type: 'socio-loaded', payload: { markdown, version, supported, reason } });
    const change = (markdown: string, version: number) => web({ type: 'socio-change', payload: { markdown, version } });
    /** The toolbar's state; `unsent`: an own edit the throttle hasn't sent yet. */
    const state = (unsent = true) =>
        web({
            type: 'socio-state',
            payload: { unsent, canUndo: true, canRedo: false, heading: 0, active: [], link: null },
        });
    return { ...fake, session, sent, of, web, loaded, change, state, errors };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('opening', () => {
    it('sends the appearance and loads the draft once the WebView is ready, and shows it once read back', () => {
        const { session, sent, loaded } = setup();
        expect(sent).toEqual([]);
        session.ready();
        expect(sent).toEqual([
            { type: 'socio-appearance', payload: APPEARANCE },
            { type: 'socio-load', payload: { markdown: START.content } },
        ]);
        expect(session.view().mode).toBe('loading');
        loaded(START.content);
        expect(session.view()).toMatchObject({ mode: 'rich', sourceReason: null, text: { title: 'Roadmap' } });
    });

    it("opens a page the rich editor can't keep as Markdown source, with the web's reason, and checks again on Visual editor", () => {
        const { session, loaded, of } = setup();
        session.ready();
        loaded(START.content, 1, false, 'This document contains extended Markdown. Source mode preserves it exactly.');
        expect(session.view()).toMatchObject({
            mode: 'source',
            sourceReason: 'This document contains extended Markdown. Source mode preserves it exactly.',
            notice: null,
        });
        // Still not one the rich editor keeps: it stays, with the reason.
        session.showRich();
        expect(of('socio-load')).toHaveLength(2);
        loaded(START.content, 1, false, 'This document contains extended Markdown. Source mode preserves it exactly.');
        expect(session.view()).toMatchObject({ mode: 'source', notice: expect.stringMatching(/extended Markdown/) });
        // The person fixed it in source: Visual editor checks the text again, and lets it in.
        session.setSource('# Plain now');
        session.showRich();
        expect(of('socio-load').at(-1)).toEqual({ type: 'socio-load', payload: { markdown: '# Plain now' } });
        loaded('# Plain now');
        expect(session.view()).toMatchObject({ mode: 'rich', sourceReason: null });
    });

    it('ignores what a WebView says before it read the page back (a page that came back empty)', () => {
        const { session, change, changes } = setup();
        session.ready();
        change('', 2);
        expect(changes).toEqual([]);
    });
});

describe('typing', () => {
    it('hands each change to the draft with the title, newest only', () => {
        const { session, loaded, change, changes } = setup();
        session.ready();
        loaded(START.content);
        change('One\n\nTwo three', 2);
        change('One\n\nTwo', 1);
        expect(changes).toEqual([{ title: 'Roadmap', content: 'One\n\nTwo three' }]);
        session.setTitle('Plan');
        expect(changes.at(-1)).toEqual({ title: 'Plan', content: 'One\n\nTwo three' });
        expect(session.view().text).toEqual({ title: 'Plan', content: 'One\n\nTwo three' });
    });

    it('says editing until the draft’s debounce has handed it on', () => {
        const { session, loaded, change } = setup();
        session.ready();
        loaded(START.content);
        change('One\n\nTwo!', 2);
        expect(session.view().editing).toBe(true);
        vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS + 200);
        expect(session.view().editing).toBe(false);
    });

    it('tells of a refused paste and of a pasted picture, until dismissed', () => {
        const { session, loaded, web } = setup();
        session.ready();
        loaded(START.content);
        web({ type: 'socio-notice', payload: { text: 'This paste was refused.' } });
        expect(session.view().notice).toBe('This paste was refused.');
        web({ type: 'socio-paste-image', payload: { mimeType: 'image/png', dataUri: 'data:image/png;base64,AAAA' } });
        expect(session.view().notice).toBe(PASTE_IMAGE_LATER);
        session.dismissNotice();
        expect(session.view().notice).toBeNull();
    });

    it('hands a pasted picture to the screen in the rich editor, and puts the uploaded block in', () => {
        vi.useFakeTimers();
        const fake = fakeDraft();
        const sent: ToWebMessage[] = [];
        const pasted: unknown[] = [];
        const session = createEditorSession({
            draft: fake.draft,
            appearance: APPEARANCE,
            onPasteImage: (image) => pasted.push(image),
        });
        const image = { id: 'cbemb_0123456789abcdef', width: 4, height: 3 };
        // Before the WebView holds the page, nothing goes in.
        expect(session.insertImage(image, 'data:image/png;base64,AAAA')).toBe(false);
        session.connect((message) => sent.push(JSON.parse(JSON.stringify(message)) as ToWebMessage));
        session.ready();
        session.receive({
            type: 'socio-loaded',
            payload: { markdown: START.content, version: 1, supported: true, reason: null },
        });
        const dataUri = 'data:image/png;base64,AAAA';
        session.receive({ type: 'socio-paste-image', payload: { mimeType: 'image/png', dataUri } });
        expect(pasted).toEqual([{ mimeType: 'image/png', dataUri }]);
        expect(session.view().notice).toBeNull();
        session.showNotice('Adding the image…');
        expect(session.view().notice).toBe('Adding the image…');
        sent.length = 0;
        expect(session.insertImage(image, dataUri)).toBe(true);
        expect(sent).toEqual([
            { type: 'socio-images', payload: { [image.id]: dataUri } },
            { type: 'socio-insert-image', payload: image },
        ]);
    });

    it('refuses a bad message from the WebView and passes tentap’s own on', () => {
        const { session, errors } = setup();
        expect(session.receive({ type: 'socio-change', payload: { markdown: 1 } })).toBe(true);
        expect(errors).toHaveLength(1);
        expect(session.receive({ type: 'content-update' })).toBe(false);
    });
});

describe('the toolbar', () => {
    it('sends commands and links only while the rich editor shows the page', () => {
        const { session, loaded, of } = setup();
        expect(session.command('bold')).toBe(false);
        session.ready();
        expect(session.command('bold')).toBe(false);
        loaded(START.content);
        expect(session.command('heading2')).toBe(true);
        expect(session.link('/#/spaces/s1/pages/p1')).toBe(true);
        expect(session.link(null)).toBe(true);
        expect(of('socio-command').map((message) => message.payload.name)).toEqual(['heading2']);
        expect(of('socio-link').map((message) => message.payload.href)).toEqual(['/#/spaces/s1/pages/p1', null]);
    });

    it('sends nothing in source mode', () => {
        const { session, loaded, of } = setup();
        session.ready();
        loaded(START.content, 1, false, 'Extended Markdown.');
        expect(session.view().editable).toBe(false);
        expect(session.command('italic')).toBe(false);
        expect(session.link(null)).toBe(false);
        expect(of('socio-command')).toEqual([]);
    });

    it('sends nothing after a dead WebView until the new one read the page, nor once closed', async () => {
        const { session, loaded, of } = setup();
        session.ready();
        loaded(START.content);
        expect(session.view().editable).toBe(true);
        session.lost();
        // The toolbar is off while a command would be dropped.
        expect(session.view().editable).toBe(false);
        expect(session.command('italic')).toBe(false);
        session.ready();
        expect(session.view().editable).toBe(false);
        expect(session.command('italic')).toBe(false);
        loaded(START.content);
        expect(session.view().editable).toBe(true);
        expect(session.command('italic')).toBe(true);
        await session.close();
        expect(session.view().editable).toBe(false);
        expect(session.command('undo')).toBe(false);
        expect(of('socio-command')).toHaveLength(1);
    });

    it('refuses a link outside the web’s rule before it reaches the WebView', () => {
        const { session, loaded, of, errors } = setup();
        session.ready();
        loaded(START.content);
        session.link('javascript:alert(1)');
        expect(of('socio-link')).toEqual([]);
        expect(errors).toHaveLength(1);
    });
});

describe('merges (the conflict’s landed, the bridge’s replace)', () => {
    it('sends the merge at the version the WebView last told, and leaves the draft alone once applied', () => {
        const { session, loaded, change, land, of, web, changes } = setup();
        session.ready();
        loaded(START.content);
        change('One\n\nTwo mine', 2);
        land({ title: 'Roadmap', content: 'One theirs\n\nTwo mine' });
        expect(of('socio-replace')).toEqual([
            { type: 'socio-replace', payload: { markdown: 'One theirs\n\nTwo mine', ifVersion: 2 } },
        ]);
        web({
            type: 'socio-replaced',
            payload: { ifVersion: 2, applied: true, markdown: 'One theirs\n\nTwo mine', version: 3 },
        });
        expect(changes).toHaveLength(1);
        expect(session.view().text.content).toBe('One theirs\n\nTwo mine');
    });

    it('merges the person’s newer words onto the merge when the WebView moved on, and sends it again', () => {
        const { session, loaded, change, land, of, web, draft, changes } = setup();
        session.ready();
        loaded('A\n\nB\n\nC');
        land({ title: 'Roadmap', content: 'A theirs\n\nB\n\nC' });
        // Typed before the replace arrived: held back from the draft, which holds the merge.
        change('A\n\nB\n\nC mine', 2);
        expect(changes).toEqual([]);
        web({
            type: 'socio-replaced',
            payload: { ifVersion: 1, applied: false, markdown: 'A\n\nB\n\nC mine', version: 2 },
        });
        expect(draft.read().content).toBe('A theirs\n\nB\n\nC mine');
        expect(of('socio-replace').at(-1)).toEqual({
            type: 'socio-replace',
            payload: { markdown: 'A theirs\n\nB\n\nC mine', ifVersion: 2 },
        });
        web({
            type: 'socio-replaced',
            payload: { ifVersion: 2, applied: true, markdown: 'A theirs\n\nB\n\nC mine', version: 3 },
        });
        change('A theirs\n\nB\n\nC mine!', 4);
        expect(draft.read().content).toBe('A theirs\n\nB\n\nC mine!');
    });

    it('keeps the change made elsewhere when the person’s words clash with it, and says so', () => {
        const { session, loaded, land, of, web, draft } = setup();
        session.ready();
        loaded('A\n\nB');
        land({ title: 'Roadmap', content: 'A theirs\n\nB' });
        web({ type: 'socio-replaced', payload: { ifVersion: 1, applied: false, markdown: 'A mine\n\nB', version: 2 } });
        expect(draft.read().content).toBe('A theirs\n\nB');
        expect(of('socio-load').at(-1)).toEqual({ type: 'socio-load', payload: { markdown: 'A theirs\n\nB' } });
        expect(session.view().notice).toBe(MERGE_CLASHED);
    });

    it('sends one replace at a time: a merge landing meanwhile goes once the first is answered', () => {
        const { session, loaded, change, land, of, web, draft } = setup();
        session.ready();
        loaded('A\n\nB\n\nC');
        land({ title: 'Roadmap', content: 'A one\n\nB\n\nC' });
        land({ title: 'Roadmap', content: 'A one\n\nB two\n\nC' });
        expect(of('socio-replace')).toHaveLength(1);
        web({
            type: 'socio-replaced',
            payload: { ifVersion: 1, applied: true, markdown: 'A one\n\nB\n\nC', version: 2 },
        });
        expect(of('socio-replace').at(-1)).toEqual({
            type: 'socio-replace',
            payload: { markdown: 'A one\n\nB two\n\nC', ifVersion: 2 },
        });
        web({
            type: 'socio-replaced',
            payload: { ifVersion: 2, applied: true, markdown: 'A one\n\nB two\n\nC', version: 3 },
        });
        expect(of('socio-replace')).toHaveLength(2);
        // The next keystroke builds on the newer merge: nothing of it is reverted.
        change('A one\n\nB two\n\nC mine', 4);
        expect(draft.read().content).toBe('A one\n\nB two\n\nC mine');
    });

    it('merges the person’s words onto a merge that landed while the first was out', () => {
        const { session, loaded, change, land, of, web, draft } = setup();
        session.ready();
        loaded('A\n\nB\n\nC');
        land({ title: 'Roadmap', content: 'A one\n\nB\n\nC' });
        change('A\n\nB\n\nC mine', 2);
        land({ title: 'Roadmap', content: 'A one\n\nB two\n\nC' });
        web({
            type: 'socio-replaced',
            payload: { ifVersion: 1, applied: false, markdown: 'A\n\nB\n\nC mine', version: 2 },
        });
        expect(draft.read().content).toBe('A one\n\nB two\n\nC mine');
        expect(of('socio-replace').at(-1)?.payload).toEqual({ markdown: 'A one\n\nB two\n\nC mine', ifVersion: 2 });
    });

    it('in source mode, shows the merge in the field and sends nothing', () => {
        const { session, loaded, land, of } = setup();
        session.ready();
        loaded(START.content, 1, false, 'Needs source.');
        land({ title: 'Roadmap 2', content: 'Merged' });
        expect(of('socio-replace')).toEqual([]);
        expect(session.view().text).toEqual({ title: 'Roadmap 2', content: 'Merged' });
    });
});

describe('a dead content process', () => {
    it('ignores the old page and loads the draft into the new one once it is ready', () => {
        const { session, loaded, change, of, web, draft, changes } = setup();
        session.ready();
        loaded(START.content);
        change('One\n\nTwo typed', 2);
        session.lost();
        // The new WebView's queued replay or an old answer: not the person's text.
        web({ type: 'socio-replaced', payload: { ifVersion: 2, applied: false, markdown: '', version: 0 } });
        change('', 1);
        expect(changes).toEqual([{ title: 'Roadmap', content: 'One\n\nTwo typed' }]);
        session.ready();
        expect(of('socio-load').at(-1)).toEqual({ type: 'socio-load', payload: { markdown: 'One\n\nTwo typed' } });
        loaded('One\n\nTwo typed');
        change('One\n\nTwo typed again', 2);
        expect(draft.read().content).toBe('One\n\nTwo typed again');
    });
});

describe('source mode on request', () => {
    it('takes the WebView’s last edit first, edits the source, and goes back once the check passes', async () => {
        const { session, loaded, change, state, of, draft } = setup();
        session.ready();
        loaded(START.content);
        state(); // An edit the throttle hasn't sent.
        session.showSource();
        expect(of('socio-flush')).toHaveLength(1);
        expect(session.view().mode).toBe('rich');
        change('One\n\nTwo last', 2);
        await vi.advanceTimersByTimeAsync(0);
        expect(session.view()).toMatchObject({ mode: 'source', sourceReason: null });
        session.setSource('# Source');
        expect(draft.read().content).toBe('# Source');
        session.showRich();
        expect(of('socio-load').at(-1)).toEqual({ type: 'socio-load', payload: { markdown: '# Source' } });
        loaded('# Source', 1, false, 'Some formatting cannot be safely round-tripped.');
        expect(session.view()).toMatchObject({
            mode: 'source',
            notice: 'Some formatting cannot be safely round-tripped.',
        });
    });
});

describe('typing in source while Visual editor checks', () => {
    it('checks the newest text again instead of showing what the check was sent', () => {
        const { session, loaded, change, of, draft } = setup();
        session.ready();
        loaded(START.content, 1, false, 'This document contains extended Markdown. Source mode preserves it exactly.');
        session.setSource('# Plain');
        session.showRich();
        expect(of('socio-load').at(-1)).toEqual({ type: 'socio-load', payload: { markdown: '# Plain' } });
        // The check is out; the person keeps typing in source.
        session.setSource('# Plain\n\nTyped during the check');
        loaded('# Plain');
        // Still source, the newest text kept, and checked again.
        expect(session.view()).toMatchObject({ mode: 'source' });
        expect(draft.read().content).toBe('# Plain\n\nTyped during the check');
        expect(of('socio-load').at(-1)).toEqual({
            type: 'socio-load',
            payload: { markdown: '# Plain\n\nTyped during the check' },
        });
        // A change the WebView sends for the stale text never reaches the draft.
        change('# Plain', 2);
        expect(draft.read().content).toBe('# Plain\n\nTyped during the check');
        loaded('# Plain\n\nTyped during the check');
        expect(session.view()).toMatchObject({ mode: 'rich', sourceReason: null });
        expect(draft.read().content).toBe('# Plain\n\nTyped during the check');
    });

    it('stays in source with the newest text when the second check refuses it', async () => {
        const { session, loaded, of, draft } = setup();
        session.ready();
        loaded(START.content);
        session.showSource();
        await vi.advanceTimersByTimeAsync(0);
        session.showRich();
        session.setSource('Typed ::: during');
        loaded(START.content);
        expect(of('socio-load').at(-1)).toEqual({ type: 'socio-load', payload: { markdown: 'Typed ::: during' } });
        loaded('Typed ::: during', 1, false, 'Some formatting cannot be safely round-tripped.');
        expect(session.view()).toMatchObject({ mode: 'source' });
        expect(draft.read().content).toBe('Typed ::: during');
    });
});

describe('leaving', () => {
    it('waits for the WebView’s last edit, then writes and closes the draft', async () => {
        const { session, loaded, change, state, of, flushes, closed, listening } = setup();
        session.ready();
        loaded(START.content);
        state();
        const leaving = session.close();
        expect(of('socio-flush')).toHaveLength(1);
        change('One\n\nTwo last words', 3);
        await leaving;
        expect(closed()).toBe(true);
        expect(listening()).toBe(0);
        await session.flush();
        expect(flushes()).toBe(1);
    });

    it(`goes after ${FLUSH_WAIT_MS} ms when the WebView never answers`, async () => {
        const { session, loaded, state, closed } = setup();
        session.ready();
        loaded(START.content);
        state();
        const leaving = session.close();
        await vi.advanceTimersByTimeAsync(FLUSH_WAIT_MS);
        await leaving;
        expect(closed()).toBe(true);
    });
});

describe('leaving while a merge’s replace is out', () => {
    /** A merge sent at version 1, and the person's words typed before the WebView applied it. */
    function typedDuringMerge() {
        const harness = setup();
        harness.session.ready();
        harness.loaded('A\n\nB\n\nC');
        harness.land({ title: 'Roadmap', content: 'A theirs\n\nB\n\nC' });
        harness.change('A\n\nB\n\nC mine', 2);
        expect(harness.changes).toEqual([]);
        return harness;
    }

    it('waits for the answer (the WebView gives it at once on flush), then closes with the words', async () => {
        const { session, web, of, draft, closed } = typedDuringMerge();
        const leaving = session.close();
        expect(of('socio-flush')).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(0);
        expect(closed()).toBe(false);
        web({
            type: 'socio-replaced',
            payload: { ifVersion: 1, applied: false, markdown: 'A\n\nB\n\nC mine', version: 2 },
        });
        await leaving;
        expect(draft.read().content).toBe('A theirs\n\nB\n\nC mine');
        expect(closed()).toBe(true);
    });

    it(`merges the words into the draft itself when no answer comes in ${FLUSH_WAIT_MS} ms`, async () => {
        const { session, web, draft, closed } = typedDuringMerge();
        const leaving = session.close();
        await vi.advanceTimersByTimeAsync(FLUSH_WAIT_MS);
        await leaving;
        expect(draft.read().content).toBe('A theirs\n\nB\n\nC mine');
        expect(closed()).toBe(true);
        // A late answer is ignored once closed.
        web({ type: 'socio-replaced', payload: { ifVersion: 1, applied: false, markdown: 'A', version: 2 } });
        expect(draft.read().content).toBe('A theirs\n\nB\n\nC mine');
    });

    it('the background’s flush writes the words, and a later answer merges only what came after', async () => {
        const { session, web, change, draft, flushes } = typedDuringMerge();
        const flushing = session.flush();
        await vi.advanceTimersByTimeAsync(FLUSH_WAIT_MS);
        await flushing;
        expect(flushes()).toBe(1);
        expect(draft.read().content).toBe('A theirs\n\nB\n\nC mine');
        change('A\n\nB\n\nC mine more', 3);
        web({
            type: 'socio-replaced',
            payload: { ifVersion: 1, applied: false, markdown: 'A\n\nB\n\nC mine more', version: 3 },
        });
        expect(draft.read().content).toBe('A theirs\n\nB\n\nC mine more');
    });

    it('a dead WebView reloads from a draft that holds the words', () => {
        const { session, of, draft } = typedDuringMerge();
        session.lost();
        expect(draft.read().content).toBe('A theirs\n\nB\n\nC mine');
        session.ready();
        expect(of('socio-load').at(-1)?.payload).toEqual({ markdown: 'A theirs\n\nB\n\nC mine' });
    });

    it('keeps the change made elsewhere and says so when the words clash with it', async () => {
        const { session, loaded, land, change, draft, closed } = setup();
        session.ready();
        loaded('A\n\nB');
        land({ title: 'Roadmap', content: 'A theirs\n\nB' });
        change('A mine\n\nB', 2);
        const flushing = session.flush();
        await vi.advanceTimersByTimeAsync(FLUSH_WAIT_MS);
        await flushing;
        expect(draft.read().content).toBe('A theirs\n\nB');
        expect(session.view().notice).toBe(MERGE_CLASHED);
        expect(closed()).toBe(false);
    });
});

describe('wired to the page draft and the page save', () => {
    const files: UserDb[] = [];
    const directories: string[] = [];
    afterEach(async () => {
        for (const file of files.splice(0)) {
            await file.db.close();
        }
        for (const directory of directories.splice(0)) {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('the WebView’s changes become one queued page save with the latest text', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const store = await userDb();
        directories.push(store.directory);
        const file = await store.open();
        files.push(file);
        const outbox = await openOutbox({
            db: file.db,
            state: file.state,
            kinds: [],
            fetch: (() => {
                throw new Error('no requests');
            }) as never,
        });
        const drafts = await openDrafts({ db: file.db, state: file.state, outbox });
        let id = 0;
        const sink = createPageSaves({
            outbox,
            drafts,
            baseOf: async () => ({
                id: 'p1',
                spaceId: 's1',
                parentId: null,
                title: START.title,
                content: START.content,
                revision: START.revision,
                createdAt: 1,
                updatedAt: 1,
                sourceThreadId: null,
                createdBy: null,
                cover: null,
                sourceUrl: null,
                sourceTitle: null,
            }),
            newId: () => `id-${(id += 1)}`,
        });
        const pages = createPageDrafts({ drafts, connected: () => true, sink });
        const session = createEditorSession({ draft: pages.open('p1', START), appearance: APPEARANCE });
        session.connect(() => {});
        session.ready();
        session.receive({
            type: 'socio-loaded',
            payload: { markdown: START.content, version: 1, supported: true, reason: null },
        });
        session.receive({ type: 'socio-change', payload: { markdown: 'One\n\nTwo three', version: 2 } });
        session.setTitle('Roadmap v2');
        session.receive({ type: 'socio-change', payload: { markdown: 'One\n\nTwo three four', version: 3 } });
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 50);
        await outbox.idle?.();
        const rows = outbox.rows().filter((row) => row.kind === PAGE_SAVE_KIND);
        expect(rows).toHaveLength(1);
        expect(decodeSave(rows[0]!.payload)).toMatchObject({
            spaceId: 's1',
            pageId: 'p1',
            base: { revision: 3, content: START.content },
            draft: { title: 'Roadmap v2', content: 'One\n\nTwo three four' },
        });
        // The editor draft went into the row in the insert's transaction.
        expect(pages.stored('p1')).toBeUndefined();
        await session.close();
        await pages.close();
        await drafts.close();
    });
});

// CB-417: the title is the WebView document's own, so it scrolls with the text.
describe('the title in the document', () => {
    it('goes to the WebView once the page is read back, and its edits go to the draft', () => {
        const { session, loaded, web, of, changes } = setup();
        session.ready();
        expect(of('socio-title')).toEqual([]);
        // Before the page is in, a title from the WebView is about a page that isn't there yet.
        web({ type: 'socio-title-change', payload: { title: '' } });
        expect(changes).toEqual([]);
        loaded(START.content);
        expect(of('socio-title')).toEqual([{ type: 'socio-title', payload: { title: 'Roadmap' } }]);
        web({ type: 'socio-title-change', payload: { title: 'Roadmap 2027' } });
        expect(changes).toEqual([{ title: 'Roadmap 2027', content: START.content }]);
        expect(session.view()).toMatchObject({ editing: true, text: { title: 'Roadmap 2027' } });
        // The WebView holds it already: nothing goes back.
        expect(of('socio-title')).toHaveLength(1);
    });

    it('sends a title a merge changed, and source mode’s field’s, but never the WebView’s own back', () => {
        const { session, loaded, of, land, web } = setup();
        session.ready();
        loaded(START.content);
        web({ type: 'socio-title-change', payload: { title: 'Mine' } });
        land({ title: 'Theirs', content: START.content });
        expect(of('socio-title').at(-1)).toEqual({ type: 'socio-title', payload: { title: 'Theirs' } });
        session.setTitle('Typed natively');
        expect(of('socio-title').at(-1)).toEqual({ type: 'socio-title', payload: { title: 'Typed natively' } });
        expect(of('socio-title')).toHaveLength(3);
    });

    it('says when the title scrolled under the bar, and a new WebView starts with it in view and sends it again', () => {
        const { session, loaded, web, of } = setup();
        session.ready();
        loaded(START.content);
        expect(session.view().titleShown).toBe(true);
        web({ type: 'socio-title-shown', payload: { shown: false } });
        expect(session.view().titleShown).toBe(false);
        session.lost();
        expect(session.view().titleShown).toBe(true);
        session.ready();
        loaded(START.content, 1);
        expect(of('socio-title')).toHaveLength(2);
    });
});
