import { describe, expect, it } from 'vitest';

import type { ReactionsView } from '@socio/shared/chat/reactions';
import { REPORT_CONFIRMATION, REPORT_NOTE_MAX, REPORT_REASONS, fillReportText } from '@socio/shared/chat/reply-reports';

import { withReaction } from '../../src/chat/reactions';
import {
    checkReportPreview,
    noteCount,
    offersReport,
    reactionPress,
    readReportPreview,
    removeSharedAsk,
    REPORT_NOTICES,
    REPORT_WORDS,
    replyReportsOf,
    replySocioName,
    reportMark,
    reportNotice,
    reportPreviewPath,
    reportRequest,
    reportSheetOf,
    reportSheetText,
} from '../../src/chat/reply-reports';
import type { AuthedFetch } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';

// AI reply reports in the app (CB-382, docs/specs/REPLY-REPORTS.md), the
// rules the chat screen runs, under Node, held to the web's behavior and
// words (packages/client's ReportDialog and MessageReactions).

const SHARING = { sharing: true, consent: 'consent-1' } as const;

describe('whether a thumbs-down may carry a report', () => {
    it('reads `replyReports` from the workspace row, and nothing else', () => {
        expect(replyReportsOf({ replyReports: SHARING })).toEqual(SHARING);
        expect(replyReportsOf({ replyReports: null })).toBeNull();
        // An older server sends no field: no report UI.
        expect(replyReportsOf({})).toBeNull();
        expect(replyReportsOf(null)).toBeNull();
        expect(replyReportsOf({ replyReports: { sharing: true } })).toBeNull();
        expect(replyReportsOf({ replyReports: { sharing: false, consent: 'c' } })).toBeNull();
        expect(replyReportsOf({ replyReports: { sharing: true, consent: '' } })).toBeNull();
    });
});

describe('the report a confirmation sends', () => {
    it('needs a reason; trims the note and leaves an empty one out', () => {
        const base = { consent: 'consent-1', shownByOther: false };
        expect(reportRequest({ ...base, reason: null, note: '' })).toBeNull();
        expect(reportRequest({ ...base, reason: 'harmful', note: '   ' })).toEqual({
            reason: 'harmful',
            consent: 'consent-1',
            shownByOther: false,
        });
        expect(reportRequest({ ...base, reason: 'other', note: '  It made up a date.  ', shownByOther: true })).toEqual(
            {
                reason: 'other',
                note: 'It made up a date.',
                consent: 'consent-1',
                shownByOther: true,
            },
        );
    });

    it('counts the note in code points after trimming, as the server does', () => {
        // Each emoji is one code point but two UTF-16 units.
        const atLimit = '😀'.repeat(REPORT_NOTE_MAX);
        expect(atLimit.length).toBe(REPORT_NOTE_MAX * 2);
        expect(noteCount(atLimit)).toMatchObject({ length: REPORT_NOTE_MAX, over: false, warning: null });
        expect(noteCount(`  ${atLimit}  `).over).toBe(false);
        expect(reportRequest({ reason: 'wrong', note: atLimit, consent: 'c', shownByOther: false })).not.toBeNull();
        const over = `${atLimit}😀`;
        expect(noteCount(over)).toMatchObject({ length: REPORT_NOTE_MAX + 1, over: true });
        expect(reportRequest({ reason: 'wrong', note: over, consent: 'c', shownByOther: false })).toBeNull();
    });

    it('says the counter and the warning in the web’s words', () => {
        expect(noteCount('Hello').count).toBe('5 / 1,000');
        expect(noteCount('x'.repeat(1001)).warning).toBe('The note is 1 character too long.');
        expect(noteCount('x'.repeat(1003)).warning).toBe('The note is 3 characters too long.');
        expect(noteCount('x'.repeat(2500)).count).toBe('2,500 / 1,000');
    });
});

