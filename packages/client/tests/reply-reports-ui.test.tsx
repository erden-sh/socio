import type { Message } from '@ag-ui/core';
// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ReactionsView } from '@socio/shared/chat/reactions';
import {
    REPLY_REPORTS_SETTING,
    REPORT_CONFIRMATION,
    REPORT_NOTE_MAX,
    REPORT_REASONS,
    fillReportText,
    type ReplyReportsAdminView,
    type ReplyReportsState,
    type ReportOutcome,
    type ReportPreview,
} from '@socio/shared/chat/reply-reports';
import type { User } from '@socio/shared/types';

import { CHANGES_CHANNEL, closeChangeChannel, refreshShown } from '../src/lib/change-channel';
import { ChatTranscript } from '../src/modules/chat/ChatTranscript';
import { OTHER_AUTHOR, PREVIEW_FAILED } from '../src/modules/chat/MessageReactions';
import { REPORT_NOTICE, useReactions, withReaction } from '../src/modules/chat/use-reactions';
import { CloudConnectionCard } from '../src/modules/operator/CloudConnectionCard';
import { ReplyReportsCard } from '../src/modules/operator/ReplyReportsCard';
import { CurrentUser } from '../src/shell/current-user';
import { ShellContext, type Shell } from '../src/shell/shell-context';

import { FakeBroadcastChannel } from './helpers/fake-broadcast-channel';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// CB-382: a thumbs-down that may go to Ingenio as an AI reply report, as the
// web shows it (docs/specs/REPLY-REPORTS.md), and the admins' setting.
const ada: User = { id: 'ada', name: 'Ada', role: 'admin' };
const alice: User = { id: 'alice', name: 'Alice', role: 'member' };

let root: Root | undefined;
let host: HTMLElement | undefined;
let server: ReactionsView;
let preview: ReportPreview | 'fail';
let outcome: ReportOutcome | undefined;
let removal: 'withdrawn' | 'kept' | undefined;
let admin: ReplyReportsAdminView | 'forbidden';
let calls: Array<{ method: string; path: string; body?: unknown }>;
let refreshes: number;

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    FakeBroadcastChannel.reset();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    server = { shared: true, messages: {} };
    preview = { sharing: true, consent: 'consent-1', promptByOther: false };
    outcome = 'queued';
    removal = undefined;
    admin = { available: true, sharing: false, queued: 0, failed: 0 };
    calls = [];
    refreshes = 0;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const path = new URL(input, 'http://app.test').pathname;
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        calls.push({ method, path, ...(body === undefined ? {} : { body }) });
        if (path === '/api/cloud/reply-reports') {
            if (admin === 'forbidden') {
                return Response.json({ error: 'Only an admin can change this.' }, { status: 403 });
            }
            if (method === 'PUT') {
                admin = body.sharing
                    ? { ...admin, sharing: true, consent: 'consent-2', since: Date.UTC(2026, 10, 26, 12), by: 'ada' }
                    : { available: admin.available, sharing: false, queued: 0, failed: admin.failed };
            }
            return Response.json(admin);
        }
        if (path === '/api/cloud') {
            return Response.json({ connection: 'connected', issuer: 'https://cloud.example.test', scopes: [] });
        }
        if (path === '/api/accounts') {
            return Response.json({ error: 'Not found.' }, { status: 404 });
        }
        if (path.endsWith('/report')) {
            return preview === 'fail' ? Response.json({ error: 'No.' }, { status: 500 }) : Response.json(preview);
        }
        if (path.endsWith('/reactions')) {
            return Response.json(server);
        }
        const kind = path.split('/').at(-1) as 'up';
        server = withReaction(server, 'a1', kind, method === 'PUT');
        if (method === 'PUT' && body?.report && outcome === 'queued') {
            server.messages.a1 = { ...server.messages.a1!, report: 'queued' };
        }
        const report = method === 'PUT' && body?.report ? outcome : method === 'DELETE' ? removal : undefined;
        return Response.json(report ? { ...server, report } : server);
    });
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = host = undefined;
    document.body.innerHTML = '';
    closeChangeChannel();
    vi.unstubAllGlobals();
});

