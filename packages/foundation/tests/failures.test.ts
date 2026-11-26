import { EventType } from '@ag-ui/core';
import { expect, it } from 'vitest';

import {
    TURN_FAILURE_MESSAGES,
    TurnFailureError,
    failureDetail,
    failureKind,
    isTurnFailureMessage,
    turnError,
    turnTimeLimitMsFromEnv,
    turnTimeLimitSecondsFromEnv,
} from '../src/observability/failures.js';

it('classifies turn failures by provider status and transport error', () => {
    // The model stream keeps only the provider message, which starts with
    // the HTTP status.
    expect(
        failureKind({
            message: '400 image input requires a supported vision checkpoint served with --vision',
        }),
    ).toBe('model_rejected');
    expect(failureKind(new Error('413 Request too large'))).toBe('model_rejected');
    expect(failureKind(Object.assign(new Error('nope'), { status: 401 }))).toBe('model_config');
    expect(failureKind(new Error('404 model "x" not found'))).toBe('model_config');
    expect(failureKind(new Error('429 Too many requests'))).toBe('model_unavailable');
    expect(failureKind(new Error('503 Service Unavailable'))).toBe('model_unavailable');
    expect(failureKind(new Error('Connection error.'))).toBe('model_unavailable');
    expect(failureKind(new TypeError('fetch failed'))).toBe('model_unavailable');
    expect(failureKind(new Error('Request timed out.'))).toBe('model_unavailable');
    expect(failureKind(new TurnFailureError('model_config', 'No model configured'))).toBe('model_config');
    expect(failureKind(new Error('Specialist Dot not found.'))).toBe('failed');
    expect(failureKind(undefined)).toBe('failed');
});

it('keeps provider text for operators without credentials or content', () => {
    expect(
        failureDetail(new Error('400 image input requires a supported vision checkpoint served with --vision')),
    ).toBe('400 image input requires a supported vision checkpoint served with --vision');
    const detail = failureDetail(
        new Error(
            `401 Incorrect API key provided: sk-proj-${'a'.repeat(40)}. Header Bearer abc.def. Contact owner@example.com or see https://model.example/v1/keys?token=secret123.\n` +
                `Invalid content "please summarize the confidential board minutes for me today": rejected`,
        ),
    );
    expect(detail).toContain('401 Incorrect API key provided');
    for (const secret of [
        'sk-proj',
        'aaaa',
        'abc.def',
        'owner@example.com',
        'secret123',
        'confidential board minutes',
    ]) {
        expect(detail).not.toContain(secret);
    }
    expect(detail).not.toContain('\n');
    expect(failureDetail(new Error('x'.repeat(10) + ' y'.repeat(400))).length).toBe(301);
    expect(failureDetail(Object.assign(new Error(''), { status: 502 }))).toBe('Error (HTTP 502)');
});

it('builds one RUN_ERROR shape: friendly message, kind as code, server-only detail', () => {
    expect(turnError('model_rejected', new Error('400 bad image'))).toEqual({
        type: EventType.RUN_ERROR,
        message: TURN_FAILURE_MESSAGES.model_rejected,
        code: 'model_rejected',
        // In metadata, which AG-UI 1.0 keeps, and at the top level.
        errorDetail: '400 bad image',
        metadata: { errorDetail: '400 bad image' },
    });
    expect(turnError('time_limit')).toEqual({
        type: EventType.RUN_ERROR,
        message: TURN_FAILURE_MESSAGES.time_limit,
        code: 'time_limit',
    });
    for (const message of Object.values(TURN_FAILURE_MESSAGES)) {
        expect(message).not.toMatch(/\d{3} |error:/i);
    }
});

it('names the time limit a turn had, and reads the environment’s (CB-123)', () => {
    expect(turnError('time_limit', undefined, 90_000).message).toBe(
        'This turn reached the 90 second time limit and was stopped. Try a smaller request.',
    );
    expect(turnError('time_limit', undefined, 120_000).message).toContain('2 minute time limit');
    for (const message of [
        TURN_FAILURE_MESSAGES.time_limit,
        turnError('time_limit', undefined, 45_000).message,
        TURN_FAILURE_MESSAGES.failed,
    ]) {
        expect(isTurnFailureMessage(message)).toBe(true);
    }
    expect(isTurnFailureMessage('Something else broke.')).toBe(false);

    expect(turnTimeLimitSecondsFromEnv({})).toBeUndefined();
    expect(turnTimeLimitSecondsFromEnv({ TURN_TIME_LIMIT_SECONDS: ' 90 ' })).toBe(90);
    expect(turnTimeLimitMsFromEnv({})).toBe(300_000);
    for (const bad of ['9', '3601', '1.5', 'soon']) {
        expect(() => turnTimeLimitSecondsFromEnv({ TURN_TIME_LIMIT_SECONDS: bad })).toThrow(
            'TURN_TIME_LIMIT_SECONDS must be a whole number from 10 to 3600.',
        );
    }
});