describe('the confirmation sheet', () => {
    it('takes promptByOther and the author from the server', () => {
        const preview = checkReportPreview({ sharing: true, consent: 'consent-1', promptByOther: true, author: 'Ben' });
        const sheet = reportSheetOf(preview, { messageId: 'r1', consent: 'consent-0', socio: 'Sebas' })!;
        expect(sheet).toEqual({ messageId: 'r1', consent: 'consent-1', socio: 'Sebas', byOther: 'Ben' });
        expect(reportSheetText(sheet).byOther).toBe("Ben's message goes to Ingenio too.");
        expect(reportSheetText(sheet).body).toBe(fillReportText(REPORT_CONFIRMATION.body, { socio: 'Sebas' }));
        expect(reportSheetText(sheet).body).not.toContain('{');
    });

    it('says “Another person” when an older server names nobody', () => {
        const sheet = reportSheetOf(checkReportPreview({ sharing: true, promptByOther: true }), {
            messageId: 'r1',
            consent: 'consent-1',
            socio: 'Sebas',
        })!;
        expect(sheet.consent).toBe('consent-1');
        expect(reportSheetText(sheet).byOther).toBe("Another person's message goes to Ingenio too.");
    });

    it('has no other person’s line when the answered message is the reader’s own', () => {
        const sheet = reportSheetOf(
            checkReportPreview({ sharing: true, consent: 'c', promptByOther: false, author: 'X' }),
            {
                messageId: 'r1',
                consent: 'c',
                socio: 'Sebas',
            },
        )!;
        expect(sheet.byOther).toBeUndefined();
        expect(reportSheetText(sheet).byOther).toBeNull();
    });

    it('is no sheet when the server says sharing went off', () => {
        expect(
            reportSheetOf(checkReportPreview({ sharing: false, promptByOther: false }), {
                messageId: 'r1',
                consent: 'c',
                socio: 'S',
            }),
        ).toBeNull();
    });

    it('lists the shared reasons, in order, with the shared confirm and cancel', () => {
        const text = reportSheetText({ socio: 'Sebas' });
        expect(text.reasons).toBe(REPORT_REASONS);
        expect(text.confirm).toBe(REPORT_CONFIRMATION.confirm);
        expect(text.cancel).toBe(REPORT_CONFIRMATION.cancel);
        expect(text.title).toBe(REPORT_CONFIRMATION.title);
    });

    it('names the reply’s own socio, never the selected one; “The socio” when it can’t', () => {
        const dots = [
            { id: 'dot-a', name: 'Sebas' },
            { id: 'dot-b', name: 'Marta' },
        ];
        expect(replySocioName('dot-b', dots)).toBe('Marta');
        expect(replySocioName(undefined, dots)).toBe(REPORT_WORDS.genericSocio);
        expect(replySocioName('dot-gone', dots)).toBe('The socio');
    });

    it('refuses a preview that isn’t one', () => {
        expect(() => checkReportPreview(null)).toThrow(TypeError);
        expect(() => checkReportPreview({ promptByOther: true })).toThrow(TypeError);
    });
});

describe('asking the server what a report would hold', () => {
    const answer = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    it('asks the report route for the reply', async () => {
        const asked: string[] = [];
        const fetch: AuthedFetch = async (path) => {
            asked.push(path);
            return answer(200, { sharing: true, consent: 'c', promptByOther: false });
        };
        await expect(readReportPreview(fetch, 'conv 1', 'r/1')).resolves.toEqual({
            kind: 'preview',
            preview: { sharing: true, consent: 'c', promptByOther: false },
        });
        expect(asked).toEqual([reportPreviewPath('conv 1', 'r/1')]);
        expect(asked[0]).toBe('/api/conversations/conv%201/messages/r%2F1/report');
    });

    it('is offline with no answer, and failed for a refusal or a body that isn’t a preview', async () => {
        const offline: AuthedFetch = async (path) => {
            throw new NetworkError(path);
        };
        await expect(readReportPreview(offline, 'c', 'r')).resolves.toEqual({ kind: 'offline' });
        await expect(readReportPreview(async () => answer(404, { error: 'x' }), 'c', 'r')).resolves.toEqual({
            kind: 'failed',
        });
        await expect(readReportPreview(async () => answer(200, { nope: 1 }), 'c', 'r')).resolves.toEqual({
            kind: 'failed',
        });
    });
});

