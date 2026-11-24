import { expect, it } from 'vitest';

import {
    applyCaptureResult,
    applyRefreshResult,
    clearNotice,
    dismissNotice,
    OFFLINE_NOTICE,
    UPDATING_NOTICE,
    visibleNotice,
    type Notices,
} from '../src/shell/poll-notice';

const none: Notices = { refresh: '', capture: '', action: '' };
const saved: Notices = { ...none, action: 'Could not save.' };

it('clears a recovered refresh error without wiping an action error', () => {
    const lost = applyRefreshResult(saved, {
        ok: false,
        message: 'Server returned an unreadable response.',
        status: 502,
    });
    expect(lost).toEqual({
        refresh: UPDATING_NOTICE,
        capture: '',
        action: 'Could not save.',
    });
    expect(visibleNotice(lost)).toBe('Could not save.');
    expect(applyRefreshResult(lost, { ok: true })).toEqual(saved);
    expect(visibleNotice(applyRefreshResult({ ...none, refresh: 'Failed to fetch' }, { ok: true }))).toBe('');
});

it('keeps an unauthorized poll from replacing the connection notice', () => {
    const current: Notices = { ...none, refresh: 'Failed to fetch' };
    expect(
        applyRefreshResult(current, {
            ok: false,
            status: 401,
            message: 'Enter your owner access token to unlock Socio.',
        }),
    ).toBe(current);
});

it('treats a capture transport failure as a capture notice and leaves save errors in place', () => {
    const lost = applyCaptureResult(saved, {
        ok: false,
        message: 'Failed to fetch',
    });
    expect(lost.capture).toBe(UPDATING_NOTICE);
    expect(lost.action).toBe('Could not save.');
    expect(applyCaptureResult(lost, { ok: true })).toEqual(saved);

    const specific = applyCaptureResult(
        { ...none, capture: 'Failed to fetch', action: 'Could not save.' },
        { ok: false, status: 500, message: 'Thread not found.' },
    );
    expect(specific.capture).toBe('Failed to fetch');
    expect(specific.action).toBe('Thread not found.');
    expect(applyRefreshResult(specific, { ok: true }).action).toBe('Thread not found.');
});

it('says nothing when the chat of a capture poll is gone (404)', () => {
    const gone = { ok: false as const, status: 404, message: 'Conversation not found.' };
    expect(applyCaptureResult(saved, gone)).toBe(saved);
    expect(applyCaptureResult(none, gone)).toBe(none);
});

it('treats any failure without an HTTP status as a transport failure', () => {
    for (const message of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed']) {
        const lost = applyCaptureResult(none, { ok: false, message });
        expect(lost).toEqual({ ...none, capture: UPDATING_NOTICE });
        expect(applyCaptureResult(lost, { ok: true })).toEqual(none);
    }
});

it('keeps a failing refresh poll visible while capture polls succeed', () => {
    const failing = applyRefreshResult(none, {
        ok: false,
        status: 503,
        message: 'Service unavailable.',
    });
    const afterCapture = applyCaptureResult(failing, { ok: true });
    expect(afterCapture.refresh).toBe('Service unavailable.');
    expect(visibleNotice(afterCapture)).toBe('Service unavailable.');
    expect(applyRefreshResult(afterCapture, { ok: true })).toEqual(none);
});

it('keeps a failing capture poll visible while refresh polls succeed', () => {
    const failing = applyCaptureResult(none, {
        ok: false,
        status: 504,
        message: 'Gateway timeout.',
    });
    const afterRefresh = applyRefreshResult(failing, { ok: true });
    expect(afterRefresh.capture).toBe(UPDATING_NOTICE);
    expect(applyCaptureResult(afterRefresh, { ok: true })).toEqual(none);
});

it('dismisses the visible notice and leaves the others', () => {
    const all: Notices = {
        refresh: 'Service unavailable.',
        capture: 'Failed to fetch',
        action: 'Could not save.',
    };
    const first = dismissNotice(all);
    expect(first).toEqual({ ...all, action: '' });
    const second = dismissNotice(first);
    expect(second).toEqual({ ...all, action: '', refresh: '' });
    expect(dismissNotice(second)).toEqual(none);
});

it('clears the notices showing a message once its toast closes', () => {
    const both: Notices = {
        refresh: 'Failed to fetch',
        capture: 'Failed to fetch',
        action: 'Could not save.',
    };
    expect(clearNotice(both, 'Failed to fetch')).toEqual({
        ...none,
        action: 'Could not save.',
    });
    // A message that is no longer shown changes nothing (same object).
    expect(clearNotice(saved, 'Gone.')).toBe(saved);
});

it('says the server is updating while it is away or draining, not what the browser or proxy said (CB-108)', () => {
    for (const failure of [
        { ok: false as const, message: 'Failed to fetch' },
        { ok: false as const, status: 502, message: 'Request failed (502).' },
        { ok: false as const, status: 504, message: 'Gateway timeout.' },
        {
            ok: false as const,
            status: 503,
            message: 'Server returned an unreadable response.',
        },
        {
            ok: false as const,
            status: 503,
            code: 'draining',
            message: 'Socio is updating. Try again in a minute.',
        },
    ]) {
        const lost = applyRefreshResult(none, failure);
        expect(lost, failure.message).toEqual({
            ...none,
            refresh: UPDATING_NOTICE,
        });
        // The same notice again changes nothing (no new toast).
        expect(applyRefreshResult(lost, failure)).toBe(lost);
        expect(applyRefreshResult(lost, { ok: true })).toEqual(none);
    }
    // An error the server explained is shown as it is.
    expect(
        applyRefreshResult(none, {
            ok: false,
            status: 503,
            message: 'Service unavailable.',
        }).refresh,
    ).toBe('Service unavailable.');
});

it('says the browser is offline, not that the server is updating, and goes once a poll is answered', () => {
    const offline = {
        ok: false as const,
        message: 'Failed to fetch',
        offline: true,
    };
    const refresh = applyRefreshResult(none, offline);
    expect(refresh).toEqual({ ...none, refresh: OFFLINE_NOTICE });
    expect(applyRefreshResult(refresh, offline)).toBe(refresh);
    const capture = applyCaptureResult(none, offline);
    expect(capture).toEqual({ ...none, capture: OFFLINE_NOTICE });
    expect(applyCaptureResult(capture, offline)).toBe(capture);
    // Back online: the server answers, or is the one away.
    expect(applyRefreshResult(refresh, { ok: true })).toEqual(none);
    expect(applyRefreshResult(refresh, { ok: false, message: 'Failed to fetch' })).toEqual({
        ...none,
        refresh: UPDATING_NOTICE,
    });
    // An answer from the server, even a draining one, came over a network.
    expect(
        applyCaptureResult(none, {
            ok: false,
            status: 503,
            code: 'draining',
            message: 'Socio is updating. Try again in a minute.',
            offline: false,
        }).capture,
    ).toBe(UPDATING_NOTICE);
});