const messages: Message[] = [
    // The transcript names someone else: the dialog never reads it for `{author}`.
    { id: 'u1', role: 'user', content: 'Plan the offsite', metadata: { author: { name: 'Bob', you: false } } },
    { id: 'a1', role: 'assistant', content: 'Talks, then lunch.' },
];
function Harness() {
    const reactions = useReactions('c1', true);
    return <ChatTranscript messages={messages} calls={[]} dotName="Pilot" reactions={reactions} />;
}
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, what: string, ms = 3000) {
    for (const deadline = Date.now() + ms; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => tick());
    }
    throw new Error(`Timed out waiting for ${what}: ${document.body.textContent}`);
}
function mount(node: React.ReactNode, replyReports: ReplyReportsState = null, user: User = alice) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const shell = {
        workspace: { user, dots: [], replyReports },
        refresh: async () => {
            refreshes += 1;
        },
    } as unknown as Shell;
    act(() =>
        root!.render(
            // As the app renders: Strict Mode runs each effect's cleanup and setup twice.
            <StrictMode>
                <ShellContext.Provider value={shell}>
                    <CurrentUser.Provider value={user}>{node}</CurrentUser.Provider>
                </ShellContext.Provider>
            </StrictMode>,
        ),
    );
}
async function chat(replyReports: ReplyReportsState = { sharing: true, consent: 'consent-1' }) {
    mount(<Harness />, replyReports);
    await until(() => !!document.querySelector('[data-reaction="down"]'), 'the reactions');
}
const text = () => document.body.textContent ?? '';
const down = () => document.querySelector<HTMLButtonElement>('[data-message-id="a1"] [data-reaction="down"]')!;
const up = () => document.querySelector<HTMLButtonElement>('[data-message-id="a1"] [data-reaction="up"]')!;
const dialog = () => document.querySelector<HTMLElement>('[data-slot="report-dialog"]');
const writes = () => calls.filter((call) => call.method !== 'GET');
const reportConfirm = () => document.querySelector<HTMLButtonElement>('[data-slot="report-confirm"]')!;
const buttonNamed = (name: string) =>
    [...document.querySelectorAll('button')].find((element) => element.textContent?.trim() === name);