describe('what a press does', () => {
    const view = (entry?: ReactionsView['messages'][string]): ReactionsView => ({
        shared: false,
        messages: entry === undefined ? {} : { r1: entry },
    });

    it('a thumbs-down while sharing asks to report; with sharing off it is a plain toggle', () => {
        expect(reactionPress(view(), 'r1', 'down', SHARING)).toEqual({ kind: 'report', consent: 'consent-1' });
        expect(reactionPress(view(), 'r1', 'down', null)).toEqual({ kind: 'toggle' });
        expect(reactionPress(view(), 'r1', 'up', SHARING)).toEqual({ kind: 'toggle' });
    });

    it('removing a thumbs-down whose report went warns first; queued or failed ones don’t', () => {
        const shared = view({ counts: { down: 1 }, mine: ['down'], report: 'shared' });
        expect(reactionPress(shared, 'r1', 'down', SHARING)).toEqual({ kind: 'warn', reaction: 'down' });
        expect(reactionPress(shared, 'r1', 'up', SHARING)).toEqual({ kind: 'warn', reaction: 'up' });
        expect(reactionPress(shared, 'r1', 'retry', SHARING)).toEqual({ kind: 'toggle' });
        const queued = view({ counts: { down: 1 }, mine: ['down'], report: 'queued' });
        expect(reactionPress(queued, 'r1', 'down', SHARING)).toEqual({ kind: 'toggle' });
        const failed = view({ counts: { down: 1 }, mine: ['down'], report: 'failed' });
        expect(reactionPress(failed, 'r1', 'up', SHARING)).toEqual({ kind: 'toggle' });
    });

    it('words the warning as the web does', () => {
        expect(removeSharedAsk('down')).toEqual({
            title: 'Remove your thumbs-down?',
            message: `Your report on this reply went to Ingenio. ${REPORT_CONFIRMATION.removeShared}`,
            cancel: 'Cancel',
            confirm: 'Remove thumbs-down',
        });
        expect(removeSharedAsk('up').confirm).toBe('Switch to thumbs-up');
    });

    it('marks only a shared report, and only while the thumbs-down stays', () => {
        expect(reportMark(view({ counts: { down: 1 }, mine: ['down'], report: 'shared' }), 'r1')).toBe(
            'Shared with Ingenio',
        );
        expect(reportMark(view({ counts: { down: 1 }, mine: ['down'], report: 'queued' }), 'r1')).toBeNull();
        expect(reportMark(view({ counts: { down: 1 }, mine: ['down'], report: 'failed' }), 'r1')).toBeNull();
        expect(reportMark(view({ counts: { down: 1 }, mine: [], report: 'shared' }), 'r1')).toBeNull();
    });

    it('keeps the mark through another reaction, and drops it with the thumbs-down', () => {
        const shared = view({ counts: { down: 1 }, mine: ['down'], report: 'shared' });
        expect(withReaction(shared, 'r1', 'retry', true).messages.r1!.report).toBe('shared');
        const up = withReaction(shared, 'r1', 'up', true);
        expect(up.messages.r1!.report).toBeUndefined();
        expect(withReaction(shared, 'r1', 'down', false).messages.r1).toBeUndefined();
    });
});

describe('what the server said about a report', () => {
    it('gives a quiet line for not-sharing, consent-changed and unavailable, and none for the rest', () => {
        expect(reportNotice('not-sharing')).toBe(REPORT_NOTICES['not-sharing']);
        expect(reportNotice('consent-changed')).toMatch(/nothing was reported/);
        expect(reportNotice('unavailable')).toMatch(/couldn’t be made/);
        expect(reportNotice('queued')).toBeNull();
        expect(reportNotice('already')).toBeNull();
    });
});

describe('“Report it now?” after an offline thumbs-down', () => {
    const down: ReactionsView = { shared: false, messages: { r1: { counts: { down: 1 }, mine: ['down'] } } };
    const base = { offered: true, reports: SHARING, online: true, view: down, messageId: 'r1', waiting: false };

    it('offers once online, sharing on, the thumbs-down sent and with no report', () => {
        expect(offersReport(base)).toBe(true);
        expect(offersReport({ ...base, online: false })).toBe(false);
        expect(offersReport({ ...base, waiting: true })).toBe(false);
        expect(offersReport({ ...base, reports: null })).toBe(false);
        expect(offersReport({ ...base, offered: false })).toBe(false);
        expect(offersReport({ ...base, view: { shared: false, messages: { r1: { counts: {}, mine: [] } } } })).toBe(
            false,
        );
        expect(
            offersReport({
                ...base,
                view: { shared: false, messages: { r1: { counts: { down: 1 }, mine: ['down'], report: 'queued' } } },
            }),
        ).toBe(false);
        expect(offersReport({ ...base, view: { shared: false, messages: {} } })).toBe(false);
    });
});
