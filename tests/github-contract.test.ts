import { expect, it } from 'vitest';

import * as api from '../src/server/github/api.js';
import * as contract from '../src/server/github/contract.js';

// The error and the constants moved to the contract and the pkt-line
// helpers to a package; the old paths in `api.ts` are gone.
it('keeps GitHubError a plain Error with its name and status', () => {
    const error = new contract.GitHubError('GitHub could not be reached.', 502);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('GitHubError');
    expect(error.status).toBe(502);
    expect(String(error)).toBe('GitHubError: GitHub could not be reached.');
});

it('makes the same clients the gateway makes today', () => {
    const app = api.gitHubClients.app({ id: '1', privateKey: 'key' });
    expect(app).toBeInstanceOf(api.GitHubApp);
    const repository = api.gitHubClients.repository({ repository: 'owner/name', token: 'token' });
    expect(repository).toBeInstanceOf(api.GitHubRepository);
});

it('names its tags socio/github/<Name>', () => {
    expect([
        contract.GitHubSettings.key,
        contract.GitHubAdmin.key,
        contract.GitHubClients.key,
        contract.GitHubConfig.key,
    ]).toEqual([
        'socio/github/GitHubSettings',
        'socio/github/GitHubAdmin',
        'socio/github/GitHubClients',
        'socio/github/GitHubConfig',
    ]);
});
