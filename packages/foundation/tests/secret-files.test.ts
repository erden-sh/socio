import { expect, it } from 'vitest';

import { loadSecretFiles, SECRET_SETTINGS } from '../src/keys/secret-files.js';

it('loads secrets from files without overriding set values', () => {
    const files: Record<string, string> = {
        '/run/secrets/session': '  session-secret-from-file\n',
        '/run/secrets/token': 'from-file',
        // One secret, SeaweedFS's identity file, for both SeaweedFS and the app.
        '/run/secrets/company_brain_s3_config': '{"identities":[]}\n',
    };
    const read = (path: string) => {
        if (!(path in files)) {
            throw new Error('ENOENT');
        }
        return files[path];
    };
    const env: Record<string, string | undefined> = {
        SESSION_SECRET_FILE: '/run/secrets/session',
        PARALLEL_API_KEY: 'already-set',
        PARALLEL_API_KEY_FILE: '/run/secrets/token',
        UNRELATED_FILE: '/run/secrets/token',
        // The owner token is gone: a leftover mount is not read.
        OWNER_TOKEN_FILE: '/run/secrets/company_brain_owner_token',
        S3_CREDENTIALS_FILE: '/run/secrets/company_brain_s3_config',
    };
    loadSecretFiles(env, read);
    expect(env.S3_CREDENTIALS).toBe('{"identities":[]}');
    expect(env.SESSION_SECRET).toBe('session-secret-from-file');
    expect(env.PARALLEL_API_KEY).toBe('already-set');
    expect(env.UNRELATED).toBeUndefined();
    expect(env.OWNER_TOKEN).toBeUndefined();
    expect(SECRET_SETTINGS).not.toContain('OWNER_TOKEN');
    expect(() => loadSecretFiles({ COMPUTER_TOKEN_FILE: '/missing' }, read)).toThrow(
        'COMPUTER_TOKEN_FILE could not be read.',
    );
    expect(() => loadSecretFiles({ TELEGRAM_BOT_TOKEN_FILE: '/run/secrets/empty' }, () => '  \n')).toThrow(
        'TELEGRAM_BOT_TOKEN_FILE is empty.',
    );
});

it("never loads a vendor's coding credential into the app (dispatch was removed, CB-325)", () => {
    const app: Record<string, string | undefined> = {
        CLAUDE_CODE_OAUTH_TOKEN_FILE: '/run/secrets/token',
        ANTHROPIC_API_KEY_FILE: '/run/secrets/key',
        CODEX_API_KEY_FILE: '/run/secrets/codex',
        DISPATCH_TOKEN_FILE: '/run/secrets/dispatch',
    };
    loadSecretFiles(app, () => 'from-file');
    expect(app.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(app.ANTHROPIC_API_KEY).toBeUndefined();
    expect(app.CODEX_API_KEY).toBeUndefined();
    expect(app.DISPATCH_TOKEN).toBeUndefined();
});

it('loads the coding gateway’s and coding-git’s shared secrets from swarm secrets (CB-239)', () => {
    const files: Record<string, string> = {
        '/run/secrets/company_brain_coding_egress_secret': 'e'.repeat(32) + '\n',
        '/run/secrets/company_brain_coding_git_secret': 'g'.repeat(32) + '\n',
    };
    const read = (path: string) => {
        if (!(path in files)) {
            throw new Error('ENOENT');
        }
        return files[path];
    };
    const env: Record<string, string | undefined> = {
        CODING_EGRESS_SECRET_FILE: '/run/secrets/company_brain_coding_egress_secret',
        CODING_GIT_SECRET_FILE: '/run/secrets/company_brain_coding_git_secret',
    };
    loadSecretFiles(env, read);
    expect(env.CODING_EGRESS_SECRET).toBe('e'.repeat(32));
    expect(env.CODING_GIT_SECRET).toBe('g'.repeat(32));
    // A missing file stops startup without echoing a value.
    expect(() => loadSecretFiles({ CODING_GIT_SECRET_FILE: '/run/secrets/none' }, read)).toThrow(
        'CODING_GIT_SECRET_FILE could not be read.',
    );
});
