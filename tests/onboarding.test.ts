import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { GUIDE_IDS, GUIDE_VERSION, onboardingPreferencesSchema } from '@socio/shared/onboarding';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabaseFile } from './helpers/test-database.js';

it('keeps guide state per person across reopening SQLite, merging individual guide records without losing other preferences', () => {
    const dir = mkdtempSync(join(tmpdir(), 'socio-onboarding-'));
    let store = new WorkspaceStore(testDatabaseFile(join(dir, 'workspace.sqlite')));
    try {
        store.setPreferences('alice', {
            dictation: 'device',
            onboarding: {
                'getting-started': {
                    version: GUIDE_VERSION,
                    status: 'dismissed',
                    stepId: 'welcome',
                },
            },
        });
        store.setPreferences('alice', {
            onboarding: {
                improvements: {
                    version: GUIDE_VERSION,
                    status: 'completed',
                    stepId: 'follow',
                },
            },
        });
        store.setPreferences('bob', {
            onboarding: {
                'getting-started': {
                    version: GUIDE_VERSION,
                    status: 'in_progress',
                    stepId: 'spaces',
                },
            },
        });
        store.close();
        store = new WorkspaceStore(testDatabaseFile(join(dir, 'workspace.sqlite')));
        expect(store.preferences('alice')).toEqual({
            dictation: 'device',
            onboarding: {
                'getting-started': {
                    version: 1,
                    status: 'dismissed',
                    stepId: 'welcome',
                },
                improvements: { version: 1, status: 'completed', stepId: 'follow' },
            },
        });
        expect(store.preferences('bob').onboarding?.['getting-started']?.stepId).toBe('spaces');
        store.setPreferences('alice', {
            onboarding: {
                'getting-started': {
                    version: 2,
                    status: 'in_progress',
                    stepId: 'welcome',
                },
            },
        });
        expect(store.preferences('alice').onboarding?.improvements?.status).toBe('completed');
    } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
it('bounds and strictly validates guide IDs, versions, states and step identities', () => {
    const p = { version: 1, status: 'in_progress', stepId: 'welcome' };
    for (const id of GUIDE_IDS) {
        expect(onboardingPreferencesSchema.safeParse({ [id]: p }).success).toBe(true);
    }
    for (const bad of [
        { foreign: p },
        { __proto__: p, x: p },
        { 'getting-started': { ...p, version: 0 } },
        { 'getting-started': { ...p, version: 10001 } },
        { 'getting-started': { ...p, status: 'skip' } },
        { 'getting-started': { ...p, stepId: '/docs/operate/secrets' } },
        { 'getting-started': { ...p, stepId: 'a'.repeat(65) } },
        { 'getting-started': { ...p, userId: 'other-person' } },
    ]) {
        expect(onboardingPreferencesSchema.safeParse(bad).success).toBe(false);
    }
});
