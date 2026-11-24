import { expect, it, vi } from 'vitest';

import { sqliteApprovals } from '../src/server/approvals/services.js';

import { testDatabase } from './helpers/test-database.js';

it('requires a person for manual-only handlers even when an older policy stores auto or bypass', async () => {
    const db = testDatabase();
    try {
        const execute = vi.fn(async () => 'Executed once.'),
            decide = vi.fn(async () => {
                throw new Error('No model should run.');
            });
        const approvals = sqliteApprovals(db, { auto: { decider: { decide } } });
        approvals.register({
            capability: 'test.human',
            label: 'Human decision',
            description: 'Every action requires its person.',
            manualOnly: true,
            execute,
        });
        expect(approvals.capabilities()).toMatchObject([
            { id: 'test.human', manualOnly: true, auto: { allowed: false } },
        ]);
        for (const policy of ['auto', 'bypass'] as const) {
            await expect(approvals.setPolicy('alice', 'dot', 'test.human', policy)).rejects.toThrow(
                'requires your approval',
            );
            db.prepare(
                'INSERT INTO approval_policies(userId,dotId,capability,policy,updatedAt) VALUES(?,?,?,?,?) ON CONFLICT(userId,dotId,capability) DO UPDATE SET policy=excluded.policy',
            ).run('alice', 'dot', 'test.human', policy, 1);
            expect(await approvals.policy('alice', 'dot', 'test.human')).toBe('manual');
            expect(await approvals.policies('alice')).toMatchObject([{ policy: 'manual' }]);
            const pending = await approvals.request({
                userId: 'alice',
                dotId: 'dot',
                capability: 'test.human',
                summary: 'Review complete arguments',
                payload: { exact: 'value' },
            });
            expect(pending.status).toBe('pending_approval');
            expect(execute).toHaveBeenCalledTimes(policy === 'auto' ? 0 : 1);
            await expect(approvals.decide(pending.id, 'bob', true)).rejects.toThrow('not found');
            await approvals.decide(pending.id, 'alice', true);
        }
        expect(execute).toHaveBeenCalledTimes(2);
        expect(decide).not.toHaveBeenCalled();
    } finally {
        db.close();
    }
});
