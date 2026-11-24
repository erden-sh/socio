// CB-492: approvals happen on cards, never in prose. The check of a final
// reply flags a request for approval or permission in text (English and
// Spanish) while nothing is waiting, and keeps false positives low.
import { describe, expect, it } from 'vitest';

import {
    APPROVAL_GUIDE,
    APPROVAL_PROSE_CORRECTION,
    approvalAsk,
    approvalProseCheck,
    approvalProseCorrection,
    approvalProseLogLine,
    pendingInHistory,
} from '../src/server/dots/approval-prose.js';

const pending = JSON.stringify({
    status: 'pending_approval',
    id: 'req-1',
    approval: { id: 'req-1', summary: 'Import up to 20 linked pages from acme.example', url: '/approvals/req-1' },
    message: 'Waiting.',
});

describe('approvalAsk', () => {
    it.each([
        // The incident's own words.
        'Please approve the import of up to 20 linked pages to proceed.',
        'Please confirm and I will import the pages.',
        'Do you approve importing 20 pages from Acme?',
        'Could you give me your permission to delete the draft?',
        'Would you authorize the transfer?',
        'Approve the import to continue.',
        'I need your approval before I save the job.',
        'This requires your permission.',
        'Waiting for your go-ahead.',
        'Reply "yes" to proceed.',
        'Type approve to continue and I will import them.',
        // Spanish.
        'Por favor, aprueba la importación de 20 páginas.',
        'Por favor autorice el cambio.',
        '¿Me autorizas a importar las 20 páginas?',
        '¿Me das permiso para borrar el borrador?',
        'Apruébalo para continuar.',
        'Necesito tu aprobación para guardar el trabajo.',
        'Espero su autorización.',
        'Responde "sí" para continuar.',
    ])('flags %j', (reply) => {
        expect(approvalAsk(reply)).toBeDefined();
    });

    it.each([
        // Mentions of approval that ask nothing of the reader.
        'Ada approved the import yesterday.',
        'The page was approved by the Acme editors.',
        'I imported 20 linked pages from acme.example.',
        'Approvals are listed under Approvals in the app.',
        'Acme needs approval from finance for the budget.',
        'The import needs approval when it is large.',
        'You can change your approval policy in settings.',
        'Do you approve of this design direction?',
        // Pointing at the card is what a waiting request should get.
        'Approve it on the card above to proceed.',
        'Please approve the request in the approval card.',
        'Aprueba la solicitud en la tarjeta de arriba para continuar.',
        'Use the Approve button to continue.',
        // Ordinary questions and statements.
        'Which of the two pages should I update?',
        'Shall I write the summary as a page?',
        'Do you want a shorter version?',
        '¿Quieres que lo resuma?',
        'La página fue aprobada por Ada.',
        'Ya importé las páginas de Acme.',
        // Quoted text and code don't ask.
        '> Please approve the import to proceed.\n\nThat is what the old version said.',
        'The old reply was `Please approve the import to proceed.`',
        '```\nplease approve\n```',
        '',
    ])('lets %j through', (reply) => {
        expect(approvalAsk(reply)).toBeUndefined();
    });

    it('names the pattern and the phrase', () => {
        expect(approvalAsk('Please approve the import of up to 20 linked pages to proceed.')).toEqual({
            name: 'please_approve',
            phrase: 'Please approve',
        });
        expect(approvalAsk('¿Me autorizas a seguir?')?.name).toBe('es_you_approve');
    });
});

describe('pendingInHistory', () => {
    it('sees a request that came back pending after the person’s last message', () => {
        expect(
            pendingInHistory([
                { role: 'user', content: 'Import Acme’s links' },
                { role: 'assistant', content: '' },
                { role: 'tool', content: pending },
            ]),
        ).toBe(true);
    });

    it('ignores one from before the person’s last message, and other results', () => {
        expect(
            pendingInHistory([
                { role: 'tool', content: pending },
                { role: 'user', content: 'Thanks' },
            ]),
        ).toBe(false);
        expect(pendingInHistory([{ role: 'tool', content: '{"status":"ok"}' }])).toBe(false);
        expect(pendingInHistory([])).toBe(false);
    });
});

