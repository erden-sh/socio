// Credentials in logs and reports (CB-146, CB-382): a credential key's
// quoted value goes whole, whatever it holds, in every form it is written.
import { describe, expect, it } from 'vitest';

import { redactAppLog } from '@socio/foundation/apps/log-redact';

describe('a credential key’s quoted value', () => {
    const cases: Array<[string, string, string]> = [
        ['JSON, with spaces', '{"password":"demo passphrase with spaces"}', '{"password":"[redacted]"}'],
        ['JSON, spaced', '{ "client_secret" : "a b c" }', '{ "client_secret" : "[redacted]" }'],
        [
            'JSON, escaped quotes',
            '{"password": "say \\"hi\\" twice", "user": "ada"}',
            '{"password": "[redacted]", "user": "ada"}',
        ],
        ['key=value, double quotes', 'password="two words" next', 'password="[redacted]" next'],
        ['key=value, single quotes', "passphrase='two words' next", "passphrase='[redacted]' next"],
        ['key: value', 'token: "a b c" done', 'token: "[redacted]" done'],
        ['single quotes, escaped', "secret: 'it\\'s here' ok", "secret: '[redacted]' ok"],
        ['camelCase and dashes', 'apiKey: \'k k\' api-key="x y"', 'apiKey: \'[redacted]\' api-key="[redacted]"'],
        [
            'refresh and access tokens',
            '{"refresh_token":"r r","access_token":"a a"}',
            '{"refresh_token":"[redacted]","access_token":"[redacted]"}',
        ],
        ['a private key', '{"private_key": "-----BEGIN KEY----- abc"}', '{"private_key": "[redacted]"}'],
        ['authorization', '{"Authorization": "Bearer abc def"}', '{"Authorization": "[redacted]"}'],
        ['any case', '{"PASSWORD":"Two Words"}', '{"PASSWORD":"[redacted]"}'],
        ['a quote never closed', 'secret: "runs on to the end', 'secret: "[redacted]'],
    ];
    for (const [name, text, redacted] of cases) {
        it(name, () => {
            expect(redactAppLog(text)).toBe(redacted);
        });
    }

    it('on an inner line of a JSON blob, and only that line', () => {
        const blob = '{\n  "user": "ada",\n  "password": "inner line secret",\n  "n": 1\n}';
        expect(redactAppLog(blob)).toBe('{\n  "user": "ada",\n  "password": "[redacted]",\n  "n": 1\n}');
    });

    it('unquoted, to the end of its token, as before', () => {
        expect(redactAppLog('password=hunter22 and more')).toBe('password=[redacted] and more');
        expect(redactAppLog('token: abcdef123 rest')).toBe('token: [redacted] rest');
        expect(redactAppLog('Authorization: Bearer abc.def.ghi')).toBe('Authorization: Bearer [redacted]');
    });

    it('leaves other keys and prose alone', () => {
        expect(redactAppLog('{"user": "ada lovelace", "mode": "password-less"}')).toBe(
            '{"user": "ada lovelace", "mode": "password-less"}',
        );
    });
});

describe('a camelCase or PascalCase credential key', () => {
    const keys = [
        'userPassword',
        'dbPassword',
        'adminPasswd',
        'gpgPassphrase',
        'clientSecret',
        'githubToken',
        'oauthAccessToken',
        'stripeSecretKey',
        'awsSecretAccessKey',
        'myApiKey',
        'myAPIKey',
        'sshPrivateKey',
        'UserPassword',
        'GithubToken',
        'v2Token',
    ];
    for (const key of keys) {
        it(`${key}: JSON, key=value and key: value, quoted and unquoted`, () => {
            const forms: Array<[string, string]> = [
                [`{"${key}":"two words"}`, `{"${key}":"[redacted]"}`],
                [`{"${key}": "value99"}`, `{"${key}": "[redacted]"}`],
                [`${key}="two words" next`, `${key}="[redacted]" next`],
                [`${key}='two words' next`, `${key}='[redacted]' next`],
                [`${key}=value99 next`, `${key}=[redacted] next`],
                [`${key}: "two words" next`, `${key}: "[redacted]" next`],
                [`${key}: value99 next`, `${key}: [redacted] next`],
            ];
            for (const [text, redacted] of forms) {
                expect(redactAppLog(text)).toBe(redacted);
                expect(redactAppLog(text)).not.toContain('two words');
                expect(redactAppLog(text)).not.toContain('value99');
            }
        });
    }

    it('proxyAuthorization: its quoted value whole, as authorization’s', () => {
        expect(redactAppLog('{"proxyAuthorization": "Basic two words"}')).toBe('{"proxyAuthorization": "[redacted]"}');
        expect(redactAppLog("proxyAuthorization='a b' next")).toBe("proxyAuthorization='[redacted]' next");
        expect(redactAppLog('proxyAuthorization: Bearer abc.def.ghi')).toBe('proxyAuthorization: Bearer [redacted]');
    });

    it('with a separator before the last word', () => {
        expect(redactAppLog('mySecret_key=abcdef rest')).toBe('mySecret_key=[redacted] rest');
        expect(redactAppLog('myApi-Key: abcdef rest')).toBe('myApi-Key: [redacted] rest');
    });

    it('stays redacted the same when redacted again', () => {
        for (const text of [
            '{"userPassword":"two words","githubToken":"abc"}',
            "stripeSecretKey='x y' myApiKey=abcdef",
            'awsSecretAccessKey: "a b" UserPassword=abcdef',
        ]) {
            const once = redactAppLog(text);
            expect(redactAppLog(once)).toBe(once);
        }
    });

    it('leaves ordinary words and other camelCase keys alone', () => {
        for (const text of [
            'tokenize: the input first',
            'secretary: Ada',
            'Passwordless: sign in by link',
            'passwordless: true',
            'Tokens are: short lived',
            'maxTokens: 4096',
            'tokenCount=12',
            '{"isPasswordless": true, "tokenizer": "word piece"}',
            'primaryKey=userId sortKey=createdAt',
            'The userPassword field is required, and githubToken is optional.',
            'Use a Password manager; a Secret Santa list; Token Ring networks.',
        ]) {
            expect(redactAppLog(text)).toBe(text);
        }
    });
});

describe('every pattern', () => {
    for (const [name, text] of Object.entries({
        'camelCase keys': 'aPassword'.repeat(7282),
        'camelCase opened quotes': 'aPassword:"'.repeat(5957),
        'camelCase JSON keys': '"userToken": "'.repeat(4681),
        'capitals before a key': `${'A'.repeat(65_000)}Token`,
        'opened quotes': 'password:"'.repeat(6553),
        'a long open value': `token="${'a'.repeat(65_000)}`,
        'JSON keys': '"password": "'.repeat(5000),
        escapes: `secret: "${'\\'.repeat(65_000)}`,
    })) {
        it(`takes time in proportion to the line: 64 KB of ${name}`, () => {
            const started = performance.now();
            redactAppLog(text);
            expect(performance.now() - started).toBeLessThan(50);
        });
    }
});