async function click(element: HTMLElement | null | undefined) {
    await act(async () => {
        element!.click();
        await tick();
    });
}
async function pressDown() {
    await click(down());
    await until(() => !!dialog() || !!document.querySelector('[data-slot="report-notice"]'), 'the dialog');
}
function typeNote(value: string) {
    const area = dialog()!.querySelector('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
        setter.call(area, value);
        area.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
const radio = (label: string) =>
    [...dialog()!.querySelectorAll('label')]
        .find((element) => element.textContent?.trim() === label)!
        .querySelector('input')!;

it('gives a plain thumbs-down, with no dialog, while sharing is off', async () => {
    await chat(null);
    await click(down());
    expect(dialog()).toBeNull();
    expect(writes()).toEqual([{ method: 'PUT', path: '/api/conversations/c1/messages/a1/reactions/down' }]);
    // Nor does it ask the server what a report would include.
    expect(calls.some((call) => call.path.endsWith('/report'))).toBe(false);
});

it('asks the server first, then shows the reasons, the text and a note with its counter', async () => {
    await chat();
    await pressDown();
    expect(calls.filter((call) => call.path.endsWith('/report'))).toEqual([
        { method: 'GET', path: '/api/conversations/c1/messages/a1/report' },
    ]);
    expect(writes()).toEqual([]);
    const shown = dialog()!;
    expect(shown.textContent).toContain(REPORT_CONFIRMATION.title);
    expect(shown.textContent).toContain(fillReportText(REPORT_CONFIRMATION.body, { socio: 'Pilot' }));
    expect(shown.querySelector('[data-slot="report-by-other"]')).toBeNull();
    // The picker is a labeled group of radios, the first one focused.
    expect(shown.querySelector('fieldset legend')!.textContent).toBe('Reason');
    const labels = [...shown.querySelectorAll('fieldset label')].map((label) => label.textContent?.trim());
    expect(labels).toEqual(REPORT_REASONS.map((reason) => reason.label));
    expect(document.activeElement).toBe(shown.querySelector('input[type="radio"]'));
    const area = shown.querySelector('textarea')!;
    expect(shown.querySelector(`label[for="${area.id}"]`)!.textContent).toBe('Note (optional)');
    const counter = document.getElementById(area.getAttribute('aria-describedby')!)!;
    expect(counter.textContent).toBe(`0 / ${REPORT_NOTE_MAX.toLocaleString('en-US')}`);
    // Code points, after trimming: an emoji counts once.
    typeNote('  It made up 😀 ');
    expect(counter.textContent).toBe(`12 / ${REPORT_NOTE_MAX.toLocaleString('en-US')}`);
    // A reason is required.
    expect(reportConfirm().disabled).toBe(true);
});

it('blocks a note over the cap', async () => {
    await chat();
    await pressDown();
    await click(radio('Wrong or made up'));
    typeNote('😀'.repeat(REPORT_NOTE_MAX));
    expect(reportConfirm().disabled).toBe(false);
    typeNote('😀'.repeat(REPORT_NOTE_MAX + 1));
    expect(reportConfirm().disabled).toBe(true);
    expect(dialog()!.querySelector('textarea')!.getAttribute('aria-invalid')).toBe('true');
    expect(dialog()!.querySelector('[role="alert"]')!.textContent).toBe('The note is 1 character too long.');
});

it('sends exactly one PUT with the reason, the trimmed note, the consent and what it showed', async () => {
    await chat();
    await pressDown();
    await click(radio('Offensive'));
    typeNote('  Rude about the venue. ');
    await click(reportConfirm());
    await until(() => !dialog(), 'the dialog to close');
    expect(writes()).toEqual([
        {
            method: 'PUT',
            path: '/api/conversations/c1/messages/a1/reactions/down',
            body: {
                report: {
                    reason: 'offensive',
                    note: 'Rude about the venue.',
                    consent: 'consent-1',
                    shownByOther: false,
                },
            },
        },
    ]);
    expect(down().getAttribute('aria-pressed')).toBe('true');
    // Queued: nothing to say, and no mark yet.
    expect(document.querySelector('[data-slot="report-notice"]')).toBeNull();
    expect(text()).not.toContain(REPORT_CONFIRMATION.shared);
});

it('leaves out an empty note', async () => {
    await chat();
    await pressDown();
    await click(radio('Something else'));
    typeNote('   ');
    await click(reportConfirm());
    expect(writes()[0]!.body).toEqual({ report: { reason: 'other', consent: 'consent-1', shownByOther: false } });
});

it('still adds when the same thumbs-down arrived from another device while the dialog was open', async () => {
    await chat();
    await pressDown();
    // Another device gave this reply the reader's thumbs-down; another tab's note re-reads.
    server = { shared: true, messages: { a1: { counts: { down: 1 }, mine: ['down'], report: 'shared' } } };
    outcome = 'already';
    await act(async () => {
        new FakeBroadcastChannel(CHANGES_CHANNEL).postMessage([{ topic: 'conversation', id: 'c1' }]);
        await tick(200);
    });
    expect(down().getAttribute('aria-pressed')).toBe('true');
    await click(radio('Offensive'));
    await click(reportConfirm());
    await until(() => writes().length === 1, 'the PUT');
    // A PUT with the report (the server answers `already`), never a DELETE.
    expect(writes()).toEqual([
        {
            method: 'PUT',
            path: '/api/conversations/c1/messages/a1/reactions/down',
            body: { report: { reason: 'offensive', consent: 'consent-1', shownByOther: false } },
        },
    ]);
    expect(down().getAttribute('aria-pressed')).toBe('true');
});

it('sends nothing on Cancel', async () => {
    await chat();
    await pressDown();
    await click(radio('Harmful or unsafe'));
    await click(buttonNamed(REPORT_CONFIRMATION.cancel));
    await until(() => !dialog(), 'the dialog to close');
    expect(writes()).toEqual([]);
    expect(down().getAttribute('aria-pressed')).toBe('false');
});

it('shows the other person’s line exactly when the server says so, named by the server', async () => {
    await chat();
    await pressDown();
    expect(dialog()!.querySelector('[data-slot="report-by-other"]')).toBeNull();
    await click(buttonNamed(REPORT_CONFIRMATION.cancel));
    await until(() => !dialog(), 'the dialog to close');
    preview = { sharing: true, consent: 'consent-1', promptByOther: true, author: 'Ada' };
    await pressDown();
    expect(dialog()!.querySelector('[data-slot="report-by-other"]')!.textContent).toBe(
        fillReportText(REPORT_CONFIRMATION.byOther, { author: 'Ada' }),
    );
    await click(radio('Offensive'));
    await click(reportConfirm());
    expect(writes()[0]!.body).toEqual({ report: { reason: 'offensive', consent: 'consent-1', shownByOther: true } });
});

it('says “Another person” when the server’s answer names nobody, never the transcript’s guess', async () => {
    preview = { sharing: true, consent: 'consent-1', promptByOther: true };
    await chat();
    await pressDown();
    expect(dialog()!.querySelector('[data-slot="report-by-other"]')!.textContent).toBe(
        fillReportText(REPORT_CONFIRMATION.byOther, { author: OTHER_AUTHOR }),
    );
    expect(dialog()!.textContent).not.toContain('Bob');
});

it('sends the consent the server answered with when it is newer', async () => {
    preview = { sharing: true, consent: 'consent-9', promptByOther: false };
    await chat();
    await pressDown();
    await click(radio('Offensive'));
    await click(reportConfirm());
    expect(writes()[0]!.body).toMatchObject({ report: { consent: 'consent-9' } });
});

it('sends nothing and says so quietly when the server can’t say what the report would include', async () => {
    preview = 'fail';
    await chat();
    await pressDown();
    expect(dialog()).toBeNull();
    expect(writes()).toEqual([]);
    expect(down().getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('[data-slot="report-notice"]')!.textContent).toBe(PREVIEW_FAILED);
    expect(document.querySelector('[data-message-id="a1"] [role="alert"]')).toBeNull();
});

it('gives a plain thumbs-down when the server says sharing went off', async () => {
    preview = { sharing: false, promptByOther: false };
    await chat();
    await click(down());
    await until(() => writes().length > 0, 'the thumbs-down');
    expect(dialog()).toBeNull();
    expect(writes()).toEqual([{ method: 'PUT', path: '/api/conversations/c1/messages/a1/reactions/down' }]);
});

for (const result of ['queued', 'already', 'not-sharing', 'consent-changed', 'unavailable'] as const) {
    it(`takes a ${result} answer without an error`, async () => {
        outcome = result;
        await chat();
        await pressDown();
        await click(radio('Offensive'));
        await click(reportConfirm());
        await until(() => writes().length === 1, 'the PUT');
        await act(() => tick());
        // The thumbs-down is stored whatever became of the report.
        expect(down().getAttribute('aria-pressed')).toBe('true');
        expect(text()).not.toContain('Could not save that');
        expect(document.querySelector('[data-message-id="a1"] [role="alert"]')).toBeNull();
        const notice = document.querySelector('[data-slot="report-notice"]');
        expect(notice?.textContent).toBe(REPORT_NOTICE[result]);
        // A quiet note says sharing changed: the shell reads it again.
        expect(refreshes).toBe(REPORT_NOTICE[result] ? 1 : 0);
        expect(['not-sharing', 'consent-changed', 'unavailable'].includes(result)).toBe(!!REPORT_NOTICE[result]);
    });
}

it('marks the reader’s own shared report, and nothing for queued or failed', async () => {
    server = { shared: true, messages: { a1: { counts: { down: 1 }, mine: ['down'], report: 'shared' } } };
    await chat();
    expect(document.querySelector('[data-slot="report-shared"]')!.textContent).toBe(REPORT_CONFIRMATION.shared);
    act(() => root!.unmount());
    host!.remove();
    for (const report of ['queued', 'failed'] as const) {
        server = { shared: true, messages: { a1: { counts: { down: 1 }, mine: ['down'], report } } };
        await chat();
        expect(document.querySelector('[data-slot="report-shared"]')).toBeNull();
        act(() => root!.unmount());
        host!.remove();
    }
    root = undefined;
});

it('warns before removing a shared report’s thumbs-down, and goes on only on confirm', async () => {
    server = { shared: true, messages: { a1: { counts: { down: 1 }, mine: ['down'], report: 'shared' } } };
    removal = 'kept';
    await chat();
    await click(down());
    const warning = document.querySelector('[data-slot="remove-shared-dialog"]')!;
    expect(warning.textContent).toContain(REPORT_CONFIRMATION.removeShared);
    await click(buttonNamed('Cancel'));
    expect(writes()).toEqual([]);
    expect(down().getAttribute('aria-pressed')).toBe('true');
    await click(down());
    await click(document.querySelector<HTMLElement>('[data-slot="remove-shared-confirm"]'));
    await until(() => writes().length === 1, 'the DELETE');
    expect(writes()).toEqual([{ method: 'DELETE', path: '/api/conversations/c1/messages/a1/reactions/down' }]);
    expect(down().getAttribute('aria-pressed')).toBe('false');
});

it('warns before a thumbs-up takes a shared report’s place', async () => {
    server = { shared: true, messages: { a1: { counts: { down: 1 }, mine: ['down'], report: 'shared' } } };
    await chat();
    await click(up());
    expect(document.querySelector('[data-slot="remove-shared-dialog"]')).not.toBeNull();
    await click(buttonNamed('Switch to thumbs-up'));
    await until(() => writes().length === 1, 'the PUT');
    expect(writes()).toEqual([{ method: 'PUT', path: '/api/conversations/c1/messages/a1/reactions/up' }]);
});

async function otherDevice(view: ReactionsView) {
    server = view;
    await act(async () => {
        new FakeBroadcastChannel(CHANGES_CHANNEL).postMessage([{ topic: 'conversation', id: 'c1' }]);
        await tick(200);
    });
}

it('removes, never restores, when the thumbs-down went on another device while the warning was open', async () => {
    server = { shared: true, messages: { a1: { counts: { down: 1 }, mine: ['down'], report: 'shared' } } };
    await chat();
    await click(down());
    await otherDevice({ shared: true, messages: {} });
    expect(down().getAttribute('aria-pressed')).toBe('false');
    await click(document.querySelector<HTMLElement>('[data-slot="remove-shared-confirm"]'));
    await until(() => writes().length === 1, 'the DELETE');
    expect(writes()).toEqual([{ method: 'DELETE', path: '/api/conversations/c1/messages/a1/reactions/down' }]);
    expect(down().getAttribute('aria-pressed')).toBe('false');
});

it('adds, never removes, the thumbs-up another device gave while the warning was open', async () => {
    server = { shared: true, messages: { a1: { counts: { down: 1 }, mine: ['down'], report: 'shared' } } };
    await chat();
    await click(up());
    await otherDevice({ shared: true, messages: { a1: { counts: { up: 1 }, mine: ['up'] } } });
    expect(up().getAttribute('aria-pressed')).toBe('true');
    await click(buttonNamed('Switch to thumbs-up'));
    await until(() => writes().length === 1, 'the PUT');
    expect(writes()).toEqual([{ method: 'PUT', path: '/api/conversations/c1/messages/a1/reactions/up' }]);
    expect(up().getAttribute('aria-pressed')).toBe('true');
});

it('removes a thumbs-down without a warning unless its report was shared', async () => {
    for (const report of ['queued', 'failed', undefined] as const) {
        server = {
            shared: true,
            messages: { a1: { counts: { down: 1 }, mine: ['down'], ...(report ? { report } : {}) } },
        };
        calls = [];
        await chat();
        await click(down());
        expect(document.querySelector('[data-slot="remove-shared-dialog"]')).toBeNull();
        await until(() => writes().length === 1, 'the DELETE');
        act(() => root!.unmount());
        host!.remove();
    }
    root = undefined;
});

it('keeps the report mark through another reaction, and drops it with the thumbs-down', () => {
    const view: ReactionsView = {
        shared: true,
        messages: { a1: { counts: { down: 1 }, mine: ['down'], report: 'shared' } },
    };
    expect(withReaction(view, 'a1', 'retry', true).messages.a1!.report).toBe('shared');
    expect(withReaction(view, 'a1', 'up', true).messages.a1!.report).toBeUndefined();
});

// ── The admins' setting ─────────────────────────────────────────────────

async function card(user: User = ada) {
    mount(<ReplyReportsCard />, null, user);
    await act(() => tick(30));
}
const setting = () => document.querySelector<HTMLElement>('[data-slot="reply-reports"]');
const toggle = () => setting()!.querySelector<HTMLButtonElement>('[role="switch"]')!;

it('hides the setting when this server can’t share, and from members', async () => {
    admin = { available: false, sharing: false, queued: 0, failed: 0 };
    await card();
    expect(calls.some((call) => call.path === '/api/cloud/reply-reports')).toBe(true);
    expect(setting()).toBeNull();
    act(() => root!.unmount());
    host!.remove();
    admin = { available: true, sharing: false, queued: 0, failed: 0 };
    calls = [];
    await card(alice);
    expect(setting()).toBeNull();
    // A member's page never asks.
    expect(calls).toEqual([]);
});

it('asks to confirm what leaves before turning sharing on', async () => {
    await card();
    expect(setting()!.textContent).toContain(REPLY_REPORTS_SETTING.label);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(setting()!.querySelector(`label[for="${toggle().id}"]`)!.textContent).toBe(REPLY_REPORTS_SETTING.label);
    await click(toggle());
    const consent = document.querySelector<HTMLElement>('[data-slot="reply-reports-consent"]')!;
    expect(consent.textContent).toContain(REPLY_REPORTS_SETTING.body);
    expect(writes()).toEqual([]);
    // Cancel: still off, nothing sent.
    await click(buttonNamed('Cancel'));
    expect(writes()).toEqual([]);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    await click(toggle());
    await click(document.querySelector<HTMLElement>('[data-slot="reply-reports-turn-on"]'));
    await until(() => toggle().getAttribute('aria-checked') === 'true', 'sharing on');
    expect(writes()).toEqual([{ method: 'PUT', path: '/api/cloud/reply-reports', body: { sharing: true } }]);
    // Who and when; the shell reads the workspace's state again.
    expect(setting()!.querySelector('[data-slot="reply-reports-since"]')!.textContent).toContain('By you');
    expect(refreshes).toBe(1);
});

it('follows another admin’s change: when the workspace’s state changes, and when the tab comes back', async () => {
    await card();
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    // Another admin turned it on: the shell's poll brings the new state.
    admin = { available: true, sharing: true, consent: 'consent-7', since: 1, by: 'bob', queued: 0, failed: 0 };
    const shell = (replyReports: ReplyReportsState) =>
        ({ workspace: { user: ada, dots: [], replyReports }, refresh: async () => {} }) as unknown as Shell;
    await act(async () => {
        root!.render(
            <StrictMode>
                <ShellContext.Provider value={shell({ sharing: true, consent: 'consent-7' })}>
                    <CurrentUser.Provider value={ada}>
                        <ReplyReportsCard />
                    </CurrentUser.Provider>
                </ShellContext.Provider>
            </StrictMode>,
        );
        await tick(30);
    });
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    // The counts moved while the tab was away: coming back reads them again.
    admin = { ...admin, queued: 5, failed: 1 };
    await act(async () => {
        await refreshShown();
        await tick(30);
    });
    expect(setting()!.querySelector('[data-slot="reply-reports-queued"]')!.textContent).toBe('5');
    expect(setting()!.querySelector('[data-slot="reply-reports-failed"]')!.textContent).toBe('1');
});

it('turns sharing off at once, and shows the counts', async () => {
    admin = {
        available: true,
        sharing: true,
        consent: 'consent-1',
        since: Date.UTC(2026, 10, 26, 12),
        by: 'bob',
        queued: 3,
        failed: 2,
    };
    await card();
    expect(setting()!.querySelector('[data-slot="reply-reports-queued"]')!.textContent).toBe('3');
    expect(setting()!.querySelector('[data-slot="reply-reports-failed"]')!.textContent).toBe('2');
    // No people list (mock sign-in): the id stands in.
    expect(setting()!.querySelector('[data-slot="reply-reports-since"]')!.textContent).toContain('By bob');
    await click(toggle());
    expect(document.querySelector('[data-slot="reply-reports-consent"]')).toBeNull();
    await until(() => toggle().getAttribute('aria-checked') === 'false', 'sharing off');
    expect(writes()).toEqual([{ method: 'PUT', path: '/api/cloud/reply-reports', body: { sharing: false } }]);
    expect(setting()!.querySelector('[data-slot="reply-reports-queued"]')!.textContent).toBe('0');
});

it('stays so it can be turned off while sharing is on but the connection can’t send', async () => {
    admin = { available: false, sharing: true, consent: 'consent-1', since: 1, by: 'ada', queued: 1, failed: 0 };
    await card();
    expect(setting()).not.toBeNull();
    expect(toggle().disabled).toBe(false);
    expect(setting()!.querySelector('[data-slot="reply-reports-paused"]')).not.toBeNull();
});

it('puts the failed count on the Cloud connection card only when there are some', async () => {
    admin = { available: true, sharing: true, queued: 0, failed: 4 };
    mount(<CloudConnectionCard />, null, ada);
    await until(() => text().includes('Connected'), 'the card');
    await until(() => !!document.querySelector('[data-slot="cloud-reports-failed"]'), 'the count');
    expect(document.querySelector('[data-slot="cloud-reports-failed"]')!.textContent).toContain('4');
    act(() => root!.unmount());
    host!.remove();
    admin = { available: true, sharing: true, queued: 0, failed: 0 };
    mount(<CloudConnectionCard />, null, ada);
    await until(() => text().includes('Connected'), 'the card');
    await act(() => tick(30));
    expect(document.querySelector('[data-slot="cloud-reports-failed"]')).toBeNull();
});
