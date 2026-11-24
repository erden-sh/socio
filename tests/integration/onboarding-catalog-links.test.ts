// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { Role, State, WorkspaceState } from '@socio/shared/types';

import { availableGuides } from '../../packages/client/src/modules/onboarding/guides';
import { clientModules } from '../../packages/client/src/modules/registry';
import { getDocsCatalog } from '../../src/server/docs/catalog';

const state = {
    settings: {
        name: 'x',
        paused: false,
        researchAllowed: false,
        memoryAllowed: true,
    },
    mode: 'live',
    configured: true,
    tasks: [],
    memories: [],
} as unknown as State;

function workspace(role: Role): WorkspaceState {
    return {
        user: { id: role, role, name: 'x' },
        preferences: { dictation: null },
        spaces: [{ id: 's1', name: 'General', description: '', createdAt: 1 }],
        dots: [
            {
                id: 'd1',
                name: 'Sebas',
                spaceId: 's1',
                spaceIds: ['s1'],
                instructions: 'x',
                researchAllowed: false,
                memoryAllowed: false,
                createdAt: 1,
            },
        ],
        conversations: [],
        setup: {
            model: true,
            browser: false,
            voice: false,
            telegram: 'not_configured',
            missing: [],
        },
        calls: [],
    } as unknown as WorkspaceState;
}

function ctxFor(role: Role) {
    const w = workspace(role);
    return {
        workspace: w,
        state,
        configured: true,
        admin: role === 'admin',
        homeDot: w.dots[0],
    };
}

describe('onboarding tour Read More links', () => {
    it('every guide step article resolves in the real role-filtered catalog', async () => {
        const catalog = await getDocsCatalog();
        const roles: Role[] = ['member', 'admin'];
        const missing: string[] = [];
        let steps = 0;
        for (const role of roles) {
            const guides = availableGuides(ctxFor(role), clientModules);
            for (const g of guides) {
                for (const s of g.steps) {
                    steps++;
                    const md = catalog.markdown(s.article, role);
                    if (md == null) {
                        missing.push(`role=${role} guide=${g.id} step=${s.id}: ${s.article}`);
                    }
                }
            }
        }
        expect(missing, `missing articles:\n${missing.join('\n')}`).toEqual([]);
        expect(steps).toBeGreaterThan(0);
    });
});