describe('approvalProseCorrection', () => {
    const ask = 'Please approve the import of up to 20 linked pages to proceed.';

    it('corrects the turn after a prose ask that had nothing waiting', () => {
        expect(
            approvalProseCorrection([
                { role: 'user', content: 'Archive Acme’s reading list' },
                { role: 'assistant', content: ask },
                { role: 'user', content: 'You’re approved' },
            ]),
        ).toBe(APPROVAL_PROSE_CORRECTION);
    });

    it('reads text parts', () => {
        expect(
            approvalProseCorrection([
                { role: 'user', content: 'Go' },
                { role: 'assistant', content: [{ type: 'text', text: ask }] },
                { role: 'user', content: 'ok' },
            ]),
        ).toBe(APPROVAL_PROSE_CORRECTION);
    });

    it('says nothing when a request was waiting, the reply asked nothing, or there is no earlier reply', () => {
        expect(
            approvalProseCorrection([
                { role: 'user', content: 'Archive it' },
                { role: 'tool', content: pending },
                { role: 'assistant', content: 'Do you approve? It is waiting for you.' },
                { role: 'user', content: 'Yes' },
            ]),
        ).toBeUndefined();
        expect(
            approvalProseCorrection([
                { role: 'user', content: 'Archive it' },
                { role: 'assistant', content: 'Done: 20 pages saved.' },
                { role: 'user', content: 'Thanks' },
            ]),
        ).toBeUndefined();
        expect(approvalProseCorrection([{ role: 'user', content: 'Hi' }])).toBeUndefined();
        expect(approvalProseCorrection([])).toBeUndefined();
    });

    it('only looks at the reply just before the person’s newest message', () => {
        expect(
            approvalProseCorrection([
                { role: 'user', content: 'Archive it' },
                { role: 'assistant', content: ask },
                { role: 'user', content: 'Never mind' },
                { role: 'assistant', content: 'Sure.' },
                { role: 'user', content: 'Thanks' },
            ]),
        ).toBeUndefined();
    });
});

describe('approvalProseCheck', () => {
    const finish = (content: string, finishReason = 'stop') => ({ finishReason, content, duration: 0 });
    const ctx = {} as never;

    it('flags a final reply that asks in prose with nothing waiting', () => {
        const flagged: string[] = [];
        const check = approvalProseCheck({ waiting: () => false, flag: (ask) => flagged.push(ask.name) });
        check.onFinish!(ctx, finish('Please approve the import of up to 20 linked pages to proceed.'));
        expect(flagged).toEqual(['please_approve']);
    });

    it('lets it through when a tool came back pending, or the turn waits for the person', () => {
        const flagged: string[] = [];
        const check = approvalProseCheck({ waiting: () => false, flag: (ask) => flagged.push(ask.name) });
        check.onAfterToolCall!(ctx, {
            toolName: 'unfurl_recursive',
            toolCallId: 'c1',
            ok: true,
            duration: 1,
            result: JSON.parse(pending),
        } as never);
        check.onFinish!(ctx, finish('Do you approve? I need your approval.'));
        const waiting = approvalProseCheck({ waiting: () => true, flag: (ask) => flagged.push(ask.name) });
        waiting.onFinish!(ctx, finish('Please approve it to proceed.'));
        const calling = approvalProseCheck({ waiting: () => false, flag: (ask) => flagged.push(ask.name) });
        calling.onFinish!(ctx, finish('Please approve it to proceed.', 'tool_calls'));
        expect(flagged).toEqual([]);
    });

    it('logs a structured line without the reply text', () => {
        const line = approvalProseLogLine({
            event: 'approval_prose',
            runId: 'run-1',
            threadId: 'thread-1',
            dotId: 'dot-1',
            pattern: 'please_approve',
        });
        expect(line).toBe('Approvals: approval_prose run="run-1" thread="thread-1" dot="dot-1" pattern=please_approve');
    });
});

it('tells the model to use the card, never prose', () => {
    expect(APPROVAL_GUIDE).toMatch(/only on an approval card/);
    expect(APPROVAL_GUIDE).toMatch(/Never ask for approval or permission in your reply/);
    // The guide's own examples are quoted, so the check never flags it.
    expect(approvalAsk(APPROVAL_GUIDE)).toBeUndefined();
});
