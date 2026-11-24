import { expect, it } from 'vitest';

import type { ApprovalContinuationView } from '@socio/shared/approvals';
import { approvalAsk, carryingOn, decidedOnCard, mustOpenFirst } from '@socio/shared/approvals-view';
import type { SocioAccessCard } from '@socio/shared/socio-access';

// The rules of an approval's card and bar, shared by the web and the app.
// Each client keeps its own words.

const card = (fields: Partial<SocioAccessCard> & Pick<SocioAccessCard, 'kind'>) => fields as SocioAccessCard;

it('keeps Approve off until long details are opened', () => {
    expect(mustOpenFirst({})).toBe(false);
    expect(mustOpenFirst({ review: null })).toBe(false);
    expect(mustOpenFirst({ review: { mustOpen: false, opened: false } })).toBe(false);
    expect(mustOpenFirst({ review: { mustOpen: true, opened: false } })).toBe(true);
    expect(mustOpenFirst({ review: { mustOpen: true, opened: true } })).toBe(false);
});

it('lets only the card allow actions, access beyond read and coding', () => {
    expect(decidedOnCard(undefined)).toBe(false);
    expect(decidedOnCard(null)).toBe(false);
    expect(decidedOnCard(card({ kind: 'app_access', access: 'read' }))).toBe(false);
    expect(decidedOnCard(card({ kind: 'app_access', access: 'write' }))).toBe(true);
    expect(decidedOnCard(card({ kind: 'app_access', access: 'act' }))).toBe(true);
    expect(decidedOnCard(card({ kind: 'app_action' }))).toBe(true);
    expect(decidedOnCard(card({ kind: 'coding_session' }))).toBe(true);
    expect(decidedOnCard(card({ kind: 'coding_runtime' }))).toBe(true);
});

it('says the socio carries on while its continuation waits or runs', () => {
    const continuation = (status: ApprovalContinuationView['status']) => ({
        continuation: { status, id: null, detail: null, waitingFor: 0 },
    });
    expect(carryingOn(undefined)).toBe(false);
    expect(carryingOn({ continuation: null })).toBe(false);
    expect(carryingOn(continuation('waiting'))).toBe(true);
    expect(carryingOn(continuation('running'))).toBe(true);
    expect(carryingOn(continuation('done'))).toBe(false);
    expect(carryingOn(continuation('failed'))).toBe(false);
    expect(carryingOn(continuation('skipped'))).toBe(false);
});

it('gives what is asked as data, the label lowered at its start only', () => {
    expect(approvalAsk({ dotName: 'Ada', capabilityLabel: 'Create datasets' })).toEqual({
        socio: 'Ada',
        capability: 'create datasets',
    });
    expect(approvalAsk({ dotName: 'Ada', capabilityLabel: 'Use GitHub' })).toEqual({
        socio: 'Ada',
        capability: 'use GitHub',
    });
    expect(approvalAsk({ dotName: 'Ada', capabilityLabel: '' })).toEqual({ socio: 'Ada', capability: '' });
});
